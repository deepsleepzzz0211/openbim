/**
 * IFC -> GLB + metadata conversion pipeline.
 *
 * Runs web-ifc (WASM) entirely on the caller's thread; apps/api runs this inside
 * a worker thread so the API process never loads WASM.
 *
 * web-ifc 0.0.77 semantics used here (verified against the package):
 *  - `GetLine(id, true)` returns fully expanded objects; referenced entities are
 *    inlined with their own `expressID` instead of being raw references.
 *  - Geometry vertex buffers are 6-float interleaved [px,py,pz,nx,ny,nz] and are
 *    already normalised to metres and the Y-up (glTF) convention; placements'
 *    rotations are baked into the vertices, `flatTransformation` carries the
 *    remaining translation.
 *  - `GetCoordinationMatrix()` returns a 16-float column-major matrix.
 */
import { IfcAPI, LoaderSettings, IFCPROJECT, IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES, IFCPROJECTEDCRS, IFCMAPCONVERSION } from "web-ifc";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { guidExpand, isValidIfcGuid } from "./guid";
import { GlbAssembler, GlbPrimitive, assembleGlbBytes, getMeshoptEncoder } from "./glb";
import { ChunkRouter } from "./chunking";
import { Float32Builder, Uint32Builder } from "./builders";
import {
  ChunkManifestEntry,
  ConversionCrs,
  ConversionMeta,
  ConversionResult,
  ElementMeta,
  GlbCompression,
  GeometryBucket,
  SpatialNode,
} from "./types";

// web-ifc ships separate browser/node entries; the CJS require hook always
// resolves the node build, so this package must be consumed as CommonJS.
const require_ = createRequire(__filename);

export { guidExpand, isValidIfcGuid, IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES };

export class IfcConversionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "WASM_INIT_FAILED"
      | "PARSE_FAILED"
      | "EMPTY_MODEL"
      | "UNKNOWN" = "UNKNOWN"
  ) {
    super(message);
    this.name = "IfcConversionError";
  }
}

let apiPromise: Promise<IfcAPI> | null = null;

/** Lazily initialised web-ifc API bound to the node WASM binary. */
export function getIfcApi(): Promise<IfcAPI> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const api = new IfcAPI();
      try {
        const wasmPath = path.dirname(require_.resolve("web-ifc/web-ifc-node.wasm"));
        api.SetWasmPath(wasmPath + path.sep, true);
      } catch {
        // fall back to web-ifc's default scriptDirectory lookup
      }
      await api.Init();
      return api;
    })().catch((err: Error) => {
      apiPromise = null;
      throw new IfcConversionError(`web-ifc init failed: ${err.message}`, "WASM_INIT_FAILED");
    });
  }
  return apiPromise;
}

/** Reset the cached API instance (useful in tests / worker shutdown). */
export function disposeIfcApi(): void {
  apiPromise = null;
}

const PREFIX_TO_METRE: Record<string, number> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
};

const METRE_UNITS: Record<string, number> = {
  METRE: 1,
  FOOT: 0.3048,
  INCH: 0.0254,
  MILLIMETRE: 1e-3,
  CENTIMETRE: 1e-2,
};

/** Unwrap a flattened web-ifc select/enum value ({type, value} | primitive). */
function raw(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

function str(v: unknown): string | null {
  const r = raw(v);
  return typeof r === "string" ? r : null;
}

/**
 * Resolve a reference to an expressID. In flattened web-ifc lines references
 * arrive either as inlined objects carrying `expressID` or as {type: REF, value}.
 */
function refId(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    const o = v as { value?: unknown; expressID?: unknown; type?: unknown };
    if (typeof o.expressID === "number") return o.expressID;
    if (o.type === 5 && typeof o.value === "number") return o.value; // REF
    if (typeof o.value === "number") return o.value;
  }
  return null;
}

/** Column-major 4x4 multiply: out = a * b (a applied after b). */
function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

interface BucketData extends GeometryBucket {
  positions: Float32Builder;
  normals: Float32Builder;
  indices: Uint32Builder;
}

export interface ConvertOptions {
  /** Throttled progress callback: 0..100 while geometry is streamed. */
  onProgress?: (percent: number, index: number, total: number) => void;
  /**
   * A geometry bucket is flushed as one GLB primitive once its vertex count
   * reaches this bound; the bucket's float32 builders are then released to the
   * garbage collector, keeping peak conversion memory independent of model
   * size. Sealed parts of the same (storey, color) bucket each get their own
   * meta bucket entry, so ranges stay primitive-local.
   */
  maxVerticesPerPrimitive?: number;
  /** Explicit web-ifc loader knobs (defaults keep 0.0.77 behaviour but are pinned). */
  loader?: { memoryLimitBytes?: number; circleSegments?: number };
  /** Apply KHR_meshopt_compression on top of quantization (default false). */
  meshopt?: boolean;
  /**
   * Split the artifact into per-storey GLB chunks (ticket 05). A storey chunk
   * that exceeds the triangle budget is spatially bisected; a model that ends
   * up in a single chunk is still emitted in the legacy single-file format.
   */
  chunking?: { maxTrianglesPerChunk: number };
}

