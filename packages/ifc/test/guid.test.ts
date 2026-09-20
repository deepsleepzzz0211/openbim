import { describe, expect, it } from "vitest";
import { guidCompress, guidExpand, isValidIfcGuid } from "../src/guid";

describe("IFC GUID codec", () => {
  it("round-trips a UUID", () => {
    const uuid = "f6a0b0f2-1500-4d8f-81a3-8a0e5a4e4a01";
    const guid = guidCompress(uuid);
    expect(guid).toHaveLength(22);
    expect(guidExpand(guid)).toBe(uuid);
  });

  it("produces the documented IFC alphabet only", () => {
    const uuid = "2b6f3d90-1f4a-4c8e-9d1a-7c3e5b8a9f01";
    const guid = guidCompress(uuid);
    expect(guid).toMatch(/^[0-9A-Za-z_$]{22}$/);
  });

  it("first character is always 0-3 (2 top bits of the first byte)", () => {
    for (let i = 0; i < 50; i++) {
      const uuid = crypto.randomUUID();
      const guid = guidCompress(uuid);
      expect(guid[0]).toMatch(/^[0-3]$/);
      expect(guidExpand(guid)).toBe(uuid);
    }
  });

  it("accepts braced and dashed UUIDs", () => {
    const a = guidCompress("{F6A0B0F2-1500-4D8F-81A3-8A0E5A4E4A01}");
    const b = guidCompress("F6A0B0F215004D8F81A38A0E5A4E4A01");
    expect(a).toBe(b);
  });

  it("rejects malformed input", () => {
    expect(() => guidCompress("not-a-uuid")).toThrow();
    expect(() => guidExpand("short")).toThrow();
  });

  it("validates IFC guids", () => {
    expect(isValidIfcGuid("0YvctVUKr0kugbFTf53O9L")).toBe(true);
    expect(isValidIfcGuid("8YvctVUKr0kugbFTf53O9L")).toBe(false); // must start 0-3
    expect(isValidIfcGuid("0YvctVUKr0kugbFTf53O9")).toBe(false); // too short
    expect(isValidIfcGuid(null)).toBe(false);
  });
});

describe("guid codec error messages and edge branches", () => {
  it("compress reports the expected character count in the error", () => {
    expect(() => guidCompress("abc")).toThrowError(/expected 32 hex chars, got 3/);
    expect(() => guidCompress("")).toThrowError(/expected 32 hex chars, got 0/);
  });

  it("expand reports length violations in the error", () => {
    expect(() => guidExpand("short")).toThrowError(/expected 22 chars, got 5/);
  });

  it("expand rejects characters outside the IFC alphabet", () => {
    // '@' is not in 0-9A-Za-z_$
    expect(() => guidExpand("@YvctVUKr0kugbFTf53O9L".padEnd(22, "0"))).toThrowError(/invalid IFC guid char/);
    // '$' and '_' ARE valid alphabet members
    const valid = "0YvctVUKr0kugbFTf53O9$";
    expect(() => guidExpand(valid)).not.toThrow();
  });

  it("is invariant to alphabet membership on round-trip", () => {
    // exercise the high end of the alphabet via targeted bytes
    const uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(guidExpand(guidCompress(uuid))).toBe(uuid);
    const zero = "00000000-0000-0000-0000-000000000000";
    expect(guidCompress(zero)).toBe("0000000000000000000000");
    expect(guidExpand("0000000000000000000000")).toBe(zero);
  });

  it("isValidIfcGuid rejects non-string inputs of any shape", () => {
    expect(isValidIfcGuid(123)).toBe(false);
    expect(isValidIfcGuid({})).toBe(false);
    expect(isValidIfcGuid(["0YvctVUKr0kugbFTf53O9L"])).toBe(false);
    expect(isValidIfcGuid(undefined)).toBe(false);
    expect(isValidIfcGuid("")).toBe(false);
  });
});

describe("isValidIfcGuid regex anchors", () => {
  it("rejects strings that are valid but for the leading/trailing junk", () => {
    expect(isValidIfcGuid("x0YvctVUKr0kugbFTf53O9L")).toBe(false); // junk prefix
    expect(isValidIfcGuid("0YvctVUKr0kugbFTf53O9Lx")).toBe(false); // junk suffix
    expect(isValidIfcGuid(" 0YvctVUKr0kugbFTf53O9L")).toBe(false); // whitespace
    expect(isValidIfcGuid("0YvctVUKr0kugbFTf53O9L\n")).toBe(false);
  });

  it("accepts boundary alphabet characters in every position", () => {
    // '_' and '$' in trailing positions, '3' as the leading maximum
    const guid = "3" + "_".repeat(8) + "$".repeat(13);
    expect(guid.length).toBe(22);
    expect(isValidIfcGuid(guid)).toBe(true);
  });
});
