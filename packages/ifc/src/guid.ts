/**
 * IFC GlobalId (compressed GUID) codec.
 *
 * Algorithm (reference: IfcOpenShell guid.py, buildingSMART):
 *  - 128-bit UUID (32 hex chars) is zero-padded to 18 bytes ("0000"),
 *  - standard base64 encoded (24 chars), first 2 chars (encoding the zero
 *    padding) are stripped -> 22 chars,
 *  - the standard base64 alphabet is translated to the IFC alphabet
 *    (digits first, then A-Z, a-z, then "_" and "$").
 */

const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const IFC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

const STD_TO_IFC = new Map<string, string>();
const IFC_TO_STD = new Map<string, string>();
for (let i = 0; i < STD.length; i++) {
  STD_TO_IFC.set(STD[i], IFC[i]);
  IFC_TO_STD.set(IFC[i], STD[i]);
}

const GUID_RE = /^[0-3][0-9A-Za-z_$]{21}$/;

/** Convert a hex UUID string (with or without dashes, optionally braced) to the 22-char IFC GlobalId. */
export function guidCompress(uuidHex: string): string {
  const clean = uuidHex.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (clean.length !== 32) {
    throw new Error(`expected 32 hex chars, got ${clean.length}`);
  }
  const buf = Buffer.from("0000" + clean, "hex");
  const std = buf.toString("base64").slice(2);
  let out = "";
  for (const c of std) {
    const t = STD_TO_IFC.get(c);
    if (t === undefined) throw new Error(`unexpected base64 char: ${c}`);
    out += t;
  }
  return out;
}

/** Convert a 22-char IFC GlobalId back to the canonical dashed hex UUID. */
export function guidExpand(guid: string): string {
  if (guid.length !== 22) {
    throw new Error(`expected 22 chars, got ${guid.length}`);
  }
  let std = "";
  for (const c of guid) {
    const t = IFC_TO_STD.get(c);
    if (t === undefined) throw new Error(`invalid IFC guid char: ${c}`);
    std += t;
  }
  const buf = Buffer.from("AA" + std, "base64");
  // Stryker disable next-line EqualityOperator: unreachable — 24 legal base64 chars always decode to 18 bytes
  if (buf.length !== 18) {
    throw new Error("guid decoded to unexpected length");
  }
  const hex = buf.toString("hex").slice(4);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** True when the string is a syntactically valid 22-char IFC GlobalId. */
export function isValidIfcGuid(value: unknown): value is string {
  return typeof value === "string" && GUID_RE.test(value);
}
