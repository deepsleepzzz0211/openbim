/**
 * HTTP client for the native IfcOpenShell conversion worker container
 * (ticket 09). The container is a separate process (LGPL boundary) sharing
 * the blob volume with the API, so jobs exchange only paths, never bytes.
 *
 * Protocol (implemented by docker/ifcopenshell-worker):
 *   POST /convert  {job_id, input_path, glb_path, meta_path, chunking?} -> 202 {job_id}
 *   GET  /jobs/{id} -> {status:"running", percent}
 *                    | {status:"done", stats, schema}
 *                    | {status:"failed", code, message}
 *   unknown job id -> 404 (worker restarted: the job is gone)
 */
import type { ConversionOutcome } from "./index";

export interface NativeJobSpec {
  jobId: string;
  inputPath: string;
  glbPath: string;
  metaPath: string;
  chunking?: { maxTrianglesPerChunk: number };
}

export interface NativeClientOptions {
  baseUrl: string;
  /** optional shared secret sent as `Authorization: Bearer` (WORKER_TOKEN) */
  token?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NativeConversionClient {
  constructor(private readonly opts: NativeClientOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  async run(spec: NativeJobSpec, onProgress?: (percent: number) => void): Promise<ConversionOutcome> {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const pollMs = this.opts.pollIntervalMs ?? 1000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 4 * 60 * 60 * 1000);

    try {
      const res = await fetch(`${base}/convert`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          job_id: spec.jobId,
          input_path: spec.inputPath,
          glb_path: spec.glbPath,
          meta_path: spec.metaPath,
          ...(spec.chunking ? { chunking: spec.chunking } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, code: "NATIVE_UNAVAILABLE", message: `POST /convert -> ${res.status} ${text}`.trim() };
      }
    } catch (err) {
      return { ok: false, code: "NATIVE_UNAVAILABLE", message: `native worker unreachable: ${(err as Error).message}` };
    }

    let consecutiveErrors = 0;
    let lastPercent = -1;
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, code: "NATIVE_TIMEOUT", message: `job ${spec.jobId} exceeded the native conversion budget` };
      }
      await sleep(pollMs);
      let res: Response;
      try {
        res = await fetch(`${base}/jobs/${encodeURIComponent(spec.jobId)}`, { headers: this.headers() });
      } catch (err) {
        // transient unavailability is tolerated; the container must die 3 polls in a row
        if (++consecutiveErrors >= 3) {
          return { ok: false, code: "NATIVE_UNAVAILABLE", message: `native worker lost during job: ${(err as Error).message}` };
        }
        continue;
      }
      if (res.status === 404) {
        return { ok: false, code: "NATIVE_JOB_LOST", message: `native worker restarted; job ${spec.jobId} is gone` };
      }
      if (!res.ok) {
        if (++consecutiveErrors >= 3) {
          return { ok: false, code: "NATIVE_UNAVAILABLE", message: `GET /jobs -> ${res.status}` };
        }
        continue;
      }
      consecutiveErrors = 0;
      const job = (await res.json()) as {
        status: "running" | "done" | "failed";
        percent?: number;
        stats?: { elements: number; triangles: number };
        schema?: string;
        code?: string;
        message?: string;
      };
      if (job.status === "running") {
        const pct = Math.max(0, Math.min(99, job.percent ?? 0));
        if (pct > lastPercent) {
          lastPercent = pct;
          onProgress?.(pct);
        }
        continue;
      }
      if (job.status === "done") {
        onProgress?.(100);
        return { ok: true, engine: "native", stats: job.stats, schema: job.schema };
      }
      return { ok: false, code: job.code ?? "NATIVE_FAILED", message: job.message };
    }
  }
}
