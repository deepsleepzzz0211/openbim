/**
 * Pure decision logic for accelerated picking (ticket 07): mapping a hit
 * triangle back to its element through the per-bucket range table, deciding
 * whether a hit is actually pickable (storey visible + outside every section
 * cut), and sampling screen rays for box selection. Kept free of live scene
 * objects so it can be unit-tested without a browser.
 */

import * as THREE from "three";

export interface PickRange {
  expressID: number;
  /** First index (not triangle) of this element inside the bucket buffer. */
  start: number;
  /** Number of indices (a multiple of 3); the element owns triangles [start/3, (start+count)/3). */
  count: number;
}

/**
 * Binary search the ascending triangle-range table for the element owning a
 * face (triangles are contiguous per element inside a bucket buffer).
 */
export function elementAt(ranges: readonly PickRange[], faceIndex: number): number | null {
  const indexPos = faceIndex * 3;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (indexPos < range.start) hi = mid - 1;
    else if (indexPos >= range.start + range.count) lo = mid + 1;
    else return range.expressID;
  }
  return null;
}

/** A point survives the section boxes when every clipping plane keeps it. */
export function pointInSection(point: THREE.Vector3Like, planes: readonly THREE.Plane[]): boolean {
  for (const plane of planes) {
    if (plane.distanceToPoint(point as THREE.Vector3) < 0) return false;
  }
  return true;
}

/** What a raycast hit must satisfy to be selectable. */
export interface HitGate {
  /** Mesh.visible — hidden storeys must never be picked. */
  meshVisible: boolean;
  /** The storey key of the hit mesh is in the current visibility set. */
  storeyVisible: boolean;
  /** Hit point vs. active section planes. */
  inSection: boolean;
}

export function hitAccepted(gate: HitGate): boolean {
  return gate.meshVisible && gate.storeyVisible && gate.inSection;
}

/** Screen-space selection rectangle in NDC (-1..1), already ordered min/max. */
export interface NdcRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function makeNdcRectFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): NdcRect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/**
 * Sample points for a box select: a ray through every grid node of the rect,
 * denser for larger drags (about one sample per `stepPx` screen pixels),
 * capped so a full-screen drag stays bounded. Includes the rect corners.
 */
export function selectionNdcPoints(
  rect: NdcRect,
  canvasWidth: number,
  canvasHeight: number,
  stepPx = 24,
  maxPerAxis = 12
): Array<{ x: number; y: number }> {
  const wPx = ((rect.maxX - rect.minX) / 2) * canvasWidth;
  const hPx = ((rect.maxY - rect.minY) / 2) * canvasHeight;
  const cols = Math.min(maxPerAxis, Math.max(2, Math.ceil(wPx / stepPx)));
  const rows = Math.min(maxPerAxis, Math.max(2, Math.ceil(hPx / stepPx)));
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < cols; i++) {
    const x = cols === 1 ? (rect.minX + rect.maxX) / 2 : rect.minX + ((rect.maxX - rect.minX) * i) / (cols - 1);
    for (let j = 0; j < rows; j++) {
      const y = rows === 1 ? (rect.minY + rect.maxY) / 2 : rect.minY + ((rect.maxY - rect.minY) * j) / (rows - 1);
      pts.push({ x, y });
    }
  }
  return pts;
}

/** Dedupe (versionId, expressID) pairs preserving first-seen order. */
export function uniqueSelection(
  hits: ReadonlyArray<{ versionId: string; expressID: number }>
): Array<{ versionId: string; expressID: number }> {
  const seen = new Set<string>();
  const out: Array<{ versionId: string; expressID: number }> = [];
  for (const h of hits) {
    const key = `${h.versionId}:${h.expressID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
