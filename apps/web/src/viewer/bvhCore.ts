/**
 * BVH build/apply helpers for accelerated picking (ticket 07). The build half
 * runs off-thread (web worker) and the apply half on the main thread, but
 * both are plain three.js data plumbing so unit tests can drive the whole
 * serialize/deserialize pipeline in node.
 */

import * as THREE from "three";
import { MeshBVH, type SerializedBVH } from "three-mesh-bvh";

/** Wire-format of MeshBVH.serialize — structured-clone/transferable friendly. */
export interface BvhPayload {
  roots: ArrayBuffer[];
  index: Int32Array | Uint32Array | Uint16Array | null;
  indirectBuffer: Uint32Array | Uint16Array | null;
}

export interface BvhBuildRequest {
  id: number;
  position: Float32Array;
  index: Uint32Array | Uint16Array | null;
}

export type BvhBuildResponse = { id: number; payload: BvhPayload } | { id: number; error: string };

/** Build a BVH over raw geometry buffers and serialize it for transfer. */
export function buildSerializedBvh(
  position: Float32Array,
  index: Uint32Array | Uint16Array | null
): BvhPayload {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const bvh = new MeshBVH(geometry);
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
  geometry.dispose();
  return {
    roots: serialized.roots,
    index: serialized.index,
    indirectBuffer: serialized.indirectBuffer,
  };
}

/** Copy a payload so a cached original is never aliased by a live BVH. */
export function cloneBvhPayload(p: BvhPayload): BvhPayload {
  return {
    roots: p.roots.map((r) => r.slice(0)),
    index: p.index ? (p.index.slice() as typeof p.index) : null,
    indirectBuffer: p.indirectBuffer ? (p.indirectBuffer.slice() as typeof p.indirectBuffer) : null,
  };
}

/** Attach a serialized BVH to a matching geometry as its boundsTree. */
export function applySerializedBvh(payload: BvhPayload, geometry: THREE.BufferGeometry): void {
  // deserialize reads the buffers without keeping them when we pass a clone
  geometry.boundsTree = MeshBVH.deserialize(
    { version: 1, ...cloneBvhPayload(payload) } as unknown as SerializedBVH,
    geometry,
    { setIndex: false }
  );
}
