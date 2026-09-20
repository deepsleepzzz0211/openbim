/// <reference lib="webworker" />
/**
 * Off-thread BVH builder (ticket 07): receives raw position/index buffers for
 * one bucket geometry, returns the serialized structure transferable. Keeps
 * the interaction thread free while chunks stream in.
 */

import { buildSerializedBvh, type BvhBuildRequest, type BvhBuildResponse } from "./bvhCore";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BvhBuildRequest>) => void) | null;
  postMessage(message: BvhBuildResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (e: MessageEvent<BvhBuildRequest>): void => {
  const { id, position, index } = e.data;
  try {
    const payload = buildSerializedBvh(position, index);
    const transfer: Transferable[] = [...payload.roots];
    if (payload.index) transfer.push(payload.index.buffer);
    if (payload.indirectBuffer) transfer.push(payload.indirectBuffer.buffer);
    ctx.postMessage({ id, payload }, transfer);
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error).message });
  }
};
