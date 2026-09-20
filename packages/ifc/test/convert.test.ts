import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { convertIfc } from "../src/convert";

const samplePath = path.join(__dirname, "fixtures", "sample-building.ifc");
const sample = fs.readFileSync(samplePath);

/** Read the JSON chunk of a GLB buffer. */
function glbJson(glb: Uint8Array): { accessors: Array<{ type: string; min?: number[]; max?: number[] }> } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  return JSON.parse(Buffer.from(glb.subarray(20, 20 + jsonLen)).toString("utf8"));
}

describe("convertIfc (sample-building.ifc)", () => {
  it("converts the sample to GLB + metadata", async () => {
    const { glb, meta } = await convertIfc(new Uint8Array(sample));

    // schema + units
    expect(meta.schema).toBe("IFC4");
    expect(meta.units.scaleToMetre).toBeCloseTo(0.001); // source file is in millimetres
    expect(meta.units.sourceName).toBe("METRE");
    expect(meta.units.sourcePrefix).toBe("MILLI");

    // spatial tree: Project -> Site -> Building -> 2 Storeys
    expect(meta.spatial.type).toBe("IFCPROJECT");
    expect(meta.spatial.name).toBe("Sample Project");
    const site = meta.spatial.children[0];
    expect(site.type).toBe("IFCSITE");
    const building = site.children[0];
    expect(building.type).toBe("IFCBUILDING");
    const storeys = building.children;
    expect(storeys).toHaveLength(2);
    expect(storeys[0].type).toBe("IFCBUILDINGSTOREY");
    expect(storeys[0].name).toBe("Ground Floor");
    expect(storeys[1].name).toBe("First Floor");

    // elements: 2 walls + 1 slab + 1 door
    const elements = Object.values(meta.elements);
    expect(elements).toHaveLength(4);
    const wall = elements.find((e) => e.name === "Wall Ground")!;
    expect(wall).toBeDefined();
    expect(wall.type).toBe("IFCWALL");
    expect(wall.guid).toHaveLength(22);
    expect(wall.storeyGuid).toBe(storeys[0].guid);
    const pset = wall.psets["Pset_WallCommon"];
    expect(pset).toBeDefined();
    expect(pset["IsExternal"]).toBe(true);
    expect(Number(pset["ThermalTransmittance"])).toBeCloseTo(1.8);

    // geometry: every element contributes exactly one bucket range
    expect(meta.stats.triangles).toBeGreaterThan(0);
    expect(meta.buckets.length).toBeGreaterThan(0);
    const totalRanges = meta.buckets.reduce((sum, b) => sum + b.ranges.length, 0);
    expect(totalRanges).toBe(4);
    // glass wall produces a transparent bucket
    expect(meta.buckets.some((b) => b.transparent)).toBe(true);

    // GLB sanity
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
  });

  it("normalises geometry to metres in Y-up (quantized, restored via node transforms)", async () => {
    const { glb } = await convertIfc(new Uint8Array(sample));
    const json = glbJson(glb);
    // world bbox = union over nodes of (translation ± scale, since scale IS the half-extent)
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const node of json.nodes) {
      const axes = [
        [node.translation[0] - node.scale[0], node.translation[0] + node.scale[0]],
        [node.translation[1] - node.scale[1], node.translation[1] + node.scale[1]],
        [node.translation[2] - node.scale[2], node.translation[2] + node.scale[2]],
      ];
      minX = Math.min(minX, axes[0][0]); maxX = Math.max(maxX, axes[0][1]);
      minY = Math.min(minY, axes[1][0]); maxY = Math.max(maxY, axes[1][1]);
      minZ = Math.min(minZ, axes[2][0]); maxZ = Math.max(maxZ, axes[2][1]);
    }
    expect(maxX - minX).toBeCloseTo(8, 1); // slab is 8 m wide
    expect(maxY - minY).toBeCloseTo(6.7, 1); // slab bottom -> first wall top (Y-up)
    expect(maxZ - minZ).toBeCloseTo(6, 1); // slab is 6 m deep
    // COORDINATE_TO_ORIGIN keeps the model near the world origin (exact
    // reference point is web-ifc's choice, spans are what matter)
    expect(Math.abs(minX)).toBeLessThan(10);
    expect(Math.abs(minY)).toBeLessThan(10);
    expect(Math.abs(minZ)).toBeLessThan(10);
    // transport extensions present
    expect(json.extensionsUsed).toContain("KHR_mesh_quantization");
    // meshopt is opt-in (decoder version matrix); quantization is the default transport
  });

  it("rejects non-STEP input", async () => {
    const garbage = new Uint8Array(Buffer.from("this is not an IFC file"));
    await expect(convertIfc(garbage)).rejects.toThrow();
  });
});

describe("convertIfc element bboxes (clash-detection input)", () => {
  it("attaches world-space AABBs in metres for every element with geometry", async () => {
    const { meta } = await convertIfc(new Uint8Array(sample));
    const elements = Object.values(meta.elements);
    for (const el of elements) {
      expect(el.bbox).toBeDefined();
      expect(el.bbox!).toHaveLength(6);
      expect(el.bbox![0] < el.bbox![3] || el.bbox![1] < el.bbox![4] || el.bbox![2] < el.bbox![5]).toBe(true);
    }
    const slab = elements.find((e) => e.name === "Ground Slab")!;
    expect(slab.bbox![3] - slab.bbox![0]).toBeCloseTo(8, 1); // 8 m span in X
    expect(slab.bbox![5] - slab.bbox![2]).toBeCloseTo(6, 1); // 6 m span in Z
    const door = elements.find((e) => e.name === "Door First")!;
    const wall = elements.find((e) => e.name === "Wall First")!;
    // door must intersect the glass wall (real clash, verified by the API tests too)
    const overlap = (a: number[], b: number[]) =>
      Math.min(a[3], b[3]) - Math.max(a[0], b[0]) > 0 &&
      Math.min(a[4], b[4]) - Math.max(a[1], b[1]) > 0 &&
      Math.min(a[5], b[5]) - Math.max(a[2], b[2]) > 0;
    expect(overlap(door.bbox!, wall.bbox!)).toBe(true);
  });
});

describe("convertIfc without spatial containment (Revit MEP-style exports)", () => {
  const noContainmentPath = path.join(__dirname, "fixtures", "sample-building-no-containment.ifc");
  const noContainment = fs.readFileSync(noContainmentPath);

  it("still registers element metadata for every meshed element (storey null)", async () => {
    const { meta } = await convertIfc(new Uint8Array(noContainment));
    const elements = Object.values(meta.elements);
    // geometry exists for all 4 products even though no containment relation does
    expect(meta.stats.triangles).toBeGreaterThan(0);
    expect(elements).toHaveLength(4);
    const wall = elements.find((e) => e.name === "Wall Ground")!;
    expect(wall).toBeDefined();
    expect(wall.type).toBe("IFCWALL");
    expect(wall.guid).toHaveLength(22);
    expect(wall.storeyGuid).toBeNull();
    expect(wall.bbox).toBeDefined();
  });
});
