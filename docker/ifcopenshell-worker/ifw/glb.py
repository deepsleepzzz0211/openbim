"""glTF 2.0 GLB writer — Python port of packages/ifc/src/glb.ts (no meshopt).

Produces the artifact contract the web viewer consumes:
 - positions quantized to int16 (KHR_mesh_quantization), restored via node scale/translation
 - normals as normalized int8
 - uint32 indices, one node/mesh/material per bucket primitive
Native artifacts ship uncompressed (glbCompression codec "none").
"""
import json
import math
import struct
from array import array
from typing import Callable, List, Optional, Sequence, Tuple

COMPONENT_BYTE = 5120
COMPONENT_SHORT = 5122
COMPONENT_UINT = 5125
TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963


def js_round(x: float) -> int:
    """Math.round semantics (half toward +inf); Python's round() is banker's."""
    return math.floor(x + 0.5)


class GlbAssembler:
    def __init__(self, emit: Optional[Callable[[bytes], None]] = None) -> None:
        self._buf = bytearray()
        self._emit = emit if emit is not None else (lambda chunk: self._buf.extend(chunk))
        self.bin_length = 0
        self.buffer_views: List[dict] = []
        self.accessors: List[dict] = []
        self.node_defs: List[dict] = []
        self.meshes: List[dict] = []
        self.materials: List[dict] = []
        self.nodes: List[dict] = []

    # -- binary sink ---------------------------------------------------------
    def _write(self, data: bytes) -> None:
        self._emit(data)
        self.bin_length += len(data)

    def _pad_to(self, align: int) -> None:
        pad = (align - (self.bin_length % align)) % align
        if pad > 0:
            self._write(bytes(pad))

    def _push_chunk(self, data: bytes, target: Optional[int] = None, byte_stride: Optional[int] = None) -> int:
        self._pad_to(4)
        view = {"buffer": 0, "byteOffset": self.bin_length, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        if byte_stride is not None:
            view["byteStride"] = byte_stride
        self._write(data)
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    # -- primitives ----------------------------------------------------------
    def add_primitive(
        self,
        name: str,
        bucket_index: int,
        positions: Sequence[float],
        normals: Sequence[float],
        indices: Sequence[int],
        base_color: Tuple[float, float, float, float],
        transparent: bool,
    ) -> None:
        mn = [float("inf")] * 3
        mx = [float("-inf")] * 3
        for v in range(0, len(positions), 3):
            for c in range(3):
                value = positions[v + c]
                if value < mn[c]:
                    mn[c] = value
                if value > mx[c]:
                    mx[c] = value
        center = [(mn[c] + mx[c]) / 2 for c in range(3)]
        half = [max((mx[c] - mn[c]) / 2, 1e-6) for c in range(3)]
        vertex_count = len(positions) // 3

        q_pos = array("h", bytes(vertex_count * 4 * 2))
        q_min = [float("inf")] * 3
        q_max = [float("-inf")] * 3
        for v in range(vertex_count):
            for c in range(3):
                n = js_round(((positions[v * 3 + c] - center[c]) / half[c]) * 32767)
                clamped = max(-32768, min(32767, n))
                q_pos[v * 4 + c] = clamped
                if clamped < q_min[c]:
                    q_min[c] = clamped
                if clamped > q_max[c]:
                    q_max[c] = clamped

        q_norm = array("b", bytes(vertex_count * 4))
        for v in range(vertex_count):
            for c in range(3):
                q_norm[v * 4 + c] = js_round(max(-1.0, min(1.0, normals[v * 3 + c])) * 127)

        idx = array("I", indices) if indices else array("I")

        pos_view = self._push_chunk(q_pos.tobytes(), TARGET_ARRAY_BUFFER, 8)
        pos_acc = len(self.accessors)
        self.accessors.append(
            {"bufferView": pos_view, "componentType": COMPONENT_SHORT, "count": vertex_count,
             "type": "VEC3", "normalized": True, "min": q_min, "max": q_max}
        )
        norm_view = self._push_chunk(q_norm.tobytes(), TARGET_ARRAY_BUFFER, 4)
        norm_acc = len(self.accessors)
        self.accessors.append(
            {"bufferView": norm_view, "componentType": COMPONENT_BYTE, "count": vertex_count,
             "type": "VEC3", "normalized": True}
        )
        idx_view = self._push_chunk(idx.tobytes(), TARGET_ELEMENT_ARRAY_BUFFER)
        idx_acc = len(self.accessors)
        self.accessors.append(
            {"bufferView": idx_view, "componentType": COMPONENT_UINT, "count": len(indices), "type": "SCALAR"}
        )

        mat_index = len(self.materials)
        self.materials.append({
            "name": f"material-{mat_index}",
            "doubleSided": True,
            "alphaMode": "BLEND" if transparent else "OPAQUE",
            "pbrMetallicRoughness": {"baseColorFactor": list(base_color), "metallicFactor": 0.05, "roughnessFactor": 0.85},
        })
        mesh_index = len(self.meshes)
        self.meshes.append({
            "primitives": [{
                "attributes": {"POSITION": pos_acc, "NORMAL": norm_acc},
                "indices": idx_acc,
                "material": mat_index,
                "mode": 4,
            }]
        })
        self.node_defs.append({
            "mesh": mesh_index,
            "name": name,
            "extras": {"bucket": bucket_index},
            "scale": half,
            "translation": center,
        })
        self.nodes.append({"scale": half, "translation": center})

    # -- serialization -------------------------------------------------------
    def build_json_chunk(self) -> bytes:
        gltf = {
            "asset": {"version": "2.0", "generator": "OpenBIM Hub native"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.node_defs)))}],
            "nodes": self.node_defs,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": self.bin_length}],
            "extensionsUsed": ["KHR_mesh_quantization"],
            "extensionsRequired": ["KHR_mesh_quantization"],
        }
        text = json.dumps(gltf, separators=(",", ":"))
        pad = (4 - (len(text) % 4)) % 4
        return (text + " " * pad).encode("latin1")

    def bin_bytes(self) -> bytes:
        """Snapshot of the accumulated BIN chunk (buffered mode only)."""
        return bytes(self._buf)


def write_glb(path: str, assembler: GlbAssembler) -> None:
    """Compose header + JSON + 4-aligned BIN into the final GLB file."""
    json_bytes = assembler.build_json_chunk()
    bin_data = assembler.bin_bytes()
    bin_pad = (4 - (len(bin_data) % 4)) % 4
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data) + bin_pad
    with open(path, "wb") as f:
        f.write(struct.pack("<IIIII", 0x46546C67, 2, total, len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_data) + bin_pad, 0x004E4942))
        f.write(bin_data)
        if bin_pad:
            f.write(bytes(bin_pad))
