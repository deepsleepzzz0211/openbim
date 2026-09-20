import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  elementAt,
  hitAccepted,
  makeNdcRectFromCorners,
  pointInSection,
  selectionNdcPoints,
  uniqueSelection,
} from "../src/viewer/picking";

describe("elementAt", () => {
  const ranges = [
    { expressID: 41, start: 0, count: 6 },
    { expressID: 58, start: 6, count: 3 },
    { expressID: 75, start: 9, count: 12 },
  ];

  it("maps a face to the element owning its index span", () => {
    expect(elementAt(ranges, 0)).toBe(41); // indices 0..2
    expect(elementAt(ranges, 1)).toBe(41); // indices 3..5 (last of first element)
    expect(elementAt(ranges, 2)).toBe(58); // indices 6..8
    expect(elementAt(ranges, 3)).toBe(75); // indices 9..11
    expect(elementAt(ranges, 6)).toBe(75); // indices 18..20 (last of third)
  });

  it("returns null outside every range (table gaps)", () => {
    const withGap = [
      { expressID: 1, start: 0, count: 3 },
      { expressID: 2, start: 9, count: 3 },
    ];
    expect(elementAt(withGap, 2)).toBeNull(); // indices 6..8 fall in the gap
    expect(elementAt(withGap, 4)).toBeNull();
    expect(elementAt([], 0)).toBeNull();
  });

  it("handles a large table identically to a linear scan (binary search)", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ expressID: i + 1, start: i * 3, count: 3 }));
    for (const face of [0, 1, 2499, 2500, 4999]) {
      const expected = many.find((r) => face * 3 >= r.start && face * 3 < r.start + r.count)!;
      expect(elementAt(many, face)).toBe(expected.expressID);
    }
  });
});

describe("pointInSection", () => {
  it("accepts everything when no plane is active", () => {
    expect(pointInSection(new THREE.Vector3(99, -99, 0), [])).toBe(true);
  });

  it("rejects the clipped-away side of a section plane", () => {
    // three's clip semantics: fragments survive where distanceToPoint >= 0
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 5); // keeps x <= 5
    expect(pointInSection({ x: 4, y: 0, z: 0 }, [plane])).toBe(true);
    expect(pointInSection({ x: 5, y: 0, z: 0 }, [plane])).toBe(true);
    expect(pointInSection({ x: 5.5, y: 0, z: 0 }, [plane])).toBe(false);
  });

  it("requires every plane of a multi-plane section to keep the point", () => {
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
    expect(pointInSection({ x: 1, y: 0, z: 1 }, planes)).toBe(true);
    expect(pointInSection({ x: -1, y: 0, z: 1 }, planes)).toBe(false);
    expect(pointInSection({ x: 1, y: 0, z: -1 }, planes)).toBe(false);
  });
});

describe("hitAccepted", () => {
  it("accepts only fully-visible hits", () => {
    const ok = { meshVisible: true, storeyVisible: true, inSection: true };
    expect(hitAccepted(ok)).toBe(true);
    expect(hitAccepted({ ...ok, meshVisible: false })).toBe(false);
    expect(hitAccepted({ ...ok, storeyVisible: false })).toBe(false);
    expect(hitAccepted({ ...ok, inSection: false })).toBe(false);
  });
});

describe("box-select sampling", () => {
  it("orders dragged corners into an NDC rect", () => {
    const rect = makeNdcRectFromCorners({ x: 0.4, y: -0.2 }, { x: -0.6, y: 0.8 });
    expect(rect).toEqual({ minX: -0.6, minY: -0.2, maxX: 0.4, maxY: 0.8 });
  });

  it("samples a grid inside the rect including all four corners", () => {
    const rect = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    const pts = selectionNdcPoints(rect, 800, 600);
    expect(pts.length).toBeGreaterThanOrEqual(4);
    expect(pts).toContainEqual({ x: -1, y: -1 });
    expect(pts).toContainEqual({ x: 1, y: 1 });
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("stays bounded for a full-screen drag", () => {
    const pts = selectionNdcPoints({ minX: -1, minY: -1, maxX: 1, maxY: 1 }, 4000, 2400, 24, 12);
    expect(pts.length).toBeLessThanOrEqual(12 * 12);
  });

  it("a small drag still gets at least 2x2 samples", () => {
    const pts = selectionNdcPoints({ minX: 0, minY: 0, maxX: 0.02, maxY: 0.02 }, 800, 600);
    expect(pts.length).toBe(4);
  });
});

describe("uniqueSelection", () => {
  it("dedupes (versionId, expressID) preserving first-seen order", () => {
    const out = uniqueSelection([
      { versionId: "a", expressID: 1 },
      { versionId: "b", expressID: 1 },
      { versionId: "a", expressID: 1 },
      { versionId: "a", expressID: 2 },
    ]);
    expect(out).toEqual([
      { versionId: "a", expressID: 1 },
      { versionId: "b", expressID: 1 },
      { versionId: "a", expressID: 2 },
    ]);
  });
});
