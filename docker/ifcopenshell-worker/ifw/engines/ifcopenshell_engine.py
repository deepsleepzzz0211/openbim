"""IfcOpenShell triangulation engine (production side of ticket 09).

Runs inside the conversion container as a subprocess (one process per file),
so the LGPL-licensed IfcOpenShell code never links into the API process.

Geometry is normalised to the wasm engine's frame so artifacts stay
interchangeable: metres (source units scaled), Z-up -> Y-up
(x, y, z) -> (x, z, -y), world placement baked in (the pipeline then
subtracts the COORDINATE_TO_ORIGIN-equivalent origin; nothing huge is baked
into float32 vertices).

NOTE: this adapter targets the ifcopenshell 0.8 python API and is verified by
the dual-engine parity workflow (.github/workflows/engine-parity.yml) — the
only place real IfcOpenShell runs.
"""
from typing import Dict, Iterator, List, Optional, Tuple

import ifcopenshell

from ..pipeline import ConversionError, GeomRecord, MeshRecord

PREFIX_TO_METRE = {
    "EXA": 1e18, "PETA": 1e15, "TERA": 1e12, "GIGA": 1e9, "MEGA": 1e6, "KILO": 1e3,
    "HECTO": 1e2, "DECA": 1e1, "DECI": 1e-1, "CENTI": 1e-2, "MILLI": 1e-3,
    "MICRO": 1e-6, "NANO": 1e-9, "PICO": 1e-12,
}
METRE_UNITS = {"METRE": 1, "FOOT": 0.3048, "INCH": 0.0254, "MILLIMETRE": 1e-3, "CENTIMETRE": 1e-2}

GEOMETRY_SKIP_TYPES = {"IFCSPACE", "IFCOPENINGELEMENT"}


def _str(v) -> Optional[str]:
    return v if isinstance(v, str) else None


def _units_of(f) -> dict:
    units = {"sourceName": "METRE", "sourcePrefix": None, "scaleToMetre": 1}
    try:
        assign = f.by_type("IFCUNITASSIGNMENT")
    except Exception:
        assign = []
    for unit in assign[0].Units if assign else []:
        if getattr(unit, "UnitType", None) != "LENGTHUNIT":
            continue
        name = _str(getattr(unit, "Name", None)) or ""
        prefix = _str(getattr(unit, "Prefix", None))
        units["sourceName"] = name
        units["sourcePrefix"] = prefix
        base = METRE_UNITS.get(name)
        if base is not None:
            units["scaleToMetre"] = base * PREFIX_TO_METRE.get(prefix or "", 1)
    return units


def _crs_of(f) -> dict:
    crs = {"source": "ABSENT", "name": None, "epsg": None, "mapConversion": None}
    import re

    proj = f.by_type("IFCPROJECTEDCRS")
    if proj:
        name = _str(getattr(proj[0], "Name", None))
        crs = {"source": "IFCPROJECTEDCRS", "name": name, "epsg": None, "mapConversion": None}
        if name:
            m = re.search(r"\bEPSG\s*[:=]?\s*(\d{4,6})\b", name, re.I) or re.match(r"^\s*(\d{4,6})\s*$", name)
            if m:
                crs["epsg"] = int(m.group(1))
    maps = f.by_type("IFCMAPCONVERSION")
    if maps:
        x0 = getattr(maps[0], "Eastings", None)
        y0 = getattr(maps[0], "Northings", None)
        if isinstance(x0, (int, float)) and isinstance(y0, (int, float)):
            crs = {**crs, "mapConversion": {"x0": float(x0), "y0": float(y0)}}
    return crs


