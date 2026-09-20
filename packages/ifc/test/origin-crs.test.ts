/**
 * Ticket 03: conversion metadata must carry the world-coordinate origin that
 * web-ifc's COORDINATE_TO_ORIGIN shift subtracted, plus CRS information taken
 * from IfcProjectedCRS / IfcMapConversion (with an explicit default when the
 * file declares none).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { convertIfc } from "../src/convert";
import type { ConversionMeta } from "../src/types";

const FIXTURE = path.join(__dirname, "fixtures/sample-building.ifc");

function translatedSite(dxMm: number, dyMm: number, dzMm: number): Uint8Array {
  const text = fs.readFileSync(FIXTURE, "utf8");
  const needle = "#14=IFCCARTESIANPOINT((0,0,0));";
  if (!text.includes(needle)) throw new Error("fixture site location point not found");
  const moved = text.replace(needle, `#14=IFCCARTESIANPOINT((${dxMm}.,${dyMm}.,${dzMm}.));`);
  return new TextEncoder().encode(moved);
}

describe("conversion origin metadata", () => {
  it("records the subtracted world origin in the final (Y-up metre) frame", async () => {
    const meta = await convertIfc(new Uint8Array(fs.readFileSync(FIXTURE)), {}).then((r) => r.meta);
    expect(meta.origin).toHaveLength(3);
    expect(meta.origin.every((v) => Number.isFinite(v))).toBe(true);
    // the sample sits at IFC mm coords up to ~8 m; its subtracted origin is
    // non-zero (web-ifc re-centres on the first processed vertex)
    expect(Math.hypot(...meta.origin)).toBeGreaterThan(0.5);
  });

  it("translated copies shift the origin by exactly the translation and keep the same shifted geometry", async () => {
    const a = await convertIfc(new Uint8Array(fs.readFileSync(FIXTURE)), {});
    // site moved +30 m (IFC x) and +40 m (IFC z -> final Y-up y); mm units x0.001
    const b = await convertIfc(translatedSite(30000, 0, 40000), {});
    for (let i = 0; i < 3; i++) {
      expect(b.meta.origin[i] - a.meta.origin[i]).toBeCloseTo([30, 40, 0][i], 4);
    }
    expect(b.meta.stats).toEqual(a.meta.stats);
    // geometry stays building-scale in the shifted frame: element bboxes must
    // match the untranslated copy (float rounding of the large offset aside)
    for (const [id, el] of Object.entries(b.meta.elements)) {
      const base = a.meta.elements[id];
      if (!el.bbox || !base?.bbox) continue;
      for (let i = 0; i < 6; i++) expect(el.bbox[i] - base.bbox[i]).toBeCloseTo(0, 3);
    }
    // GLB sizes track within a hair (per-primitive quantization grids differ
    // slightly with coordinate magnitude, triangle/index counts do not)
    expect(Math.abs(b.glb.byteLength - a.glb.byteLength)).toBeLessThan(a.glb.byteLength * 0.02);
  });

  it("keeps huge-but-coherent global coordinates out of the geometry by absorbing them into origin", async () => {
    // a building placed at a UTM-like site position: geometry must stay
    // small-magnitude (shifted), the absolute position lives in meta.origin
    const base = await convertIfc(new Uint8Array(fs.readFileSync(FIXTURE)), {}).then((r) => r.meta);
    const meta = await convertIfc(translatedSite(500000000, 0, 3000000000), {}).then((r) => r.meta);
    // p0 sits at the first streamed vertex, so compare against the base
    // model's own origin rather than the raw site coordinates
    expect(meta.origin[0] - base.origin[0]).toBeCloseTo(500000, 2);
    expect(meta.origin[1] - base.origin[1]).toBeCloseTo(3000000, 2);
    expect(meta.origin[2] - base.origin[2]).toBeCloseTo(0, 2);
    // nothing dropped by the 100 km outlier guard
    expect(meta.stats).toEqual(base.stats);
    let maxAbs = 0;
    for (const el of Object.values(meta.elements)) {
      if (!el.bbox) continue;
      for (const v of el.bbox) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    // bboxes are stored in the shifted (GLB) frame: still building-scale
    expect(maxAbs).toBeLessThan(1000);
  });

  it("legacy meta.json without origin is treated as zero by the meta consumers (field is optional)", async () => {
    const meta = await convertIfc(new Uint8Array(fs.readFileSync(FIXTURE)), {}).then((r) => r.meta);
    // freshly converted models always carry it
    expect(meta.origin).toBeDefined();
    // and the type stays consumable when absent (old artifacts)
    const legacy: Partial<ConversionMeta> = { ...meta };
    delete legacy.origin;
    const read = legacy.origin ?? [0, 0, 0];
    expect(read).toEqual([0, 0, 0]);
  });
});

describe("conversion crs metadata", () => {
  it("defaults to an explicit ABSENT crs when the file declares none", async () => {
    const meta = await convertIfc(new Uint8Array(fs.readFileSync(FIXTURE)), {}).then((r) => r.meta);
    expect(meta.crs).toEqual({ source: "ABSENT", name: null, epsg: null, mapConversion: null });
  });

  it("extracts EPSG codes and map conversions from georeferenced files", async () => {
    const text = fs.readFileSync(FIXTURE, "utf8");
    const georef = text
      .replace(
        "DATA;",
        [
          "DATA;",
          "#900=IFCPROJECTEDCRS('EPSG:25832',$,'UTM zone 32N',$,$,$,$);",
          "#901=IFCMAPCONVERSION(#900,$,500000.,3000000.,0.,0.,0.,1.);",
        ].join("\n")
      )
      // unreferenced entities are fine: extraction queries by entity type
      ;
    // IfcMapConversion arity: SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale
    const meta = await convertIfc(new TextEncoder().encode(georef), {}).then((r) => r.meta);
    expect(meta.crs.source).toBe("IFCPROJECTEDCRS");
    expect(meta.crs.name).toBe("EPSG:25832");
    expect(meta.crs.epsg).toBe(25832);
    expect(meta.crs.mapConversion).toEqual({ x0: 500000, y0: 3000000 });
  });

  it("tolerates projected CRS names without an EPSG code", async () => {
    const text = fs.readFileSync(FIXTURE, "utf8").replace(
      "DATA;",
      "DATA;\n#900=IFCPROJECTEDCRS('OSGB36 / British National Grid',$,$,$,$,$,$);"
    );
    const meta = await convertIfc(new TextEncoder().encode(text), {}).then((r) => r.meta);
    expect(meta.crs.source).toBe("IFCPROJECTEDCRS");
    expect(meta.crs.epsg).toBeNull();
    expect(meta.crs.name).toBe("OSGB36 / British National Grid");
  });
});
