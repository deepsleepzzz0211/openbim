/**
 * Conversion worker thread: owns the web-ifc WASM instance, isolated from the
 * API process. Protocol (parentPort messages):
 *   -> { jobId, inputPath, glbPath, metaPath }
 *   <- { type: "progress", jobId, percent }
 *   <- { jobId, ok: true, stats, schema } | { jobId, ok: false, code, message }
 */
import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";

export interface ConvertTask {
  jobId: string;
  inputPath: string;
  glbPath: string;
  metaPath: string;
  meshopt?: boolean;
  chunking?: { maxTrianglesPerChunk: number };
}

export interface ConvertResult {
  jobId: string;
  ok: boolean;
  code?: string;
  message?: string;
  stats?: { elements: number; triangles: number };
  schema?: string;
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error("must run as a worker thread");
  const { convertIfcFile } = await import("@openbim-hub/ifc");

  parentPort.on("message", async (task: ConvertTask) => {
    try {
      const meta = await convertIfcFile(task.inputPath, task.glbPath, {
        meshopt: task.meshopt,
        chunking: task.chunking,
        onProgress: (percent) => {
          parentPort!.postMessage({ type: "progress", jobId: task.jobId, percent });
        },
      });
      fs.writeFileSync(task.metaPath, Buffer.from(JSON.stringify(meta)));
      parentPort!.postMessage({
        jobId: task.jobId,
        ok: true,
        stats: meta.stats,
        schema: meta.schema,
      } satisfies ConvertResult);
    } catch (err) {
      const e = err as Error & { code?: string };
      parentPort!.postMessage({
        jobId: task.jobId,
        ok: false,
        code: e.code ?? "UNKNOWN",
        message: e.message,
      } satisfies ConvertResult);
    }
  });
}

void main();
