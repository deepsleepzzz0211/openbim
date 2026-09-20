"""Spatial bisection chunk router — Python port of packages/ifc/src/chunking.ts.

The algorithms on both sides MUST stay in lock-step (ticket 09 dual-engine
consistency): same streaming approximation, same guard/bisection semantics.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

Point = Tuple[float, float, float]
MAX_SPLITS_PER_STOREY = 32


@dataclass
class ChunkGuard:
    axis: int  # 0|1|2
    limit: float
    upper: bool  # geometry with centroid[axis] >= limit belongs to this chunk


@dataclass
class ChunkTarget:
    index: int
    storey_express_id: Optional[int]
    guards: List[ChunkGuard] = field(default_factory=list)
    triangles: int = 0
    min: List[float] = field(default_factory=lambda: [float("inf")] * 3)
    max: List[float] = field(default_factory=lambda: [float("-inf")] * 3)
    overflowed: bool = False


class ChunkRouter:
    def __init__(self, max_triangles_per_chunk: int) -> None:
        self.max_triangles_per_chunk = max_triangles_per_chunk
        self.chunks: List[ChunkTarget] = []
        self._splits_left: Dict[str, int] = {}
        self._targets: Dict[str, List[ChunkTarget]] = {}

    @staticmethod
    def _key(storey: Optional[int]) -> str:
        return "none" if storey is None else str(storey)

    def _make_target(self, storey: Optional[int], guards: List[ChunkGuard]) -> ChunkTarget:
        target = ChunkTarget(index=len(self.chunks), storey_express_id=storey, guards=guards)
        self.chunks.append(target)
        key = self._key(storey)
        lst = self._targets.setdefault(key, [])
        lst.insert(0, target)  # newest (most constrained) matched first
        return target

    def _locate(self, storey: Optional[int], centroid: Point) -> ChunkTarget:
        lst = self._targets.get(self._key(storey))
        if not lst:
            return self._make_target(storey, [])
        for t in lst:
            if all((centroid[g.axis] >= g.limit) == g.upper for g in t.guards):
                return t
        return lst[-1]  # invariant fallback: root target

    def route(self, storey: Optional[int], centroid: Point, gmin: Point, gmax: Point, tri_count: int) -> ChunkTarget:
        target = self._locate(storey, centroid)
        target.triangles += tri_count
        for a in range(3):
            if gmin[a] < target.min[a]:
                target.min[a] = gmin[a]
            if gmax[a] > target.max[a]:
                target.max[a] = gmax[a]
        if target.triangles <= self.max_triangles_per_chunk or target.overflowed:
            return target

        key = self._key(storey)
        left = self._splits_left.get(key, MAX_SPLITS_PER_STOREY)
        if left <= 0:
            target.overflowed = True  # depth-capped: accept an oversized chunk
            return target
        self._splits_left[key] = left - 1

        # bisect at the midpoint of the target box's longest axis
        axis = 0
        for a in (1, 2):
            if target.max[a] - target.min[a] > target.max[axis] - target.min[axis]:
                axis = a
        limit = (target.min[axis] + target.max[axis]) / 2
        keep_upper = centroid[axis] >= limit
        # the fresh target takes the side the current geometry does NOT belong to
        self._make_target(storey, list(target.guards) + [ChunkGuard(axis, limit, not keep_upper)])
        target.guards.append(ChunkGuard(axis, limit, keep_upper))
        # clip the kept box to the guard so repeated bisections converge
        if keep_upper:
            target.min[axis] = max(target.min[axis], limit)
        else:
            target.max[axis] = min(target.max[axis], limit)
        return target

    def splits_left_for(self, storey: Optional[int]) -> int:
        return self._splits_left.get(self._key(storey), MAX_SPLITS_PER_STOREY)
