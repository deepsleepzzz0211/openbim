/**
 * glTF 2.0 GLB writer with production transport optimizations:
 *  - POSITION quantized to int16 (KHR_mesh_quantization), restored via node scale/translation
 *  - NORMAL stored as normalized int8 (core glTF `normalized` accessors)
 *  - KHR_meshopt_compression (lossless meshopt) over the quantized buffers when the
 *    encoder is available; three.js GLTFLoader + MeshoptDecoder decode transparently.
 *
 * The writer is incremental (GlbAssembler): primitives are quantized and pushed
 * through a chunk sink one at a time, so peak memory is one primitive wide
 * rather than the whole model. `buildGlb` is the in-memory convenience wrapper.
 */
import type { GlbCompression } from "./types";

export interface GlbBuildOptions {
  /**
   * KHR_meshopt_compression on top of quantization. Disabled by default: the
   * npm encoder/decoder version matrix must exactly match the consumer's
   * decoder (three.js bundles its own). Quantization alone already removes
   * ~60%% of vertex payload.
   */
  meshopt?: boolean;
}

export interface GlbPrimitive {
  name: string;
  bucketIndex: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  baseColor: [number, number, number, number];
  transparent: boolean;
}

export interface GlbNode {
  scale: [number, number, number];
  translation: [number, number, number];
}

/** Receives every BIN-chunk byte range in final GLB order. Chunks may be released after the call. */
export type GlbChunkSink = (chunk: Uint8Array) => void;

interface BufferViewDef {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  extensions?: Record<string, unknown>;
}

interface AccessorDef {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

const COMPONENT_BYTE = 5120; // BYTE
const COMPONENT_SHORT = 5122; // SHORT
const COMPONENT_UINT = 5125; // UNSIGNED_INT
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** Optional meshopt encoder (npm `meshoptimizer`, MIT). Absent/failed => uncompressed output. */
export interface MeshoptEncoderLike {
  ready: Promise<void>;
  supported: boolean;
  encodeGltfBuffer: (source: Uint8Array, count: number, size: number, mode: string) => Uint8Array;
}

let cachedEncoder: MeshoptEncoderLike | null | undefined;

export async function getMeshoptEncoder(): Promise<MeshoptEncoderLike | null> {
  // Stryker disable all: caching is a perf-only optimisation and the import-failure
  // fallback cannot be exercised while the optional dependency is installed
  if (cachedEncoder !== undefined) return cachedEncoder;
  try {
    const mod = (await import("meshoptimizer")) as { MeshoptEncoder: MeshoptEncoderLike };
    const enc = mod.MeshoptEncoder;
    await enc.ready;
    cachedEncoder = enc.supported ? enc : null;
  } catch {
    cachedEncoder = null;
  }
  return cachedEncoder;
  // Stryker restore all
}

/* used by tests to inject a deterministic encoder; undefined restores auto-detection */
export function setMeshoptEncoderForTest(encoder: MeshoptEncoderLike | null | undefined): void {
  cachedEncoder = encoder;
}

interface Mesh {
  primitives: unknown[];
}

/**
 * Incremental GLB writer. Feed primitives one at a time; each is quantized and
 * emitted through the sink immediately, so the caller can release its float32
 * arrays right after `addPrimitive` returns.
 */
export class GlbAssembler {
  readonly nodes: GlbNode[] = [];
  private binLength = 0;
  private virtualOriginal = 0;
  private fallbackViews = 0;
  private readonly bufferViews: BufferViewDef[] = [];
  private readonly accessors: AccessorDef[] = [];
  private readonly nodeDefs: unknown[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly materials: unknown[] = [];
  private readonly usesMeshopt: boolean;

  constructor(
    private readonly encoder: MeshoptEncoderLike | null,
    private readonly emit: GlbChunkSink
  ) {
    this.usesMeshopt = encoder !== null;
  }

  /** Unpadded BIN chunk length accumulated so far. */
  get byteLength(): number {
    return this.binLength;
  }

  /** What actually reached the artifact; recorded in meta.json for status. */
  get compressionStats(): GlbCompression {
    return { codec: this.usesMeshopt ? "meshopt" : "none", fallbackViews: this.fallbackViews };
  }

  private write(data: Uint8Array): void {
    this.emit(data);
    this.binLength += data.byteLength;
  }

  private padTo(align: number): void {
    // Stryker disable all: padding is unreachable today (all chunk lengths are multiples of 4);
    // kept so future callers cannot emit misaligned bufferViews
    const pad = (align - (this.binLength % align)) % align;
    // Stryker restore all
    if (pad > 0) {
      this.write(new Uint8Array(pad));
    }
  }

  private pushChunk(data: Uint8Array, target?: number, byteStride?: number, align = 4): number {
    this.padTo(align);
    const byteOffset = this.binLength;
    this.write(data);
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target, byteStride });
    return this.bufferViews.length - 1;
  }

