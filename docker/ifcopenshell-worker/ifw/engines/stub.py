"""Stub engine: builds synthetic Documents for tests and protocol dev runs."""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..pipeline import GeomRecord, MeshRecord

DEFAULT_UNITS = {"sourceName": "METRE", "sourcePrefix": None, "scaleToMetre": 1}
DEFAULT_CRS = {"source": "ABSENT", "name": None, "epsg": None, "mapConversion": None}


def box_mesh(centroid, size=1.0, color=(0.8, 0.8, 0.8, 1.0)):
    """Axis-aligned box as 12 triangles (world positions, metres, Y-up)."""
    h = size / 2
    x, y, z = centroid
    v = [
        (x - h, y - h, z - h), (x + h, y - h, z - h), (x + h, y + h, z - h), (x - h, y + h, z - h),
        (x - h, y - h, z + h), (x + h, y - h, z + h), (x + h, y + h, z + h), (x - h, y + h, z + h),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),  # -z
        (4, 5, 6), (4, 6, 7),  # +z
        (0, 1, 5), (0, 5, 4),  # -y
        (2, 3, 7), (2, 7, 6),  # +y
        (0, 4, 7), (0, 7, 3),  # -x
        (1, 2, 6), (1, 6, 5),  # +x
    ]
    positions: List[float] = []
    normals: List[float] = []
    indices: List[int] = []
    for t, (a, b, c) in enumerate(faces):
        p = [v[a], v[b], v[c]]
        ux, uy, uz = p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]
        wx, wy, wz = p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]
        n = (uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)
        for vtx in p:
            positions.extend(vtx)
            normals.extend(n)
        indices.extend([t * 3, t * 3 + 1, t * 3 + 2])
    return GeomRecord(color=color, positions=positions, normals=normals, indices=indices)


@dataclass
class StubDocument:
    """Duck-typed conversion `Document` (see ifw.pipeline)."""

    meshes_list: List[MeshRecord] = field(default_factory=list)
    infos: Dict[int, dict] = field(default_factory=dict)
    storey_of: Dict[int, int] = field(default_factory=dict)
    psets_of: Dict[int, dict] = field(default_factory=dict)
    spatial_root: dict = field(default_factory=lambda: {"guid": "", "expressID": -1, "type": "IFCPROJECT", "name": "stub", "children": []})
    schema: str = "IFC4"
    units: dict = field(default_factory=lambda: dict(DEFAULT_UNITS))
    crs: dict = field(default_factory=lambda: dict(DEFAULT_CRS))

    @property
    def mesh_total(self) -> Optional[int]:
        return len(self.meshes_list)

    def element_info(self, express_id: int) -> dict:
        return self.infos.get(express_id) or {"guid": "", "type": "IFCUNKNOWN", "name": f"el{express_id}", "attributes": {}}

    def meshes(self) -> List[MeshRecord]:
        return self.meshes_list


class StubEngine:
    """Engine façade: `open(path)` returns the document registered for it."""

    def __init__(self, documents: Optional[Dict[str, StubDocument]] = None) -> None:
        self.documents = documents or {}

    def open(self, path: str) -> StubDocument:
        return self.documents[path]


def synthetic_document() -> StubDocument:
    """A tiny two-storey wall field; used by `IFW_ENGINE=stub` protocol tests."""
    doc = StubDocument(
        spatial_root={
            "guid": "P0",
            "expressID": 1,
            "type": "IFCPROJECT",
            "name": "stub",
            "children": [
                {
                    "guid": "S1",
                    "expressID": 11,
                    "type": "IFCBUILDINGSTOREY",
                    "name": "L1",
                    "children": [],
                },
                {
                    "guid": "S2",
                    "expressID": 12,
                    "type": "IFCBUILDINGSTOREY",
                    "name": "L2",
                    "children": [],
                },
            ],
        }
    )
    for eid, storey, y in ((101, 11, 0.5), (102, 12, 3.5)):
        doc.infos[eid] = {"guid": f"G{eid}", "type": "IFCWALL", "name": f"wall {eid}", "attributes": {}}
        doc.storey_of[eid] = storey
        doc.meshes_list.append(MeshRecord(eid, [box_mesh((eid * 2.0, y, 0.0))]))
    return doc
