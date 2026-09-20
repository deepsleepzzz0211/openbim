import { describe, expect, it } from "vitest";
import { buildGlb, setMeshoptEncoderForTest, type GlbPrimitive, type MeshoptEncoderLike } from "../src/glb";

const prim = (i: number, transparent = false): GlbPrimitive => ({
  name: `bucket-${i}`,
  bucketIndex: i,
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  baseColor: [0.5, 0.5, 0.5, transparent ? 0.4 : 1],
  transparent,
});

/** A pass-through encoder that mimics meshoptimizer's calling convention. */
const fakeEncoder: MeshoptEncoderLike = {
  ready: Promise.resolve(),
  supported: true,
  encodeGltfBuffer: (source) => {
    // "compress" by reversing the bytes — round-trip must still be verified via real encoder in convert tests
    return Uint8Array.from(source, (b) => b ^ 0xff);
  },
};

function parseGlb(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // magic
  expect(dv.getUint32(4, true)).toBe(2); // version
  expect(dv.getUint32(8, true)).toBe(glb.length);
  const jsonLen = dv.getUint32(12, true);
  expect(jsonLen % 4).toBe(0);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
  const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + jsonLen)).toString("utf8"));
  const binHeader = 20 + jsonLen;
  const binLen = dv.getUint32(binHeader, true);
  expect(dv.getUint32(binHeader + 4, true)).toBe(0x004e4942); // "BIN"
  expect(binLen % 4).toBe(0);
  expect(12 + 8 + jsonLen + 8 + binLen).toBe(glb.length);
  return { json, bin: glb.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

describe("GLB writer (quantized)", () => {
  it("writes quantized accessors with node transforms restoring world space", async () => {
    const { glb, nodes } = await buildGlb([prim(0)]);
    const { json } = parseGlb(glb);

    expect(json.extensionsUsed).toContain("KHR_mesh_quantization");
    expect(json.extensionsRequired).toContain("KHR_mesh_quantization");
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(pos.componentType).toBe(5122); // SHORT
    expect(pos.normalized).toBe(true);
    const norm = json.accessors[json.meshes[0].primitives[0].attributes.NORMAL];
    expect(norm.componentType).toBe(5120); // BYTE
    expect(norm.normalized).toBe(true);

    // world span 1m on each axis => scale = half-extent = 0.5, translation = center = 0.5
    const [sx] = nodes[0].scale;
    expect(sx).toBeCloseTo(0.5, 5);
    expect(nodes[0].translation[0]).toBeCloseTo(0.5, 5);
    // nodes carry the scale/translation for three.js to apply
    expect(json.nodes[0].scale).toEqual(nodes[0].scale);
    expect(json.nodes[0].translation).toEqual(nodes[0].translation);
  });

  it("applies KHR_meshopt_compression when an encoder is available", async () => {
    setMeshoptEncoderForTest(fakeEncoder);
    try {
      const { glb } = await buildGlb([prim(0)], { meshopt: true });
      const { json } = parseGlb(glb);
      expect(json.extensionsUsed).toContain("KHR_meshopt_compression");
      expect(json.extensionsRequired).toContain("KHR_meshopt_compression");
      const compressed = json.bufferViews.filter((v: any) => v.extensions?.KHR_meshopt_compression);
      expect(compressed).toHaveLength(3); // pos + normal + indices
      expect(compressed[0].extensions.KHR_meshopt_compression.buffer).toBe(0);
      expect(compressed[0].extensions.KHR_meshopt_compression.mode).toBe("ATTRIBUTES"); // spec uses uppercase enums
      // compressed offset must land inside the real data buffer
      expect(compressed[0].extensions.KHR_meshopt_compression.byteOffset).toBeLessThan(json.buffers[0].byteLength);
      expect(compressed[2].extensions.KHR_meshopt_compression.mode).toBe("INDICES");
      // compressed offsets are 8-byte aligned
      for (const v of compressed) expect(v.byteOffset % 8).toBe(0);
      // byteStride preserved for vertex streams
      expect(compressed[0].byteStride).toBe(8);
      expect(compressed[1].byteStride).toBe(4);
    } finally {
      setMeshoptEncoderForTest(undefined); // restore auto-detection
    }
  });

  it("falls back to uncompressed bufferViews without an encoder", async () => {
    setMeshoptEncoderForTest(null);
    try {
      const { glb } = await buildGlb([prim(0)]);
      const { json } = parseGlb(glb);
      expect(json.extensionsUsed).not.toContain("KHR_meshopt_compression");
      expect(json.bufferViews.every((v: any) => !v.extensions)).toBe(true);
      expect(json.buffers).toHaveLength(1);
    } finally {
      setMeshoptEncoderForTest(undefined as unknown as null);
    }
  });

  it("emits one node/mesh/material per bucket with extras", async () => {
    const { glb } = await buildGlb([prim(0), prim(1, true)]);
    const { json } = parseGlb(glb);
    expect(json.nodes).toHaveLength(2);
    expect(json.meshes).toHaveLength(2);
    expect(json.materials).toHaveLength(2);
    expect(json.nodes[0].extras.bucket).toBe(0);
    expect(json.materials[1].alphaMode).toBe("BLEND");
    expect(json.materials[0].alphaMode).toBe("OPAQUE");
  });
});

describe("GLB writer: exact JSON contract", () => {
  it("emits the full glTF JSON for a single opaque primitive (no meshopt)", async () => {
    setMeshoptEncoderForTest(null);
    try {
      const { glb, nodes } = await buildGlb([
        {
          name: "bucket-7",
          bucketIndex: 7,
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: Uint32Array.from([0, 1, 2]),
          baseColor: [0.25, 0.5, 0.75, 1],
          transparent: false,
        },
      ]);
      const { json, bin } = parseGlb(glb);
      expect(json).toEqual({
        asset: { version: "2.0", generator: "OpenBIM Hub" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            mesh: 0,
            name: "bucket-7",
            extras: { bucket: 7 },
            scale: [0.5, 0.5, 1e-6], // z is degenerate (all z equal) -> clamped to 1e-6
            translation: [0.5, 0.5, 0],
          },
        ],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0, NORMAL: 1 },
                indices: 2,
                material: 0,
                mode: 4,
              },
            ],
          },
        ],
        materials: [
          {
            name: "material-0",
            doubleSided: true,
            alphaMode: "OPAQUE",
            pbrMetallicRoughness: {
              baseColorFactor: [0.25, 0.5, 0.75, 1],
              metallicFactor: 0.05,
              roughnessFactor: 0.85,
            },
          },
        ],
        accessors: [
          {
            bufferView: 0,
            componentType: 5122,
            count: 3,
            type: "VEC3",
            normalized: true,
            min: [-32767, -32767, 0],
            max: [32767, 32767, 0],
          },
          { bufferView: 1, componentType: 5120, count: 3, type: "VEC3", normalized: true },
          { bufferView: 2, componentType: 5125, count: 3, type: "SCALAR" },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 24, target: 34962, byteStride: 8 },
          { buffer: 0, byteOffset: 24, byteLength: 12, target: 34962, byteStride: 4 },
          { buffer: 0, byteOffset: 36, byteLength: 12, target: 34963 },
        ],
        buffers: [{ byteLength: 48 }],
        extensionsUsed: ["KHR_mesh_quantization"],
        extensionsRequired: ["KHR_mesh_quantization"],
      });
      expect(nodes[0].scale).toEqual([0.5, 0.5, 1e-6]);
      expect(bin.byteLength).toBe(48);
    } finally {
      setMeshoptEncoderForTest(undefined);
    }
  });

  it("handles degenerate flat geometry (zero-extent axis clamps to 1e-6)", async () => {
    const { nodes } = await buildGlb([
      {
        name: "flat",
        bucketIndex: 0,
        positions: Float32Array.from([2, 3, 5, 2, 3, 5, 2, 3, 5]), // single point repeated
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        baseColor: [0, 0, 0, 1],
        transparent: false,
      },
    ]);
    expect(nodes[0].scale).toEqual([1e-6, 1e-6, 1e-6]);
    expect(nodes[0].translation).toEqual([2, 3, 5]);
  });

  it("clamps normals outside [-1, 1] to the normalized int8 range", async () => {
    const { glb } = await buildGlb([
      {
        name: "n",
        bucketIndex: 0,
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: Float32Array.from([2, -2, 1, 0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        baseColor: [0, 0, 0, 1],
        transparent: false,
      },
    ]);
    const { json, bin } = parseGlb(glb);
    const normView = json.bufferViews[json.accessors[json.meshes[0].primitives[0].attributes.NORMAL].bufferView];
    const normData = new Int8Array(bin.buffer, bin.byteOffset + normView.byteOffset, 12);
    expect(Array.from(normData.subarray(0, 4))).toEqual([127, -127, 127, 0]);
  });

  it("returns empty scenes/buffers for zero primitives", async () => {
    const { glb, nodes } = await buildGlb([]);
    const { json } = parseGlb(glb);
    expect(json.nodes).toEqual([]);
    expect(json.meshes).toEqual([]);
    expect(json.materials).toEqual([]);
    expect(json.scenes[0].nodes).toEqual([]);
    expect(json.buffers[0].byteLength).toBe(0);
    expect(nodes).toEqual([]);
    expect(json.extensionsUsed).toEqual(["KHR_mesh_quantization"]);
  });
});
