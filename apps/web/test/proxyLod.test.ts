import { describe, expect, it } from "vitest";
import {
  lodNearDistance,
  ndcBoxOfBox,
  parseProxyBoxes,
  planLodLoads,
  pointBoxDistance,
  proxyBoxesInRect,
} from "../src/viewer/proxyLod";

describe("parseProxyBoxes", () => {
  it("parses well-formed tuples", () => {
    const boxes = parseProxyBoxes("v1", [[41, "guid-a", 3, 0, 0, 0, 1, 2, 3]]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({
      versionId: "v1",
      expressID: 41,
      storeyGuid: "guid-a",
      chunkId: 3,
      min: [0, 0, 0],
      max: [1, 2, 3],
    });
  });

  it("normalises inverted extents and keeps null storey/chunk (single format)", () => {
    const boxes = parseProxyBoxes("v1", [[7, null, null, 1, 2, 3, 0, -2, -3]]);
    expect(boxes[0]?.min).toEqual([0, -2, -3]);
    expect(boxes[0]?.max).toEqual([1, 2, 3]);
    expect(boxes[0]?.storeyGuid).toBeNull();
    expect(boxes[0]?.chunkId).toBeNull();
  });

  it("drops malformed rows instead of throwing", () => {
    const junk = [
      [41, null, null, 0, 0, 0, 1, 1], // too short
      [0, null, null, 0, 0, 0, 1, 1, 1], // expressID < 1
      [41, null, null, 0, 0, 0, 1, 1, NaN], // non-finite extent
      [41, 42, null, 0, 0, 0, 1, 1, 1], // storeyGuid not a string
      [41, null, 1.5, 0, 0, 0, 1, 1, 1], // fractional chunkId
      "nope",
    ];
    expect(parseProxyBoxes("v1", junk)).toEqual([]);
    expect(parseProxyBoxes("v1", [[41, null, null, 0, 0, 0, 1, 1, 1], ...junk])).toHaveLength(1);
  });
});

describe("pointBoxDistance", () => {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [1, 1, 1];

  it("is zero inside and on the surface", () => {
    expect(pointBoxDistance({ x: 0.5, y: 0.5, z: 0.5 }, min, max)).toBe(0);
    expect(pointBoxDistance({ x: 1, y: 1, z: 1 }, min, max)).toBe(0);
  });

  it("measures axis and corner distances exactly", () => {
    expect(pointBoxDistance({ x: 3, y: 0.5, z: 0.5 }, min, max)).toBe(2);
    expect(pointBoxDistance({ x: 2, y: 2, z: 2 }, min, max)).toBeCloseTo(Math.sqrt(3), 10);
  });
});

describe("planLodLoads", () => {
  const chunks = [
    { key: "v:1", storeyKey: "v:1", bbox: [0, 0, 0, 10, 3, 10] as [number, number, number, number, number, number] },
    { key: "v:2", storeyKey: "v:2", bbox: [0, 20, 0, 10, 23, 10] as [number, number, number, number, number, number] },
    { key: "v:3", storeyKey: "v:3", bbox: [0, 40, 0, 10, 43, 10] as [number, number, number, number, number, number] },
  ];

  it("pulls in only near chunks of visible storeys", () => {
    const camera = { x: 5, y: 5, z: 5 }; // inside storey 1; 15 m from storey 2, 35 m from storey 3
    expect(planLodLoads(chunks, camera, 16, new Set(["v:1", "v:2"]))).toEqual(["v:1", "v:2"]);
    expect(planLodLoads(chunks, camera, 16, new Set(["v:1", "v:2", "v:3"]))).toEqual(["v:1", "v:2"]);
    expect(planLodLoads(chunks, camera, 10, new Set(["v:1", "v:2", "v:3"]))).toEqual(["v:1"]);
  });

  it("respects the visibility set even when close", () => {
    expect(planLodLoads(chunks, { x: 5, y: 1.5, z: 5 }, 100, new Set(["v:2"]))).toEqual(["v:2"]);
  });

  it("applies the per-version offset (federation frames)", () => {
    const shifted = [{ ...chunks[2], offset: [0, -40, 0] as [number, number, number] }]; // storey 3 slid down to the camera
    expect(planLodLoads(shifted, { x: 5, y: 5, z: 5 }, 10, new Set(["v:3"]))).toEqual(["v:3"]);
    expect(planLodLoads(chunks, { x: 5, y: 5, z: 5 }, 10, new Set(["v:3"]))).toEqual([]);
  });

  it("returns nothing when no storey is visible", () => {
    expect(planLodLoads(chunks, { x: 0, y: 0, z: 0 }, 1000, new Set())).toEqual([]);
  });
});

describe("lodNearDistance", () => {
  it("has a street-level floor for tiny models", () => {
    expect(lodNearDistance(12)).toBe(40);
  });
  it("scales with the model so fit-all views keep the core loaded", () => {
    expect(lodNearDistance(200)).toBeCloseTo(80, 5);
  });
});

describe("proxy box screen selection", () => {
  // identity-ish projection: drop z, keep x/y (an orthographic top view)
  const project = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y });

  it("computes the 2D hull of a projected box", () => {
    const box = { min: [-1, -2, 0] as [number, number, number], max: [3, 4, 9] as [number, number, number] };
    expect(ndcBoxOfBox(box, project)).toEqual({ minX: -1, minY: -2, maxX: 3, maxY: 4 });
  });

  it("yields null when every corner fails to project", () => {
    expect(ndcBoxOfBox({ min: [0, 0, 0], max: [1, 1, 1] }, () => null)).toBeNull();
  });

  it("selects overlapping boxes and skips disjoint / unprojectable ones", () => {
    const rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const boxes = [
      { minX: 0.5, minY: 0.5, maxX: 2, maxY: 2 }, // overlaps
      { minX: -3, minY: -3, maxX: -1, maxY: -1 }, // left-out
      { minX: 0.2, minY: 0.2, maxX: 0.4, maxY: 0.4 }, // fully inside
      null, // behind the camera
    ];
    expect(proxyBoxesInRect(boxes, rect)).toEqual([0, 2]);
  });
});