const DEFAULT_MAX_VERTICES_PER_PRIMITIVE = 1 << 20;
const DEFAULT_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

function loaderSettings(opts: ConvertOptions): LoaderSettings {
  const settings: LoaderSettings = {
    COORDINATE_TO_ORIGIN: true,
    MEMORY_LIMIT: opts.loader?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
  };
  if (opts.loader?.circleSegments !== undefined) settings.CIRCLE_SEGMENTS = opts.loader.circleSegments;
  return settings;
}

/** Entity types that must not contribute renderable geometry. */
const GEOMETRY_SKIP_TYPES = new Set(["IFCSPACE", "IFCOPENINGELEMENT"]);

/** Parse an EPSG registry code out of an IfcProjectedCRS name ("EPSG:25832", "25832"). */
export function parseEpsgCode(name: string | null): number | null {
  if (!name) return null;
  const labelled = name.match(/\bEPSG\s*[:=]?\s*(\d{4,6})\b/i);
  if (labelled) return Number(labelled[1]);
  const bare = name.trim().match(/^(\d{4,6})$/);
  return bare ? Number(bare[1]) : null;
}

/**
 * Strip STEP `/* ... *​/` comments (outside string literals). Several exporters
 * (buildingSMART test suite among them) emit commented lines that web-ifc's
 * parser rejects as "Invalid IFC Line", silently dropping relationships.
 */
