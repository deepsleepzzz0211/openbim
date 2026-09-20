/**
 * Dual-engine consistency regression (ticket 09).
 *
 * Converts every samples/complex model with BOTH engines — the wasm
 * (web-ifc) pipeline in-process and the native IfcOpenShell worker over HTTP
 * — then compares triangulation statistics per model:
 *   triangles, AABB dimensions (translation-invariant), surface area
 * Thresholds are env-overridable:
 *   PARITY_TRI_TOL=0.15  PARITY_DIM_TOL=0.02  PARITY_AREA_TOL=0.10
 * Run:
 *   node scripts/engine-parity.mjs --native http://127.0.0.1:8090 [--only name.ifc]
 * Exit code != 0 when any model exceeds a threshold.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { convertIfcFile } from "../packages/ifc/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = path.join(ROOT, "samples", "complex");

const argv = process.argv.slice(2);
const argVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NATIVE = argVal("--native") || process.env.NATIVE_WORKER_URL || "";
const ONLY = argVal("--only") || "";
const TRI_TOL = Number(process.env.PARITY_TRI_TOL || 0.15);
const DIM_TOL = Number(process.env.PARITY_DIM_TOL || 0.02);
const AREA_TOL = Number(process.env.PARITY_AREA_TOL || 0.1);
// keep both engines on identical conversion options
const CHUNKING = (sizeBytes) =>
  sizeBytes >= 32 * 1024 * 1024 ? { maxTrianglesPerChunk: 500_000 } : undefined;

// ---------------------------------------------------------------------------
// GLB geometry statistics (reads the quantized KHR_mesh_quantization layout)
// ---------------------------------------------------------------------------

function glbStats(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen + 8;
  let triangles = 0;
  let area = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of gltf.nodes ?? []) {
    const mesh = gltf.meshes[node.mesh];
    for (const prim of mesh.primitives) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const idxAcc = gltf.accessors[prim.indices];
      if (!posAcc || posAcc.componentType !== 5122 || posAcc.type !== "VEC3") continue;
      const posView = gltf.bufferViews[posAcc.bufferView];
      const idxView = gltf.bufferViews[idxAcc.bufferView];
      const stride = posView.byteStride ?? 6;
      const posBase = binStart + posView.byteOffset;
      const scale = node.scale ?? [1, 1, 1];
      const trans = node.translation ?? [0, 0, 0];
      const v = [[], [], []]; // dequantized per-axis arrays
      for (let c = 0; c < 3; c++) {
        const arr = new Int16Array(posAcc.count);
        for (let i = 0; i < posAcc.count; i++) arr[i] = buf.readInt16LE(posBase + i * stride + c * 2);
        v[c] = arr;
      }
      const deq = (i, c) => (v[c][i] / 32767) * scale[c] + trans[c];
      const idxBase = binStart + idxView.byteOffset;
      const readIdx = (t) => buf.readUInt32LE(idxBase + t * 4);
      for (let t = 0; t + 2 < idxAcc.count; t += 3) {
        const a = readIdx(t);
        const b = readIdx(t + 1);
        const c2 = readIdx(t + 2);
        const p0 = [deq(a, 0), deq(a, 1), deq(a, 2)];
        const p1 = [deq(b, 0), deq(b, 1), deq(b, 2)];
        const p2 = [deq(c2, 0), deq(c2, 1), deq(c2, 2)];
        const ux = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const wx = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const n = [
          ux[1] * wx[2] - ux[2] * wx[1],
          ux[2] * wx[0] - ux[0] * wx[2],
          ux[0] * wx[1] - ux[1] * wx[0],
        ];
        area += 0.5 * Math.hypot(n[0], n[1], n[2]);
        triangles++;
        for (const p of [p0, p1, p2]) {
          for (let c = 0; c < 3; c++) {
            if (p[c] < min[c]) min[c] = p[c];
            if (p[c] > max[c]) max[c] = p[c];
          }
        }
      }
    }
  }
  return { triangles, area, dims: [0, 1, 2].map((c) => max[c] - min[c]) };
}

function artifactStats(dir, meta) {
  const files =
    meta.artifactFormat === "chunked"
      ? meta.chunks.map((c) => path.join(dir, "chunks", `${c.id}.glb`))
      : [path.join(dir, "model.glb")];
  const out = { triangles: 0, area: 0, dims: [0, 0, 0] };
  for (const f of files) {
    const s = glbStats(f);
    out.triangles += s.triangles;
    out.area += s.area;
    for (let c = 0; c < 3; c++) out.dims[c] = Math.max(out.dims[c], s.dims[c]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// native worker client (same protocol as apps/api)
// ---------------------------------------------------------------------------

async function convertNative(file, dir) {
  const body = JSON.stringify({
    job_id: `parity-${crypto.randomUUID()}`,
    input_path: file,
    glb_path: path.join(dir, "model.glb"),
    meta_path: path.join(dir, "meta.json"),
    ...(CHUNKING(fs.statSync(file).size) ? { chunking: CHUNKING(fs.statSync(file).size) } : {}),
  });
  const res = await fetch(`${NATIVE.replace(/\/+$/, "")}/convert`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.NATIVE_WORKER_TOKEN ? { authorization: `Bearer ${process.env.NATIVE_WORKER_TOKEN}` } : {}) },
    body,
  });
  if (!res.ok) throw new Error(`POST /convert -> ${res.status}: ${await res.text()}`);
  const { job_id: jobId } = await res.json();
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`native job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, 1000));
    const st = await fetch(`${NATIVE.replace(/\/+$/, "")}/jobs/${jobId}`, { headers: process.env.NATIVE_WORKER_TOKEN ? { authorization: `Bearer ${process.env.NATIVE_WORKER_TOKEN}` } : {} });
    if (st.status === 404) continue; // not registered yet
    const job = await st.json();
    if (job.status === "done") break;
    if (job.status === "failed") throw new Error(`native job failed: ${job.code} ${job.message}`);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

const rel = (a, b) => (Math.max(a, b) === 0 ? 0 : Math.abs(a - b) / Math.max(a, b));

async function parityOne(file) {
  const size = fs.statSync(file).size;
  const dirW = fs.mkdtempSync(path.join(os.tmpdir(), "parity-wasm-"));
  const dirN = fs.mkdtempSync(path.join(os.tmpdir(), "parity-native-"));
  const name = path.basename(file);
  try {
    const t0 = Date.now();
    const metaW = await convertIfcFile(file, path.join(dirW, "model.glb"), { meshopt: false, chunking: CHUNKING(size) });
    const wasmMs = Date.now() - t0;
    const t1 = Date.now();
    const metaN = await convertNative(file, dirN);
    const nativeMs = Date.now() - t1;

    const w = artifactStats(dirW, metaW);
    const n = artifactStats(dirN, metaN);
    const problems = [];
    if (metaW.engine !== "wasm") problems.push(`wasm meta.engine=${metaW.engine}`);
    if (metaN.engine !== "native") problems.push(`native meta.engine=${metaN.engine}`);
    if (rel(w.triangles, n.triangles) > TRI_TOL) problems.push(`triangles ${w.triangles} vs ${n.triangles}`);
    if (rel(w.area, n.area) > AREA_TOL) problems.push(`area ${w.area.toFixed(1)} vs ${n.area.toFixed(1)}`);
    for (let c = 0; c < 3; c++) {
      const tol = Math.max(DIM_TOL * Math.max(w.dims[c], n.dims[c]), 0.05);
      if (Math.abs(w.dims[c] - n.dims[c]) > tol) problems.push(`dim${c} ${w.dims[c].toFixed(2)} vs ${n.dims[c].toFixed(2)}`);
    }
    const fmtMatch = metaW.artifactFormat === metaN.artifactFormat;
    const status = problems.length === 0 && fmtMatch ? "OK" : problems.length ? "FAIL" : "WARN";
    console.log(
      `${status}\t${name}\ttri ${w.triangles}/${n.triangles}\tarea ${w.area.toFixed(0)}/${n.area.toFixed(0)}\t` +
        `dims ${w.dims.map((d) => d.toFixed(1)).join(",")} vs ${n.dims.map((d) => d.toFixed(1)).join(",")}\t` +
        `fmt ${metaW.artifactFormat}/${metaN.artifactFormat}\tel ${metaW.stats.elements}/${metaN.stats.elements}\t` +
        `${(wasmMs / 1000).toFixed(1)}s/${(nativeMs / 1000).toFixed(1)}s`
    );
    if (problems.length) problems.forEach((p) => console.log(`   ! ${p}`));
    if (!fmtMatch) console.log(`   ~ artifact format differs (chunking thresholds are engine-independent; check router drift)`);
    return status !== "FAIL";
  } catch (err) {
    console.log(`FAIL\t${name}\t${err.message}`);
    return false;
  } finally {
    fs.rmSync(dirW, { recursive: true, force: true });
    fs.rmSync(dirN, { recursive: true, force: true });
  }
}

const files = fs
  .readdirSync(SAMPLES)
  .filter((f) => f.endsWith(".ifc") && (!ONLY || f === ONLY))
  .map((f) => path.join(SAMPLES, f));

if (!NATIVE) {
  console.error("usage: node scripts/engine-parity.mjs --native http://worker:8090   (ticket 09 parity)");
  process.exit(2);
}
console.log(`engine parity: ${files.length} models | tolerances tri=${TRI_TOL} dim=${DIM_TOL} area=${AREA_TOL}`);
let allOk = true;
for (const f of files) allOk = (await parityOne(f)) && allOk;
console.log(allOk ? "ENGINE PARITY OK" : "ENGINE PARITY FAILED");
process.exit(allOk ? 0 : 1);
