/**
 * Pure decision logic for the AABB proxy LOD layer (ticket 08): parsing the
 * server proxy tuples, measuring camera-to-box distance, deciding which
 * chunks the auto-LOD radius pulls in, and matching screen-space box rects
 * for proxy-level box selection. No three.js imports so it unit-tests in node.
 */

import type { NdcRect } from "./picking";

export type { NdcRect };

export interface ProxyBox {
  versionId: string;
  expressID: number;
  storeyGuid: string | null;
  chunkId: number | null;
  min: [number, number, number];
  max: [number, number, number];
}

/** [expressID, storeyGuid, chunkId, minX, minY, minZ, maxX, maxY, maxZ] */
export type ProxyTuple = [number, string | null, number | null, number, number, number, number, number, number];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Defensive parse of the proxy/1 payload; malformed rows render no box. */
export function parseProxyBoxes(versionId: string, tuples: readonly unknown[]): ProxyBox[] {
  const out: ProxyBox[] = [];
  for (const t of tuples) {
    if (!Array.isArray(t) || t.length !== 9) continue;
    const [expressID, storeyGuid, chunkId, a, b, c, d, e, f] = t as ProxyTuple;
    if (!isNum(expressID) || expressID < 1) continue;
    if (![a, b, c, d, e, f].every(isNum)) continue;
    if (storeyGuid !== null && typeof storeyGuid !== "string") continue;
    if (chunkId !== null && !(isNum(chunkId) && Number.isInteger(chunkId))) continue;
    out.push({
      versionId,
      expressID,
      storeyGuid,
      chunkId,
      min: [Math.min(a, d), Math.min(b, e), Math.min(c, f)],
      max: [Math.max(a, d), Math.max(b, e), Math.max(c, f)],
    });
  }
  return out;
}

/** Distance from a point to an AABB (0 when inside). */
export function pointBoxDistance(
  p: { x: number; y: number; z: number },
  min: [number, number, number],
  max: [number, number, number]
): number {
  const dx = Math.max(min[0] - p.x, 0, p.x - max[0]);
  const dy = Math.max(min[1] - p.y, 0, p.y - max[1]);
  const dz = Math.max(min[2] - p.z, 0, p.z - max[2]);
  return Math.hypot(dx, dy, dz);
}

/** A chunk as the LOD planner needs it (bbox comes from the ticket 05 manifest;
 *  offset is the version's scene-group position, since bboxes are GLB-local). */
export interface LodChunk {
  key: string;
  storeyKey: string;
  bbox: [number, number, number, number, number, number];
  offset?: [number, number, number];
}

/**
 * Auto-LOD: of the user-visible storeys, which chunks are close enough to the
 * camera to deserve real geometry? Everything else stays on the proxy layer.
 */
export function planLodLoads(
  chunks: Iterable<LodChunk>,
  camera: { x: number; y: number; z: number },
  nearDistance: number,
  visibleStoreyKeys: Set<string>
): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    if (!visibleStoreyKeys.has(c.storeyKey)) continue;
    const [x0, y0, z0, x1, y1, z1] = c.bbox;
    const off = c.offset ?? [0, 0, 0];
    const p = { x: camera.x - off[0], y: camera.y - off[1], z: camera.z - off[2] };
    if (pointBoxDistance(p, [x0, y0, z0], [x1, y1, z1]) <= nearDistance) out.push(c.key);
  }
  return out;
}

/** Auto-LOD radius for a model of the given diagonal size: distant wings
 *  stay as boxes while the close core loads real geometry. */
export function lodNearDistance(modelDiagonal: number): number {
  return Math.max(40, modelDiagonal * 0.4);
}

/** Screen-space bounds of one proxy box after projection (null = fully behind). */
export interface NdcBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Project the box corners and take the 2D hull; `project` returns null for
 *  points clipped behind the camera. */
export function ndcBoxOfBox(
  box: { min: [number, number, number]; max: [number, number, number] },
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null
): NdcBox | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let seen = 0;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const p = project({ x, y, z });
        if (!p) continue;
        seen++;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  return seen > 0 ? { minX, minY, maxX, maxY } : null;
}

/** Indices of boxes whose projected rect overlaps the selection rect. */
export function proxyBoxesInRect(boxes: ReadonlyArray<NdcBox | null>, rect: NdcRect): number[] {
  const out: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    if (b.maxX < rect.minX || b.minX > rect.maxX || b.maxY < rect.minY || b.minY > rect.maxY) continue;
    out.push(i);
  }
  return out;
}
