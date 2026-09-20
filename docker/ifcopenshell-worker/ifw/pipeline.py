"""Conversion pipeline — Python port of convertOpen() in packages/ifc/src/convert.ts.

Consumes a triangulation `Document` (engine-agnostic: the IfcOpenShell adapter
in production, a stub in unit tests) and emits the exact artifact contract the
web viewer expects: meta.json (schema "conversion/1"-style fields as produced
by the wasm engine) plus single model.glb or chunks/<id>.glb artifacts.

Frame semantics match the wasm engine: metres, Y-up, origin-relative vertices
with meta.origin carrying the subtracted world position (true world = glb +
origin; "do not bake world coordinates").
"""
import json
import math
import os
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .chunking import ChunkRouter
from .glb import GlbAssembler, write_glb

Color = Tuple[float, float, float, float]
GEOMETRY_SKIP_TYPES = {"IFCSPACE", "IFCOPENINGELEMENT"}
DEFAULT_MAX_VERTICES_PER_PRIMITIVE = 1 << 20


class ConversionError(Exception):
    def __init__(self, message: str, code: str = "UNKNOWN") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class GeomRecord:
    """One placed geometry in WORLD frame: metres, Y-up (origin subtraction
    is the pipeline's job, matching web-ifc's COORDINATE_TO_ORIGIN output)."""

    color: Color
    positions: Sequence[float]  # xyz triples
    normals: Sequence[float]  # xyz triples (unit-ish; pipeline renormalizes)
    indices: Sequence[int]


@dataclass
class MeshRecord:
    express_id: int
    geometries: List[GeomRecord] = field(default_factory=list)


class BucketData:
    def __init__(self, storey: Optional[int], color: Color) -> None:
        self.storey_express_id = storey
        self.color = color
        self.transparent = color[3] < 0.99
        self.ranges: List[dict] = []
        self.positions: List[float] = []
        self.normals: List[float] = []
        self.indices: List[int] = []

    @property
    def vertex_count(self) -> int:
        return len(self.positions) // 3


class ChunkStream:
    def __init__(self, index: int) -> None:
        self.index = index
        self.assembler = GlbAssembler()
        self.buckets: Dict[str, BucketData] = {}
        self.bucket_indices: List[int] = []


def collect_storeys(node: dict, out: Dict[int, str]) -> None:
    if node.get("type") == "IFCBUILDINGSTOREY":
        out[node["expressID"]] = node.get("guid", "")
    for child in node.get("children", []):
        collect_storeys(child, out)


