/**
 * Streaming chunk router (ticket 05).
 *
 * Geometry arrives element-by-element from StreamAllMeshes with no second
 * pass, so spatial bisection is incremental: each storey owns an ordered list
 * of chunk targets; every target is the intersection of half-plane guards
 * inherited from its split ancestors. When a target's accumulated triangle
 * count crosses the budget it is bisected at the midpoint of its longest bbox
 * axis, keeping the side that received the overflowing geometry and moving the
 * other side into a fresh target. Already-streamed geometry stays where it was
 * routed (a streaming approximation); per-chunk bboxes stay exact because they
 * are accumulated from the same centroids' geometry boxes.
 */

export interface ChunkGuard {
  axis: 0 | 1 | 2;
  limit: number;
  /** geometry with centroid[axis] >= limit belongs to this chunk */
  upper: boolean;
}

export interface ChunkTarget {
  /** stable index into the router's chunk list */
  index: number;
  storeyExpressID: number | null;
  guards: ChunkGuard[];
  triangles: number;
  /** world-space AABB of all geometry routed here (metres, Y-up) */
  min: [number, number, number];
  max: [number, number, number];
  /** true once the split depth cap allowed an over-budget chunk to grow */
  overflowed: boolean;
}

const MAX_SPLITS_PER_STOREY = 32;

export class ChunkRouter {
  readonly chunks: ChunkTarget[] = [];
  private splitsLeft = new Map<string, number>();
  /** "storeyExpressID" | "none" -> creation-ordered targets (most specific first) */
  private targets = new Map<string, ChunkTarget[]>();

  constructor(readonly maxTrianglesPerChunk: number) {}

  private static key(storey: number | null): string {
    return storey === null ? "none" : String(storey);
  }

  /** Register a new chunk target and return its stable index. */
  private makeTarget(storey: number | null, guards: ChunkGuard[]): ChunkTarget {
    const target: ChunkTarget = {
      index: this.chunks.length,
      storeyExpressID: storey,
      guards,
      triangles: 0,
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
      overflowed: false,
    };
    this.chunks.push(target);
    const key = ChunkRouter.key(storey);
    const list = this.targets.get(key) ?? [];
    list.unshift(target); // newest (most constrained) matched first
    this.targets.set(key, list);
    return target;
  }

  /** First target (creation order) whose guards contain the point. */
  private locate(storey: number | null, centroid: [number, number, number]): ChunkTarget {
    const list = this.targets.get(ChunkRouter.key(storey));
    if (!list || list.length === 0) {
      return this.makeTarget(storey, []);
    }
    for (const t of list) {
      if (t.guards.every((g) => (centroid[g.axis] >= g.limit) === g.upper)) return t;
    }
    // Coverage is an invariant (a split replaces T with T∩half and adds the
    // complement); reaching here means a bug — fall back to the root target.
    return list[list.length - 1];
  }

  /**
   * Route one streamed geometry to a chunk, given its world centroid, world
   * AABB (min/max) and triangle count; splits the receiving target when it
   * exceeds the triangle budget.
   */
  route(storey: number | null, centroid: [number, number, number], gmin: [number, number, number], gmax: [number, number, number], triCount: number): ChunkTarget {
    const target = this.locate(storey, centroid);
    target.triangles += triCount;
    for (let a = 0; a < 3; a++) {
      if (gmin[a] < target.min[a]) target.min[a] = gmin[a];
      if (gmax[a] > target.max[a]) target.max[a] = gmax[a];
    }
    if (target.triangles <= this.maxTrianglesPerChunk || target.overflowed) return target;

    const key = ChunkRouter.key(storey);
    const left = this.splitsLeft.get(key) ?? MAX_SPLITS_PER_STOREY;
    if (left <= 0) {
      target.overflowed = true; // depth-capped: accept an oversized chunk
      return target;
    }
    this.splitsLeft.set(key, left - 1);

    // bisect at the midpoint of the target box's longest axis
    let axis: 0 | 1 | 2 = 0;
    for (let a = 1; a < 3; a++) {
      if (target.max[a] - target.min[a] > target.max[axis] - target.min[axis]) axis = a as 0 | 1 | 2;
    }
    const limit = (target.min[axis] + target.max[axis]) / 2;
    const keepUpper = centroid[axis] >= limit;
    // The fresh target takes the side the current geometry does NOT belong to;
    // the overflowing target keeps its accumulated data and gains its own guard.
    this.makeTarget(storey, [...target.guards, { axis, limit, upper: !keepUpper }]);
    target.guards.push({ axis, limit, upper: keepUpper });
    // Clip the kept box to the guard so repeated bisections converge on the
    // data actually routed here (an unclipped box re-splits at the same plane).
    if (keepUpper) target.min[axis] = Math.max(target.min[axis], limit);
    else target.max[axis] = Math.min(target.max[axis], limit);
    return target;
  }

  /** Number of splits still available for a storey (tests/diagnostics). */
  splitsLeftFor(storey: number | null): number {
    return this.splitsLeft.get(ChunkRouter.key(storey)) ?? MAX_SPLITS_PER_STOREY;
  }
}
