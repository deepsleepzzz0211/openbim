/**
 * Ticket 11 (spike): 3D Tiles 1.1 export from the chunked manifest.
 * Asserts the tileset contract (version/relative uris/double transforms),
 * the block-local-origin rewrite (tile translation + local node offset ==
 * original GLB-frame placement), and the attribute hook path
 * tile(chunk id) -> manifest bucket ranges -> element GUIDs.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { convertIfc } from "../src/convert";
import { readGlbFile } from "../src/presplit";
import { buildTilesetJson, exportTilesetFromArtifact, tileSpecsForMeta, Y_UP_TO_Z_UP } from "../src/tiles";
import type { ConversionMeta } from "../src/types";

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "sample-building.ifc"));

/** materialise a chunked artifact dir (meta.json + chunks/<id>.glb) on disk */
async function writeArtifact(maxTri = 20): Promise<{ dir: string; meta: ConversionMeta }> {
  const res = await convertIfc(new Uint8Array(FIXTURE), { chunking: { maxTrianglesPerChunk: maxTri } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbim-tiles-"));
  fs.mkdirSync(path.join(dir, "chunks"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(res.meta));
  res.meta.chunks!.forEach((c, k) => fs.writeFileSync(path.join(dir, "chunks", `${c.id}.glb`), Buffer.from(res.chunks![k])));
  return { dir, meta: res.meta };
}

describe("buildTilesetJson (manifest -> 3D Tiles 1.1)", () => {
  it("emits a spec-shaped tree with one leaf tile per manifest chunk", async () => {
    const res = await convertIfc(new Uint8Array(FIXTURE), { chunking: { maxTrianglesPerChunk: 20 } });
    const meta = res.meta;
    const ts = buildTilesetJson(meta);
    expect(ts.asset.version).toBe("1.1");
    expect(ts.geometricError).toBeGreaterThan(0);

    const root = ts.root;
    expect(root.refine).toBe("REPLACE");
    expect(root.transform).toHaveLength(16);
    expect(root.boundingVolume.box).toHaveLength(12);
    // root carries the Y-up -> Z-up rotation and the model origin
    for (let i = 0; i < 12; i++) expect(root.transform![i]).toBe(Y_UP_TO_Z_UP[i]);
    const o = meta.origin;
    expect(root.transform![12]).toBeCloseTo(o[0], 9);
    expect(root.transform![13]).toBeCloseTo(-o[2], 9);
    expect(root.transform![14]).toBeCloseTo(o[1], 9);

    expect(root.children).toHaveLength(meta.chunks!.length);
    for (const child of root.children!) {
      expect(child.content?.uri).toMatch(/^tiles\/\d+\.glb$/); // relative, id-derived only
      expect(child.geometricError).toBe(0); // leaves are exact
      expect(child.transform).toHaveLength(16);
      const chunk = meta.chunks!.find((c) => c.id === Number(child.content!.uri.match(/\d+/)![0]))!;
      expect(child.transform![12]).toBeCloseTo((chunk.bbox[0] + chunk.bbox[3]) / 2, 9);
      expect(child.transform![13]).toBeCloseTo((chunk.bbox[1] + chunk.bbox[4]) / 2, 9);
      expect(child.transform![14]).toBeCloseTo((chunk.bbox[2] + chunk.bbox[5]) / 2, 9);
      const bv = child.boundingVolume.box; // 1.1 flat array: center + 3 axis columns
      expect(bv).toHaveLength(12);
      expect(bv.slice(0, 3)).toEqual([0, 0, 0]);
      expect(bv[3]).toBeCloseTo((chunk.bbox[3] - chunk.bbox[0]) / 2, 9);
      expect(bv[7]).toBeCloseTo((chunk.bbox[4] - chunk.bbox[1]) / 2, 9);
      expect(bv[11]).toBeCloseTo((chunk.bbox[5] - chunk.bbox[2]) / 2, 9);
      expect([bv[4], bv[5], bv[6], bv[8], bv[9], bv[10]]).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });

  it("single-format metas export as one tile around the element-bbox centre", async () => {
    const res = await convertIfc(new Uint8Array(FIXTURE));
    const ts = buildTilesetJson(res.meta);
    const specs = tileSpecsForMeta(res.meta);
    expect(specs).toHaveLength(1);
    expect(specs[0].uri).toBe("model.glb");
    expect(ts.root.children).toHaveLength(1);
    // every element bbox must sit inside the union box (soundness of the root volume)
    const c = specs[0].center;
    const h = specs[0].half;
    for (const el of Object.values(res.meta.elements)) {
      if (!el.bbox) continue;
      for (let a = 0; a < 3; a++) {
        expect(el.bbox[a]).toBeGreaterThanOrEqual(c[a] - h[a] - 1e-9);
        expect(el.bbox[a + 3]).toBeLessThanOrEqual(c[a] + h[a] + 1e-9);
      }
    }
  });
});

describe("exportTilesetFromArtifact (block-local origin rewrite)", () => {
  it("rewrites tile GLBs so transform + local offset reproduce the GLB frame", async () => {
    const { dir, meta } = await writeArtifact();
    const out = path.join(dir, "tileset");
    try {
      const { tiles } = exportTilesetFromArtifact({ artifactDir: dir, outDir: out });
      expect(tiles).toBe(meta.chunks!.length);
      const ts = JSON.parse(fs.readFileSync(path.join(out, "tileset.json"), "utf8")) as ReturnType<typeof buildTilesetJson>;

      for (const child of ts.root.children!) {
        const id = Number(child.content!.uri.match(/\d+/)![0]);
        const chunk = meta.chunks!.find((c) => c.id === id)!;
        const center: [number, number, number] = [
          (chunk.bbox[0] + chunk.bbox[3]) / 2,
          (chunk.bbox[1] + chunk.bbox[4]) / 2,
          (chunk.bbox[2] + chunk.bbox[5]) / 2,
        ];
        const half = [
          (chunk.bbox[3] - chunk.bbox[0]) / 2,
          (chunk.bbox[4] - chunk.bbox[1]) / 2,
          (chunk.bbox[5] - chunk.bbox[2]) / 2,
        ];
        const orig = readGlbFile(path.join(dir, "chunks", `${id}.glb`));
        const now = readGlbFile(path.join(out, child.content!.uri));
        expect(now.json.nodes!.length).toBe(orig.json.nodes!.length);
        for (let k = 0; k < orig.json.nodes!.length; k++) {
          const a = orig.json.nodes![k].translation!;
          const b = now.json.nodes![k].translation!;
          // recentred exactly (doubles): transform + offset == original placement
          expect(b[0]).toBeCloseTo(a[0] - center[0], 6);
          expect(b[1]).toBeCloseTo(a[1] - center[1], 6);
          expect(b[2]).toBeCloseTo(a[2] - center[2], 6);
          // local coordinates stay within the tile extent (float32-safe frame)
          expect(Math.abs(b[0])).toBeLessThanOrEqual(half[0] + 1e-6);
          expect(Math.abs(b[1])).toBeLessThanOrEqual(half[1] + 1e-6);
          expect(Math.abs(b[2])).toBeLessThanOrEqual(half[2] + 1e-6);
          // extras.bucket survives the rewrite (ranges/manifest linkage intact)
          expect(now.json.nodes![k].extras).toEqual(orig.json.nodes![k].extras);
        }
        // the tile transform itself carries the chunk centre in doubles
        expect(child.transform![12]).toBe(center[0]);
        expect(child.transform![13]).toBe(center[1]);
        expect(child.transform![14]).toBe(center[2]);
      }
      expect(fs.readdirSync(out).sort()).toEqual(["tiles", "tileset.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports a single-format artifact directory too", async () => {
    const res = await convertIfc(new Uint8Array(FIXTURE));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbim-tiles1-"));
    try {
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(res.meta));
      fs.writeFileSync(path.join(dir, "model.glb"), Buffer.from(res.glb));
      const out = path.join(dir, "tileset");
      const { tiles } = exportTilesetFromArtifact({ artifactDir: dir, outDir: out });
      expect(tiles).toBe(1);
      expect(fs.existsSync(path.join(out, "model.glb"))).toBe(true);
      expect(fs.existsSync(path.join(out, "tileset.json"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("attribute hook: tile -> chunk -> element GUIDs", () => {
  it("every tile resolves a non-empty, disjoint GUID set covering all geometry", async () => {
    const res = await convertIfc(new Uint8Array(FIXTURE), { chunking: { maxTrianglesPerChunk: 20 } });
    const meta = res.meta;
    const tiles = tileSpecsForMeta(meta).filter((s) => s.key !== "model");
    const seen = new Map<string, number>(); // guid -> tile(chunk) id
    for (const s of tiles) {
      const entry = meta.chunks!.find((c) => c.id === s.key)!;
      let count = 0;
      for (const bucketIdx of entry.buckets) {
        for (const r of meta.buckets[bucketIdx].ranges) {
          const el = meta.elements[String(r.expressID)];
          if (!el || !el.bbox) continue; // ranges for non-geometric ids have no tile claim
          expect(el.chunkId).toBe(entry.id); // consistent with the manifest side
          expect(seen.has(el.guid), `guid ${el.guid} claimed by two tiles`).toBe(false);
          seen.set(el.guid, entry.id);
          count++;
        }
      }
      expect(count).toBeGreaterThan(0);
    }
    const allGuids = Object.values(meta.elements)
      .filter((e) => e.bbox)
      .map((e) => e.guid)
      .sort();
    expect([...seen.keys()].sort()).toEqual(allGuids);
  });
});
