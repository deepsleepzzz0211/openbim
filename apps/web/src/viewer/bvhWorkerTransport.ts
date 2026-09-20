/**
 * Worker-backed BvhManager transport (ticket 07). The worker is created
 * lazily on the first build; requests are correlated by id and the raw
 * geometry buffers are transferred, not copied.
 */

import type { BvhTransport } from "./bvhManager";
import type { BvhBuildRequest, BvhBuildResponse, BvhPayload } from "./bvhCore";

export interface BvhWorkerHandle {
  transport: BvhTransport;
  dispose(): void;
}

export function createBvhWorkerTransport(): BvhWorkerHandle {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: BvhPayload) => void; reject: (e: Error) => void }>();

  function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL("./bvh.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<BvhBuildResponse>) => {
      const { id } = e.data;
      const slot = pending.get(id);
      if (!slot) return;
      pending.delete(id);
      if ("error" in e.data) slot.reject(new Error(e.data.error));
      else slot.resolve(e.data.payload);
    };
    worker.onerror = (e) => {
      for (const slot of pending.values()) slot.reject(new Error(e.message || "BVH worker error"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  }

  return {
    transport: (position, index) =>
      new Promise<BvhPayload>((resolve, reject) => {
        const w = ensureWorker();
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: BvhBuildRequest = { id, position, index };
        const transfer: Transferable[] = [position.buffer];
        if (index) transfer.push(index.buffer);
        w.postMessage(request, transfer);
      }),
    dispose(): void {
      for (const slot of pending.values()) slot.reject(new Error("viewer disposed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    },
  };
}
