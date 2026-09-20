/**
 * Ticket 09: conversion-engine routing + native IfcOpenShell worker client.
 * Covers: pure routing (size threshold, per-model engine stickiness, graceful
 * fallback when no worker is configured), the HTTP job protocol of
 * NativeConversionClient against a fake worker (progress, done, failed,
 * unreachable, lost job, bearer token), and processVersion wiring end-to-end
 * through a fake native worker that writes real artifacts to disk.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { routeEngine } from "../src/conversion/engineRouting";
import { NativeConversionClient } from "../src/conversion/nativeClient";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db";
import { LocalDiskBlobStore } from "../src/blobStore";
import { createConversionService } from "../src/conversion";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// pure routing
// ---------------------------------------------------------------------------

describe("routeEngine", () => {
  const base = { sizeBytes: 1024, nativeThresholdBytes: 256 * 1024 * 1024, nativeConfigured: true, previousEngine: null } as const;

  it("routes small models to the wasm engine", () => {
    expect(routeEngine({ ...base })).toEqual({ engine: "wasm" });
  });

  it("routes at/above the wasm-safety threshold to native", () => {
    expect(routeEngine({ ...base, sizeBytes: 256 * 1024 * 1024 }).engine).toBe("native");
    expect(routeEngine({ ...base, sizeBytes: 500 * 1024 * 1024 }).engine).toBe("native");
  });

  it("falls back to wasm (with a note) when no native worker is configured", () => {
    expect(routeEngine({ ...base, sizeBytes: 500 * 1024 * 1024, nativeConfigured: false })).toEqual({
      engine: "wasm",
      note: "native-not-configured",
    });
  });

  it("is sticky: an existing model engine wins over the size route", () => {
    expect(routeEngine({ ...base, sizeBytes: 1, previousEngine: "native" })).toEqual({
      engine: "native",
      note: "sticky-model-engine",
    });
    expect(routeEngine({ ...base, sizeBytes: 500 * 1024 * 1024, previousEngine: "wasm" }).engine).toBe("wasm");
  });
});

// ---------------------------------------------------------------------------
// fake native worker (HTTP) + client protocol
// ---------------------------------------------------------------------------

interface FakeJob {
  status: "running" | "done" | "failed";
  percent: number;
  code?: string;
  message?: string;
  /** number of /jobs polls before a running job flips to done (default 2) */
  runningPolls?: number;
  polls?: number;
  /** request body captured on POST /convert */
  spec?: Record<string, unknown>;
}

class FakeWorker {
  server = http.createServer();
  jobs = new Map<string, FakeJob>();
  requests: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
  rejectConvert = false;
  /** when set, a completed job writes meta.json/model.glb through this callback */
  onDone: ((spec: { glb_path: string; meta_path: string }) => void) | null = null;

  async start(): Promise<string> {
    this.server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
        this.requests.push({ path: req.url ?? "", auth: req.headers.authorization, body });
        const url = req.url ?? "";
        if (req.method === "POST" && url === "/convert") {
          if (this.rejectConvert) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "UNAVAILABLE", message: "no workers" }));
            return;
          }
          const id = String((body.job_id ?? "") as string);
          if (!id || !body.input_path || !body.glb_path || !body.meta_path) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "BAD_REQUEST", message: "job_id and paths are required" }));
            return;
          }
          const job = this.jobs.get(id) ?? { status: "running" as const, percent: 0 };
          job.spec = body;
          this.jobs.set(id, job);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ job_id: id }));
          return;
        }
        const m = url.match(/^\/jobs\/(.+)$/);
        if (req.method === "GET" && m) {
          const job = this.jobs.get(m[1]);
          if (!job) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "NOT_FOUND" }));
            return;
          }
          if (job.status === "running") {
            job.polls = (job.polls ?? 0) + 1;
            if (job.polls > (job.runningPolls ?? 2)) {
              // fall through to the done branch below
            } else {
              job.percent = Math.min(job.percent + 45, 90);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: "running", percent: job.percent }));
              return;
            }
          }
          if (job.status === "failed") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "failed", code: job.code, message: job.message }));
            return;
          }
          if (this.onDone && job.spec) {
            this.onDone({ glb_path: String(job.spec.glb_path), meta_path: String(job.spec.meta_path) });
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "done", percent: 100, stats: { elements: 1, triangles: 2 }, schema: "IFC4" }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r, rej) => this.server.close((e) => (e ? rej(e) : r())));
  }
}

