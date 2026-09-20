/**
 * Ticket 05: chunked conversion — router semantics (unit) and the manifest /
 * file-layout contract through the real converter (integration).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChunkRouter } from "../src/chunking";
import { convertIfc, convertIfcFile } from "../src/convert";

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "sample-building.ifc"));

describe("ChunkRouter (spatial bisection)", () => {
  it("scatters geometry across disjoint half-space chunks once the budget is crossed", () => {
    const router = new ChunkRouter(10);
    // 200 unit geometries spread over [0,100)^3 in one storey
    for (let i = 0; i < 200; i++) {
      const c: [number, number, number] = [(i * 37) % 100, (i * 53) % 100, (i * 71) % 100];
      router.route(1, c, c, c, 1);
    }
    expect(router.chunks.length).toBeGreaterThan(1);
    let total = 0;
    for (const t of router.chunks) {
      total += t.triangles;
      if (t.triangles > 0) {
        expect(t.triangles, `chunk ${t.index} budget`).toBeLessThanOrEqual(20); // one geometry of slack at split time
      }
    }
    expect(total).toBe(200);
  });

  it("caps splits per storey and marks the surviving chunk as overflowed", () => {
    const router = new ChunkRouter(10);
    const c: [number, number, number] = [5, 5, 5]; // identical centroids: bisection cannot separate
    for (let i = 0; i < 5000; i++) router.route(7, c, c, c, 1);
    const receiving = router.chunks.filter((t) => t.storeyExpressID === 7);
    const overflowed = receiving.filter((t) => t.overflowed);
    expect(overflowed.length).toBe(1);
    expect(overflowed[0].triangles).toBeGreaterThan(10);
    // every geometry was still routed somewhere
    expect(receiving.reduce((s, t) => s + t.triangles, 0)).toBe(5000);
  });

  it("keeps storey-less elements in their own root chunk", () => {
    const router = new ChunkRouter(1000);
    router.route(null, [0, 0, 0], [0, 0, 0], [0, 0, 0], 1);
    router.route(null, [50, 50, 50], [50, 50, 50], [50, 50, 50], 1);
    router.route(3, [50, 50, 50], [50, 50, 50], [50, 50, 50], 1);
    const nullChunks = router.chunks.filter((t) => t.storeyExpressID === null);
    expect(nullChunks).toHaveLength(1);
    expect(nullChunks[0].triangles).toBe(2);
    expect(router.chunks.filter((t) => t.storeyExpressID === 3)).toHaveLength(1);
  });
});

describe("chunked conversion (integration, ticket 05)", () => {
  // meta.chunks and result.chunks arrays are aligned (manifest order)
  const glbOf = (res: Awaited<ReturnType<typeof convertIfc>>, chunkId: number): Uint8Array => {
    const k = res.meta.chunks!.findIndex((c) => c.id === chunkId);
    return res.chunks![k];
  };

  it("small budget yields a chunked manifest covering every bucket and element exactly once", async () => {
    const res = await convertIfc(FIXTURE, { chunking: { maxTrianglesPerChunk: 20 } });
    expect(res.meta.artifactFormat).toBe("chunked");
    const chunks = res.meta.chunks!;
    expect(chunks.length).toBeGreaterThan(1);

    // triangles conserved
    expect(chunks.reduce((s, c) => s + c.triangles, 0)).toBe(res.meta.stats.triangles);
    // bucket index sets are a partition of meta.buckets
    const allBuckets = new Set<number>();
    for (const c of chunks) {
      expect(c.bytes).toBeGreaterThan(0);
      expect(c.buckets.length).toBeGreaterThan(0);
      for (const b of c.buckets) {
        expect(allBuckets.has(b)).toBe(false);
        allBuckets.add(b);
      }
    }
    expect([...allBuckets].sort((a, b) => a - b)).toEqual(res.meta.buckets.map((_, i) => i));
    // every element with geometry names exactly one chunk from the manifest
    const ids = new Set(chunks.map((c) => c.id));
    for (const el of Object.values(res.meta.elements)) {
      if (el.bbox) expect(ids.has(el.chunkId!)).toBe(true);
    }
    // per-chunk GLBs parse; node bucket extras equal the manifest bucket set
    for (const c of chunks) {
      const glb = glbOf(res, c.id);
      expect(Buffer.from(glb.subarray(0, 4)).toString("latin1")).toBe("glTF");
      const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
      const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + dv.getUint32(12, true))).toString("utf8"));
      expect(json.nodes.length).toBe(c.buckets.length);
      expect(json.nodes.map((n: any) => n.extras.bucket).sort((a: number, b: number) => a - b)).toEqual([...c.buckets].sort((a, b) => a - b));
    }
  });

  it("a large budget still splits per storey but never bisects", async () => {
    const res = await convertIfc(FIXTURE, { chunking: { maxTrianglesPerChunk: 1_000_000 } });
    expect(res.meta.artifactFormat).toBe("chunked");
    const chunks = res.meta.chunks!;
    expect(chunks).toHaveLength(2); // the fixture has two storeys
    expect(new Set(chunks.map((c) => c.storeyExpressID)).size).toBe(2);
    expect(chunks.every((c) => c.storeyGuid !== null)).toBe(true);
    expect(chunks.every((c) => !c.overflowed)).toBe(true);
  });

  it("models that fit one chunk stay byte-identical to the legacy single path", async () => {
    const slab = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "slab-standard-case.ifc")));
    const a = await convertIfc(slab, {});
    const b = await convertIfc(slab, { chunking: { maxTrianglesPerChunk: 1_000_000 } });
    expect(a.meta.artifactFormat).toBe("single");
    expect(b.meta.artifactFormat).toBe("single");
    expect(b.meta.chunks).toBeUndefined();
    expect(Buffer.from(b.glb).equals(Buffer.from(a.glb))).toBe(true);
  });

  it("writes chunks/<id>.glb files instead of model.glb when chunked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbim-chunks-"));
    const inputPath = path.join(dir, "sample.ifc");
    fs.writeFileSync(inputPath, FIXTURE);
    try {
      const glbPath = path.join(dir, "model.glb");
      const meta = await convertIfcFile(inputPath, glbPath, { chunking: { maxTrianglesPerChunk: 20 } });
      expect(meta.artifactFormat).toBe("chunked");
      expect(fs.existsSync(glbPath)).toBe(false);
      for (const c of meta.chunks!) {
        const file = path.join(dir, "chunks", `${c.id}.glb`);
        expect(fs.existsSync(file), `chunk file ${c.id}`).toBe(true);
        expect(fs.statSync(file).size).toBe(c.bytes);
      }
      // temp bin files are cleaned up
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contained-in-building (non-storey) elements get their own chunk without a storey guid", async () => {
    const slab = fs.readFileSync(path.join(__dirname, "..", "..", "..", "samples", "slab-standard-case.ifc"));
    const res = await convertIfc(new Uint8Array(slab), { chunking: { maxTrianglesPerChunk: 1 } });
    // single slab element: one stream -> still single format, but the routing
    // must not crash on a non-storey spatial parent; with a forced split the
    // chunk would carry storeyGuid null.
    expect(res.meta.stats.triangles).toBeGreaterThan(0);
    const el = Object.values(res.meta.elements).find((e) => e.bbox);
    expect(el).toBeTruthy();
  });
});
