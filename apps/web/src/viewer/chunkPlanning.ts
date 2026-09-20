/**
 * Pure decision logic for manifest-driven chunk loading (tickets 06 + 08):
 * which resident chunks an LRU byte budget should evict, given the set of
 * chunks the viewer currently wants on screen. Kept free of three.js so it
 * can be unit-tested without a browser.
 */

export interface ChunkResident {
  /** Unique per-chunk key (same identity as the manifest chunk). */
  key: string;
  /** Downloaded (or declared) GLB size in bytes. */
  bytes: number;
  /** Last time the chunk was needed/shown (ms timestamp). */
  touched: number;
  /** True when the chunk should currently show real geometry. */
  needed: boolean;
}

/** Default desktop resident-geometry budget; override via the viewer option. */
export const DEFAULT_MAX_RESIDENT_BYTES = 512 * 1024 * 1024;

/**
 * Keys to evict (least-recently-used first) until `residentBytes` fits under
 * `budget`. Only unneeded chunks are candidates: needed geometry is never
 * evicted, so an over-budget set of needed chunks comes back as-is.
 */
export function planEvictions(resident: ChunkResident[], residentBytes: number, budget: number): string[] {
  const out: string[] = [];
  let bytes = residentBytes;
  if (bytes <= budget) return out;
  const hidden = resident.filter((r) => !r.needed).sort((a, b) => a.touched - b.touched);
  for (const r of hidden) {
    if (bytes <= budget) break;
    out.push(r.key);
    bytes -= r.bytes;
  }
  return out;
}
