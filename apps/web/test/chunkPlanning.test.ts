import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESIDENT_BYTES, planEvictions } from "../src/viewer/chunkPlanning";

const r = (key: string, bytes: number, touched: number, needed: boolean) => ({ key, bytes, touched, needed });

describe("planEvictions", () => {
  it("no-ops under budget", () => {
    const resident = [r("a", 10, 1, false), r("b", 10, 2, true)];
    expect(planEvictions(resident, 20, 100)).toEqual([]);
  });

  it("evicts hidden chunks least-recently-used first until under budget", () => {
    const resident = [r("a", 40, 3, false), r("b", 40, 1, false), r("c", 40, 2, true)];
    // 120 bytes, budget 90: evict b (oldest hidden) => 80 <= 90, stop before a
    expect(planEvictions(resident, 120, 90)).toEqual(["b"]);
  });

  it("evicts every hidden chunk when needed but never visible ones", () => {
    const resident = [r("a", 40, 1, false), r("b", 40, 2, false), r("c", 100, 3, true)];
    const out = planEvictions(resident, 180, 90);
    expect(out).toEqual(["a", "b"]);
  });

  it("leaves an over-budget visible set untouched (budget is a ceiling, not a panic)", () => {
    const resident = [r("a", 100, 1, true), r("b", 100, 2, true)];
    expect(planEvictions(resident, 200, 90)).toEqual([]);
  });
});

describe("DEFAULT_MAX_RESIDENT_BYTES", () => {
  it("is a sane desktop default", () => {
    expect(DEFAULT_MAX_RESIDENT_BYTES).toBe(512 * 1024 * 1024);
  });
});