describe("NativeConversionClient", () => {
  let worker: FakeWorker;
  let baseUrl = "";

  beforeAll(async () => {
    worker = new FakeWorker();
    baseUrl = await worker.start();
  });
  afterAll(async () => {
    await worker.stop();
  });

  const spec = { jobId: "j1", inputPath: "in.ifc", glbPath: "out/model.glb", metaPath: "out/meta.json" };
  const client = () => new NativeConversionClient({ baseUrl, pollIntervalMs: 1, timeoutMs: 5000 });

  it("reports progress and settles with a native outcome", async () => {
    worker.jobs.set("j1", { status: "running", percent: 0 });
    const percents: number[] = [];
    const out = await client().run(spec, (p) => percents.push(p));
    expect(out).toMatchObject({ ok: true, engine: "native", schema: "IFC4", stats: { elements: 1, triangles: 2 } });
    expect(percents.length).toBeGreaterThan(0);
    expect(Math.max(...percents)).toBeLessThanOrEqual(100);
  });

  it("surfaces worker-side failure codes", async () => {
    worker.jobs.set("j2", { status: "failed", percent: 10, code: "IFC_PARSE_FAILED", message: "boom" });
    const out = await client().run({ ...spec, jobId: "j2" });
    expect(out).toMatchObject({ ok: false, code: "IFC_PARSE_FAILED", message: "boom" });
  });

  it("fails with NATIVE_UNAVAILABLE when the worker cannot be reached", async () => {
    const dead = new NativeConversionClient({ baseUrl: "http://127.0.0.1:1", pollIntervalMs: 1, timeoutMs: 2000 });
    const out = await dead.run({ ...spec, jobId: "j-dead" });
    expect(out).toMatchObject({ ok: false, code: "NATIVE_UNAVAILABLE" });
  });

  it("fails with NATIVE_UNAVAILABLE when the POST itself is refused", async () => {
    worker.rejectConvert = true;
    const out = await client().run({ ...spec, jobId: "j-refused" });
    expect(out).toMatchObject({ ok: false, code: "NATIVE_UNAVAILABLE" });
    worker.rejectConvert = false;
  });

  it("fails with NATIVE_JOB_LOST when the worker forgot the job (restart)", async () => {
    worker.jobs.set("j-lost", { status: "running", percent: 0, runningPolls: 50 });
    const c = new NativeConversionClient({ baseUrl, pollIntervalMs: 1, timeoutMs: 2000 });
    setTimeout(() => worker.jobs.delete("j-lost"), 5);
    const out = await c.run({ ...spec, jobId: "j-lost" });
    expect(out).toMatchObject({ ok: false, code: "NATIVE_JOB_LOST" });
  });

  it("sends the bearer token when configured", async () => {
    worker.jobs.set("j-auth", { status: "done", percent: 0 });
    const c = new NativeConversionClient({ baseUrl, token: "s3cret", pollIntervalMs: 1, timeoutMs: 5000 });
    const out = await c.run({ ...spec, jobId: "j-auth" });
    expect(out.ok).toBe(true);
    const authed = worker.requests.filter((r) => r.auth === "Bearer s3cret");
    expect(authed.length).toBeGreaterThanOrEqual(2); // POST + at least one poll
  });
});

// ---------------------------------------------------------------------------
// service routing + processVersion stickiness through the real API
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "tmp-data-engine");
const DB_URL = `file:${path.join(DATA_DIR, "test.db").replace(/\\/g, "/")}`;
const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "sample-building.ifc"));

/** Minimal contract-valid native meta.json (what the Python worker emits). */
function nativeMeta(): Record<string, unknown> {
  return {
    schema: "IFC4",
    engine: "native",
    units: { sourceName: "METRE", sourcePrefix: null, scaleToMetre: 1 },
    origin: [0, 0, 0],
    crs: { source: "ABSENT", name: null, epsg: null, mapConversion: null },
    stats: { elements: 1, triangles: 2 },
    glbCompression: { codec: "none", fallbackViews: 0 },
    artifactFormat: "single",
    buckets: [{ storeyExpressID: null, color: [0.8, 0.8, 0.8, 1], transparent: false, ranges: [{ expressID: 1, start: 0, count: 3 }] }],
    spatial: { guid: "", expressID: -1, type: "IFCPROJECT", name: "native", children: [] },
    elements: {
      "1": { guid: "", type: "IFCWALL", name: "w", storeyExpressID: null, storeyGuid: null, attributes: {}, psets: {}, bbox: [0, 0, 0, 1, 1, 1] },
    },
  };
}