class IfcDocument:
    def __init__(self, f, scale: float, threads: int) -> None:
        self.f = f
        self.schema = (f.schema or "IFC4").upper()
        self.units_scale = scale
        self.threads = max(1, threads)
        self.units = {"sourceName": "METRE", "sourcePrefix": None, "scaleToMetre": scale}
        u = f.by_type("IFCUNITASSIGNMENT")
        if u:
            for unit in u[0].Units:
                if getattr(unit, "UnitType", None) == "LENGTHUNIT":
                    self.units = {
                        "sourceName": _str(getattr(unit, "Name", None)) or "METRE",
                        "sourcePrefix": _str(getattr(unit, "Prefix", None)),
                        "scaleToMetre": scale,
                    }
        self.crs = _crs_of(f)
        self.spatial_root, self.storey_guids = self._spatial()
        self.storey_of = self._containment()
        self.psets_of = self._psets()
        self._info_cache: Dict[int, dict] = {}

    # -- structure -----------------------------------------------------------
    def _node(self, el) -> dict:
        guid = getattr(el, "GlobalId", "") or ""
        return {
            "guid": guid,
            "expressID": el.id(),
            "type": el.is_a().upper(),
            "name": _str(getattr(el, "Name", None)) or guid,
            "children": [],
        }

    def _spatial(self) -> Tuple[dict, Dict[int, str]]:
        children_of: Dict[int, List[int]] = {}
        project_id: Optional[int] = None
        for rel in self.f.by_type("IFCRELAGGREGATES"):
            parent = rel.RelatingObject
            if parent is None:
                continue
            if parent.is_a().upper() == "IFCPROJECT":
                project_id = parent.id()
            for child in rel.RelatedObjects:
                children_of.setdefault(parent.id(), []).append(child)
        root = None
        guids: Dict[int, str] = {}
        node_cache: Dict[int, dict] = {}

        def make(el) -> dict:
            node = node_cache.get(el.id())
            if node is None:
                node = self._node(el)
                node_cache[el.id()] = node
            return node

        projects = self.f.by_type("IFCPROJECT")
        root_el = projects[0] if (project_id is not None and projects) else None
        if root_el is not None:
            root = make(root_el)
        else:
            root = {"guid": "", "expressID": -1, "type": "IFCPROJECT", "name": "(no project)", "children": []}

        if root_el is not None:
            # iterative walk (avoids deep recursion on large hierarchies)
            pending = [(root_el, root)]
            while pending:
                el, node = pending.pop()
                for child in children_of.get(el.id(), []):
                    if child.is_a().upper() in GEOMETRY_SKIP_TYPES:
                        continue
                    cnode = make(child)
                    node["children"].append(cnode)
                    pending.append((child, cnode))
        for el_id, node in node_cache.items():
            if node["type"] == "IFCBUILDINGSTOREY":
                guids[el_id] = node["guid"]
        return root, guids

    def _containment(self) -> Dict[int, int]:
        out: Dict[int, int] = {}
        for rel in self.f.by_type("IFCRELCONTAINEDINSPATIALSTRUCTURE"):
            structure = rel.RelatingStructure
            if structure is None or structure.is_a().upper() != "IFCBUILDINGSTOREY":
                continue
            for el in rel.RelatedElements:
                out.setdefault(el.id(), structure.id())
        return out

    def _psets(self) -> Dict[int, dict]:
        out: Dict[int, dict] = {}
        for rel in self.f.by_type("IFCRELDEFINESBYPROPERTIES"):
            definition = rel.RelatingPropertyDefinition
            if definition is None or definition.is_a().upper() != "IFCPROPERTYSET":
                continue
            name = _str(getattr(definition, "Name", None)) or "Pset_Unknown"
            props: Dict[str, object] = {}
            for prop in getattr(definition, "HasProperties", None) or []:
                pname = _str(getattr(prop, "Name", None))
                if not pname:
                    continue
                value = getattr(prop, "NominalValue", None)
                props[pname] = getattr(value, "wrappedValue", None) if value is not None else None
            for obj in rel.RelatedObjects:
                out.setdefault(obj.id(), {})[name] = props
        return out

    def element_info(self, express_id: int) -> dict:
        cached = self._info_cache.get(express_id)
        if cached:
            return cached
        try:
            el = self.f.by_id(express_id)
        except Exception:
            el = None
        guid = (getattr(el, "GlobalId", "") or "") if el is not None else ""
        attributes = {}
        if el is not None:
            for attr in ("ObjectType", "Tag", "PredefinedType"):
                try:
                    value = getattr(el, attr, None)
                except Exception:
                    value = None
                if value is not None and not isinstance(value, (list, tuple)):
                    attributes[attr] = value
        info = {
            "guid": guid,
            "type": el.is_a().upper() if el is not None else "IFCUNKNOWN",
            "name": _str(getattr(el, "Name", None)) or guid if el is not None else f"el{express_id}",
            "attributes": attributes,
        }
        self._info_cache[express_id] = info
        return info

    # -- geometry ------------------------------------------------------------
    def _settings(self):
        settings = ifcopenshell.geom.settings()
        # world coordinates in source units; the pipeline subtracts the origin
        for flag, value in (("use_world_coordinates", True), ("use_multiprocessing", True)):
            try:
                setattr(settings, flag, value)
            except Exception:
                try:
                    settings.set(getattr(settings, flag.upper()), value)
                except Exception:
                    pass
        try:
            settings.set("num_processors", self.threads)
        except Exception:
            pass
        return settings

    def _candidates(self) -> List[int]:
        ids = set()
        for rel in self.f.by_type("IFCRELCONTAINEDINSPATIALSTRUCTURE"):
            for el in rel.RelatedElements:
                ids.add(el.id())
        try:
            for el in self.f.by_type("IFCELEMENT"):
                if getattr(el, "Representation", None) is not None:
                    ids.add(el.id())
        except Exception:
            pass
        return sorted(i for i in ids if self.f.by_id(i).is_a().upper() not in GEOMETRY_SKIP_TYPES)

    @property
    def mesh_total(self) -> int:
        return len(self._candidates())

    def _color_of(self, shape) -> Tuple[float, float, float, float]:
        try:
            material = shape.material
        except Exception:
            material = None
        diffuse = None
        if material is not None:
            for attr in ("diffuse", "diffuse_colour", "DIFFUSE"):
                value = getattr(material, attr, None) if not isinstance(material, dict) else material.get(attr)
                if value is not None:
                    diffuse = value
                    break
        if diffuse is not None and len(diffuse) >= 3:
            alpha = float(diffuse[3]) if len(diffuse) > 3 else 1.0
            return (float(diffuse[0]), float(diffuse[1]), float(diffuse[2]), alpha)
        return (0.8, 0.8, 0.8, 1.0)

    def meshes(self) -> Iterator[MeshRecord]:
        settings = self._settings()
        scale = self.units["scaleToMetre"]
        for express_id in self._candidates():
            try:
                shape = ifcopenshell.geom.create_shape(settings, self.f.by_id(express_id))
            except Exception:
                continue  # broken placement: metadata survives, geometry drops
            geom = shape.geometry
            verts = list(geom.verts)
            faces = list(geom.faces)
            if not verts or not faces:
                continue
            # Z-up -> Y-up: (x, y, z) -> (x, z, -y); expand to flat-normalised
            # per-triangle vertices so every vertex carries its face normal.
            positions: List[float] = []
            normals: List[float] = []
            indices: List[int] = []
            for t in range(0, len(faces), 3):
                tri = [verts[i * 3 : i * 3 + 3] for i in faces[t : t + 3]]
                p = [[(x * scale, z * scale, -y * scale) for x, y, z in vtx] for vtx in tri]
                ux = [p[1][k] - p[0][k] for k in range(3)]
                wx = [p[2][k] - p[0][k] for k in range(3)]
                n = [ux[1] * wx[2] - ux[2] * wx[1], ux[2] * wx[0] - ux[0] * wx[2], ux[0] * wx[1] - ux[1] * wx[0]]
                base = len(positions) // 3
                for vtx in p:
                    positions.extend(vtx)
                    normals.extend(n)
                indices.extend([base, base + 1, base + 2])
            rec = GeomRecord(color=self._color_of(shape), positions=positions, normals=normals, indices=indices)
            yield MeshRecord(express_id=express_id, geometries=[rec])


class IfcOpenShellEngine:
    def __init__(self, threads: int = 4) -> None:
        self.threads = threads

    def open(self, path: str) -> IfcDocument:
        try:
            f = ifcopenshell.open(path)
        except Exception as err:
            raise ConversionError(f"ifcopenshell failed to open {path}: {err}", "PARSE_FAILED") from err
        scale = _units_of(f)["scaleToMetre"]
        return IfcDocument(f, scale, self.threads)
