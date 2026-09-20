/**
 * Ticket 10 (API side): presplit shard pipeline.
 *  - pipeline semantics against a recording ConversionService: per-shard
 *    plan, failed-shard-only retry (partially-done shards are NOT re-run),
 *    shard-granular progress, intermediate cleanup after aggregation
 *  - end-to-end through the API in inline mode with a tiny threshold
 *  - config parsing (0 = disabled needs the non-negative path)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db";
import { LocalDiskBlobStore } from "../src/blobStore";
import { createConversionService, type ConversionOutcome, type ConversionService } from "../src/conversion";
import { runPresplitConversion, type PresplitPlan } from "../src/conversion/presplitPipeline";

const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "sample-building.ifc"));

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Delegates to a real service but records job ids and can fail chosen jobs. */
class RecordingService implements ConversionService {
  jobs: string[] = [];
  failJobs = new Set<string>();
  constructor(private readonly inner: ConversionService) {}
  async submit(
    input: Parameters<ConversionService["submit"]>[0],
    onProgress?: (percent: number) => void
  ): Promise<ConversionOutcome> {
    this.jobs.push(input.jobId);
    if (this.failJobs.has(input.jobId)) {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: false, code: "WORKER_CRASH", message: "kaboom" };
    }
    return this.inner.submit(input, onProgress);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("runPresplitConversion (pipeline semantics)", () => {
  let dir: string;
  let inputPath: string;
  let baseDir: string;
  let inner: ConversionService;

  beforeAll(() => {
    dir = tmpDir("obh-presplit-api-");
    inputPath = path.join(dir, "source.ifc");
    fs.writeFileSync(inputPath, SAMPLE);
    baseDir = path.join(dir, "artifacts");
    inner = createConversionService("inline", 1, null);
  });

  afterAll(async () => {
    await inner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const req = (onProgress: (p: number, s: { done: number; total: number }) => void) => ({
    versionId: "v1",
    inputPath,
    baseDir,
    meshopt: false,
    onProgress,
  });

  it("fails on a shard error, keeps completed shards in the plan; the retry re-runs only the failed shard", async () => {
    const events: Array<{ percent: number; done: number; total: number }> = [];
    const svc1 = new RecordingService(inner);
    svc1.failJobs.add("v1:shard:1");

    const out1 = await runPresplitConversion(svc1, req((p, s) => events.push({ percent: p, ...s })));
    expect(out1).toMatchObject({ ok: false, code: "WORKER_CRASH" });
    expect(svc1.jobs.sort()).toEqual(["v1:shard:0", "v1:shard:1"]);

    // the sample has 2 storeys -> 2 shards; shard 0 kept its real artifact
    const plan = JSON.parse(fs.readFileSync(path.join(baseDir, "presplit", "plan.json"), "utf8")) as PresplitPlan;
    expect(plan.versionId).toBe("v1");
    expect(plan.shards.map((s) => [s.index, s.status])).toEqual([
      [0, "DONE"],
      [1, "FAILED"],
    ]);
    expect(fs.existsSync(path.join(baseDir, "presplit", "shard-0", "meta.json"))).toBe(true);
    // progress events carry shard granularity
    expect(events.some((e) => e.total === 2 && e.done === 1)).toBe(true);
    const percents = events.map((e) => e.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents); // monotonic

    // "restart" attempt: a fresh service must NOT reconvert the DONE shard
    const svc2 = new RecordingService(inner);
    const out2 = await runPresplitConversion(svc2, req(() => {}));
    expect(out2).toMatchObject({ ok: true, engine: "wasm" });
    expect(svc2.jobs).toEqual(["v1:shard:1"]);
    expect(out2.stats).toEqual({ elements: 4, triangles: out2.stats!.triangles });

    // merged artifact contract + intermediates reclaimed
    const meta = JSON.parse(fs.readFileSync(path.join(baseDir, "meta.json"), "utf8"));
    expect(meta.artifactFormat).toBe("chunked"); // two shard chunks
    expect(meta.chunks.map((c: { id: number }) => c.id)).toEqual([0, 1]);
    expect(meta.stats).toEqual({ elements: 4, triangles: meta.stats.triangles });
    expect(fs.existsSync(path.join(baseDir, "chunks", "0.glb"))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "chunks", "1.glb"))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "presplit"))).toBe(false);
  });

  it("re-running on a fully converted baseDir produces the same artifact again (plan rebuilt)", async () => {
    const svc = new RecordingService(inner);
    const out = await runPresplitConversion(svc, req(() => {}));
    expect(out.ok).toBe(true);
    expect(svc.jobs.length).toBe(2); // no plan left after success: full re-slice
    const meta = JSON.parse(fs.readFileSync(path.join(baseDir, "meta.json"), "utf8"));
    expect(meta.stats.triangles).toBeGreaterThan(0);
  });
});

