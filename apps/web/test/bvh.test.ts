import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { acceleratedRaycast } from "three-mesh-bvh";
import { applySerializedBvh, buildSerializedBvh } from "../src/viewer/bvhCore";
import { BvhManager } from "../src/viewer/bvhManager";
import { elementAt, type PickRange } from "../src/viewer/picking";

// What the Viewer does at module load: swap three's linear Mesh.raycast for
// the boundsTree-aware accelerated one (plain geometries still work).
(THREE.Mesh.prototype as unknown as { raycast: unknown }).raycast = acceleratedRaycast;

/** `count` unit quads side by side along +x, each raised slightly, 2 triangles per element. */
function quadStrip(count: number): { position: Float32Array; index: Uint32Array } {
  const position = new Float32Array(count * 4 * 3);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const v = i * 4;
    const z = i * 0.001;
    const corners: Array<[number, number]> = [
      [i, 0],
      [i + 1, 0],
      [i + 1, 1],
      [i, 1],
    ];
    for (let c = 0; c < 4; c++) {
      position.set([corners[c][0], corners[c][1], z], (v + c) * 3);
    }
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  return { position, index };
}

function makeGeometry(buffers: { position: Float32Array; index: Uint32Array }): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(buffers.position, 3));
  geometry.setIndex(new THREE.BufferAttribute(buffers.index, 1));
  return geometry;
}

/** Straight-down ray at world x. */
function rayAt(x: number): THREE.Raycaster {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, 0.5, 10), new THREE.Vector3(0, 0, -1));
  rc.near = 0;
  return rc;
}

describe("BVH serialize/deserialize pipeline", () => {
  it("deserialized BVH reproduces unaccelerated raycast hits", () => {
    const buffers = quadStrip(200);
    const geometry = makeGeometry(buffers);
    const payload = buildSerializedBvh(buffers.position, buffers.index);
    expect(payload.roots.length).toBeGreaterThan(0);

    // brute force reference (no boundsTree)
    const plainMesh = new THREE.Mesh(geometry);
    plainMesh.updateMatrixWorld(true);
    const plain = rayAt(37.5).intersectObject(plainMesh, false)[0];
    expect(plain).toBeTruthy();

    applySerializedBvh(payload, geometry);
    expect(geometry.boundsTree).toBeTruthy();

    const fast = rayAt(37.5).intersectObject(plainMesh, false)[0];
    expect(fast.faceIndex).toBe(plain.faceIndex);
    expect(fast.distance).toBeCloseTo(plain.distance, 5);
  });

  it("hit faceIndex maps through the range table to the owning element", () => {
    const buffers = quadStrip(100);
    const geometry = makeGeometry(buffers);
    applySerializedBvh(buildSerializedBvh(buffers.position, buffers.index), geometry);
    const ranges: PickRange[] = Array.from({ length: 100 }, (_, i) => ({
      expressID: i + 1,
      start: i * 6,
      count: 6,
    }));
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    const hit = rayAt(55.25).intersectObject(mesh, false)[0];
    expect(hit).toBeTruthy();
    expect(elementAt(ranges, hit.faceIndex!)).toBe(56); // quad 55 spans x 55..56
  });
});

describe("BvhManager", () => {
  function harness() {
    let builds = 0;
    const manager = new BvhManager(async (position, index) => {
      builds++;
      return buildSerializedBvh(position, index);
    });
    return { manager, builds: () => builds };
  }

  const alive = () => true;

  it("builds a boundsTree for a geometry through the transport", async () => {
    const { manager, builds } = harness();
    const geometry = makeGeometry(quadStrip(10));
    await expect(manager.ensure("v:1#3", geometry, alive)).resolves.toBe(true);
    expect(geometry.boundsTree).toBeTruthy();
    expect(builds()).toBe(1);
  });

  it("reuses the cached serialized result when a chunk reloads (no rebuild)", async () => {
    const { manager, builds } = harness();
    const first = makeGeometry(quadStrip(10));
    await manager.ensure("v:1#3", first, alive);
    const reloaded = makeGeometry(quadStrip(10)); // fresh geometry after eviction
    await expect(manager.ensure("v:1#3", reloaded, alive)).resolves.toBe(true);
    expect(reloaded.boundsTree).toBeTruthy();
    expect(builds()).toBe(1);
  });

  it("dedupes concurrent ensures for the same key", async () => {
    const { manager, builds } = harness();
    const a = makeGeometry(quadStrip(8));
    const b = makeGeometry(quadStrip(8));
    await Promise.all([manager.ensure("k", a, alive), manager.ensure("k", b, alive)]);
    expect(builds()).toBe(1);
    expect(a.boundsTree).toBeTruthy();
    expect(b.boundsTree).toBeTruthy();
  });

  it("skips applying to dead geometries but keeps the cache warm", async () => {
    const { manager, builds } = harness();
    const geometry = makeGeometry(quadStrip(8));
    await expect(manager.ensure("k", geometry, () => false)).resolves.toBe(false);
    expect(geometry.boundsTree).toBeFalsy();
    expect(manager.cachedKeys).toEqual(["k"]);
    expect(builds()).toBe(1);
    const survivor = makeGeometry(quadStrip(8));
    await expect(manager.ensure("k", survivor, alive)).resolves.toBe(true);
    expect(builds()).toBe(1);
  });

  it("returns false for geometries without a position attribute", async () => {
    const { manager } = harness();
    await expect(manager.ensure("k", new THREE.BufferGeometry(), alive)).resolves.toBe(false);
  });
});
