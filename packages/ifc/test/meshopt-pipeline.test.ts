/**
 * Ticket 04: real meshopt encode/decode roundtrip through the conversion
 * pipeline, per-view fallback on encode errors, and honest glbCompression
 * status in meta.
 */
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MeshoptDecoder } from "meshoptimizer";
import { convertIfc } from "../src/convert";
import { setMeshoptEncoderForTest, type MeshoptEncoderLike } from "../src/glb";

const SAMPLE = fs.readFileSync(path.join(__dirname, "fixtures", "sample-building.ifc"));

function parseGlb(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + jsonLen)).toString("utf8"));
  const binHeader = 20 + jsonLen;
  const binLen = dv.getUint32(binHeader, true);
  return { json, bin: glb.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

describe("meshopt compression pipeline (ticket 04)", () => {
  beforeAll(async () => {
    setMeshoptEncoderForTest(undefined); // auto-detect the real wasm encoder
    await MeshoptDecoder.ready;
  });

  it("compresses every buffer view and the decoder restores byte-identical data", async () => {
    const plain = await convertIfc(SAMPLE, { meshopt: false });
    const packed = await convertIfc(SAMPLE, { meshopt: true });

    expect(packed.meta.glbCompression).toEqual({ codec: "meshopt", fallbackViews: 0 });
    expect(plain.meta.glbCompression).toEqual({ codec: "none", fallbackViews: 0 });

    const p = parseGlb(plain.glb);
    const m = parseGlb(packed.glb);
    expect(m.json.extensionsRequired).toContain("KHR_meshopt_compression");
    expect(m.json.bufferViews.length).toBe(p.json.bufferViews.length);

    let checked = 0;
    for (let i = 0; i < m.json.bufferViews.length; i++) {
      const ext = m.json.bufferViews[i].extensions?.KHR_meshopt_compression;
      expect(ext, `view ${i} must carry the compression extension`).toBeTruthy();
      const raw = p.bin.subarray(p.json.bufferViews[i].byteOffset, p.json.bufferViews[i].byteOffset + p.json.bufferViews[i].byteLength);
      expect(ext.byteLength, `view ${i} must shrink`).toBeLessThan(raw.byteLength);

      const target = new Uint8Array(ext.count * (p.json.bufferViews[i].byteStride ?? raw.byteLength / ext.count));
      MeshoptDecoder.decodeGltfBuffer(
        target,
        ext.count,
        target.byteLength / ext.count,
        m.bin.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength),
        ext.mode,
        ext.filter
      );
      expect(Buffer.from(target).equals(Buffer.from(raw)), `view ${i} roundtrip`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("falls back to raw bytes for views whose encoding throws and records the count", async () => {
    const failing: MeshoptEncoderLike = {
      ready: Promise.resolve(),
      supported: true,
      encodeGltfBuffer: (source, _count, _size, mode) => {
        if (mode === "INDICES") throw new Error("simulated encoder failure");
        return Uint8Array.from(source, (b) => b ^ 0xa5);
      },
    };
    setMeshoptEncoderForTest(failing);
    try {
      const res = await convertIfc(SAMPLE, { meshopt: true });
      expect(res.meta.glbCompression?.codec).toBe("meshopt");
      expect(res.meta.glbCompression!.fallbackViews).toBeGreaterThanOrEqual(1);

      const g = parseGlb(res.glb);
      const idxViews = g.json.bufferViews.filter((v: any) => v.target === 34963);
      expect(idxViews.every((v: any) => !v.extensions)).toBe(true);
      const attrViews = g.json.bufferViews.filter((v: any) => v.target === 34962);
      expect(attrViews.every((v: any) => v.extensions?.KHR_meshopt_compression)).toBe(true);
    } finally {
      setMeshoptEncoderForTest(undefined);
    }
  });

  it("keeps the artifact fully uncompressed when no encoder is available", async () => {
    setMeshoptEncoderForTest(null);
    try {
      const res = await convertIfc(SAMPLE, { meshopt: true });
      expect(res.meta.glbCompression).toEqual({ codec: "none", fallbackViews: 0 });
      const g = parseGlb(res.glb);
      expect(g.json.extensionsUsed).not.toContain("KHR_meshopt_compression");
      expect(g.json.bufferViews.every((v: any) => !v.extensions)).toBe(true);
    } finally {
      setMeshoptEncoderForTest(undefined);
    }
  });
});
