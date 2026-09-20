/**
 * Ticket 02: sha256 instant-upload (秒传) + reference-counted content dedup.
 * Covers: dedupe on re-upload, fast-import zero-byte path, per-part checksums,
 * project scoping, ref-count decrement and physical cleanup on version delete,
 * and concurrent identical uploads racing the blob unique constraint.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db";
import { LocalDiskBlobStore } from "../src/blobStore";
import { createConversionService } from "../src/conversion";
import type { FastifyInstance } from "fastify";

const DATA_DIR = path.join(__dirname, "tmp-data-dedup");
const DB_URL = `file:${path.join(DATA_DIR, "test.db").replace(/\\/g, "/")}`;
const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "sample-building.ifc"));
const SAMPLE2 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "slab-standard-case.ifc"));
const SAMPLE_SHA = crypto.createHash("sha256").update(SAMPLE).digest("hex");

let app: FastifyInstance;
let token = "";
let projectId = "";
let projectBId = "";
let modelId = "";
let modelBId = "";

const sha = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

function multipart(field: string, filename: string, data: Buffer) {
  const boundary = "----openbimdedup" + Date.now() + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function inject(method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: method as never,
    url,
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

async function uploadMultipart(model: string, data: Buffer, filename = "model.ifc") {
  const mp = multipart("file", filename, data);
  const res = await inject("POST", `/api/v1/models/${model}/versions`, mp.payload, mp.headers);
  expect(res.statusCode).toBe(202);
  return res.json().version as { id: string; sha256: string; blobId?: string };
}

async function waitForReady(versionId: string, timeoutMs = 60000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await inject("GET", `/api/v1/versions/${versionId}`);
    const v = res.json().version;
    if (v.status === "READY") return v;
    if (v.status === "FAILED") throw new Error(`conversion failed: ${v.errorCode}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("conversion did not finish in time");
}

async function blobFor(sha256: string, project = projectId) {
  return app.db.contentBlob.findFirst({ where: { projectId: project, sha256 } });
}

beforeAll(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  execSync(`pnpm exec prisma db push --skip-generate`, {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "ignore",
  });
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: DB_URL,
    DATA_DIR,
    JWT_SECRET: "test-secret",
    CONVERSION_MODE: "inline",
  });
  const db = createDb(config.databaseUrl);
  const blobs = new LocalDiskBlobStore(config.dataDir);
  const conversion = createConversionService("inline", 1);
  app = await buildApp({ config, db, blobs, conversion, logger: false });

  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "dedup@test.local", name: "Dedup", password: "password123" },
  });
  expect(reg.statusCode).toBe(201);
  token = reg.json().accessToken;

  for (const [key, name] of [["dedup", "Dedup A"], ["dedupb", "Dedup B"]] as const) {
    const p = await inject("POST", "/api/v1/projects", { name, key });
    expect(p.statusCode).toBe(201);
    if (key === "dedup") projectId = p.json().project.id;
    else projectBId = p.json().project.id;
  }
  const m = await inject("POST", `/api/v1/projects/${projectId}/models`, { name: "M" });
  modelId = m.json().model.id;
  const mb = await inject("POST", `/api/v1/projects/${projectBId}/models`, { name: "M" });
  modelBId = mb.json().model.id;
});

afterAll(async () => {
  await app.close();
});

describe("content dedup on upload", () => {
  it("re-uploading identical bytes links one blob with two refs", async () => {
    const v1 = await uploadMultipart(modelId, SAMPLE);
    await waitForReady(v1.id);
    const v2 = await uploadMultipart(modelId, SAMPLE);
    await waitForReady(v2.id);

    expect(v2.sha256).toBe(SAMPLE_SHA);
    const blob = await blobFor(SAMPLE_SHA);
    expect(blob).not.toBeNull();
    const versions = await app.db.version.findMany({ where: { id: { in: [v1.id, v2.id] } } });
    expect(versions.every((v) => v.blobId === blob!.id)).toBe(true);
    expect(blob!.refCount).toBe(2);
    expect(blob!.sizeBytes).toBe(SAMPLE.byteLength);
    // single physical file at the content key, readable through both versions
    expect(fs.existsSync(app.blobs.pathFor(blob!.storageKey))).toBe(true);
    const orig = await inject("GET", `/api/v1/versions/${v2.id}/file/original`);
    expect(orig.statusCode).toBe(200);
    expect(orig.rawPayload.equals(SAMPLE)).toBe(true);
  });

  it("dedupe is project-scoped: another project creates its own blob", async () => {
    const vb = await uploadMultipart(modelBId, SAMPLE);
    await waitForReady(vb.id);
    const blobB = await blobFor(SAMPLE_SHA, projectBId);
    const blobA = await blobFor(SAMPLE_SHA, projectId);
    expect(blobB).not.toBeNull();
    expect(blobB!.id).not.toBe(blobA!.id);
    expect(blobB!.refCount).toBe(1);
  });

  it("concurrent identical uploads race the unique constraint safely", async () => {
    const before = await app.db.contentBlob.count({ where: { projectId, sha256: sha(SAMPLE2) } });
    expect(before).toBe(0);
    const [a, b] = await Promise.all([
      uploadMultipart(modelId, SAMPLE2),
      uploadMultipart(modelId, SAMPLE2),
    ]);
    await waitForReady(a.id);
    await waitForReady(b.id);
    const blobs = await app.db.contentBlob.findMany({ where: { projectId, sha256: sha(SAMPLE2) } });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].refCount).toBe(2);
  });
});

describe("fast-import (zero-byte instant upload)", () => {
  it("registers a version without transferring bytes", async () => {
    const res = await inject("POST", `/api/v1/models/${modelId}/versions/fast-import`, {
      sha256: SAMPLE_SHA,
      sizeBytes: SAMPLE.byteLength,
      fileName: "sample-building.ifc",
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.deduped).toBe(true);
    expect(body.version.versionNumber).toBeGreaterThan(1);
    await waitForReady(body.version.id);

    const blob = await blobFor(SAMPLE_SHA);
    expect(blob!.refCount).toBeGreaterThanOrEqual(3);
    const orig = await inject("GET", `/api/v1/versions/${body.version.id}/file/original`);
    expect(orig.rawPayload.equals(SAMPLE)).toBe(true);
  });

  it("404s for unknown hashes, wrong sizes, and other projects", async () => {
    const unknown = await inject("POST", `/api/v1/models/${modelId}/versions/fast-import`, {
      sha256: "0".repeat(64),
      sizeBytes: 10,
      fileName: "x.ifc",
    });
    expect(unknown.statusCode).toBe(404);

    const wrongSize = await inject("POST", `/api/v1/models/${modelId}/versions/fast-import`, {
      sha256: SAMPLE_SHA,
      sizeBytes: 1,
      fileName: "x.ifc",
    });
    expect(wrongSize.statusCode).toBe(404);

    const onlyA = await inject("POST", `/api/v1/models/${modelBId}/versions/fast-import`, {
      sha256: sha(SAMPLE2),
      sizeBytes: SAMPLE2.byteLength,
      fileName: "x.ifc",
    });
    expect(onlyA.statusCode).toBe(404);
  });
});

describe("chunked upload integrity + dedup", () => {
  it("rejects a part whose checksum does not match", async () => {
    const create = await inject("POST", `/api/v1/models/${modelId}/uploads`, {
      fileName: "sample-building.ifc",
      partSize: 2048,
      partsTotal: Math.ceil(SAMPLE.byteLength / 2048),
    });
    expect(create.statusCode).toBe(201);
    const { uploadId, partSize } = create.json();
    const bad = await inject(
      "PUT",
      `/api/v1/models/${modelId}/uploads/${uploadId}/parts/1`,
      SAMPLE.subarray(0, partSize),
      { "content-type": "application/octet-stream", "x-part-sha256": "f".repeat(64) }
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toMatch(/checksum mismatch/);
  });

  it("accepts checksummed parts and dedupes the assembled file", async () => {
    const partSize = 4096;
    const partsTotal = Math.ceil(SAMPLE.byteLength / partSize);
    const create = await inject("POST", `/api/v1/models/${modelId}/uploads`, {
      fileName: "sample-building.ifc",
      partSize,
      partsTotal,
    });
    const { uploadId } = create.json();
    for (let p = 0; p < partsTotal; p++) {
      const slice = SAMPLE.subarray(p * partSize, Math.min((p + 1) * partSize, SAMPLE.byteLength));
      const res = await inject(
        "PUT",
        `/api/v1/models/${modelId}/uploads/${uploadId}/parts/${p + 1}`,
        slice,
        { "content-type": "application/octet-stream", "x-part-sha256": sha(slice) }
      );
      expect(res.statusCode).toBe(200);
    }
    const done = await inject("POST", `/api/v1/models/${modelId}/uploads/${uploadId}/complete`);
    expect(done.statusCode).toBe(202);
    const version = done.json().version;
    expect(version.sha256).toBe(SAMPLE_SHA);
    await waitForReady(version.id);
    const blob = await blobFor(SAMPLE_SHA);
    const linked = await app.db.version.findUnique({ where: { id: version.id } });
    expect(linked!.blobId).toBe(blob!.id);
    // part files are consumed during assembly
    expect(fs.existsSync(app.blobs.pathFor(`tmp/uploads/${uploadId}/part-1`))).toBe(false);
  });
});

describe("reference-counted cleanup", () => {
  it("deleting one ref keeps others readable; last delete removes the file", async () => {
    // dedicated blob: two versions in a fresh model via fast-import path
    const v1 = await uploadMultipart(modelId, SAMPLE2);
    await waitForReady(v1.id);
    const fast = await inject("POST", `/api/v1/models/${modelId}/versions/fast-import`, {
      sha256: sha(SAMPLE2),
      sizeBytes: SAMPLE2.byteLength,
      fileName: "slab.ifc",
    });
    expect(fast.statusCode).toBe(202);
    const v2 = fast.json().version;
    await waitForReady(v2.id);

    let blob = await blobFor(sha(SAMPLE2));
    // concurrent-race pair (2) + this upload + this fast-import
    expect(blob!.refCount).toBe(4);
    const blobPath = app.blobs.pathFor(blob!.storageKey);

    const del = await inject("DELETE", `/api/v1/versions/${v2.id}`);
    expect(del.statusCode).toBe(200);
    blob = await blobFor(sha(SAMPLE2));
    expect(blob!.refCount).toBe(3);
    expect(fs.existsSync(blobPath)).toBe(true);
    // sibling version still serves the original bytes
    const orig = await inject("GET", `/api/v1/versions/${v1.id}/file/original`);
    expect(orig.statusCode).toBe(200);
    expect(orig.rawPayload.equals(SAMPLE2)).toBe(true);

    // delete every remaining ref -> physical file goes
    const refs = await app.db.version.findMany({ where: { blobId: blob!.id }, select: { id: true } });
    for (const r of refs) {
      const d = await inject("DELETE", `/api/v1/versions/${r.id}`);
      expect(d.statusCode).toBe(200);
    }
    expect(await blobFor(sha(SAMPLE2))).toBeNull();
    expect(fs.existsSync(blobPath)).toBe(false);
  });

  it("model delete releases refs of all its versions", async () => {
    const m = await inject("POST", `/api/v1/projects/${projectId}/models`, { name: "Temp" });
    const tempModel = m.json().model.id;
    const v = await uploadMultipart(tempModel, SAMPLE);
    await waitForReady(v.id);
    const blob = await blobFor(SAMPLE_SHA);
    const refsBefore = blob!.refCount;
    await inject("DELETE", `/api/v1/models/${tempModel}`);
    const after = await blobFor(SAMPLE_SHA);
    expect(after!.refCount).toBe(refsBefore - 1);
    expect(fs.existsSync(app.blobs.pathFor(after!.storageKey))).toBe(true); // still referenced elsewhere
  });
});