export function stripStepComments(input: Uint8Array): Uint8Array {
  let hasComment = false;
  for (let i = 0; i < input.length - 1; i++) {
    if (input[i] === 0x2f && input[i + 1] === 0x2a) {
      hasComment = true;
      break;
    }
  }
  if (!hasComment) return input;

  const parts: Uint8Array[] = [];
  const state: StripState = { inString: false, inComment: false, pending: null };
  stripStepCommentsChunk(state, input, true, (b) => parts.push(b));
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Carry-over state for chunked STEP comment stripping. */
export interface StripState {
  inString: boolean;
  inComment: boolean;
  /** last byte of the previous chunk, not yet processed (needs one-byte lookahead) */
  pending: number | null;
}

/**
 * Stateful chunk of {@link stripStepComments}: feed sequential file chunks with
 * `isLast` on the final one; emits stripped bytes (never the 0xFF end sentinel).
 */
export function stripStepCommentsChunk(
  state: StripState,
  chunk: Uint8Array,
  isLast: boolean,
  emit: (bytes: Uint8Array) => void
): void {
  const extra = (state.pending === null ? 0 : 1) + (isLast ? 1 : 0);
  if (chunk.length === 0 && !isLast) return; // nothing new to resolve
  const work = new Uint8Array(chunk.length + extra);
  let w = 0;
  if (state.pending !== null) work[w++] = state.pending;
  work.set(chunk, w);
  w += chunk.length;
  if (isLast) work[w++] = 0xff; // sentinel: no STEP byte equals 0xFF

  const out = new Uint8Array(work.length);
  let o = 0;
  // the trailing byte is only ever a lookahead (real next byte, or the 0xFF
  // sentinel on the final chunk) and is never emitted as `c` itself
  const limit = work.length - 1;
  let consumedLast = false;
  for (let i = 0; i < limit; i++) {
    const c = work[i];
    const next = work[i + 1];
    if (state.inComment) {
      if (c === 0x2a && next === 0x2f) {
        state.inComment = false;
        if (++i >= limit) consumedLast = true;
      }
      continue;
    }
    if (state.inString) {
      out[o++] = c;
      if (c === 0x27) {
        if (next === 0x27) {
          out[o++] = work[++i]; // escaped quote ''
          if (i >= limit) consumedLast = true;
        } else {
          state.inString = false;
        }
      }
      continue;
    }
    if (c === 0x27) {
      state.inString = true;
      out[o++] = c;
      continue;
    }
    if (c === 0x2f && next === 0x2a) {
      state.inComment = true;
      if (++i >= limit) consumedLast = true;
      continue;
    }
    out[o++] = c;
  }
  if (o > 0) emit(out.subarray(0, o));
  state.pending = isLast || consumedLast ? null : work[work.length - 1];
}

export async function convertIfc(input: Uint8Array, opts: ConvertOptions = {}): Promise<ConversionResult> {
  const api = await getIfcApi();

  // Fail fast on non-STEP input: OpenModel on garbage can hang the WASM heap.
  const header = Buffer.from(input.subarray(0, 16)).toString("latin1");
  if (!header.startsWith("ISO-10303-21")) {
    throw new IfcConversionError("input is not an IFC (ISO-10303-21) file", "PARSE_FAILED");
  }

  let modelID: number;
  try {
    modelID = api.OpenModel(stripStepComments(input), loaderSettings(opts));
  } catch (err) {
    throw new IfcConversionError(`OpenModel failed: ${(err as Error).message}`, "PARSE_FAILED");
  }
  if (modelID < 0) {
    throw new IfcConversionError("OpenModel returned no model handle", "PARSE_FAILED");
  }

  const encoder = opts.meshopt ? await getMeshoptEncoder() : null;
  const perChunk = new Map<number, { asm: GlbAssembler; bins: Uint8Array[] }>();
  const makeAssembler = (chunkIndex: number): GlbAssembler => {
    const bins: Uint8Array[] = [];
    const asm = new GlbAssembler(encoder, (chunk) => bins.push(chunk));
    perChunk.set(chunkIndex, { asm, bins });
    return asm;
  };
  try {
    const schema = api.GetModelSchema(modelID) || "IFC4";
    const meta = await convertOpen(api, modelID, schema, opts, makeAssembler);
    const build = (id: number): Uint8Array => {
      const e = perChunk.get(id)!;
      return assembleGlbBytes(e.asm, e.bins);
    };
    if (meta.artifactFormat === "chunked" && meta.chunks) {
      const chunks = meta.chunks.map((c) => build(c.id));
      chunks.forEach((g, k) => {
        meta.chunks![k].bytes = g.byteLength;
      });
      return { glb: new Uint8Array(0), meta, chunks };
    }
    return { glb: build(0), meta };
  } finally {
    api.CloseModel(modelID);
  }
}

/**
 * File-based conversion: the IFC is paged into WASM through a byte-range
 * callback (no whole-file JS buffer) and quantized GLB chunks are written
 * straight to disk, so peak memory is bounded by the primitive flush
 * threshold rather than by the model size.
 */
export async function convertIfcFile(inputPath: string, glbPath: string, opts: ConvertOptions = {}): Promise<ConversionMeta> {
  const api = await getIfcApi();
  fs.mkdirSync(path.dirname(glbPath), { recursive: true });

  const size = fs.statSync(inputPath).size;
  const srcFd = fs.openSync(inputPath, "r");
  let effectiveFd = srcFd;
  let strippedPath: string | null = null;
  let modelID = -1;
  interface ChunkFile {
    asm: GlbAssembler;
    fd: number;
    temp: string;
  }
  const chunkFiles = new Map<number, ChunkFile>();
  try {
    const header = Buffer.alloc(16);
    fs.readSync(srcFd, header, 0, 16, 0);
    if (!header.subarray(0, 16).toString("latin1").startsWith("ISO-10303-21")) {
      throw new IfcConversionError("input is not an IFC (ISO-10303-21) file", "PARSE_FAILED");
    }

    if (hasStepComments(srcFd, size)) {
      strippedPath = path.join(os.tmpdir(), `openbim-strip-${path.basename(inputPath)}.${Date.now()}.ifc`);
      stripStepCommentsToFile(srcFd, size, strippedPath);
      fs.closeSync(srcFd);
      effectiveFd = fs.openSync(strippedPath, "r");
    }

    // web-ifc asks for one 64 MiB block; the glue copies out immediately and
    // reports our short reads back to WASM, so serve it from a small scratch.
    const SCRATCH_BYTES = 4 * 1024 * 1024;
    let scratch: Buffer | null = null;
    try {
      modelID = api.OpenModelFromCallback((offset, readSize) => {
        if (!scratch) scratch = Buffer.allocUnsafe(SCRATCH_BYTES);
        const want = Math.min(readSize, SCRATCH_BYTES);
        let done = 0;
        while (done < want) {
          const n = fs.readSync(effectiveFd, scratch, done, want - done, offset + done);
          if (n <= 0) break;
          done += n;
        }
        return scratch.subarray(0, done);
      }, loaderSettings(opts));
    } catch (err) {
      throw new IfcConversionError(`OpenModel failed: ${(err as Error).message}`, "PARSE_FAILED");
    }
    if (modelID < 0) {
      throw new IfcConversionError("OpenModel returned no model handle", "PARSE_FAILED");
    }

    const encoder = opts.meshopt ? await getMeshoptEncoder() : null;
    const makeAssembler = (chunkIndex: number): GlbAssembler => {
      const temp = `${glbPath}.chunk-${chunkIndex}.bin.tmp`; // chunkIndex: router-assigned integer
      const fd = fs.openSync(temp, "w+");
      const asm = new GlbAssembler(encoder, makeFdWriter(fd));
      chunkFiles.set(chunkIndex, { asm, fd, temp });
      return asm;
    };
    let meta: ConversionMeta;
    try {
      const schema = api.GetModelSchema(modelID) || "IFC4";
      meta = await convertOpen(api, modelID, schema, opts, makeAssembler);
    } finally {
      api.CloseModel(modelID);
      modelID = -1;
    }
    if (meta.artifactFormat === "chunked" && meta.chunks) {
      // chunked layout: <dir of glbPath>/chunks/<id>.glb, no model.glb
      const chunkDir = path.join(path.dirname(glbPath), "chunks");
      fs.mkdirSync(chunkDir, { recursive: true });
      for (const entry of meta.chunks) {
        const cf = chunkFiles.get(entry.id);
        if (!cf) throw new IfcConversionError(`missing chunk stream ${entry.id}`, "UNKNOWN");
        const dest = path.join(chunkDir, `${entry.id}.glb`); // entry.id: numeric, router-assigned
        writeGlbToFile(dest, cf.asm, cf.fd);
        entry.bytes = fs.statSync(dest).size;
      }
      // stale single-file artifact from a previous (sub-threshold) run
      fs.rmSync(glbPath, { force: true });
    } else {
      writeGlbToFile(glbPath, chunkFiles.get(0)!.asm, chunkFiles.get(0)!.fd);
      // stale chunk dir from a previous chunked conversion (reconvert)
      fs.rmSync(path.join(path.dirname(glbPath), "chunks"), { recursive: true, force: true });
    }
    return meta;
  } finally {
    if (modelID >= 0) api.CloseModel(modelID);
    for (const cf of chunkFiles.values()) {
      try {
        fs.closeSync(cf.fd);
      } catch {
        // already closed on the success path
      }
      fs.rmSync(cf.temp, { force: true });
    }
    if (strippedPath) {
      fs.closeSync(effectiveFd);
      fs.rmSync(strippedPath, { force: true });
    }
    try {
      fs.closeSync(srcFd);
    } catch {
      // already closed on the stripped-input path
    }
  }
}

function makeFdWriter(fd: number): (data: Uint8Array) => void {
  let pos = 0;
  return (data) => {
    let off = 0;
    while (off < data.byteLength) {
      // explicit position keeps writes sequential even on "w"-opened fds
      const n = fs.writeSync(fd, data, off, data.byteLength - off, pos);
      off += n;
      pos += n;
    }
  };
}

function writeGlbToFile(glbPath: string, assembler: GlbAssembler, binFd: number): void {
  const jsonBytes = assembler.buildJsonChunk();
  const binLength = assembler.byteLength;
  const binPad = (4 - (binLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + 8 + binLength + binPad;

  const out = fs.openSync(glbPath, "w");
  const writeOut = makeFdWriter(out);
  try {
    const head = new Uint8Array(20);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x46546c67, true); // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true); // "JSON"
    writeOut(head);
    writeOut(jsonBytes);
    const binHead = new Uint8Array(8);
    const bdv = new DataView(binHead.buffer);
    bdv.setUint32(0, binLength + binPad, true);
    bdv.setUint32(4, 0x004e4942, true); // "BIN"
    writeOut(binHead);

    const copy = Buffer.allocUnsafe(4 * 1024 * 1024);
    let pos = 0;
    while (pos < binLength) {
      const n = fs.readSync(binFd, copy, 0, Math.min(copy.length, binLength - pos), pos);
      if (n <= 0) break;
      writeOut(copy.subarray(0, n));
      pos += n;
    }
    if (binPad > 0) writeOut(new Uint8Array(binPad));
  } finally {
    fs.closeSync(out);
  }
}

/** Detect `/* *\/` STEP comments in a file without holding it in memory. */
export function hasStepComments(fd: number, size: number): boolean {
  const chunkSize = 4 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(chunkSize);
  let prev = -1;
  let pos = 0;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(chunkSize, size - pos), pos);
    if (n <= 0) break;
    pos += n;
    for (let i = 0; i < n; i++) {
      if (prev === 0x2f && buf[i] === 0x2a) return true;
      prev = buf[i];
    }
  }
  return false;
}

