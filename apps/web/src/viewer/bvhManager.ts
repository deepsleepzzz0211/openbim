/**
 * Main-thread BVH lifecycle (ticket 07): builds acceleration structures
 * through an injectable transport (a worker in the browser, the synchronous
 * builder in tests), caches serialized results per chunk-bucket key so an
 * evicted-and-reloaded chunk never pays the build cost twice, and attaches
 * results to geometries only while they are still alive.
 */

import * as THREE from "three";
import { applySerializedBvh, type BvhPayload } from "./bvhCore";

export type BvhTransport = (position: Float32Array, index: Uint32Array | Uint16Array | null) => Promise<BvhPayload>;

export class BvhManager {
  private cache = new Map<string, BvhPayload>();
  private pending = new Map<string, Promise<BvhPayload>>();

  constructor(private transport: BvhTransport) {}

  /**
   * Ensure `geometry` has a boundsTree, building it at most once per key.
   * Returns false when the geometry is unusable (no position) or was gone
   * (`alive` returned false) by the time the build finished.
   */
  async ensure(key: string, geometry: THREE.BufferGeometry, alive: () => boolean): Promise<boolean> {
    if (geometry.boundsTree) return true;
    const position = geometry.getAttribute("position");
    if (!position) return false;
    const cached = this.cache.get(key);
    if (cached) {
      if (!alive()) return false;
      applySerializedBvh(cached, geometry);
      return true;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      const pos = new Float32Array(position.array as ArrayLike<number>);
      const indexAttribute = geometry.getIndex();
      const idx = indexAttribute
        ? indexAttribute.array instanceof Uint32Array
          ? new Uint32Array(indexAttribute.array)
          : new Uint16Array(indexAttribute.array)
        : null;
      pending = this.transport(pos, idx)
        .then((payload) => {
          this.cache.set(key, payload);
          return payload;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    const payload = await pending;
    if (!alive()) return false;
    applySerializedBvh(payload, geometry);
    return true;
  }

  /** Cache size in entries (diagnostics / tests). */
  get cachedKeys(): string[] {
    return [...this.cache.keys()];
  }

  /** Drop one cached structure (e.g. when a version is unloaded entirely). */
  drop(keyPrefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(keyPrefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