def convert_document(
    doc,
    glb_path: str,
    meta_path: str,
    chunking: Optional[dict] = None,
    on_progress: Optional[Callable[[int], None]] = None,
    max_vertices_per_primitive: int = DEFAULT_MAX_VERTICES_PER_PRIMITIVE,
) -> dict:
    storey_guids: Dict[int, str] = {}
    collect_storeys(doc.spatial_root, storey_guids)
    storey_of: Dict[int, int] = dict(doc.storey_of)

    elements: Dict[str, dict] = {}

    def add_element(express_id: int) -> None:
        key = str(express_id)
        if key in elements:
            return
        info = doc.element_info(express_id)
        storey = storey_of.get(express_id)
        elements[key] = {
            "guid": info.get("guid", "") or "",
            "type": info.get("type", "IFCUNKNOWN"),
            "name": info.get("name") or info.get("guid", ""),
            "storeyExpressID": storey,
            "storeyGuid": storey_guids.get(storey) if storey is not None else None,
            "attributes": info.get("attributes", {}),
            "psets": doc.psets_of.get(express_id, {}),
        }

    for express_id in storey_of.keys():
        add_element(express_id)

    router = ChunkRouter(chunking["maxTrianglesPerChunk"]) if chunking else None
    streams: Dict[int, ChunkStream] = {}

    def stream_for(chunk_index: int) -> ChunkStream:
        s = streams.get(chunk_index)
        if s is None:
            s = ChunkStream(chunk_index)
            streams[chunk_index] = s
        return s

    sealed_buckets: List[dict] = []

    def seal(s: ChunkStream, b: BucketData) -> None:
        if not b.positions:
            return
        idx = len(sealed_buckets)
        s.assembler.add_primitive(
            name=f"bucket-{idx}",
            bucket_index=idx,
            positions=b.positions,
            normals=b.normals,
            indices=b.indices,
            base_color=b.color,
            transparent=b.transparent,
        )
        sealed_buckets.append(
            {
                "storeyExpressID": b.storey_express_id,
                "color": list(b.color),
                "transparent": b.transparent,
                "ranges": b.ranges,
            }
        )
        s.bucket_indices.append(idx)
        b.positions = []
        b.normals = []
        b.indices = []
        b.ranges = []

    def get_bucket(s: ChunkStream, storey: Optional[int], color: Color) -> BucketData:
        key = f"{storey}|" + ",".join(f"{c:.3f}" for c in color)
        bucket = s.buckets.get(key)
        if bucket is None:
            bucket = BucketData(storey, color)
            s.buckets[key] = bucket
        return bucket

    def grow_box(box, x, y, z):
        if x < box[0]:
            box[0] = x
        if y < box[1]:
            box[1] = y
        if z < box[2]:
            box[2] = z
        if x > box[3]:
            box[3] = x
        if y > box[4]:
            box[4] = y
        if z > box[5]:
            box[5] = z

    bbox_of: Dict[int, List[float]] = {}
    chunk_of: Dict[int, int] = {}
    triangles = 0
    origin: Optional[List[float]] = None
    last_reported = -1
    total = doc.mesh_total
    index = 0

    for mesh in doc.meshes():
        if on_progress and total:
            pct = int(index / total * 90)  # 0..90: streaming, 90+: assembly
            if pct > last_reported:
                last_reported = pct
                on_progress(pct)
        index += 1
        info_type = doc.element_info(mesh.express_id).get("type", "")
        if info_type in GEOMETRY_SKIP_TYPES:
            continue
        storey = storey_of.get(mesh.express_id)

        for geom in mesh.geometries:
            pos = geom.positions
            if origin is None and len(pos) >= 3:
                # web-ifc COORDINATE_TO_ORIGIN: p0 = first streamed vertex
                origin = [pos[0], pos[1], pos[2]]
            ox, oy, oz = origin if origin is not None else (0.0, 0.0, 0.0)

            # world AABB of this geometry + the 100 km broken-placement guard
            gmin = [float("inf")] * 3
            gmax = [float("-inf")] * 3
            coord_ok = True
            for v in range(0, len(pos), 3):
                coords = (pos[v] - ox, pos[v + 1] - oy, pos[v + 2] - oz)
                for a in range(3):
                    if abs(coords[a]) > 1e5:
                        coord_ok = False
                        break
                    if coords[a] < gmin[a]:
                        gmin[a] = coords[a]
                    if coords[a] > gmax[a]:
                        gmax[a] = coords[a]
                if not coord_ok:
                    break
            add_element(mesh.express_id)
            if not coord_ok:
                continue  # drop the mesh, keep its metadata

            if router is not None:
                centroid = [(gmin[a] + gmax[a]) / 2 for a in range(3)]
                target = router.route(storey, centroid, gmin, gmax, len(geom.indices) // 3)  # type: ignore[arg-type]
                stream = stream_for(target.index)
                chunk_of.setdefault(mesh.express_id, target.index)
                box = bbox_of.setdefault(mesh.express_id, [float("inf")] * 3 + [float("-inf")] * 3)
                grow_box(box, gmin[0], gmin[1], gmin[2])
                grow_box(box, gmax[0], gmax[1], gmax[2])
            else:
                stream = stream_for(0)
                box = bbox_of.setdefault(mesh.express_id, [float("inf")] * 3 + [float("-inf")] * 3)
                for v in range(0, len(pos), 3):
                    grow_box(box, pos[v] - ox, pos[v + 1] - oy, pos[v + 2] - oz)

            bucket = get_bucket(stream, storey, tuple(geom.color))  # type: ignore[arg-type]
            vertex_base = bucket.vertex_count
            bucket.positions.extend(p - o for p, o in zip(pos, (ox, oy, oz) * (len(pos) // 3)))
            nrm = geom.normals
            for v in range(0, len(nrm), 3):
                nx, ny, nz = nrm[v], nrm[v + 1], nrm[v + 2]
                ln = math.sqrt(nx * nx + ny * ny + nz * nz)
                if ln > 1e-12:
                    nx, ny, nz = nx / ln, ny / ln, nz / ln
                bucket.normals.extend((nx, ny, nz))
            start = len(bucket.indices)
            bucket.indices.extend(i + vertex_base for i in geom.indices)
            bucket.ranges.append({"expressID": mesh.express_id, "start": start, "count": len(geom.indices)})
            triangles += len(geom.indices) / 3
            if bucket.vertex_count >= max_vertices_per_primitive:
                seal(stream, bucket)

    for express_id in list(bbox_of.keys()):
        add_element(express_id)

    if origin is None:
        origin = [0.0, 0.0, 0.0]
    if on_progress:
        on_progress(92)
    for s in streams.values():
        for b in s.buckets.values():
            seal(s, b)

    if not elements and not sealed_buckets:
        raise ConversionError("no elements or geometry found in IFC file", "EMPTY_MODEL")

    for express_id, box in bbox_of.items():
        el = elements.get(str(express_id))
        if el and box[0] != float("inf"):
            el["bbox"] = box
        c = chunk_of.get(express_id)
        if el and c is not None:
            el["chunkId"] = c

    if on_progress:
        on_progress(99)

    chunked = len(streams) > 1
    meta = {
        "schema": doc.schema,
        "engine": "native",
        "units": doc.units,
        "origin": origin,
        "crs": doc.crs,
        "stats": {"elements": len(elements), "triangles": round(triangles)},
        "glbCompression": {"codec": "none", "fallbackViews": 0},
        "artifactFormat": "chunked" if chunked else "single",
        "buckets": sealed_buckets,
        "spatial": doc.spatial_root,
        "elements": elements,
    }
    if chunked:
        entries = []
        for s in sorted(streams.values(), key=lambda s: s.index):
            t = next(t for t in router.chunks if t.index == s.index)
            entry = {
                "id": s.index,
                "storeyExpressID": t.storey_express_id,
                "storeyGuid": storey_guids.get(t.storey_express_id) if t.storey_express_id is not None else None,
                "bbox": [t.min[0], t.min[1], t.min[2], t.max[0], t.max[1], t.max[2]],
                "triangles": t.triangles,
                "bytes": 0,
                "buckets": s.bucket_indices,
            }
            if t.overflowed:
                entry["overflowed"] = True
            entries.append(entry)
        meta["chunks"] = entries

    if not streams:
        stream_for(0)  # metadata-only model: emit an empty single artifact
    os.makedirs(os.path.dirname(glb_path) or ".", exist_ok=True)
    if chunked:
        chunk_dir = os.path.join(os.path.dirname(glb_path), "chunks")
        os.makedirs(chunk_dir, exist_ok=True)
        for entry in meta["chunks"]:
            dest = os.path.join(chunk_dir, f"{entry['id']}.glb")  # entry.id: integer, router-assigned
            write_glb(dest, streams[entry["id"]].assembler)
            entry["bytes"] = os.path.getsize(dest)
        if os.path.exists(glb_path):
            os.remove(glb_path)  # stale single artifact from a previous run
    else:
        write_glb(glb_path, streams[0].assembler)
        stale_dir = os.path.join(os.path.dirname(glb_path), "chunks")
        if os.path.isdir(stale_dir):
            import shutil

            shutil.rmtree(stale_dir)  # stale chunk dir from a previous chunked run

    with open(meta_path, "w", encoding="utf8") as f:
        json.dump(meta, f, separators=(",", ":"))
    return meta
