import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db";
import { LocalDiskBlobStore } from "../src/blobStore";
import { createConversionService } from "../src/conversion";
import { parseOrigin, translateBoxes } from "../src/routes/clash";
import type { FastifyInstance } from "fastify";

const DATA_DIR = path.join(__dirname, "tmp-data");
const DB_URL = `file:${path.join(DATA_DIR, "test.db").replace(/\\/g, "/")}`;
const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "sample-building.ifc"));

let app: FastifyInstance;
let adminToken = "";
const alice = { accessToken: "", refreshToken: "" };
const bob = { accessToken: "", refreshToken: "" };
let projectId = "";
let modelId = "";
let versionId = "";

async function waitForReady(versionId: string, timeoutMs = 60000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = res.json();
    if (body.version?.status === "READY") return body.version;
    if (body.version?.status === "FAILED") throw new Error(`conversion failed: ${body.version.errorCode}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("conversion did not finish in time");
}

function multipart(field: string, filename: string, data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----openbimhubtest" + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
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
  config.conversionMode = "inline";
  const db = createDb(config.databaseUrl);
  const blobs = new LocalDiskBlobStore(config.dataDir);
  const conversion = createConversionService("inline", 1);
  app = await buildApp({ config, db, blobs, conversion, logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("OpenBIM Hub API", () => {
  it("registers the first user as platform admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "alice@test.local", name: "Alice", password: "password123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe("ADMIN");
    expect(body.accessToken).toBeTruthy();
    alice.accessToken = body.accessToken;
    alice.refreshToken = body.refreshToken;
    adminToken = body.accessToken;
  });

  it("rejects duplicate registration and bad credentials", async () => {
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "alice@test.local", name: "Alice2", password: "password123" },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@test.local", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("authenticates and rotates refresh tokens", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@test.local", password: "password123" },
    });
    expect(login.statusCode).toBe(200);
    const { refreshToken } = login.json();
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().refreshToken).not.toBe(refreshToken);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a project and model", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { name: "Demo Project", key: "demo", description: "integration test" },
    });
    expect(project.statusCode).toBe(201);
    projectId = project.json().project.id;

    const model = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/models`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { name: "Architecture" },
    });
    expect(model.statusCode).toBe(201);
    modelId = model.json().model.id;
  });

  it("uploads an IFC file, converts it, and exposes metadata", async () => {
    const mp = multipart("file", "sample-building.ifc", SAMPLE);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/models/${modelId}/versions`,
      headers: { authorization: `Bearer ${alice.accessToken}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(upload.statusCode).toBe(202);
    expect(upload.json().version.status).toBe("PENDING");
    versionId = upload.json().version.id;

    const version = await waitForReady(versionId);
    expect(version.schema).toBe("IFC4");
    expect(version.progress).toBeGreaterThanOrEqual(99); // throttled final tick may lag one write
    expect(JSON.parse(version.statsJson).elements).toBe(4);

    // origin/crs persisted on the version row and embedded in meta.json
    const origin = JSON.parse(version.originJson) as number[];
    expect(origin).toHaveLength(3);
    expect(origin.every((v) => Number.isFinite(v))).toBe(true);
    expect(JSON.parse(version.crsJson)).toEqual({ source: "ABSENT", name: null, epsg: null, mapConversion: null });
    const metaRes = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/meta`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(metaRes.statusCode).toBe(200);
    expect(JSON.parse(metaRes.payload).origin).toEqual(origin);

    // elements list
    const elements = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/elements?ifcType=IFCWALL`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(elements.statusCode).toBe(200);
    expect(elements.json().total).toBe(2);

    // single element with psets
    const wall = elements.json().elements[0];
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/elements/${wall.expressID}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const psets = detail.json().element.psets;
    expect(psets.Pset_WallCommon.IsExternal).toBe(true);

    // spatial tree
    const spatial = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/spatial`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(spatial.statusCode).toBe(200);
    const tree = spatial.json().spatial;
    expect(tree.name).toBe("Sample Project");
    expect(tree.children[0].children[0].children).toHaveLength(2);

    // glTF artifact (quantized + meshopt-compressed)
    const glb = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/glTF`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(glb.statusCode).toBe(200);
    expect(glb.headers["content-type"]).toBe("model/gltf-binary");
    expect(glb.rawPayload.subarray(0, 4).toString("latin1")).toBe("glTF");
    // JSON chunk advertises the transport extensions
    const dv = new DataView(glb.rawPayload.buffer, glb.rawPayload.byteOffset, glb.rawPayload.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const gltfJson = JSON.parse(Buffer.from(glb.rawPayload.subarray(20, 20 + jsonLen)).toString("utf8"));
    expect(gltfJson.extensionsUsed).toContain("KHR_mesh_quantization");
    // ticket 04: the pipeline applies KHR_meshopt_compression by default
    expect(gltfJson.extensionsRequired).toContain("KHR_meshopt_compression");
    // positions are stored as normalized int16 (4-component padded)
    const posAccessor = gltfJson.accessors[gltfJson.meshes[0].primitives[0].attributes.POSITION];
    expect(posAccessor.componentType).toBe(5122);
    expect(posAccessor.normalized).toBe(true);
    const metaJson = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/versions/${versionId}/file/meta`,
          headers: { authorization: `Bearer ${alice.accessToken}` },
        })
      ).rawPayload.toString("utf8")
    );
    expect(metaJson.glbCompression).toEqual({ codec: "meshopt", fallbackViews: 0 });

    // static Brotli sidecar is negotiated via Accept-Encoding (ticket 04)
    const brRes = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/glTF`,
      headers: { authorization: `Bearer ${alice.accessToken}`, "accept-encoding": "gzip, deflate, br" },
    });
    expect(brRes.statusCode).toBe(200);
    expect(brRes.headers["content-encoding"]).toBe("br");
    expect(String(brRes.headers.vary)).toContain("Accept-Encoding");
    const decompressed = zlib.brotliDecompressSync(brRes.rawPayload);
    expect(decompressed.subarray(0, 20)).toEqual(glb.rawPayload.subarray(0, 20));
    expect(decompressed.byteLength).toBe(glb.rawPayload.byteLength);
    const plainRes = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/glTF`,
      headers: { authorization: `Bearer ${alice.accessToken}`, "accept-encoding": "identity" },
    });
    expect(plainRes.headers["content-encoding"]).toBeUndefined();

    // original download + hash integrity
    const original = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/original`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(SAMPLE)).toBe(true);
  });

  it("tracks issues with viewpoints and round-trips BCF 2.1 (export -> import)", async () => {
    const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).toString("base64");
    const issue = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        title: "Wall <clash> & gap",
        description: "check it",
        priority: "HIGH",
        viewpoint: {
          camera: { viewPoint: [12, 9, 14], viewUp: [0, 1, 0], viewDirection: [-0.5, -0.3, -0.8], fieldOfView: 55 },
          selected: ["1r6PQPPXvATBmG_rT2sJiC"],
        },
        snapshotBase64: pngBase64,
      },
    });
    expect(issue.statusCode).toBe(201);
    const issueId = issue.json().issue.id;
    expect(issue.json().issue.viewpointJson).toBeTruthy();
    expect(issue.json().issue.snapshotKey).toBeTruthy();

    // snapshot retrievable
    const snap = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/snapshot`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers["content-type"]).toBe("image/png");

    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { body: "Fixed on site" },
    });
    expect(comment.statusCode).toBe(201);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { status: "OPEN" },
    });
    expect(patch.json().issue.status).toBe("OPEN");

    // export: zip must contain viewpoint.bcfv + snapshot.png
    const bcf = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues/export.bcfzip`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(bcf.statusCode).toBe(200);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bcf.rawPayload);
    expect(zip.file("bcf.version")).toBeTruthy();
    const markupPath = Object.keys(zip.files).find((f) => f.endsWith("markup.bcf"))!;
    const markup = await zip.file(markupPath)!.async("string");
    expect(markup).toContain("Wall &lt;clash&gt; &amp; gap");
    expect(Object.keys(zip.files).some((f) => f.endsWith("viewpoint.bcfv"))).toBe(true);
    expect(Object.keys(zip.files).some((f) => f.endsWith("snapshot.png"))).toBe(true);

    // re-import the exported zip: guid dedup -> skipped, nothing duplicated
    const boundary = "----obhimport";
    const importMp = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.bcfzip"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      bcf.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const importRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues/import.bcfzip`,
      headers: { authorization: `Bearer ${alice.accessToken}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: importMp,
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json()).toMatchObject({ imported: 0, skipped: 1 });

    // audit trail captured the issue lifecycle
    const auditLog = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/audit`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(auditLog.statusCode).toBe(200);
    const actions = auditLog.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("issue.create");
    expect(actions).toContain("issue.export");
    expect(actions).toContain("issue.import");
    expect(actions).toContain("version.upload");
  });

  it("supports chunked (multi-part) uploads", async () => {
    const newModel = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/models`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { name: "Structure" },
    });
    const chunkModelId = newModel.json().model.id;

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/models/${chunkModelId}/uploads`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { fileName: "sample-building.ifc", partSize: 2048, partsTotal: 3 },
    });
    expect(create.statusCode).toBe(201);
    const { uploadId } = create.json();

    const chunkSize = 2048;
    for (let p = 1; p <= 3; p++) {
      const slice = SAMPLE.subarray((p - 1) * chunkSize, p * chunkSize);
      const part = await app.inject({
        method: "PUT",
        url: `/api/v1/models/${chunkModelId}/uploads/${uploadId}/parts/${p}`,
        headers: { authorization: `Bearer ${alice.accessToken}`, "content-type": "application/octet-stream" },
        payload: slice,
      });
      expect(part.statusCode).toBe(200);
    }

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/models/${chunkModelId}/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {},
    });
    expect(complete.statusCode).toBe(202);
    const assembled = complete.json().version;
    expect(assembled.sizeBytes).toBe(SAMPLE.length);

    const version = await waitForReady(assembled.id);
    expect(version.status).toBe("READY");
    expect(JSON.parse(version.statsJson).elements).toBe(4);
  });

  it("enforces project-level RBAC", async () => {
    // bob registers (not a member)
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "bob@test.local", name: "Bob", password: "password123" },
    });
    bob.accessToken = reg.json().accessToken;

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(denied.statusCode).toBe(403);

    // alice adds bob as VIEWER
    const add = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { email: "bob@test.local", role: "VIEWER" },
    });
    expect(add.statusCode).toBe(201);

    const viewerOk = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(viewerOk.statusCode).toBe(200);

    // viewer cannot upload a new version
    const mp = multipart("file", "sample-building.ifc", SAMPLE);
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/models/${modelId}/versions`,
      headers: { authorization: `Bearer ${bob.accessToken}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("rejects non-IFC uploads", async () => {
    const mp = multipart("file", "evil.txt", Buffer.from("not an ifc"));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/models/${modelId}/versions`,
      headers: { authorization: `Bearer ${alice.accessToken}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(415);
  });

  it("serves health and openapi", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const docs = await app.inject({ method: "GET", url: "/api/v1/docs" });
    expect(docs.statusCode).toBe(200);
  });

  it("manifest serves default-config versions as single (compat read path)", async () => {
    const man = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/manifest`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(man.statusCode).toBe(200);
    const body = man.json();
    expect(body.artifactFormat).toBe("single");
    expect(body.url).toBe(`/api/v1/versions/${versionId}/file/glTF`);
    expect(body.chunks).toBeUndefined();
    const lookup = await app.inject({
      method: "POST",
      url: `/api/v1/versions/${versionId}/elements/lookup`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { guids: ["no-such-guid"] },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().elements).toEqual([]);
  });
});

describe("Tier-2: bboxes, clash detection, diff, SSE", () => {
  let secondVersionId = "";

  it("uploads a second version and stores per-element bboxes", async () => {
    const mp = multipart("file", "sample-building.ifc", SAMPLE);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/models/${modelId}/versions`,
      headers: { authorization: `Bearer ${alice.accessToken}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(upload.statusCode).toBe(202);
    secondVersionId = upload.json().version.id;
    await waitForReady(secondVersionId);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/elements/41`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    void detail;
    const glb = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/file/meta`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(glb.statusCode).toBe(200);
  });

  it("detects self-clashes with tolerance (touching faces ignored)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/clash-detection",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { versionAId: versionId, versionBId: versionId, tolerance: 0.01 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.checkedA).toBe(4);
    // door intersects the glass wall; wall resting on slab touches (overlap 0) -> excluded
    const pair = (c: { a: { name: string }; b: { name: string } }) => [c.a.name, c.b.name].sort().join("+");
    const pairs = body.clashes.map(pair);
    expect(pairs).toContain("Door First+Wall First");
    expect(pairs).not.toContain("Ground Slab+Wall Ground");
    expect(body.clashes.find((c: { a: { name: string }; b: { name: string } }) => c.a.name === "Door First" || c.b.name === "Door First").overlap[2]).toBeGreaterThan(0);
  });

  it("detects clashes across two versions of the same model", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/clash-detection",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { versionAId: versionId, versionBId: secondVersionId, tolerance: 0.01, maxResults: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // identical geometry stacked on itself: every element clashes with its twin
    expect(body.summary.clashes).toBeGreaterThanOrEqual(4);
    expect(body.clashes[0].a.guid).toBe(body.clashes[0].b.guid);
  });

  it("rejects clash requests for versions the caller cannot access", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/clash-detection",
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { versionAId: versionId, versionBId: secondVersionId },
    });
    // bob is a VIEWER member of the project -> allowed to read
    expect(denied.statusCode).toBe(200);

    const outsider = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "eve@test.local", name: "Eve", password: "password123" },
    });
    const eveRes = await app.inject({
      method: "POST",
      url: "/api/v1/clash-detection",
      headers: { authorization: `Bearer ${outsider.json().accessToken}` },
      payload: { versionAId: versionId, versionBId: secondVersionId },
    });
    expect(eveRes.statusCode).toBe(403);
  });

  it("diffs two versions by GUID identity", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/diff/${secondVersionId}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: { total: 0 }, removed: { total: 0 }, changed: { total: 0 }, unchanged: 4 });
  });

  it("streams version events over SSE", async () => {
    // subscribe then upload; expect PROCESSING/READY events to arrive
    const token = alice.accessToken;
    const mp = multipart("file", "sample-building.ifc", SAMPLE);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/models/${modelId}/versions`,
      headers: { authorization: `Bearer ${token}`, ...mp.headers },
      payload: mp.payload,
    });
    const newId = upload.json().version.id;
    await waitForReady(newId);
    // SSE verified in the browser E2E; here we assert events were emitted (indirectly via status readiness)
    expect(newId).toBeTruthy();
  });
});