/** Streaming counterpart of {@link stripStepComments}: reads `fd` in chunks, writes the stripped file. */
export function stripStepCommentsToFile(fd: number, size: number, outPath: string): void {
  const out = fs.openSync(outPath, "w");
  const writeOut = makeFdWriter(out);
  try {
    const state: StripState = { inString: false, inComment: false, pending: null };
    const chunkSize = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(chunkSize, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      stripStepCommentsChunk(state, buf.subarray(0, n), pos >= size, writeOut);
    }
    if (pos < size) {
      // loop exited early (short read): finalize with whatever remains
      stripStepCommentsChunk(state, new Uint8Array(0), true, writeOut);
    }
  } finally {
    fs.closeSync(out);
  }
}

async function convertOpen(
  api: IfcAPI,
  modelID: number,
  schema: string,
  opts: ConvertOptions,
  makeAssembler: (chunkIndex: number) => GlbAssembler
): Promise<ConversionMeta> {
  const typeName = (expressID: number): string => {
    const t = api.GetLineType(modelID, expressID) as number;
    return (api.GetNameFromTypeCode(t) || "IFCUNKNOWN").toUpperCase();
  };

  // ---- units -------------------------------------------------------------
  const units = { sourceName: "METRE", sourcePrefix: null as string | null, scaleToMetre: 1 };
  const projectIDs = api.GetLineIDsWithType(modelID, IFCPROJECT);
  if (projectIDs.size() > 0) {
    const project = api.GetLine(modelID, projectIDs.get(0), true);
    const unitAssignID = refId(project?.UnitsInContext);
    if (unitAssignID !== null) {
      const unitAssignment = api.GetLine(modelID, unitAssignID, true);
      for (const unit of (unitAssignment?.Units ?? []) as Array<Record<string, unknown>>) {
        if (str(unit?.UnitType) !== "LENGTHUNIT") continue;
        const name = str(unit?.Name) ?? "";
        const prefix = str(unit?.Prefix);
        units.sourceName = name;
        units.sourcePrefix = prefix;
        const base = METRE_UNITS[name];
        if (base !== undefined) {
          units.scaleToMetre = prefix ? base * (PREFIX_TO_METRE[prefix] ?? 1) : base;
        }
      }
    }
  }

  // ---- coordinate reference system -----------------------------------------
  let crs: ConversionCrs = { source: "ABSENT", name: null, epsg: null, mapConversion: null };
  const projIDs = api.GetLineIDsWithType(modelID, IFCPROJECTEDCRS);
  if (projIDs.size() > 0) {
    const line = api.GetLine(modelID, projIDs.get(0), true);
    const name = str(line?.Name);
    crs = { source: "IFCPROJECTEDCRS", name, epsg: parseEpsgCode(name), mapConversion: null };
  }
  const mapIDs = api.GetLineIDsWithType(modelID, IFCMAPCONVERSION);
  if (mapIDs.size() > 0) {
    const line = api.GetLine(modelID, mapIDs.get(0), true);
    const x0 = raw(line?.Eastings);
    const y0 = raw(line?.Northings);
    if (typeof x0 === "number" && typeof y0 === "number" && Number.isFinite(x0) && Number.isFinite(y0)) {
      crs = { ...crs, mapConversion: { x0, y0 } };
    }
  }

  // ---- spatial structure (Project->Site->Building->Storey) ---------------
  const nodeMap = new Map<number, SpatialNode>();
  const childrenOf = new Map<number, number[]>();
  let projectExpressID: number | null = null;

  const aggRelIDs = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  for (let i = 0; i < aggRelIDs.size(); i++) {
    const rel = api.GetLine(modelID, aggRelIDs.get(i), true);
    const parentRef = refId(rel?.RelatingObject);
    if (parentRef === null) continue;
    if (typeName(parentRef) === "IFCPROJECT") projectExpressID = parentRef;
    for (const childRef of (rel?.RelatedObjects ?? []) as unknown[]) {
      const child = refId(childRef);
      if (child === null) continue;
      const list = childrenOf.get(parentRef) ?? [];
      list.push(child);
      childrenOf.set(parentRef, list);
    }
  }

  const makeNode = (expressID: number): SpatialNode => {
    const existing = nodeMap.get(expressID);
    if (existing) return existing;
    const line = api.GetLine(modelID, expressID, true);
    const guid = str(line?.GlobalId) ?? "";
    const node: SpatialNode = {
      guid,
      expressID,
      type: typeName(expressID),
      name: str(line?.Name) ?? guid,
      children: [],
    };
    nodeMap.set(expressID, node);
    return node;
  };

  let root: SpatialNode;
  if (projectExpressID !== null) {
    root = makeNode(projectExpressID);
  } else {
    // Degenerate file without a project: synthesise a root so viewers still work.
    root = { guid: "", expressID: -1, type: "IFCPROJECT", name: "(no project)", children: [] };
  }

  const attach = (parent: SpatialNode): void => {
    const kids = childrenOf.get(parent.expressID) ?? [];
    for (const kid of kids) {
      if (GEOMETRY_SKIP_TYPES.has(typeName(kid))) continue;
      const childNode = makeNode(kid);
      parent.children.push(childNode);
      attach(childNode);
    }
  };
  attach(root);

  const storeyGuids = new Map<number, string>();
  const collectStoreys = (node: SpatialNode): void => {
    if (node.type === "IFCBUILDINGSTOREY") storeyGuids.set(node.expressID, node.guid);
    for (const c of node.children) collectStoreys(c);
  };
  collectStoreys(root);

  // ---- element -> storey containment -------------------------------------
  const storeyOf = new Map<number, number>();
  const containRelIDs = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < containRelIDs.size(); i++) {
    const rel = api.GetLine(modelID, containRelIDs.get(i), true);
    const structureRef = refId(rel?.RelatingStructure);
    if (structureRef === null) continue;
    for (const elRef of (rel?.RelatedElements ?? []) as unknown[]) {
      const el = refId(elRef);
      if (el !== null && !storeyOf.has(el)) storeyOf.set(el, structureRef);
    }
  }

  // ---- property sets ------------------------------------------------------
  const psetsOf = new Map<number, Record<string, Record<string, unknown>>>();
  const defRelIDs = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < defRelIDs.size(); i++) {
    const rel = api.GetLine(modelID, defRelIDs.get(i), true);
    const defID = refId(rel?.RelatingPropertyDefinition);
    if (defID === null) continue;
    if (typeName(defID) !== "IFCPROPERTYSET") continue;
    const pset = api.GetLine(modelID, defID, true);
    const psetName = str(pset?.Name) ?? "Pset_Unknown";
    const props: Record<string, unknown> = {};
    for (const propRef of (pset?.HasProperties ?? []) as unknown[]) {
      const prop = (propRef ?? {}) as Record<string, unknown>;
      const propName = str(prop?.Name);
      if (!propName) continue;
      props[propName] = raw(prop?.NominalValue);
    }
    for (const objRef of (rel?.RelatedObjects ?? []) as unknown[]) {
      const obj = refId(objRef);
      if (obj === null) continue;
      const target = psetsOf.get(obj) ?? {};
      target[psetName] = props;
      psetsOf.set(obj, target);
    }
  }

  // ---- element metadata ---------------------------------------------------
  const elements: Record<string, ElementMeta> = {};
  const addElement = (expressID: number): void => {
    const key = String(expressID);
    if (elements[key]) return;
    const line = api.GetLine(modelID, expressID, true);
    const guid = str(line?.GlobalId) ?? "";
    const storeyExpressID = storeyOf.get(expressID) ?? null;
    const attributes: Record<string, unknown> = {};
    for (const attr of ["ObjectType", "Tag", "PredefinedType"]) {
      const value = raw(line?.[attr]);
      if (value !== null && value !== undefined) attributes[attr] = value;
    }
    elements[key] = {
      guid: isValidIfcGuid(guid) ? guid : "",
      type: typeName(expressID),
      name: str(line?.Name) ?? guid,
      storeyExpressID,
      storeyGuid: storeyExpressID !== null ? (storeyGuids.get(storeyExpressID) ?? null) : null,
      attributes,
      psets: psetsOf.get(expressID) ?? {},
    };
  };
  for (const expressID of storeyOf.keys()) addElement(expressID);

  // ---- geometry -----------------------------------------------------------
  // web-ifc normalises units (metres) and bakes placement rotations into the
  // vertices, so the coordination matrix is applied as-is. Note: in 0.0.77
  // GetCoordinationMatrix returns the geometry processor's live matrix, which
  // is still identity here — the COORDINATE_TO_ORIGIN translation is folded
  // into it lazily during streaming (read back after the loop for `origin`).
  const coordination = api.GetCoordinationMatrix(modelID);

  const maxVertsPerPrim = opts.maxVerticesPerPrimitive ?? DEFAULT_MAX_VERTICES_PER_PRIMITIVE;
  const sealedBuckets: GeometryBucket[] = [];
  const router = opts.chunking ? new ChunkRouter(opts.chunking.maxTrianglesPerChunk) : null;

  interface ChunkStream {
    index: number;
    assembler: GlbAssembler;
    buckets: Map<string, BucketData>;
    bucketIndices: number[];
  }
  const streams = new Map<number, ChunkStream>();
  const streamFor = (chunkIndex: number): ChunkStream => {
    let s = streams.get(chunkIndex);
    if (!s) {
      s = { index: chunkIndex, assembler: makeAssembler(chunkIndex), buckets: new Map(), bucketIndices: [] };
      streams.set(chunkIndex, s);
    }
    return s;
  };

  /** Seal one bucket part into its chunk's GLB primitive + meta entry, then free its builders. */
  const seal = (s: ChunkStream, b: BucketData): void => {
    if (b.positions.len === 0) return;
    const prim: GlbPrimitive = {
      name: `bucket-${sealedBuckets.length}`,
      bucketIndex: sealedBuckets.length,
      positions: b.positions.view(),
      normals: b.normals.view(),
      indices: b.indices.view(),
      baseColor: b.color,
      transparent: b.transparent,
    };
    s.assembler.addPrimitive(prim);
    sealedBuckets.push({
      storeyExpressID: b.storeyExpressID,
      color: b.color,
      transparent: b.transparent,
      ranges: b.ranges,
    });
    s.bucketIndices.push(sealedBuckets.length - 1);
    b.positions = new Float32Builder();
    b.normals = new Float32Builder();
    b.indices = new Uint32Builder();
    b.ranges = [];
  };

  const getBucket = (s: ChunkStream, storey: number | null, color: [number, number, number, number]): BucketData => {
    const key = `${storey}|${color.map((c) => c.toFixed(3)).join(",")}`;
    let bucket = s.buckets.get(key);
    if (!bucket) {
      bucket = {
        storeyExpressID: storey,
        color,
        transparent: color[3] < 0.99,
        ranges: [],
        positions: new Float32Builder(),
        normals: new Float32Builder(),
        indices: new Uint32Builder(),
      };
      s.buckets.set(key, bucket);
    }
    return bucket;
  };

  // per-element world-space AABB (metres, Y-up) for clash detection & focus
  const bboxOf = new Map<number, [number, number, number, number, number, number]>();
  const growBox = (box: [number, number, number, number, number, number], x: number, y: number, z: number): void => {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (z < box[2]) box[2] = z;
    if (x > box[3]) box[3] = x;
    if (y > box[4]) box[4] = y;
    if (z > box[5]) box[5] = z;
  };

  let triangles = 0;
  let lastReported = -1;
  /** element -> chunk that first received its geometry (reverse manifest index) */
  const chunkOf = new Map<number, number>();
  api.StreamAllMeshes(modelID, (mesh, index, total) => {
    if (opts.onProgress && total > 0) {
      const pct = Math.floor((index / total) * 90); // 0..90: streaming, 90+: assembly
      if (pct > lastReported) {
        lastReported = pct;
        opts.onProgress(pct, index, total);
      }
    }
    const expressID = mesh.expressID;
    if (GEOMETRY_SKIP_TYPES.has(typeName(expressID))) return;
    const storey = storeyOf.get(expressID) ?? null;

    for (let g = 0; g < mesh.geometries.size(); g++) {
      const placed = mesh.geometries.get(g);
      const color: [number, number, number, number] = [
        placed.color.x,
        placed.color.y,
        placed.color.z,
        placed.color.w,
      ];
      const geom = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const vertexCopy = new Float32Array(verts); // copy out of the WASM heap
      const indexCopy = new Uint32Array(idx);
      geom.delete();

      const M = mat4Mul(coordination, placed.flatTransformation);
      // Some real exports (e.g. Revit 2011 MEP devices) carry broken placements
      // that put vertices at ~1e16 m; they would poison the scene bounds, the
      // quantization scale and clash detection. Any world coordinate beyond
      // 100 km cannot be a building element — drop the mesh, keep its metadata.
      let box = bboxOf.get(expressID);
      if (!box) {
        box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        bboxOf.set(expressID, box);
      }
      let stream: ChunkStream;
      if (router) {
        // pass 1: world AABB of this geometry (also the 100 km guard)
        const gmin: [number, number, number] = [Infinity, Infinity, Infinity];
        const gmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        let coordOk = true;
        for (let v = 0; v < vertexCopy.length; v += 6) {
          const x = vertexCopy[v], y = vertexCopy[v + 1], z = vertexCopy[v + 2];
          const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
          const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
          const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
          if (Math.abs(wx) > 1e5 || Math.abs(wy) > 1e5 || Math.abs(wz) > 1e5) {
            coordOk = false;
            break;
          }
          if (wx < gmin[0]) gmin[0] = wx;
          if (wy < gmin[1]) gmin[1] = wy;
          if (wz < gmin[2]) gmin[2] = wz;
          if (wx > gmax[0]) gmax[0] = wx;
          if (wy > gmax[1]) gmax[1] = wy;
          if (wz > gmax[2]) gmax[2] = wz;
        }
        if (!coordOk) {
          addElement(expressID);
          continue;
        }
        const centroid: [number, number, number] = [
          (gmin[0] + gmax[0]) / 2,
          (gmin[1] + gmax[1]) / 2,
          (gmin[2] + gmax[2]) / 2,
        ];
        const target = router.route(storey, centroid, gmin, gmax, indexCopy.length / 3);
        stream = streamFor(target.index);
        if (!chunkOf.has(expressID)) chunkOf.set(expressID, target.index);
        growBox(box, gmin[0], gmin[1], gmin[2]);
        growBox(box, gmax[0], gmax[1], gmax[2]);
      } else {
        stream = streamFor(0);
        let coordOk = true;
        for (let v = 0; v < vertexCopy.length; v += 6) {
          const x = vertexCopy[v], y = vertexCopy[v + 1], z = vertexCopy[v + 2];
          const wx = Math.abs(M[0] * x + M[4] * y + M[8] * z + M[12]);
          const wy = Math.abs(M[1] * x + M[5] * y + M[9] * z + M[13]);
          const wz = Math.abs(M[2] * x + M[6] * y + M[10] * z + M[14]);
          if (wx > 1e5 || wy > 1e5 || wz > 1e5) {
            coordOk = false;
            break;
          }
        }
        if (!coordOk) {
          addElement(expressID);
          continue;
        }
      }

      const bucket = getBucket(stream, storey, color);
      const vertexBase = bucket.positions.len / 3;
      for (let v = 0; v < vertexCopy.length; v += 6) {
        const x = vertexCopy[v];
        const y = vertexCopy[v + 1];
        const z = vertexCopy[v + 2];
        const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
        const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
        if (!router) growBox(box, wx, wy, wz);
        bucket.positions.push(wx, wy, wz);
        const dx = vertexCopy[v + 3];
        const dy = vertexCopy[v + 4];
        const dz = vertexCopy[v + 5];
        let nx = M[0] * dx + M[4] * dy + M[8] * dz;
        let ny = M[1] * dx + M[5] * dy + M[9] * dz;
        let nz = M[2] * dx + M[6] * dy + M[10] * dz;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12) {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        bucket.normals.push(nx, ny, nz);
      }
      const rangeStart = bucket.indices.len;
      for (let t = 0; t < indexCopy.length; t++) {
        bucket.indices.push(indexCopy[t] + vertexBase);
      }
      bucket.ranges.push({ expressID, start: rangeStart, count: indexCopy.length });
      triangles += indexCopy.length / 3;
      // keep float32 accumulation bounded: seal the bucket part and continue
      // its stream in fresh builders (ranges stay primitive-local)
      if (bucket.positions.len / 3 >= maxVertsPerPrim) seal(stream, bucket);
    }
  });

  // Elements that carry geometry but have no IfcRelContainedInSpatialStructure
  // relation (e.g. Revit MEP exports, some IFC4 infra models) must still be
  // pickable: register metadata for every meshed element.
  for (const expressID of bboxOf.keys()) addElement(expressID);

  // With COORDINATE_TO_ORIGIN the processor lazily stores translate(-p0),
  // p0 being the final-frame world position of the first streamed vertex; the
  // same matrix now reads back from the API, so the subtracted origin is exact.
  const hiddenOrigin = api.GetCoordinationMatrix(modelID);
  const origin: [number, number, number] = [-hiddenOrigin[12], -hiddenOrigin[13], -hiddenOrigin[14]];

  opts.onProgress?.(92, 0, 1);
  for (const s of streams.values()) {
    for (const b of s.buckets.values()) seal(s, b);
  }
  const fallbackViews = [...streams.values()].reduce((n, s) => n + s.assembler.compressionStats.fallbackViews, 0);
  const codec: GlbCompression["codec"] = streams.get(0)?.assembler.compressionStats.codec ?? "none";

  if (Object.keys(elements).length === 0 && sealedBuckets.length === 0) {
    throw new IfcConversionError("no elements or geometry found in IFC file", "EMPTY_MODEL");
  }

  // attach element bboxes + owning chunk (elements with geometry only)
  for (const [expressID, box] of bboxOf) {
    const el = elements[String(expressID)];
    if (el && box[0] !== Infinity) el.bbox = box;
    const c = chunkOf.get(expressID);
    if (el && c !== undefined) el.chunkId = c;
  }

  opts.onProgress?.(99, 0, 1);

  const chunked = streams.size > 1;
  const meta: ConversionMeta = {
    schema,
    engine: "wasm",
    units,
    origin,
    crs,
    stats: { elements: Object.keys(elements).length, triangles: Math.round(triangles) },
    glbCompression: { codec, fallbackViews },
    artifactFormat: chunked ? "chunked" : "single",
    chunks: chunked
      ? [...streams.values()]
          .sort((a, b) => a.index - b.index)
          .map((s) => {
            const target = router!.chunks.find((t) => t.index === s.index)!;
            const entry: ChunkManifestEntry = {
              id: s.index,
              storeyExpressID: target.storeyExpressID,
              storeyGuid: target.storeyExpressID !== null ? (storeyGuids.get(target.storeyExpressID) ?? null) : null,
              bbox: [target.min[0], target.min[1], target.min[2], target.max[0], target.max[1], target.max[2]],
              triangles: target.triangles,
              bytes: 0,
              buckets: s.bucketIndices,
            };
            if (target.overflowed) entry.overflowed = true;
            return entry;
          })
      : undefined,
    buckets: sealedBuckets,
    spatial: root,
    elements,
  };

  return meta;
}
