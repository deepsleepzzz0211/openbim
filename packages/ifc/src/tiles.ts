/**
 * Ticket 11 (spike): OGC 3D Tiles 1.1 export for chunked artifacts.
 *
 * Purely additive — the main conversion path never imports this. Builds a
 * `tileset.json` from a ConversionMeta manifest and rewrites each chunk GLB
 * so the tile's bbox centre lives in the tile's 4x4 *double* transform
 * (block-local origin). Vertex floats then only span the tile's own extent,
 * which is the precision argument for 3D Tiles over relative GLB offsets.
 *
 * Frame conventions (all column-major, as in the 3D Tiles spec):
 *  - our artifacts are Y-up metres, origin-relative (world = glb + origin)
 *  - tilesets are Z-up, so the ROOT transform carries the single
 *    Y-up→Z-up rotation plus the model origin offset
 *  - tile transforms are pure translations in the (still Y-up) root frame:
 *    content and boundingVolume.box stay Y-up around the tile-local origin
 *
 * Content uris are relative paths derived from server-side chunk ids
 * (`tiles/<id>.glb`) — never absolute URLs, never user input.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { IfcConversionError } from "./convert";
import { readGlbFile, writeGlbFile } from "./presplit";
import type { ConversionMeta, ChunkManifestEntry } from "./types";

/** 3D Tiles 1.1 box: flat [cx,cy,cz, xCol(3), yCol(3), zCol(3)] (the 1.1 JSON
 *  schema uses arrays; the {center, halfAxes} object form is b3dm-internal). */
function boxArray(center: V3, half: V3): number[] {
  return [center[0], center[1], center[2], half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]];
}

export interface TilesetNode {
  boundingVolume: { box: number[] };
  geometricError: number;
  refine: "REPLACE" | "ADD";
  transform?: number[];
  content?: { uri: string };
  children?: TilesetNode[];
}

export interface TilesetJson {
  asset: { version: "1.1"; tilesetVersion?: string };
  geometricError: number;
  viewerRevision?: number;
  root: TilesetNode;
}

export interface TilesetOptions {
  /** default: the union diagonal (single-level tree → children always loadable) */
  rootGeometricError?: number;
  /** leaf-tile error; 0 = tiles are exact (no procedural simplification) */
  tileGeometricError?: number;
  tilesetVersion?: string;
  /** content uri per tile key (chunk id, or "model" for single format) */
  contentUri?: (key: number | "model") => string;
}

/** Column-major rotation mapping Y-up content into a Z-up frame. */
export const Y_UP_TO_Z_UP: readonly number[] = [
  1, 0, 0, 0, //
  0, 0, 1, 0, //
  0, -1, 0, 0, //
  0, 0, 0, 1,
];

type V3 = [number, number, number];

interface TileSpec {
  key: number | "model";
  uri: string;
  center: V3;
  half: V3;
  triangles: number;
}

function unionBox(meta: ConversionMeta): { center: V3; half: V3 } | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const eat = (b: number[]) => {
    any = true;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], b[a]);
      max[a] = Math.max(max[a], b[a + 3]);
    }
  };
  if (meta.chunks) for (const c of meta.chunks) eat(c.bbox);
  else for (const el of Object.values(meta.elements)) if (el.bbox) eat(el.bbox);
  if (!any) return null;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
  };
}

const diag = (half: V3) => 2 * Math.hypot(half[0], half[1], half[2]);

