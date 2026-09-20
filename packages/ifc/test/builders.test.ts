import { describe, expect, it } from "vitest";
import { Float32Builder, Uint32Builder } from "../src/builders";

describe("Float32Builder growth and view semantics", () => {
  it("grows beyond the initial capacity while preserving order", () => {
    // initial capacity 2 floats: every push3 forces at least one growth
    const b = new Float32Builder(2);
    const expected: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = i * 3;
      b.push(a, a + 1, a + 2);
      expected.push(a, a + 1, a + 2);
    }
    expect(b.len).toBe(30);
    expect(Array.from(b.view())).toEqual(expected);
  });

  it("view() reflects only pushed values, not spare capacity", () => {
    const b = new Float32Builder(64); // large: pushes never grow
    b.push(1, 2, 3);
    expect(b.view().length).toBe(3);
    expect(b.view()).not.toBe(b.view()); // subarray copy semantics: a fresh view each call
  });

  it("interleaves many growth cycles without corruption", () => {
    const b = new Float32Builder(3); // exactly one push per capacity
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 7; i++) {
        b.push(round, i, -i);
      }
    }
    expect(b.len).toBe(105);
    const view = b.view();
    let k = 0;
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 7; i++) {
        expect(view[k++]).toBe(round);
        expect(view[k++]).toBe(i);
        expect(view[k++]).toBe(-i);
      }
    }
  });
});

describe("Uint32Builder growth and view semantics", () => {
  it("grows beyond initial capacity preserving values", () => {
    const b = new Uint32Builder(2);
    const expected: number[] = [];
    for (let i = 0; i < 20; i++) {
      b.push(i);
      expected.push(i);
    }
    expect(b.len).toBe(20);
    expect(Array.from(b.view())).toEqual(expected);
  });

  it("view() truncates to pushed length", () => {
    const b = new Uint32Builder(64);
    b.push(7);
    expect(b.view().length).toBe(1);
    expect(b.view()[0]).toBe(7);
  });

  it("handles values beyond 32-bit signed range (indices stay unsigned)", () => {
    const b = new Uint32Builder(1);
    b.push(4_000_000_000);
    expect(b.view()[0]).toBe(4_000_000_000);
  });
});
