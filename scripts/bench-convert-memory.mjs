#!/usr/bin/env node
/**
 * Peak-memory benchmark: buffer conversion (convertIfc) vs file streaming
 * conversion (convertIfcFile), used as the ticket-01 before/after artefact.
 *
 * Each (input, mode) pair runs in a fresh child process; the child samples its
 * own RSS at phase boundaries and inside every onProgress tick (the only
 * async-adjacent observation points inside web-ifc's synchronous mesh loop).
 *
 * Usage:
 *   node scripts/bench-convert-memory.mjs [file.ifc ...]
 *   (defaults to samples/complex/*.ifc, biggest first)
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const MB = (n) => (n / 1024 / 1024).toFixed(1);

if (process.env.BENCH_CHILD) {
  const mode = process.env.BENCH_CHILD; // "buffer" | "file"
  const input = process.env.BENCH_INPUT;
  const out = process.env.BENCH_OUT;
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const ifc = require(path.join(repoRoot, "packages", "ifc", "dist", "index.js"));

  let peak = process.memoryUsage().rss;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  };
  const t0 = process.hrtime.bigint();
  let meta;
  if (mode === "buffer") {
    const bytes = new Uint8Array(fs.readFileSync(input));
    sample();
    const { glb, meta: m } = await ifc.convertIfc(bytes, { onProgress: sample });
    meta = m;
    fs.writeFileSync(out, glb);
  } else {
    sample();
    meta = await ifc.convertIfcFile(input, out, { onProgress: sample });
  }
  sample();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  // gc-free reading: peak is monotone, no need to force collections
  // marker line: web-ifc logs to stdout too, so plain JSON.parse(buf) is unsafe
  process.stdout.write("BENCH_RESULT " + JSON.stringify({
    mode,
    peakRss: peak,
    elapsedMs,
    glbBytes: fs.statSync(out).size,
    elements: meta.stats.elements,
    triangles: meta.stats.triangles,
  }) + "\n");
  process.exit(0);
}

// ---- parent: run children and tabulate -------------------------------------

let inputs = process.argv.slice(2).filter((a) => a.endsWith(".ifc"));
if (inputs.length === 0) {
  const dir = path.join(repoRoot, "samples", "complex");
  inputs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ifc"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
}

function runChild(mode, input) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "bim-bench-"));
    const out = path.join(dir, "out.glb");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), input], {
      env: { ...process.env, BENCH_CHILD: mode, BENCH_INPUT: input, BENCH_OUT: out },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${mode} child exited ${code}`));
      const line = buf.split("\n").find((l) => l.startsWith("BENCH_RESULT "));
      if (!line) return reject(new Error(`${mode} child printed no result:\n${buf}`));
      resolve(JSON.parse(line.slice("BENCH_RESULT ".length)));
    });
  });
}

console.log(`\nIFC conversion peak memory — ${inputs.length} file(s)\n`);
const rows = [];
for (const input of inputs) {
  const size = fs.statSync(input).size;
  const bufferRun = await runChild("buffer", input);
  const fileRun = await runChild("file", input);
  rows.push({
    file: path.basename(input),
    ifcMB: +MB(size),
    bufferPeakMB: +MB(bufferRun.peakRss),
    filePeakMB: +MB(fileRun.peakRss),
    bufferSec: +(bufferRun.elapsedMs / 1000).toFixed(2),
    fileSec: +(fileRun.elapsedMs / 1000).toFixed(2),
    glbMB: +MB(fileRun.glbBytes),
    ok:
      bufferRun.peakRss > 0 &&
      bufferRun.triangles === fileRun.triangles &&
      bufferRun.elements === fileRun.elements,
  });
  const r = rows[rows.length - 1];
  console.log(
    `${r.file.padEnd(34)} ifc ${String(r.ifcMB).padStart(6)} MB | ` +
      `buffer peak ${String(r.bufferPeakMB).padStart(7)} MB (${String(r.bufferSec).padStart(5)}s) | ` +
      `file peak ${String(r.filePeakMB).padStart(7)} MB (${String(r.fileSec).padStart(5)}s) | ` +
      `glb ${String(r.glbMB).padStart(6)} MB | parity ${r.ok ? "OK" : "MISMATCH"}`
  );
}
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
console.log(
  `\nTOTALS  buffer peak ${sum("bufferPeakMB").toFixed(1)} MB | file peak ${sum("filePeakMB").toFixed(1)} MB`
);
console.log(`method: in-process RSS sampling at phase boundaries + every progress tick; peak per child run\n`);