describe("presplit pipeline through the API (inline, tiny threshold)", () => {
  const DATA_DIR = path.join(__dirname, "tmp-data-presplit");
  const DB_URL = `file:${path.join(DATA_DIR, "test.db").replace(/\\/g, "/")}`;
  let app: FastifyInstance;
  let token = "";
  let modelId = "";

  async function inject(method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }

  async function upload(filename: string) {
    const boundary = "----openbimpresplit" + Date.now() + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const body = Buffer.concat([head, SAMPLE, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await inject("POST", `/api/v1/models/${modelId}/versions`, body, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.statusCode).toBe(202);
    return res.json().version.id as string;
  }

  async function waitFor(versionId: string, timeoutMs = 60000) {
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
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      JWT_SECRET: "test-secret",
      CONVERSION_MODE: "inline",
      PRESPLIT_THRESHOLD_BYTES: "1024", // every 5 KB sample upload takes the shard pipeline
    });
    const db = createDb(config.databaseUrl);
    const blobs = new LocalDiskBlobStore(config.dataDir);
    const conversion = createConversionService("inline", 2, null);
    app = await buildApp({ config, db, blobs, conversion, logger: false });

    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "presplit@test.local", name: "Pre", password: "password123" },
    });
    token = reg.json().accessToken;
    const p = await inject("POST", "/api/v1/projects", { name: "PS", key: "presplit" });
    expect(p.statusCode, `create project: ${p.body}`).toBe(201);
    modelId = (await inject("POST", `/api/v1/projects/${p.json().project.id}/models`, { name: "M" })).json().model.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("uploads, shards, imports the element index and reaches READY", async () => {
    const shardEvents: Array<{ status: string; progress?: number; shards?: { done: number; total: number } }> = [];
    const listener = (e: { status: string; progress?: number; shards?: { done: number; total: number } }) => {
      shardEvents.push(e);
    };
    app.events.on("version", listener as never);
    try {
      const versionId = await upload("presplit.ifc");
      const v = await waitFor(versionId);
      expect(v.status).toBe("READY");
      expect(v.engine).toBe("wasm");

      // shard-granular progress reached the SSE channel
      const withShards = shardEvents.filter((e) => e.shards);
      expect(withShards.length).toBeGreaterThan(0);
      expect(withShards.some((e) => e.shards!.total === 2 && e.shards!.done >= 1)).toBe(true);

      // element index imported from the merged meta.json
      expect(await app.db.element.count({ where: { versionId } })).toBe(4);

      // version dir holds the merged contract artifact, no intermediates
      const base = path.join(DATA_DIR, v.storageKey as string);
      const meta = JSON.parse(fs.readFileSync(path.join(base, "meta.json"), "utf8"));
      expect(meta.artifactFormat).toBe("chunked");
      expect(fs.existsSync(path.join(base, "chunks", "0.glb"))).toBe(true);
      expect(fs.existsSync(path.join(base, "presplit"))).toBe(false);
    } finally {
      app.events.off("version", listener as never);
    }
  });
});

describe("presplitThresholdBytes config", () => {
  it("defaults to 512 MiB, accepts 0 (disabled), falls back on garbage", () => {
    expect(loadConfig({}).presplitThresholdBytes).toBe(512 * 1024 * 1024);
    expect(loadConfig({ PRESPLIT_THRESHOLD_BYTES: "0" }).presplitThresholdBytes).toBe(0);
    expect(loadConfig({ PRESPLIT_THRESHOLD_BYTES: "-5" }).presplitThresholdBytes).toBe(512 * 1024 * 1024);
    expect(loadConfig({ PRESPLIT_THRESHOLD_BYTES: "abc" }).presplitThresholdBytes).toBe(512 * 1024 * 1024);
  });
});

describe("no-worker fallback also engages presplit (review fix: T09 gap)", () => {
  const DATA_DIR = path.join(__dirname, "tmp-data-fallback");
  const DB_URL = `file:${path.join(DATA_DIR, "test.db").replace(/\\/g, "/")}`;
  let app: FastifyInstance;
  let token = "";
  let modelId = "";

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
      NATIVE_THRESHOLD_BYTES: "1024", // sample (5 KB) exceeds the wasm-safety threshold...
      PRESPLIT_THRESHOLD_BYTES: String(100 * 1024 * 1024), // ...but is far below the presplit one
    });
    const db = createDb(config.databaseUrl);
    const blobs = new LocalDiskBlobStore(config.dataDir);
    const conversion = createConversionService("inline", 2, null);
    app = await buildApp({ config, db, blobs, conversion, logger: false });
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "fallback@test.local", name: "FB", password: "password123" },
    });
    token = reg.json().accessToken;
    const p = await inject("POST", "/api/v1/projects", { name: "FB", key: "fallback" });
    modelId = (await inject("POST", `/api/v1/projects/${p.json().project.id}/models`, { name: "M" })).json().model.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function inject(method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }

  it("runs the shard pipeline for over-threshold sources when no native worker is configured", async () => {
    const shardEvents: Array<{ shards?: { done: number; total: number } }> = [];
    const listener = (e: { shards?: { done: number; total: number } }) => shardEvents.push(e);
    app.events.on("version", listener as never);
    try {
      const boundary = "----openbimfallback" + Date.now();
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fb.ifc"\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const body = Buffer.concat([head, SAMPLE, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const res = await app.inject({
        method: "POST" as never,
        url: `/api/v1/models/${modelId}/versions`,
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body as never,
      });
      expect(res.statusCode).toBe(202);
      const versionId = res.json().version.id as string;
      let v: { status: string; storageKey?: string };
      for (;;) {
        v = (await inject("GET", `/api/v1/versions/${versionId}`)).json().version;
        if (v.status === "READY" || v.status === "FAILED") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(v.status).toBe("READY");
      expect(v.engine).toBe("wasm"); // degraded route
      expect(shardEvents.some((e) => e.shards)).toBe(true); // shard pipeline ran despite big threshold
      const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, v.storageKey!, "meta.json"), "utf8"));
      expect(meta.artifactFormat).toBe("chunked");
    } finally {
      app.events.off("version", listener as never);
    }
  });
});
