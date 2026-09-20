/**
 * Ticket 01 (zero-accumulation conversion memory model):
 *  - convertIfcFile must be byte-for-byte equivalent to convertIfc
 *  - step comments must survive the streaming strip path unchanged
 *  - maxVerticesPerPrimitive must seal bucket parts without losing geometry
 *  - stripStepCommentsChunk must match stripStepComments at any chunk split
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { convertIfc, convertIfcFile, stripStepComments, stripStepCommentsChunk, StripState } from "../src/convert";

const samplePath = path.join(__dirname, "fixtures", "sample-building.ifc");
const sample = fs.readFileSync(samplePath);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** stripStepComments over a buffer, without the "no comment" short-circuit, via the chunk core. */
function stripViaChunks(input: Uint8Array, chunkSize: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const state: StripState = { inString: false, inComment: false, pending: null };
  for (let off = 0; off <= input.length; off += chunkSize) {
    const chunk = input.subarray(off, Math.min(off + chunkSize, input.length));
    stripStepCommentsChunk(state, chunk, off + chunkSize >= input.length, (b) => parts.push(b.slice()));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("convertIfcFile (file pipeline parity with convertIfc)", () => {
  it("produces identical meta and byte-identical GLB", async () => {
    const dir = tmpDir("openbim-ifcfile-");
    try {
      const inputPath = path.join(dir, "sample.ifc");
      const glbPath = path.join(dir, "out.glb");
      fs.writeFileSync(inputPath, sample);

      const memory = await convertIfc(new Uint8Array(sample));
      const meta = await convertIfcFile(inputPath, glbPath);

      expect(meta).toEqual(memory.meta);
      const onDisk = fs.readFileSync(glbPath);
      expect(Buffer.compare(onDisk, Buffer.from(memory.glb))).toBe(0);
      // no temp artefacts left behind
      expect(fs.readdirSync(dir).sort()).toEqual(["out.glb", "sample.ifc"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles STEP comments through the streaming strip path", async () => {
    const dir = tmpDir("openbim-ifccomment-");
    try {
      const text = sample.toString("latin1");
      const commented = text.replace(
        "DATA;",
        "DATA;\n/* exporter banner comment */\n/* another\n   multi-line\n   comment */"
      );
      const inputPath = path.join(dir, "commented.ifc");
      fs.writeFileSync(inputPath, Buffer.from(commented, "latin1"));

      const glbPath = path.join(dir, "out.glb");
      const fileMeta = await convertIfcFile(inputPath, glbPath);
      const memory = await convertIfc(Buffer.from(commented, "latin1"));
      expect(fileMeta).toEqual(memory.meta);
      expect(fs.statSync(glbPath).size).toBe(memory.glb.byteLength);
      expect(fs.readdirSync(dir).sort()).toEqual(["commented.ifc", "out.glb"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-STEP input and leaves no output file", async () => {
    const dir = tmpDir("openbim-ifcbad-");
    try {
      const inputPath = path.join(dir, "garbage.ifc");
      fs.writeFileSync(inputPath, "not an ifc file at all");
      await expect(convertIfcFile(inputPath, path.join(dir, "out.glb"))).rejects.toThrow(/ISO-10303-21/);
      expect(fs.existsSync(path.join(dir, "out.glb"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("convertIfc bucket sealing (maxVerticesPerPrimitive)", () => {
  // no-containment fixture, but two elements forced to the same colour so one
  // (storey=null, colour) bucket holds several ranges that must be split apart
  const sharedColourSample = (() => {
    const base = fs.readFileSync(path.join(__dirname, "fixtures", "sample-building-no-containment.ifc"), "latin1");
    return Buffer.from(
      base.replace("IFCCOLOURRGB($,0.78,0.78,0.77)", "IFCCOLOURRGB($,0.7,0.7,0.7)")
        .replace("IFCCOLOURRGB($,0.55,0.55,0.55)", "IFCCOLOURRGB($,0.7,0.7,0.7)"),
      "latin1"
    );
  })();

  it("seals parts without changing geometry totals", async () => {
    const full = await convertIfc(new Uint8Array(sharedColourSample));
    const shared = full.meta.buckets.filter((b) => b.ranges.length > 1);
    expect(shared.length).toBe(1); // precondition: the fixture really shares a bucket

    const tiny = await convertIfc(new Uint8Array(sharedColourSample), { maxVerticesPerPrimitive: 1 });
    expect(tiny.meta.buckets.length).toBeGreaterThan(full.meta.buckets.length);
    for (const b of tiny.meta.buckets) expect(b.ranges.length).toBe(1);

    // stats unchanged (sealing only re-partitions the same triangles)
    expect(tiny.meta.stats).toEqual(full.meta.stats);

    // ranges stay primitive-local and contiguous inside each sealed part
    for (const bucket of tiny.meta.buckets) {
      let expectedStart = 0;
      for (const r of bucket.ranges) {
        expect(r.start).toBe(expectedStart);
        expect(r.count).toBeGreaterThan(0);
        expectedStart += r.count;
      }
    }
    // same element coverage as the unsealed conversion
    const idsOf = (m: typeof full.meta) =>
      m.buckets.flatMap((b) => b.ranges.map((r) => r.expressID)).sort((a, b) => a - b);
    expect(idsOf(tiny.meta)).toEqual(idsOf(full.meta));
  });

  it("emits one GLB mesh per sealed part", async () => {
    const tiny = await convertIfc(new Uint8Array(sharedColourSample), { maxVerticesPerPrimitive: 1 });
    const dv = new DataView(tiny.glb.buffer, tiny.glb.byteOffset, tiny.glb.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(Buffer.from(tiny.glb.subarray(20, 20 + jsonLen)).toString("utf8"));
    expect(json.meshes.length).toBe(tiny.meta.buckets.length);
    // every sealed part carries its own primitive indices
    expect(json.nodes.length).toBe(tiny.meta.buckets.length);
  });
});

describe("stripStepCommentsChunk (streaming strip core)", () => {
  const cases: Array<[string, string]> = [
    ["plain passthrough", "ISO-10303-21\n#1=IFCROOT('no comments here');\nEND-ISO-10303-21;\n"],
    ["basic comment", "A(/*c*/B); /*tail*/\n"],
    ["comment with quotes inside", "/* it''s fine, \'quoted\' */ kept 'as is'\n"],
    ["escaped quotes and false comment", "#2=Y('quote /*not*/ end');\n"],
    ["nested-looking comment markers", "/* a /* still one comment */ after\n"],
    ["string then comment", "#3='str' /*x*/ #4=END;\n"],
    ["comment before EOF without newline", "#5=X(); /*end*/"],
    ["comment unterminated", "#6=Y(); /*dangling"],
  ];

  for (const [name, text] of cases) {
    it(`chunked strip matches buffer strip: ${name}`, () => {
      const input = Buffer.from(text, "latin1");
      const buffered = stripStepComments(input);
      for (let size = 1; size <= input.length + 1; size++) {
        const chunked = stripViaChunks(new Uint8Array(input), size);
        expect(Buffer.from(chunked).toString("latin1"), `chunk size ${size}`).toBe(
          Buffer.from(buffered).toString("latin1")
        );
      }
    });
  }
});
