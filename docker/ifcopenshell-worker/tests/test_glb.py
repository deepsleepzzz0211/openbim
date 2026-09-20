"""GLB writer contract checks: header layout, quantization round-trip, node
extras and bufferView/accessor wiring (frontend + ticket 05 manifest)."""
import json
import os
import struct
import tempfile
import unittest

from ifw.glb import GlbAssembler, js_round, write_glb


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2 and total == len(data)
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A
    gltf = json.loads(data[20 : 20 + json_len])
    bin_len, bin_type = struct.unpack_from("<II", data, 20 + json_len)
    assert bin_type == 0x004E4942
    bin_data = data[20 + json_len + 8 : 20 + json_len + 8 + bin_len]
    return gltf, bin_data


class GlbWriterTest(unittest.TestCase):
    def positions(self):
        # two triangles (one quad) of a unit square in the XZ plane
        return [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0]

    def normals(self):
        return [0.0, 1.0, 0.0] * 4

    def primitive_kwargs(self):
        return dict(
            name="bucket-0",
            bucket_index=0,
            positions=self.positions(),
            normals=self.normals(),
            indices=[0, 1, 2, 0, 2, 3],
            base_color=(0.5, 0.25, 0.125, 1.0),
            transparent=False,
        )

    def test_js_round_matches_math_semantics(self):
        self.assertEqual(js_round(0.5), 1)  # Math.round(0.5) === 1
        self.assertEqual(js_round(-0.5), 0)  # Math.round(-0.5) === -0
        self.assertEqual(js_round(2.4), 2)

    def test_glb_file_layout_and_json_chunk(self):
        asm = GlbAssembler()
        asm.add_primitive(**self.primitive_kwargs())
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "m.glb")
            write_glb(path, asm)
            gltf, bin_data = read_glb(path)
        self.assertEqual(gltf["extensionsRequired"], ["KHR_mesh_quantization"])
        self.assertEqual(len(gltf["nodes"]), 1)
        self.assertEqual(gltf["nodes"][0]["extras"], {"bucket": 0})
        self.assertEqual(gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"], [0.5, 0.25, 0.125, 1.0])
        self.assertEqual(len(gltf["accessors"]), 3)
        pos_acc, norm_acc, idx_acc = gltf["accessors"]
        self.assertEqual((pos_acc["componentType"], pos_acc["count"], pos_acc["type"]), (5122, 4, "VEC3"))
        self.assertTrue(pos_acc["normalized"])
        self.assertEqual(norm_acc["componentType"], 5120)
        self.assertEqual((idx_acc["componentType"], idx_acc["count"]), (5125, 6))
        self.assertEqual(gltf["buffers"][0]["byteLength"], asm.bin_length)
        self.assertGreaterEqual(len(bin_data), asm.bin_length)

    def test_quantization_round_trip_is_within_int16_resolution(self):
        asm = GlbAssembler()
        asm.add_primitive(**self.primitive_kwargs())
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "m.glb")
            write_glb(path, asm)
            gltf, bin_data = read_glb(path)
        pos_view = gltf["bufferViews"][gltf["accessors"][0]["bufferView"]]
        node = gltf["nodes"][0]
        import array

        q = array.array("h")
        q.frombytes(bin_data[pos_view["byteOffset"] : pos_view["byteOffset"] + pos_view["byteLength"]])
        src = self.positions()
        for v in range(4):
            for c in range(3):
                restored = q[v * 4 + c] / 32767.0 * node["scale"][c] + node["translation"][c]
                self.assertLess(abs(restored - src[v * 3 + c]), 2e-3)


if __name__ == "__main__":
    unittest.main()