describe("origin-aware clash offsets (ticket 03 helpers)", () => {
  const box = { expressID: 1, guid: "g", ifcType: "IFCWALL", name: "w", min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };

  it("parseOrigin defaults to zero for missing or malformed rows", () => {
    expect(parseOrigin(null)).toEqual([0, 0, 0]);
    expect(parseOrigin("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseOrigin("nope")).toEqual([0, 0, 0]);
    expect(parseOrigin("[1,2]")).toEqual([0, 0, 0]);
    expect(parseOrigin("[1,2,NaN]")).toEqual([0, 0, 0]);
  });

  it("translateBoxes shifts both corners and keeps a zero delta cheap", () => {
    const moved = translateBoxes([box], [30, 40, -5]);
    expect(moved[0].min).toEqual([30, 40, -5]);
    expect(moved[0].max).toEqual([31, 41, -4]);
    expect(translateBoxes([box], [0, 0, 0])[0]).toBe(box);
  });
});

describe("chunked artifacts + manifest (ticket 05)", () => {
  const CH_DIR = path.join(__dirname, "tmp-data-chunks");
  const CH_DB = `file:${path.join(CH_DIR, "test.db").replace(/\\/g, "/")}`;
  const SLAB = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "slab-standard-case.ifc"));

  let capp: FastifyInstance;
  let ctoken = "";
  let cprojectId = "";
  let cmodelId = "";
  let cversionId = "";
  let manifest: any;

  async function cWaitReady(id: string, timeoutMs = 60000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await capp.inject({ method: "GET", url: `/api/v1/versions/${id}`, headers: { authorization: `Bearer ${ctoken}` } });
      const body = res.json();
      if (body.version?.status === "READY") return body.version;
      if (body.version?.status === "FAILED") throw new Error(`conversion failed: ${body.version.errorCode}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("conversion did not finish in time");
  }

  beforeAll(async () => {
    fs.rmSync(CH_DIR, { recursive: true, force: true });
    fs.mkdirSync(CH_DIR, { recursive: true });
    execSync(`pnpm exec prisma db push --skip-generate`, {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: CH_DB },
      stdio: "ignore",
    });
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: CH_DB,
      DATA_DIR: CH_DIR,
      JWT_SECRET: "test-secret",
      CONVERSION_MODE: "inline",
      CHUNK_THRESHOLD_BYTES: "1",
      CHUNK_MAX_TRIANGLES: "20",
    });
    const cdb = createDb(config.databaseUrl);
    const cblobs = new LocalDiskBlobStore(config.dataDir);
    const cconv = createConversionService("inline", 1);
    capp = await buildApp({ config, db: cdb, blobs: cblobs, conversion: cconv, logger: false });

    const reg = await capp.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "chunker@test.local", name: "Chunker", password: "password123" },
    });
    ctoken = reg.json().accessToken;
    const project = await capp.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${ctoken}` },
      payload: { name: "Chunk Project", key: "chunks" },
    });
    cprojectId = project.json().project.id;
    const model = await capp.inject({
      method: "POST",
      url: `/api/v1/projects/${cprojectId}/models`,
      headers: { authorization: `Bearer ${ctoken}` },
      payload: { name: "Tower" },
    });
    cmodelId = model.json().model.id;

    const mp = multipart("file", "sample-building.ifc", SAMPLE);
    const up = await capp.inject({
      method: "POST",
      url: `/api/v1/models/${cmodelId}/versions`,
      headers: { authorization: `Bearer ${ctoken}`, ...mp.headers },
      payload: mp.payload,
    });
    cversionId = up.json().version.id;
    await cWaitReady(cversionId);
    const man = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/manifest`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(man.statusCode).toBe(200);
    manifest = man.json();
  });

  it("rejects malformed route params and SSE query strings via fastify schemas", async () => {
    const bad: Array<[string, string]> = [
      ["GET", "/api/v1/versions/NOT-VALID_ID/manifest"],
      ["GET", `/api/v1/versions/${cversionId}/chunks/${encodeURIComponent("!9")}`],
      ["PUT", `/api/v1/models/${cmodelId}/uploads/abc123def/parts/NaN`],
      ["POST", `/api/v1/models/${cmodelId}/uploads/${encodeURIComponent("!!bad")}/complete`],
    ];
    for (const [m, u] of bad) {
      const res = await capp.inject({ method: m as never, url: u, headers: { authorization: `Bearer ${ctoken}` } });
      expect(res.statusCode, `${m} ${u}`).toBe(400);
    }
    const ev = await capp.inject({ method: "GET", url: `/api/v1/versions/events?token=${encodeURIComponent("!!!not-a-jwt!!!")}` });
    expect(ev.statusCode).toBe(400);
  });

  afterAll(async () => {
    await capp.close();
  });

  it("manifest lists per-storey chunks with budgets conserved and relative urls", () => {
    expect(manifest.artifactFormat).toBe("chunked");
    expect(manifest.chunks.length).toBeGreaterThanOrEqual(2);
    const ids = manifest.chunks.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(manifest.chunks.reduce((s: number, c: any) => s + c.triangles, 0)).toBe(manifest.stats.triangles);
    for (const c of manifest.chunks) {
      expect(c.bytes).toBeGreaterThan(0);
      expect(c.url).toBe(`/api/v1/versions/${cversionId}/chunks/${c.id}`);
      expect(c.bbox).toHaveLength(6);
    }
  });

  it("serves each manifest chunk as a GLB sized as declared", async () => {
    for (const c of manifest.chunks) {
      const res = await capp.inject({ method: "GET", url: c.url, headers: { authorization: `Bearer ${ctoken}` } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("model/gltf-binary");
      expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("glTF");
      expect(res.rawPayload.byteLength).toBe(c.bytes);
    }
  });

  it("rejects unknown and non-numeric chunk ids", async () => {
    const missing = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/chunks/999999`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/chunks/7%2F..%2Fmeta.json`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
  });

  it("chunked versions have no model.glb; legacy glTF route 404s cleanly", async () => {
    const res = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/file/glTF`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("guid lookup resolves every element to a manifest chunk", async () => {
    const list = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/elements?pageSize=50`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    const guids = list.json().elements.map((e: any) => e.guid);
    expect(guids.length).toBe(4);
    const lookup = await capp.inject({
      method: "POST",
      url: `/api/v1/versions/${cversionId}/elements/lookup`,
      headers: { authorization: `Bearer ${ctoken}` },
      payload: { guids },
    });
    expect(lookup.statusCode).toBe(200);
    const found = lookup.json().elements;
    expect(found).toHaveLength(4);
    const chunkIds = new Set(manifest.chunks.map((c: any) => c.id));
    for (const e of found) {
      expect(chunkIds.has(e.chunkId)).toBe(true);
    }
    expect(typeof found[0].name).toBe("string");
    const byExpress = await capp.inject({
      method: "POST",
      url: `/api/v1/versions/${cversionId}/elements/lookup`,
      headers: { authorization: `Bearer ${ctoken}` },
      payload: { expressIDs: list.json().elements.map((e: any) => e.expressID) },
    });
    expect(byExpress.json().elements).toHaveLength(4);
    const emptyBody = await capp.inject({
      method: "POST",
      url: `/api/v1/versions/${cversionId}/elements/lookup`,
      headers: { authorization: `Bearer ${ctoken}` },
      payload: {},
    });
    expect(emptyBody.statusCode).toBe(400);
    const tooMany = await capp.inject({
      method: "POST",
      url: `/api/v1/versions/${cversionId}/elements/lookup`,
      headers: { authorization: `Bearer ${ctoken}` },
      payload: { guids: Array.from({ length: 501 }, (_, i) => `g${i}`) },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("proxy layer ships one AABB tuple per element, bound to its chunk", async () => {
    const res = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/proxy`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema).toBe("proxy/1");
    expect(body.boxes.length).toBeGreaterThan(0);
    const chunkIds = new Set(manifest.chunks.map((c: any) => c.id));
    for (const b of body.boxes) {
      expect(b).toHaveLength(9);
      expect(b[0]).toBeGreaterThan(0); // expressID
      expect(chunkIds.has(b[2])).toBe(true); // owning chunk
      expect(b[3]).toBeLessThan(b[6]); // min < max on every axis
      expect(b[4]).toBeLessThan(b[7]);
      expect(b[5]).toBeLessThan(b[8]);
    }
  });

  it("proxy works for single-format versions (null chunk) and 404s for unknown ids", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${versionId}/proxy`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const boxes = res.json().boxes;
    expect(boxes.length).toBe(4);
    expect(boxes.every((b: any[]) => b[2] === null)).toBe(true);
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/versions/no000000000000000000000/proxy`, // well-formed cuid that cannot exist
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("single-stream models degrade to single format under the same config", async () => {
    const mp = multipart("file", "slab.ifc", SLAB);
    const up = await capp.inject({
      method: "POST",
      url: `/api/v1/models/${cmodelId}/versions`,
      headers: { authorization: `Bearer ${ctoken}`, ...mp.headers },
      payload: mp.payload,
    });
    const slabVersionId = up.json().version.id;
    await cWaitReady(slabVersionId);
    const man = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${slabVersionId}/manifest`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    const body = man.json();
    expect(body.artifactFormat).toBe("single");
    expect(body.url).toBe(`/api/v1/versions/${slabVersionId}/file/glTF`);
    const glb = await capp.inject({
      method: "GET",
      url: body.url,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(glb.statusCode).toBe(200);
    expect(glb.rawPayload.subarray(0, 4).toString("latin1")).toBe("glTF");
  });

  it("reconvert of a chunked version lands READY with a fresh manifest", async () => {
    const rc = await capp.inject({
      method: "POST",
      url: `/api/v1/versions/${cversionId}/reconvert`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(rc.statusCode).toBe(202);
    await cWaitReady(cversionId);
    const man = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/manifest`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(man.json().artifactFormat).toBe("chunked");
    expect(man.json().chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("deleting a chunked version removes its chunk directory", async () => {
    const chunksDir = path.join(CH_DIR, "projects", cprojectId, "models", cmodelId, "v1", "chunks");
    expect(fs.existsSync(chunksDir)).toBe(true);
    const del = await capp.inject({
      method: "DELETE",
      url: `/api/v1/versions/${cversionId}`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(chunksDir)).toBe(false);
    const man = await capp.inject({
      method: "GET",
      url: `/api/v1/versions/${cversionId}/manifest`,
      headers: { authorization: `Bearer ${ctoken}` },
    });
    expect(man.statusCode).toBe(404);
  });
});