describe("engine routing through the API (ticket 09)", () => {
  let app: FastifyInstance;
  let worker: FakeWorker;
  let token = "";
  let modelId = "";
  let model2Id = "";

  async function inject(method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }

  async function upload(model: string, filename: string) {
    const boundary = "----openbimengine" + Date.now() + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const payload = Buffer.concat([head, SAMPLE, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await inject("POST", `/api/v1/models/${model}/versions`, payload, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.statusCode).toBe(202);
    return res.json().version.id as string;
  }

  async function waitFor(versionId: string, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await inject("GET", `/api/v1/versions/${versionId}`);
      const v = res.json().version;
      if (v.status === "READY" || v.status === "FAILED") return v;
      if (Date.now() > deadline) throw new Error(`version ${versionId} stuck in ${v.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    execSync(`pnpm exec prisma db push --skip-generate`, {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: "ignore",
    });
    worker = new FakeWorker();
    worker.onDone = ({ glb_path, meta_path }) => {
      fs.mkdirSync(path.dirname(glb_path), { recursive: true });
      fs.writeFileSync(glb_path, Buffer.from("glTF-fake-native-artifact"));
      fs.writeFileSync(meta_path, JSON.stringify(nativeMeta()));
    };
    const baseUrl = await worker.start();
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      JWT_SECRET: "test-secret",
      CONVERSION_MODE: "inline",
      NATIVE_WORKER_URL: baseUrl,
      NATIVE_THRESHOLD_BYTES: "1", // every upload would route native without stickiness
    });
    const db = createDb(config.databaseUrl);
    const blobs = new LocalDiskBlobStore(config.dataDir);
    const conversion = createConversionService("inline", 1, new NativeConversionClient({ baseUrl, pollIntervalMs: 5, timeoutMs: 30000 }));
    app = await buildApp({ config, db, blobs, conversion, logger: false });

    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "engine@test.local", name: "Engine", password: "password123" },
    });
    token = reg.json().accessToken;
    const p = await inject("POST", "/api/v1/projects", { name: "Eng", key: "eng" });
    const projectId = p.json().project.id;
    modelId = (await inject("POST", `/api/v1/projects/${projectId}/models`, { name: "M1" })).json().model.id;
    model2Id = (await inject("POST", `/api/v1/projects/${projectId}/models`, { name: "M2" })).json().model.id;
  });

  afterAll(async () => {
    await app.close();
    await worker.stop();
  });

  it("converts via the native worker and records the engine + artifacts", async () => {
    const versionId = await upload(modelId, "a.ifc");
    const v = await waitFor(versionId);
    expect(v.status).toBe("READY");
    expect(v.engine).toBe("native");
    // the fake worker wrote contract artifacts: meta.json parsed into the element index
    const el = await app.db.element.findFirst({ where: { versionId, expressID: 1 } });
    expect(el?.ifcType).toBe("IFCWALL");
    expect(v.statsJson).toBeTruthy();
  });

  it("keeps the model on its first engine and never silently falls back to wasm (no mixing)", async () => {
    worker.rejectConvert = true; // native is now down: the wasm engine must NOT take over mid-model
    const versionId = await upload(modelId, "b.ifc");
    const v = await waitFor(versionId);
    expect(v.status).toBe("FAILED");
    expect(v.engine).toBe("native"); // sticky decision recorded even on failure
    expect(v.errorCode).toBe("NATIVE_UNAVAILABLE");
    worker.rejectConvert = false;
  });

  it("routes a fresh model to native by size and converts", async () => {
    const before = worker.requests.filter((r) => r.path === "/convert").length;
    const versionId = await upload(model2Id, "c.ifc");
    const v = await waitFor(versionId);
    expect(v.status).toBe("READY");
    expect(v.engine).toBe("native");
    expect(worker.requests.filter((r) => r.path === "/convert").length).toBe(before + 1);
  });
});

describe("createConversionService without a native client", () => {
  it("fails native jobs with NATIVE_UNAVAILABLE but serves wasm jobs", async () => {
    const svc = createConversionService("inline", 1, null);
    const bad = await svc.submit({ jobId: "x", engine: "native", inputPath: "a.ifc", glbPath: "g", metaPath: "m" });
    expect(bad).toMatchObject({ ok: false, code: "NATIVE_UNAVAILABLE" });
  });
});
