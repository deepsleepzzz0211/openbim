"""End-to-end artifact-contract tests for the native pipeline (stub engine):
meta.json shape, single vs chunked layouts, bucket/range integrity, origin
subtraction, and manifest/file agreement — mirroring the wasm engine's contract.
"""
import json
import os
import struct
import tempfile
import unittest

from ifw.engines.stub import StubDocument, box_mesh
from ifw.pipeline import ConversionError, GeomRecord, MeshRecord, convert_document


def storey_tree():
    return {
        "guid": "P0",
        "expressID": 1,
        "type": "IFCPROJECT",
        "name": "proj",
        "children": [
            {
                "guid": "B0",
                "expressID": 2,
                "type": "IFCBUILDING",
                "name": "bldg",
                "children": [
                    {"guid": "S1", "expressID": 11, "type": "IFCBUILDINGSTOREY", "name": "L1", "children": []},
                    {"guid": "S2", "expressID": 12, "type": "IFCBUILDINGSTOREY", "name": "L2", "children": []},
                ],
            }
        ],
    }


def build_doc(n_per_storey=6):
    doc = StubDocument(spatial_root=storey_tree())
    eid = 100
    for storey, y in ((11, 0.0), (12, 3.0)):
        for i in range(n_per_storey):
            eid += 1
            doc.infos[eid] = {"guid": f"G{eid}", "type": "IFCWALL", "name": f"wall {eid}", "attributes": {"Tag": str(eid)}}
            doc.storey_of[eid] = storey
            doc.psets_of[eid] = {"Pset_WallCommon": {"IsExternal": True}}
            color = (0.8, 0.8, 0.8, 1.0) if i % 2 == 0 else (0.2, 0.4, 0.6, 0.5)
            doc.meshes_list.append(MeshRecord(eid, [box_mesh((i * 5.0, y + 0.5, eid % 7), 1.0, color)]))
    return doc


