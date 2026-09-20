/**
 * Conversion service with two interchangeable implementations:
 *  - worker pool (production): web-ifc WASM stays out of the API process
 *  - inline (tests / tiny deployments): runs in-process
 */
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { ConversionEngine } from "./engineRouting";
import type { NativeConversionClient } from "./nativeClient";

export interface ConversionJobInput {
  jobId: string;
  /** Target engine (ticket 09 routing); defaults to the in-process wasm pool. */
  engine?: ConversionEngine;
  inputPath: string;
  glbPath: string;
  metaPath: string;
  /** KHR_meshopt_compression on the GLB artifact (encoder absent => uncompressed). */
  meshopt?: boolean;
  /** Per-storey chunked output (ticket 05); absent keeps the single-file format. */
  chunking?: { maxTrianglesPerChunk: number };
}

export interface ConversionOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  stats?: { elements: number; triangles: number };
  schema?: string;
  /** Which engine actually produced the artifact. */
  engine?: ConversionEngine;
}

export interface ConversionService {
  submit(input: ConversionJobInput, onProgress?: (percent: number) => void): Promise<ConversionOutcome>;
  close(): Promise<void>;
}

interface PendingJob {
  task: ConversionJobInput;
  resolve: (v: ConversionOutcome) => void;
  onProgress?: (percent: number) => void;
}

class WorkerPoolConversionService implements ConversionService {
  private workers: Worker[] = [];
  private queues: PendingJob[][] = [];
  private inflight: Array<PendingJob | null> = [];

  constructor(size: number) {
    const workerPath = path.join(__dirname, "worker.js");
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath);
      this.queues.push([]);
      this.inflight.push(null);
      const slot = i;
      worker.on("message", (msg: { jobId?: string; type?: string; percent?: number } & ConversionOutcome) => {
        if (msg.type === "progress") {
          const job = this.inflight[slot];
          if (job?.onProgress && typeof msg.percent === "number") job.onProgress(msg.percent);
          return;
        }
        this.settle(slot, { ...msg, engine: "wasm" as const });
      });
      worker.on("error", (err) => {
        this.settle(slot, { ok: false, code: "WORKER_CRASH", message: err.message });
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          this.settle(slot, { ok: false, code: "WORKER_EXIT", message: `worker exited with code ${code}` });
        }
      });
      this.workers.push(worker);
    }
  }

  /** Resolve the in-flight job for a slot (if any) and pull the next queued one. */
  private settle(slot: number, outcome: ConversionOutcome): void {
    const job = this.inflight[slot];
    this.inflight[slot] = null;
    if (job) job.resolve(outcome);
    this.dispatch(slot);
  }

  private dispatch(slot: number): void {
    if (this.inflight[slot]) return; // worker busy
    const job = this.queues[slot].shift();
    if (!job) return;
    this.inflight[slot] = job;
    this.workers[slot].postMessage(job.task);
  }

  submit(input: ConversionJobInput, onProgress?: (percent: number) => void): Promise<ConversionOutcome> {
    let slot = 0;
    let min = Infinity;
    for (let i = 0; i < this.queues.length; i++) {
      const load = this.queues[i].length + (this.inflight[i] ? 1 : 0);
      if (load < min) {
        min = load;
        slot = i;
      }
    }
    return new Promise<ConversionOutcome>((resolve) => {
      this.queues[slot].push({ task: input, resolve, onProgress });
      this.dispatch(slot);
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

class InlineConversionService implements ConversionService {
  async submit(input: ConversionJobInput, onProgress?: (percent: number) => void): Promise<ConversionOutcome> {
    const { convertIfcFile } = await import("@openbim-hub/ifc");
    const fs = await import("node:fs");
    try {
      const meta = await convertIfcFile(input.inputPath, input.glbPath, { onProgress, meshopt: input.meshopt, chunking: input.chunking });
      fs.writeFileSync(input.metaPath, Buffer.from(JSON.stringify(meta)));
      return { ok: true, engine: "wasm", stats: meta.stats, schema: meta.schema };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { ok: false, code: e.code ?? "UNKNOWN", message: e.message };
    }
  }

  async close(): Promise<void> {}
}

/**
 * Engine router (ticket 09): native jobs go to the IfcOpenShell worker
 * container, everything else to the wasm delegate (pool or inline). A native
 * job with no configured worker FAILS — silently falling back to wasm mid-job
 * would mix two engines' geometry inside one model.
 */
class RoutingConversionService implements ConversionService {
  constructor(
    private readonly wasm: ConversionService,
    private readonly native: NativeConversionClient | null
  ) {}

  submit(input: ConversionJobInput, onProgress?: (percent: number) => void): Promise<ConversionOutcome> {
    if (input.engine === "native") {
      if (!this.native) {
        return Promise.resolve({
          ok: false,
          code: "NATIVE_UNAVAILABLE",
          message: "job routed to the native engine but no conversion worker is configured (set NATIVE_WORKER_URL)",
        });
      }
      return this.native.run(input, onProgress);
    }
    return this.wasm.submit(input, onProgress);
  }

  close(): Promise<void> {
    return this.wasm.close();
  }
}

export function createConversionService(
  mode: "worker" | "inline",
  concurrency: number,
  native: NativeConversionClient | null = null
): ConversionService {
  const wasm = mode === "worker" ? new WorkerPoolConversionService(concurrency) : new InlineConversionService();
  return new RoutingConversionService(wasm, native);
}