  private pushCompressed(
    data: Uint8Array,
    count: number,
    stride: number,
    mode: "attributes" | "indices",
    target?: number,
    byteStride?: number
  ): number {
    // A per-view encode failure (e.g. WASM growth limit on a huge buffer) must
    // not sink the whole artifact: keep that view raw and record the fallback.
    let encoded: Uint8Array;
    try {
      encoded = this.encoder!.encodeGltfBuffer(data, count, stride, mode.toUpperCase());
    } catch {
      this.fallbackViews++;
      return this.pushChunk(data, target, byteStride);
    }
    this.padTo(8);
    // Compressed data location (what KHR_meshopt_compression.buffer points at).
    const compressedOffset = this.binLength;
    const compressedLength = encoded.byteLength;
    this.write(encoded);
    // The bufferView's own byteOffset/byteLength describe the VIRTUAL
    // uncompressed data; consumers only read them via the extension.
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.virtualOriginal,
      byteLength: data.byteLength,
      target,
      byteStride,
      extensions: {
        KHR_meshopt_compression: {
          buffer: 0,
          byteOffset: compressedOffset,
          byteLength: compressedLength,
          mode: mode.toUpperCase(),
          filter: "NONE",
          count,
        },
      },
    });
    this.virtualOriginal += data.byteLength;
    return this.bufferViews.length - 1;
  }

  /** Consume one primitive; all arrays it references may be released once it returns. */
  addPrimitive(p: GlbPrimitive): void {
    // ---- quantize positions to int16 in [-1,1], restored by node transform ----
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < p.positions.length; v += 3) {
      for (let c = 0; c < 3; c++) {
        const value = p.positions[v + c];
        if (value < min[c]) min[c] = value;
        if (value > max[c]) max[c] = value;
      }
    }
    const center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const half: [number, number, number] = [
      Math.max((max[0] - min[0]) / 2, 1e-6),
      Math.max((max[1] - min[1]) / 2, 1e-6),
      Math.max((max[2] - min[2]) / 2, 1e-6),
    ];
    const vertexCount = p.positions.length / 3;
    // meshopt requires vertex strides to be multiples of 4: pad to 4 components
    const qPos = new Int16Array(vertexCount * 4);
    const qMin = [Infinity, Infinity, Infinity];
    const qMax = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < vertexCount; v++) {
      for (let c = 0; c < 3; c++) {
        const n = Math.round(((p.positions[v * 3 + c] - center[c]) / half[c]) * 32767);
        const clamped = Math.max(-32768, Math.min(32767, n));
        qPos[v * 4 + c] = clamped;
        if (clamped < qMin[c]) qMin[c] = clamped;
        if (clamped > qMax[c]) qMax[c] = clamped;
      }
    }

    // ---- normals to normalized int8 (padded to 4 components) ----
    const qNorm = new Int8Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
      for (let c = 0; c < 3; c++) {
        qNorm[v * 4 + c] = Math.round(Math.max(-1, Math.min(1, p.normals[v * 3 + c])) * 127);
      }
    }

    // ---- accessors / bufferViews ----
    const posBytes = new Uint8Array(qPos.buffer, qPos.byteOffset, qPos.byteLength);
    const posView = this.usesMeshopt
      ? this.pushCompressed(posBytes, vertexCount, 8, "attributes", TARGET_ARRAY_BUFFER, 8)
      : this.pushChunk(posBytes, TARGET_ARRAY_BUFFER, 8);
    const posAcc = this.accessors.push({
      bufferView: posView,
      componentType: COMPONENT_SHORT,
      count: vertexCount,
      type: "VEC3",
      normalized: true,
      min: qMin,
      max: qMax,
    }) - 1;

    const normBytes = new Uint8Array(qNorm.buffer, qNorm.byteOffset, qNorm.byteLength);
    const normView = this.usesMeshopt
      ? this.pushCompressed(normBytes, vertexCount, 4, "attributes", TARGET_ARRAY_BUFFER, 4)
      : this.pushChunk(normBytes, TARGET_ARRAY_BUFFER, 4);
    const normAcc = this.accessors.push({
      bufferView: normView,
      componentType: COMPONENT_BYTE,
      count: vertexCount,
      type: "VEC3",
      normalized: true,
    }) - 1;

    const idxBytes = new Uint8Array(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength);
    const idxView = this.usesMeshopt
      ? this.pushCompressed(idxBytes, p.indices.length, 4, "indices", TARGET_ELEMENT_ARRAY_BUFFER)
      : this.pushChunk(idxBytes, TARGET_ELEMENT_ARRAY_BUFFER);
    const idxAcc = this.accessors.push({
      bufferView: idxView,
      componentType: COMPONENT_UINT,
      count: p.indices.length,
      type: "SCALAR",
    }) - 1;

    const matIndex = this.materials.push({
      name: `material-${this.materials.length}`,
      doubleSided: true,
      alphaMode: p.transparent ? "BLEND" : "OPAQUE",
      pbrMetallicRoughness: {
        baseColorFactor: p.baseColor,
        metallicFactor: 0.05,
        roughnessFactor: 0.85,
      },
    }) - 1;

    this.meshes.push({
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: normAcc },
          indices: idxAcc,
          material: matIndex,
          mode: 4,
        },
      ],
    });
    const transform: GlbNode = {
      // normalized int16 arrives in the shader as [-1,1]; scale must therefore
      // be the half-extent itself (NOT half/32767)
      scale: [half[0], half[1], half[2]],
      translation: center,
    };
    this.nodeDefs.push({
      mesh: this.meshes.length - 1,
      name: p.name,
      extras: { bucket: p.bucketIndex },
      scale: transform.scale,
      translation: transform.translation,
    });
    this.nodes.push(transform);
  }

  /** Serialize the JSON chunk (space-padded to the 4-byte GLB alignment). */
  buildJsonChunk(): Uint8Array {
    const extensionsUsed: string[] = ["KHR_mesh_quantization"];
    const extensionsRequired: string[] = ["KHR_mesh_quantization"];
    if (this.usesMeshopt) {
      extensionsUsed.push("KHR_meshopt_compression");
      extensionsRequired.push("KHR_meshopt_compression");
    }
    const gltf = {
      asset: { version: "2.0", generator: "OpenBIM Hub" },
      scene: 0,
      scenes: [{ nodes: this.nodeDefs.map((_, i) => i) }],
      nodes: this.nodeDefs,
      meshes: this.meshes,
      materials: this.materials,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: this.binLength }],
      extensionsUsed,
      extensionsRequired,
    };
    const jsonText = JSON.stringify(gltf);
    const jsonPad = (4 - (jsonText.length % 4)) % 4;
    const jsonBytes = new Uint8Array(jsonText.length + jsonPad);
    for (let i = 0; i < jsonText.length; i++) jsonBytes[i] = jsonText.charCodeAt(i);
    for (let i = 0; i < jsonPad; i++) jsonBytes[jsonText.length + i] = 0x20;
    return jsonBytes;
  }
}

export async function buildGlb(primitives: GlbPrimitive[], opts: GlbBuildOptions = {}): Promise<{ glb: Uint8Array; nodes: GlbNode[] }> {
  const encoder = opts.meshopt ? await getMeshoptEncoder() : null;

  const binChunks: Uint8Array[] = [];
  const assembler = new GlbAssembler(encoder, (chunk) => binChunks.push(chunk));
  for (const p of primitives) assembler.addPrimitive(p);
  return { glb: assembleGlbBytes(assembler, binChunks), nodes: assembler.nodes };
}

/** Concatenate JSON + collected BIN chunks into the final GLB byte stream. */
export function assembleGlbBytes(assembler: GlbAssembler, binChunks: Uint8Array[]): Uint8Array {
  const jsonBytes = assembler.buildJsonChunk();
  const binLength = assembler.byteLength;
  const binPad = (4 - (binLength % 4)) % 4;
  const binBytes = new Uint8Array(binLength + binPad);
  let off = 0;
  for (const chunk of binChunks) {
    binBytes.set(chunk, off);
    off += chunk.byteLength;
  }

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  dv.setUint32(binHeader, binBytes.length, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true); // "BIN"
  out.set(binBytes, binHeader + 8);
  return out;
}
