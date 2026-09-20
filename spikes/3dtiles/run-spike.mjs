/**
 * Ticket 11 spike runner: convert sample models to chunked artifacts,
 * export them as OGC 3D Tiles 1.1, print sizes, and (optionally) validate
 * with the official 3d-tiles-validator CLI.
 *
 * Run:  node spikes/3dtiles/run-spike.mjs [--validate]
 * Output: spikes/3dtiles/out/<model>/{artifact/, tileset/} + out/viewer.html
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const { convertIfcFile, exportTilesetFromArtifact } = require(path.join(repo, "packages", "ifc", "dist", "index.js"));

const MB = (n) => (n / (1024 * 1024)).toFixed(2) + " MB";

const MODELS = [
  // name, source, chunk triangle budget (chosen so each model splits >= 2 tiles)
  ["sample-building", path.join(repo, "samples", "sample-building.ifc"), 20],
  ["duplex", path.join(repo, "samples", "complex", "Duplex_A_20110907.ifc"), 100_000],
  ["landscaping", path.join(repo, "samples", "complex", "Building-Landscaping.ifc"), 100_000],
];

const outRoot = path.join(here, "out");
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
fs.copyFileSync(path.join(here, "viewer.html"), path.join(outRoot, "viewer.html"));

const report = [];
for (const [name, input, budget] of MODELS) {
  const dir = path.join(outRoot, name);
  const artifact = path.join(dir, "artifact");
  fs.mkdirSync(artifact, { recursive: true });
  const t0 = Date.now();
  const meta = await convertIfcFile(input, path.join(artifact, "model.glb"), {
    chunking: { maxTrianglesPerChunk: budget },
  });
  const convertMs = Date.now() - t0;
  fs.writeFileSync(path.join(artifact, "meta.json"), JSON.stringify(meta));

  const t1 = Date.now();
  const { tiles } = exportTilesetFromArtifact({ artifactDir: artifact, outDir: path.join(dir, "tileset") });
  const exportMs = Date.now() - t1;

  const tileBytes = fs
    .readdirSync(path.join(dir, "tileset", "tiles"))
    .map((f) => fs.statSync(path.join(dir, "tileset", "tiles", f)).size);
  const tilesetBytes = fs.statSync(path.join(dir, "tileset", "tileset.json")).size;
  const whole = meta.artifactFormat === "single" ? fs.statSync(path.join(artifact, "model.glb")).size : 0;
  const row = {
    model: name,
    sourceBytes: fs.statSync(input).size,
    schema: meta.schema,
    elements: meta.stats.elements,
    triangles: meta.stats.triangles,
    chunks: meta.chunks?.length ?? 1,
    tiles,
    convertMs,
    exportMs,
    tileBytesTotal: tileBytes.reduce((a, b) => a + b, 0),
    tilesetBytes,
    singleFormatBytes: whole,
    largestTile: Math.max(...tileBytes),
    tileSizes: tileBytes,
  };
  report.push(row);
  console.log(
    `[${name}] ${row.chunks} tiles | tiles=${MB(row.tileBytesTotal)} tileset.json=${(tilesetBytes / 1024).toFixed(1)} KB` +
      (whole ? ` | single=${MB(whole)}` : "") +
      ` | convert=${convertMs}ms export=${exportMs}ms`
  );
}
fs.writeFileSync(path.join(outRoot, "spike-report.json"), JSON.stringify(report, null, 2));

if (process.argv.includes("--validate")) {
  const validator = path.join(here, "tools", "node_modules", "3d-tiles-validator", "build", "main.js");
  for (const row of report) {
    const ts = path.join(outRoot, row.model, "tileset", "tileset.json");
    const res = spawnSync(process.execPath, [validator, "-t", ts], { encoding: "utf8", maxBuffer: 32 << 20 });
    const text = (res.stdout || "") + (res.stderr || "");
    fs.writeFileSync(path.join(outRoot, `${row.model}.validator.txt`), `exit=${res.status}\n${text}`);
    const summary = text
      .split(/\r?\n/)
      .filter((l) => /error|warning|valid|invalid|SUCCESS|DONE/i.test(l))
      .slice(0, 40)
      .join("\n");
    console.log(`--- validator ${row.model}: exit=${res.status}\n${summary}`);
  }
}