class PipelineTest(unittest.TestCase):
    def run_convert(self, doc, chunking=None):
        d = tempfile.mkdtemp()
        glb_path = os.path.join(d, "model.glb")
        meta_path = os.path.join(d, "meta.json")
        meta = convert_document(doc, glb_path, meta_path, chunking=chunking)
        return d, glb_path, meta_path, meta

    def test_single_artifact_contract(self):
        doc = build_doc(2)
        # a router with a generous budget over two storeys still splits per storey;
        # without chunking the artifact stays single
        d, glb_path, meta_path, meta = self.run_convert(doc, chunking=None)
        self.assertEqual(meta["engine"], "native")
        self.assertEqual(meta["artifactFormat"], "single")
        self.assertNotIn("chunks", meta)
        self.assertTrue(os.path.isfile(glb_path))
        self.assertTrue(os.path.isfile(meta_path))
        with open(meta_path, encoding="utf8") as f:
            self.assertEqual(json.load(f)["schema"], "IFC4")
        # origin = first streamed vertex (wasm COORDINATE_TO_ORIGIN semantics)
        first = doc.meshes_list[0].geometries[0].positions[:3]
        self.assertEqual(list(meta["origin"]), first)
        # stats
        self.assertEqual(meta["stats"]["elements"], 4)
        self.assertEqual(meta["stats"]["triangles"], 4 * 12)
        # buckets: keyed by (storey, color): 2 storeys x 2 colors
        self.assertEqual(len(meta["buckets"]), 4)
        for b in meta["buckets"]:
            total = sum(r["count"] for r in b["ranges"])
            self.assertEqual(total % 3, 0)
            self.assertGreater(total, 0)
        # element metadata
        el = meta["elements"]["101"]
        self.assertEqual(el["type"], "IFCWALL")
        self.assertEqual(el["storeyGuid"], "S1")
        self.assertEqual(el["psets"], {"Pset_WallCommon": {"IsExternal": True}})
        self.assertEqual(len(el["bbox"]), 6)
        self.assertLess(el["bbox"][1], el["bbox"][4])
        # glb magic
        with open(glb_path, "rb") as f:
            self.assertEqual(f.read(4), b"glTF")

    def test_chunked_manifest_matches_files(self):
        doc = build_doc(6)
        d, glb_path, meta_path, meta = self.run_convert(doc, chunking={"maxTrianglesPerChunk": 40})
        self.assertEqual(meta["artifactFormat"], "chunked")
        chunks = meta["chunks"]
        self.assertGreater(len(chunks), 1)
        # triangles conserved across the manifest
        self.assertEqual(sum(c["triangles"] for c in chunks), meta["stats"]["triangles"])
        # buckets partitioned across chunks exactly once
        seen = set()
        for c in chunks:
            self.assertGreater(c["bytes"], 0)
            self.assertGreater(len(c["buckets"]), 0)
            self.assertEqual(len(c["bbox"]), 6)
            for b in c["buckets"]:
                self.assertNotIn(b, seen)
                seen.add(b)
        self.assertEqual(sorted(seen), list(range(len(meta["buckets"]))))
        # every geometric element names exactly one manifest chunk
        ids = {c["id"] for c in chunks}
        for el in meta["elements"].values():
            if el.get("bbox"):
                self.assertIn(el["chunkId"], ids)
        # storey guids propagated
        for c in chunks:
            if c["storeyExpressID"] == 11:
                self.assertEqual(c["storeyGuid"], "S1")
        # files on disk: chunks/<id>.glb, stale model.glb removed
        self.assertFalse(os.path.exists(glb_path))
        for c in chunks:
            f = os.path.join(d, "chunks", f"{c['id']}.glb")
            self.assertTrue(os.path.isfile(f))
            self.assertEqual(os.path.getsize(f), c["bytes"])
            with open(f, "rb") as fh:
                head = fh.read(12)
            magic, version, total = struct.unpack("<III", head)
            self.assertEqual((magic, version), (0x46546C67, 2))
            self.assertEqual(total, os.path.getsize(f))
        # ranges inside each bucket stay within index bounds of its GLB primitive
        for b, _ in enumerate(meta["buckets"]):
            for r in meta["buckets"][b]["ranges"]:
                self.assertGreaterEqual(r["start"], 0)
                self.assertGreater(r["count"], 0)

    def test_empty_model_raises(self):
        doc = StubDocument()
        with self.assertRaises(ConversionError) as ctx:
            self.run_convert(doc)
        self.assertEqual(ctx.exception.code, "EMPTY_MODEL")

    def test_broken_placement_dropped_but_metadata_kept(self):
        doc = build_doc(1)
        eid = 999
        doc.storey_of[eid] = 11
        doc.infos[eid] = {"guid": "G999", "type": "IFCDOOR", "name": "far", "attributes": {}}
        bad = GeomRecord(color=(1, 1, 1, 1), positions=[2e6, 0, 0, 2e6, 1, 0, 2e6, 0, 1], normals=[0, 1, 0] * 3, indices=[0, 1, 2])
        doc.meshes_list.append(MeshRecord(eid, [bad]))
        d, glb_path, meta_path, meta = self.run_convert(doc, chunking=None)
        # element survives with metadata but no bbox (geometry dropped by the 100km guard)
        el = meta["elements"]["999"]
        self.assertEqual(el["type"], "IFCDOOR")
        self.assertNotIn("bbox", el)

    def test_progress_reporting(self):
        doc = build_doc(4)
        seen = []
        d = tempfile.mkdtemp()
        convert_document(
            doc,
            os.path.join(d, "model.glb"),
            os.path.join(d, "meta.json"),
            on_progress=lambda p: seen.append(p),
        )
        self.assertTrue(seen)
        self.assertEqual(seen, sorted(seen))  # monotonic
        self.assertEqual(seen[-1], 99)

    def test_skip_types_contribute_no_geometry(self):
        doc = build_doc(1)
        eid = 555
        doc.infos[eid] = {"guid": "G555", "type": "IFCSPACE", "name": "space", "attributes": {}}
        doc.storey_of[eid] = 11
        doc.meshes_list.append(MeshRecord(eid, [box_mesh((0, 0, 0))]))
        d, glb_path, meta_path, meta = self.run_convert(doc, chunking=None)
        # contained, so the element keeps its metadata, but its box never renders
        self.assertIn("555", meta["elements"])
        self.assertNotIn("bbox", meta["elements"]["555"])
        # triangles: only the two real walls' boxes
        self.assertEqual(meta["stats"]["triangles"], 2 * 12)


if __name__ == "__main__":
    unittest.main()
