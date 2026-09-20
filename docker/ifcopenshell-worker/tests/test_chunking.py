"""Ported from packages/ifc/test/chunking.test.ts router semantics (ticket 09
dual-engine consistency): the Python router must make identical decisions."""
import unittest

from ifw.chunking import ChunkRouter


class ChunkRouterTest(unittest.TestCase):
    def test_scatters_geometry_across_disjoint_half_space_chunks(self):
        router = ChunkRouter(10)
        for i in range(200):
            c = ((i * 37) % 100, (i * 53) % 100, (i * 71) % 100)
            router.route(1, c, c, c, 1)
        self.assertGreater(len(router.chunks), 1)
        total = 0
        for t in router.chunks:
            total += t.triangles
            if t.triangles > 0:
                self.assertLessEqual(t.triangles, 20, f"chunk {t.index} budget")
        self.assertEqual(total, 200)

    def test_caps_splits_and_marks_the_surviving_chunk_overflowed(self):
        router = ChunkRouter(10)
        c = (5, 5, 5)
        for _ in range(5000):
            router.route(7, c, c, c, 1)
        receiving = [t for t in router.chunks if t.storey_express_id == 7]
        overflowed = [t for t in receiving if t.overflowed]
        self.assertEqual(len(overflowed), 1)
        self.assertGreater(overflowed[0].triangles, 10)
        self.assertEqual(sum(t.triangles for t in receiving), 5000)

    def test_storey_less_elements_get_their_own_root_chunk(self):
        router = ChunkRouter(1000)
        router.route(None, (0, 0, 0), (0, 0, 0), (0, 0, 0), 1)
        router.route(None, (50, 50, 50), (50, 50, 50), (50, 50, 50), 1)
        router.route(3, (50, 50, 50), (50, 50, 50), (50, 50, 50), 1)
        null_chunks = [t for t in router.chunks if t.storey_express_id is None]
        self.assertEqual(len(null_chunks), 1)
        self.assertEqual(null_chunks[0].triangles, 2)
        self.assertEqual(len([t for t in router.chunks if t.storey_express_id == 3]), 1)

    def test_splits_left_tracking(self):
        router = ChunkRouter(1)
        self.assertEqual(router.splits_left_for(5), 32)
        c = (5, 5, 5)
        router.route(5, c, c, c, 1)
        router.route(5, c, c, c, 1)  # crosses budget, splits
        self.assertEqual(router.splits_left_for(5), 31)


if __name__ == "__main__":
    unittest.main()