function translationMatrix(t: V3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

/** Tiles for a manifest: one per manifest chunk, or one for a single artifact. */
export function tileSpecsForMeta(meta: ConversionMeta, opts: TilesetOptions = {}): TileSpec[] {
  const contentUri = opts.contentUri ?? ((k) => (k === "model" ? "model.glb" : `tiles/${k}.glb`));
  if (meta.chunks && meta.chunks.length > 0) {
    return [...meta.chunks]
      .sort((a, b) => a.id - b.id)
      .map((c: ChunkManifestEntry) => ({
        key: c.id,
        uri: contentUri(c.id),
        center: [(c.bbox[0] + c.bbox[3]) / 2, (c.bbox[1] + c.bbox[4]) / 2, (c.bbox[2] + c.bbox[5]) / 2] as V3,
        half: [(c.bbox[3] - c.bbox[0]) / 2, (c.bbox[4] - c.bbox[1]) / 2, (c.bbox[5] - c.bbox[2]) / 2] as V3,
        triangles: c.triangles,
      }));
  }
  const box = unionBox(meta);
  if (!box) return [];
  return [{ key: "model", uri: contentUri("model"), center: box.center, half: box.half, triangles: meta.stats.triangles }];
}

/** Pure manifest → tileset.json object (relative content uris, double transforms). */
export function buildTilesetJson(meta: ConversionMeta, opts: TilesetOptions = {}): TilesetJson {
  const tiles = tileSpecsForMeta(meta, opts);
  if (!tiles.length) {
    throw new IfcConversionError("meta carries no tile geometry to export", "EMPTY_MODEL");
  }
  const box = unionBox(meta)!;
  const origin: V3 = meta.origin ?? [0, 0, 0];
  // The root-local frame is our GLB frame (Y-up, origin-relative metres):
  // tile centres/boxes stay in manifest coordinates and only the root
  // transform rotates into the Z-up tileset frame + applies the model origin
  // (geo-referencing would extend this single matrix, e.g. region/ECEF).
  const R = Y_UP_TO_Z_UP;
  const t: V3 = [
    R[0] * origin[0] + R[4] * origin[1] + R[8] * origin[2],
    R[1] * origin[0] + R[5] * origin[1] + R[9] * origin[2],
    R[2] * origin[0] + R[6] * origin[1] + R[10] * origin[2],
  ];
  const rootTransform = [...Y_UP_TO_Z_UP];
  rootTransform[12] = t[0];
  rootTransform[13] = t[1];
  rootTransform[14] = t[2];
  return {
    asset: { version: "1.1", ...(opts.tilesetVersion ? { tilesetVersion: opts.tilesetVersion } : {}) },
    geometricError: opts.rootGeometricError ?? diag(box.half),
    root: {
      transform: rootTransform,
      boundingVolume: { box: boxArray(box.center, box.half) },
      geometricError: opts.rootGeometricError ?? diag(box.half),
      refine: "REPLACE",
      children: tiles.map((s) => ({
        // block-local origin lives HERE, in doubles: the rewritten tile GLB
        // only spans its own extent around zero
        transform: translationMatrix(s.center),
        boundingVolume: { box: boxArray([0, 0, 0], s.half) },
        geometricError: opts.tileGeometricError ?? 0,
        refine: "REPLACE" as const,
        content: { uri: s.uri },
      })),
    },
  };
}

export interface ExportTilesetOptions extends TilesetOptions {
  /** artifact directory holding meta.json + chunks/ or model.glb */
  artifactDir: string;
  /** default: `<artifactDir>/meta.json` */
  metaPath?: string;
  outDir: string;
}

/**
 * Write a full tileset directory: tileset.json plus tile GLBs re-centred so
 * each tile's vertices live around its own origin (the centre moves into the
 * tile transform). JSON-only rewrite — the BIN (meshopt-compressed or not)
 * is copied untouched.
 */
export function exportTilesetFromArtifact(opts: ExportTilesetOptions): { tileset: TilesetJson; tiles: number } {
  const metaPath = opts.metaPath ?? path.join(opts.artifactDir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as ConversionMeta;
  const specs = tileSpecsForMeta(meta, opts);
  if (!specs.length) {
    throw new IfcConversionError("meta carries no tile geometry to export", "EMPTY_MODEL");
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const s of specs) {
    const src = path.join(opts.artifactDir, s.key === "model" ? "model.glb" : path.join("chunks", `${s.key}.glb`));
    const rel = path.normalize(s.uri);
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
      throw new IfcConversionError("tile content uri escapes the output directory", "UNKNOWN");
    }
    const dest = path.join(opts.outDir, rel);
    const doc = readGlbFile(src);
    for (const node of doc.json.nodes ?? []) {
      if (node.translation) {
        node.translation = [node.translation[0] - s.center[0], node.translation[1] - s.center[1], node.translation[2] - s.center[2]];
      }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeGlbFile(dest, doc.json, doc.bin);
  }
  const tileset = buildTilesetJson(meta, opts);
  fs.writeFileSync(path.join(opts.outDir, "tileset.json"), JSON.stringify(tileset, null, 2));
  return { tileset, tiles: specs.length };
}
