/**
 * Ticket 10: text-level per-storey preslicing + shard artifact aggregation.
 *  - presplitIfcFile slices valid STEP shards that preserve original entity ids
 *  - leftover (uncontained) entities land in a trailing shard
 *  - convertIfcFilePresplit output is consistent with a whole-model conversion:
 *    element index, spatial tree, triangle conservation, manifest contract
 *  - preslicing is streaming: peak memory stays a small fraction of the input
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { convertIfcFile } from "../src/convert";
import {
  convertIfcFilePresplit,
  presplitIfcFile,
  readGlbFile,
  splitTopLevelArgs,
} from "../src/presplit";
import type { ConversionMeta } from "../src/types";

const samplePath = path.join(__dirname, "fixtures", "sample-building.ifc");
const noContPath = path.join(__dirname, "fixtures", "sample-building-no-containment.ifc");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entityIdsOf(file: string): Set<number> {
  const text = fs.readFileSync(file, "latin1");
  const ids = new Set<number>();
  for (const m of text.matchAll(/^#(\d+)=/gm)) ids.add(Number(m[1]));
  return ids;
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = tmpDir("openbim-presplit-");
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("splitTopLevelArgs", () => {
  it("splits at top-level commas only, respecting nested parens and strings", () => {
    expect(splitTopLevelArgs("#1=X((#2,#3),#4,'a,b');")).toEqual(["(#2,#3)", "#4", "'a,b'"]);
    expect(splitTopLevelArgs("#1=X();")).toEqual([]);
  });
});

describe("presplitIfcFile (text-level slicing)", () => {
  it("emits one shard per containing structure, preserving entity ids", () => {
    withTemp((dir) => {
      const input = path.join(dir, "sample.ifc");
      fs.copyFileSync(samplePath, input);
      const shards = presplitIfcFile(input, path.join(dir, "shards"));

      expect(shards).toHaveLength(2);
      expect(shards[0].structureExpressID).toBe(24); // Ground Floor
      expect(shards[1].structureExpressID).toBe(28); // First Floor
      expect(shards[0].ownedElements).toBe(2); // wall + slab
      expect(shards[1].ownedElements).toBe(2); // wall + door

      const ids0 = entityIdsOf(shards[0].path);
      const ids1 = entityIdsOf(shards[1].path);
      // the spatial base is shared by every shard
      for (const shared of [1, 16, 20, 24, 28]) {
        expect(ids0.has(shared)).toBe(true);
        expect(ids1.has(shared)).toBe(true);
      }
      // each product lands only in its owning shard (ids verbatim)
      for (const owned of [41, 58]) {
        expect(ids0.has(owned)).toBe(true);
        expect(ids1.has(owned)).toBe(false);
      }
      for (const owned of [75, 92]) {
        expect(ids1.has(owned)).toBe(true);
        expect(ids0.has(owned)).toBe(false);
      }
      // the wall pset relationship follows #41 into shard 0 only
      expect(ids0.has(106)).toBe(true);
      expect(ids1.has(106)).toBe(false);
      // containment relationships stay shard-local
      expect(ids0.has(100)).toBe(true);
      expect(ids1.has(100)).toBe(false);

      for (const s of shards) {
        const text = fs.readFileSync(s.path, "latin1");
        expect(text.startsWith("ISO-10303-21;")).toBe(true);
        expect(text).toContain("ENDSEC;");
        expect(text).toContain("END-ISO-10303-21;");
        expect(s.sizeBytes).toBe(fs.statSync(s.path).size);
      }
    });
  });

  it("routes uncontained entities into a trailing leftover shard", () => {
    withTemp((dir) => {
      const input = path.join(dir, "nocont.ifc");
      fs.copyFileSync(noContPath, input);
      const shards = presplitIfcFile(input, path.join(dir, "shards"));

      // no containment relationships at all: everything is leftover
      expect(shards).toHaveLength(1);
      expect(shards[0].structureExpressID).toBeNull();
      const ids = entityIdsOf(shards[0].path);
      for (const owned of [41, 58, 75, 92]) expect(ids.has(owned)).toBe(true);
      for (const shared of [1, 24, 28]) expect(ids.has(shared)).toBe(true);
    });
  });

  it("rejects non-STEP input", () => {
    withTemp((dir) => {
      const input = path.join(dir, "garbage.ifc");
      fs.writeFileSync(input, "not an ifc file");
      expect(() => presplitIfcFile(input, path.join(dir, "shards"))).toThrow(/ISO-10303-21/);
    });
  });
});

describe("convertIfcFilePresplit (consistency regression vs whole-model)", () => {
  let whole: ConversionMeta;
  let merged: ConversionMeta;
  let dir: string;

  beforeAll(async () => {
    dir = tmpDir("openbim-presplit-cons-");
    const input = path.join(dir, "sample.ifc");
    fs.copyFileSync(samplePath, input);
    whole = await convertIfcFile(input, path.join(dir, "whole.glb"));
    merged = await convertIfcFilePresplit(input, path.join(dir, "model.glb"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves the element index (guid, type, storey, psets)", () => {
    expect(Object.keys(merged.elements).sort()).toEqual(Object.keys(whole.elements).sort());
    for (const key of Object.keys(whole.elements)) {
      const w = whole.elements[key];
      const m = merged.elements[key];
      expect({ ...m, bbox: undefined, chunkId: undefined }).toEqual({ ...w, bbox: undefined });
    }
  });

  it("conserves triangles and elements; spatial tree is identical", () => {
    expect(merged.stats.triangles).toBe(whole.stats.triangles);
    expect(merged.stats.elements).toBe(whole.stats.elements);
    expect(merged.spatial).toEqual(whole.spatial);
    expect(merged.schema).toBe(whole.schema);
    expect(merged.units).toEqual(whole.units);
  });

  it("keeps per-(storey, colour) buckets identical to the whole model", () => {
    const sig = (m: ConversionMeta) =>
      m.buckets
        .map((b) => `${b.storeyExpressID}|${b.color.map((c) => c.toFixed(3)).join(",")}|${b.transparent}`)
        .sort();
    expect(sig(merged)).toEqual(sig(whole));
  });

  it("emits a manifest-contract chunked artifact with exact bucket partitioning", () => {
    expect(merged.artifactFormat).toBe("chunked");
    const chunks = merged.chunks!;
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => i));

    const seen = new Set<number>();
    for (const c of chunks) {
      expect(c.triangles).toBeGreaterThan(0);
      expect(c.bbox.every((v) => Number.isFinite(v))).toBe(true);
      expect(fs.statSync(path.join(dir, "chunks", `${c.id}.glb`)).size).toBe(c.bytes);
      for (const b of c.buckets) {
        expect(seen.has(b)).toBe(false); // disjoint
        seen.add(b);
        expect(b).toBeLessThan(merged.buckets.length);
      }
    }
    expect(seen.size).toBe(merged.buckets.length); // complete cover
    expect(chunks.reduce((s, c) => s + c.triangles, 0)).toBe(merged.stats.triangles);
    expect(fs.existsSync(path.join(dir, "model.glb"))).toBe(false);
  });

  it("maps element chunkIds into the merged manifest", () => {
    for (const el of Object.values(merged.elements)) {
      if (el.chunkId === undefined) continue;
      expect(el.chunkId).toBeGreaterThanOrEqual(0);
      expect(el.chunkId).toBeLessThan(merged.chunks!.length);
    }
  });

  it("keeps world-space bboxes consistent (frame + origin lands on the same world)", () => {
    for (const key of Object.keys(whole.elements)) {
      const w = whole.elements[key];
      const m = merged.elements[key];
      if (!w.bbox || !m.bbox) {
        expect(Boolean(w.bbox)).toBe(Boolean(m.bbox));
        continue;
      }
      for (let k = 0; k < 6; k++) {
        const axis = k % 3;
        const ww = w.bbox[k] + whole.origin[axis];
        const mw = m.bbox[k] + merged.origin[axis];
        expect(Math.abs(ww - mw), `${key} bbox[${k}]`).toBeLessThan(1e-3);
      }
    }
  });

  it("chunk GLBs load and reference global bucket indices", () => {
    const referenced = new Set<number>();
    for (const c of merged.chunks!) {
      const doc = readGlbFile(path.join(dir, "chunks", `${c.id}.glb`));
      expect((doc.json.nodes ?? []).length).toBeGreaterThan(0);
      let bucketNodes = 0;
      for (const node of doc.json.nodes ?? []) {
        if (node.extras && typeof node.extras.bucket === "number") {
          referenced.add(node.extras.bucket);
          bucketNodes++;
        }
      }
      expect(bucketNodes).toBe(c.buckets.length);
    }
    expect(referenced.size).toBe(merged.buckets.length);
  });
});

describe("presplit parity for a leftover-only file", () => {
  it("single-shard presplit equals the whole-model conversion", async () => {
    const dir = tmpDir("openbim-presplit-rest-");
    try {
      const input = path.join(dir, "nocont.ifc");
      fs.copyFileSync(noContPath, input);
      const whole = await convertIfcFile(input, path.join(dir, "whole.glb"));
      const merged = await convertIfcFilePresplit(input, path.join(dir, "model.glb"));
      expect(merged.artifactFormat).toBe("single");
      expect(merged.chunks ?? []).toHaveLength(0);
      // JSON round-trip normalises -0 → 0 (the aggregation path serialises)
      expect(JSON.parse(JSON.stringify(merged))).toEqual(JSON.parse(JSON.stringify(whole)));
      // GLB bytes may differ in JSON padding only: compare parsed doc + BIN
      const a = readGlbFile(path.join(dir, "model.glb"));
      const b = readGlbFile(path.join(dir, "whole.glb"));
      expect(a.json).toEqual(b.json);
      expect(Buffer.compare(a.bin, b.bin)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("presplit streaming memory profile", () => {
  /** synthetic multi-storey STEP: `storeys` x `perStorey` contained walls, each
   * with a padded cartesian point so the file reaches tens of MB cheaply. */
  function synthIfc(storeys: number, perStorey: number): string {
    const out: string[] = [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('synth'),'2;1');",
      "FILE_NAME('synth.ifc','2026-01-01T00:00:00',('t'),('t'),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      "ENDSEC;",
      "DATA;",
      "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Synth',$,$,$,$,($),$);",
      "#2=IFCSITE('1sQPDPPXvATBmG_rT2sJiC',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('2rSmgPPXvATBmG_rT2sJiC',$,'Bldg',$,$,$,$,$,.ELEMENT.,$,$,$);",
    ];
    let id = 100;
    const storeyIds: number[] = [];
    const pad = Array.from({ length: 40 }, (_, i) => `${(i * 0.0123).toFixed(4)}`).join(",");
    for (let st = 0; st < storeys; st++) {
      const storeyId = id++;
      storeyIds.push(storeyId);
      out.push(`#${storeyId}=IFCBUILDINGSTOREY('s${st}000000000000000000',$,'Floor ${st}',$,$,$,$,$,.ELEMENT.,${st * 3.5}.);`);
      const elements: number[] = [];
      for (let e = 0; e < perStorey; e++) {
        const elId = id++;
        const ptId = id++;
        elements.push(elId);
        out.push(`#${ptId}=IFCCARTESIANPOINT((${pad}));`);
        out.push(`#${elId}=IFCWALL('w${st}${e}00000000000000000',$,'W${st}-${e}',$,'',$,#${ptId},$,$);`);
      }
      const relId = id++;
      out.push(`#${relId}=IFCRELCONTAINEDINSPATIALSTRUCTURE('r${st}00000000000000000',$,$,$,(${elements.map((x) => `#${x}`).join(",")}),#${storeyId});`);
    }
    out.push(`#${id++}=IFCRELAGGREGATES('a00000000000000000000000',$,$,$,#1,(#2));`);
    out.push(`#${id++}=IFCRELAGGREGATES('a10000000000000000000000',$,$,$,#2,(#3));`);
    out.push(`#${id++}=IFCRELAGGREGATES('a20000000000000000000000',$,$,$,#3,(${storeyIds.map((x) => `#${x}`).join(",")}));`);
    out.push("ENDSEC;", "END-ISO-10303-21;", "");
    return out.join("\n");
  }

  it("live peak stays under 2x the source on a ~34 MB multi-storey file", () => {
    return withTemp((dir) => {
      const storeys = 60;
      const perStorey = 1500;
      const input = path.join(dir, "synth.ifc");
      fs.writeFileSync(input, synthIfc(storeys, perStorey));
      const size = fs.statSync(input).size;
      expect(size).toBeGreaterThan(20 << 20); // sanity: a real tens-of-MB source

      // run in a child process so the generator's own allocations (a ~2× file
      // JS string) can't pollute the measurement. live-heap (heapUsed+external)
      // after a forced gc is deterministic; RSS is not (Windows keeps freed,
      // fragmented pages resident, so it reads as a runaway peak at random).
      const mod = path.join(__dirname, "..", "dist", "presplit.js");
      expect(fs.existsSync(mod), "packages/ifc must be built before the memory test").toBe(true);
      const code = [
        "const [input, out, mod] = process.argv.slice(1);",
        "const sample = () => { if (global.gc) global.gc(); const u = process.memoryUsage(); return u.heapUsed + u.external; };",
        "const base = sample();",
        "let peak = base;",
        "const m = require(mod);",
        "const shards = m.presplitIfcFile(input, out, { onProgress: () => { peak = Math.max(peak, sample()); } });",
        "peak = Math.max(peak, sample());",
        "process.stdout.write(JSON.stringify({ base, peak, shards: shards.length }));",
      ].join("\n");
      const run = spawnSync(process.execPath, ["--expose-gc", "-e", code, input, path.join(dir, "shards"), mod], {
        encoding: "utf8",
        maxBuffer: 16 << 20,
      });
      expect(run.status, run.stderr).toBe(0);
      const res = JSON.parse(run.stdout) as { base: number; peak: number; shards: number };
      expect(res.shards).toBe(storeys);

      const growth = res.peak - res.base;
      // streaming keeps only a ~60 B/statement table (plus fixed read buffers):
      // well under 2x the source. A DOM-style implementation holds the whole
      // file as a UTF-16 JS string + per-line copies, i.e. 4x+ of the source.
      expect(growth, `child live heap grew ${(growth >> 20) + 1} MB on a ${(size >> 20) + 1} MB source`).toBeLessThan(2 * size);
    });
  }, 300_000);
});
