/**
 * Ticket 10: GB-scale pre-split pipeline.
 *
 *  1. presplitIfcFile — text-level per-storey STEP slicing. Streams the file
 *     with a byte-level statement scanner (no full-file buffer), keeps a
 *     compact statement table (byte ranges + #id references), assigns every
 *     entity to a shard by spatial containment, shares the project/site/
 *     building/storey "base" set across shards, and writes N valid STEP files
 *     whose entity ids are preserved verbatim (so per-shard expressIDs match
 *     the whole-model conversion).
 *  2. Shard conversion — each shard is an ordinary convertIfcFile job, so the
 *     caller can fan them out across the worker pool in parallel.
 *  3. aggregatePresplitShards — stitches shard artifacts back into one
 *     manifest-contract artifact: concatenated bucket tables, globally unique
 *     chunk ids, per-shard origin deltas folded into node translations and
 *     bboxes, merged element index and spatial tree.
 *
 * Consistency contract with whole-model conversion (asserted by tests):
 * element GUID/type/storey/psets, triangle conservation and the chunk
 * manifest partition rules. Geometry is origin-aligned; tessellation may
 * deviate slightly because web-ifc's COORDINATE_TO_ORIGIN pivot differs per
 * shard. Known rare deviations: an element contained under two storeys is
 * emitted in both; a relationship shared across storeys lands in every
 * involved shard.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IfcConversionError, convertIfcFile, type ConvertOptions } from "./convert";
import type { ChunkManifestEntry, ConversionMeta, ElementMeta, SpatialNode } from "./types";

const SPATIAL_TYPES = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE"]);
const CONTAINMENT_TYPE = "IFCRELCONTAINEDINSPATIALSTRUCTURE";
const AGGREGATES_TYPE = "IFCRELAGGREGATES";

// ---------------------------------------------------------------------------
// growable helpers
// ---------------------------------------------------------------------------

class GI32 {
  private a = new Int32Array(1 << 12);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const g = new Int32Array(this.a.length * 2);
      g.set(this.a);
      this.a = g;
    }
    this.a[this.n++] = v;
  }
  at(i: number): number {
    return this.a[i];
  }
}

class GF64 {
  private a = new Float64Array(1 << 12);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const g = new Float64Array(this.a.length * 2);
      g.set(this.a);
      this.a = g;
    }
    this.a[this.n++] = v;
  }
  at(i: number): number {
    return this.a[i];
  }
}

/** nShards flags per entity id. */
class ShardBits {
  private readonly words: Uint32Array;
  private readonly w: number;
  constructor(maxId: number, nShards: number) {
    this.w = Math.max(1, Math.ceil(nShards / 32));
    this.words = new Uint32Array((maxId + 1) * this.w);
  }
  set(id: number, shard: number): void {
    this.words[id * this.w + (shard >>> 5)] |= 1 << (shard & 31);
  }
  test(id: number, shard: number): boolean {
    return ((this.words[id * this.w + (shard >>> 5)] >>> (shard & 31)) & 1) === 1;
  }
  any(id: number): boolean {
    const base = id * this.w;
    for (let k = 0; k < this.w; k++) if (this.words[base + k]) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// byte-level STEP scanning
// ---------------------------------------------------------------------------

interface DataSection {
  /** first byte of the first DATA statement line (right after `DATA;\n`) */
  dataStart: number;
  /** first byte of the `ENDSEC;` line closing DATA */
  dataEnd: number;
}

function findDataSection(fd: number, size: number): DataSection {
  const CHUNK = 4 << 20;
  const OVERLAP = 64;
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0;
  let dataStart = -1;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
    if (n <= 0) break;
    const text = buf.toString("latin1", 0, n);
    if (dataStart === -1) {
      const m = /\r?\n[ \t]*DATA;[ \t]*\r?\n/gi.exec(text);
      if (m) dataStart = pos + m.index + m[0].length;
    }
    if (dataStart !== -1) {
      for (const m of text.matchAll(/\r?\n[ \t]*ENDSEC;[ \t]*(?=\r?\n)/gi)) {
        const at = pos + m.index + m[0].indexOf("ENDSEC");
        if (at > dataStart) return { dataStart, dataEnd: at };
      }
    }
    pos += Math.max(1, n - OVERLAP);
  }
  throw new IfcConversionError("IFC file has no DATA section", "PARSE_FAILED");
}

/** Parse `#12=IFCTYPE(` out of a statement's header peek. */
function parseHeader(head: string): { id: number; type: string | null } {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*#(\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)/.exec(head);
  if (!m) return { id: -1, type: null };
  return { id: Number(m[1]), type: m[2].toUpperCase() };
}

const EMPTY_REFS: number[] = [];

/**
 * Stream STEP statements in [from, to). A statement runs from its first
 * non-whitespace byte to the first top-level `;` (outside `'` strings and
 * `/* *\/` comments) and may span physical lines and read chunks.
 *
 * - collectRefs records every `#<digits>` reference token after the owner.
 * - wantText collects only a HEADER PEEK (first HEADER_PEEK bytes): enough to
 *   parse `#id=TYPE` without materialising 100k+ full statement strings.
 *   Callers that need the argument list re-read the byte range (rel statements
 *   are rare; `text.length === HEADER_PEEK` flags the truncation).
 */
function scanStatements(
  fd: number,
  from: number,
  to: number,
  opts: { collectRefs: boolean; wantText: boolean },
  onStmt: (start: number, end: number, refs: number[], text: string | null) => void
): void {
  const CHUNK = 4 << 20;
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = from;

  let open = false;
  let start = 0;
  let inString = false;
  let inComment = false;
  let refs: number[] = EMPTY_REFS;
  let ownerPending = true;
  let hashSeen = false;
  let hashVal = 0;
  let hashDigits = 0;
  let segs: Buffer[] = [];
  let segTotal = 0;
  let segFrom = 0;
  // single-byte lookaheads that straddle chunk boundaries
  let pendQuote = false;
  let pendSlash = false;
  let pendStar = false;

  const openAt = (absStart: number, idx: number): void => {
    open = true;
    start = absStart;
    inString = false;
    inComment = false;
    refs = opts.collectRefs ? [] : EMPTY_REFS;
    ownerPending = true;
    hashSeen = false;
    hashVal = 0;
    hashDigits = 0;
    segs = [];
    segTotal = 0;
    segFrom = idx;
  };
  const takeSeg = (upto: number): void => {
    if (!opts.wantText || segTotal >= HEADER_PEEK || upto <= segFrom) return;
    const end = Math.min(upto, segFrom + (HEADER_PEEK - segTotal));
    segs.push(Buffer.from(buf.subarray(segFrom, end)));
    segTotal += end - segFrom;
  };
  const closeStatement = (): string | null => {
    if (hashSeen && hashDigits > 0) refs.push(hashVal);
    hashSeen = false;
    hashDigits = 0;
    const text = opts.wantText ? (segs.length === 1 ? segs[0].toString("latin1") : Buffer.concat(segs).toString("latin1")) : null;
    open = false;
    return text;
  };

  while (pos < to) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, to - pos), pos);
    if (n <= 0) break;
    const base = pos;
    pos += n;
    let i = 0;

    // resolve boundary carry-over states from the previous chunk
    if (pendQuote) {
      pendQuote = false;
      if (i < n && buf[i] === 0x27) i++; // escaped '' continues the string
      else if (open) inString = false;
    }
    if (pendSlash) {
      pendSlash = false;
      if (i < n && buf[i] === 0x2a) {
        inComment = true;
        i++;
      }
    }
    if (pendStar) {
      pendStar = false;
      if (i < n && buf[i] === 0x2f && inComment) i++; // comment ends; next byte may terminate
    }
    if (hashSeen) {
      while (i < n && buf[i] >= 0x30 && buf[i] <= 0x39) {
        hashVal = hashVal * 10 + (buf[i] - 0x30);
        hashDigits++;
        i++;
      }
    }
    segFrom = 0;

    let skipRest = false;
    while (i < n && !skipRest) {
      if (!open) {
        while (i < n && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
        if (i === n) break;
        openAt(base + i, i);
      }
      let closedEnd = -1;
      for (; i < n; i++) {
        const c = buf[i];
        if (hashSeen) {
          if (c >= 0x30 && c <= 0x39) {
            hashVal = hashVal * 10 + (c - 0x30);
            hashDigits++;
            continue;
          }
          if (!(ownerPending && c === 0x3d) && hashDigits > 0) refs.push(hashVal);
          ownerPending = false;
          hashSeen = false;
          hashVal = 0;
          hashDigits = 0;
          if (c === 0x3b) {
            closedEnd = i;
            break;
          }
          continue;
        }
        if (inComment) {
          if (c === 0x2a) {
            if (i + 1 < n) {
              if (buf[i + 1] === 0x2f) i++;
              else continue; // '*' not followed by '/' stays inside the comment
            } else pendStar = true;
          }
          continue;
        }
        if (inString) {
          if (c === 0x27) {
            if (i + 1 < n) {
              if (buf[i + 1] === 0x27) i++;
              else inString = false;
            } else pendQuote = true;
          }
          continue;
        }
        if (c === 0x23 && opts.collectRefs) {
          hashSeen = true;
          hashVal = 0;
          hashDigits = 0;
          continue;
        }
        if (c === 0x27) inString = true;
        else if (c === 0x2f) {
          if (i + 1 < n) {
            if (buf[i + 1] === 0x2a) {
              inComment = true;
              i++;
            }
          } else pendSlash = true;
        } else if (c === 0x3b) {
          closedEnd = i;
          break;
        }
      }
      if (closedEnd === -1) {
        takeSeg(n);
        i = n;
        skipRest = true;
        break;
      }
      takeSeg(closedEnd + 1);
      const text = closeStatement();
      onStmt(start, base + closedEnd + 1, refs, text);
      i = closedEnd + 1;
    }
  }
  if (open) {
    // tolerant EOF: statement without a terminator
    const text = opts.wantText && segs.length ? (segs.length === 1 ? segs[0].toString("latin1") : Buffer.concat(segs).toString("latin1")) : null;
    onStmt(start, to, refs, text);
  }
}

// ---------------------------------------------------------------------------
// statement table
// ---------------------------------------------------------------------------

interface ContainmentRel {
  id: number;
  slot: number;
  structId: number;
  elements: number[];
}
interface AggregateRel {
  id: number;
  slot: number;
  parent: number;
  children: number[];
}

interface StmtTable {
  n: number;
  starts: GF64;
  ends: GF64;
  ids: GI32;
  refsOff: GI32;
  refsLen: GI32;
  refsFlat: GI32;
  slotOf: Int32Array;
  maxId: number;
  containments: ContainmentRel[];
  aggregates: AggregateRel[];
  spatialSlots: number[];
}

/** Split the `(...)` argument list of an entity statement at top level. */
export function splitTopLevelArgs(text: string): string[] | null {
  const open = text.indexOf("(");
  if (open === -1) return null;
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (text[k + 1] === "'") {
          cur += "'";
          k++;
        } else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      if (depth > 1) cur += c;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return args;
      }
      cur += c;
      continue;
    }
    if (c === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    if (depth >= 1) cur += c;
  }
  return args.length ? args : null;
}

function argRefs(arg: string | undefined): number[] {
  if (!arg || arg === "$" || arg === "*") return [];
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg))) out.push(Number(m[1]));
  return out;
}
function argRef(arg: string | undefined): number | null {
  const list = argRefs(arg);
  return list.length ? list[0] : null;
}

const HEADER_PEEK = 512;

function readRange(fd: number, start: number, end: number): Buffer {
  const len = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, start + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}
function readRangeText(fd: number, start: number, end: number): string {
  return readRange(fd, start, end).toString("latin1");
}
function headerAt(fd: number, start: number): { id: number; type: string | null } {
  return parseHeader(readRangeText(fd, start, start + HEADER_PEEK));
}

function buildTable(fd: number, sec: DataSection): StmtTable {
  const t: StmtTable = {
    n: 0,
    starts: new GF64(),
    ends: new GF64(),
    ids: new GI32(),
    refsOff: new GI32(),
    refsLen: new GI32(),
    refsFlat: new GI32(),
    slotOf: new Int32Array(0),
    maxId: 0,
    containments: [],
    aggregates: [],
    spatialSlots: [],
  };
  const idToSlot = new Map<number, number>();
  scanStatements(fd, sec.dataStart, sec.dataEnd, { collectRefs: true, wantText: true }, (start, end, refs, text) => {
    const slot = t.n++;
    t.starts.push(start);
    t.ends.push(end);
    t.refsOff.push(t.refsFlat.n);
    for (const r of refs) t.refsFlat.push(r);
    t.refsLen.push(refs.length);
    const head = text !== null ? parseHeader(text) : headerAt(fd, start);
    t.ids.push(head.id);
    if (head.id >= 0) {
      if (head.id > t.maxId) t.maxId = head.id;
      if (!idToSlot.has(head.id)) idToSlot.set(head.id, slot);
      const type = head.type ?? "";
      if (SPATIAL_TYPES.has(type)) t.spatialSlots.push(slot);
      else if (type === CONTAINMENT_TYPE || type === AGGREGATES_TYPE) {
        // wantText only peeks the header; relationship argument lists re-read
        // the full statement range (rare statements, cheap on demand).
        const full = text !== null && text.length < HEADER_PEEK ? text : readRangeText(fd, start, end);
        const args = splitTopLevelArgs(full);
        // IFC4 argument order: (GlobalId, OwnerHistory, Name, Description,
        // RelatedElements|RelatingObject, RelatingStructure|RelatedObjects)
        if (args && type === CONTAINMENT_TYPE) {
          t.containments.push({ id: head.id, slot, structId: argRef(args[5]) ?? -1, elements: argRefs(args[4]) });
        } else if (args && type === AGGREGATES_TYPE) {
          t.aggregates.push({ id: head.id, slot, parent: argRef(args[4]) ?? -1, children: argRefs(args[5]) });
        }
      }
    }
  });
  t.slotOf = new Int32Array(t.maxId + 1).fill(-1);
  for (const [id, slot] of idToSlot) t.slotOf[id] = slot;
  return t;
}

function refsOf(t: StmtTable, slot: number): number[] {
  const off = t.refsOff.at(slot);
  const len = t.refsLen.at(slot);
  const out: number[] = [];
  for (let k = 0; k < len; k++) out.push(t.refsFlat.at(off + k));
  return out;
}

// ---------------------------------------------------------------------------
// preslice
// ---------------------------------------------------------------------------

export interface PresplitShardInfo {
  index: number;
  /** absolute path of the written shard .ifc file */
  path: string;
  /** RelatingStructure expressID of this shard; null for the leftover shard */
  structureExpressID: number | null;
  /** elements whose containment lands in this shard */
  ownedElements: number;
  sizeBytes: number;
}

export interface PresplitOptions {
  onProgress?: (percent: number) => void;
}

/**
 * Slice a STEP file into per-structure shard files that keep the original
 * entity ids. Streaming only: peak memory is the statement table
 * (~40 bytes/statement) plus one read buffer.
 */
export function presplitIfcFile(inputPath: string, shardDir: string, opts: PresplitOptions = {}): PresplitShardInfo[] {
  const size = fs.statSync(inputPath).size;
  const fd = fs.openSync(inputPath, "r");
  try {
    if (!readRangeText(fd, 0, 16).startsWith("ISO-10303-21")) {
      throw new IfcConversionError("input is not an IFC (ISO-10303-21) file", "PARSE_FAILED");
    }
    const sec = findDataSection(fd, size);
    const table = buildTable(fd, sec);
    opts.onProgress?.(40);

    // ---- structures and element ownership ----------------------------------
    const containments = [...table.containments].sort((a, b) => a.id - b.id);
    const structIds: number[] = [];
    for (const c of containments) {
      if (c.structId >= 0 && !structIds.includes(c.structId)) structIds.push(c.structId);
    }
    structIds.sort((a, b) => a - b);
    const nStruct = structIds.length;
    const shardOfStruct = new Map<number, number>();
    structIds.forEach((s, i) => shardOfStruct.set(s, i));
    const REST = nStruct;
    const nShards = nStruct + 1;

    const ownerOf = new Int32Array(table.maxId + 1); // 0 none, else shard+1
    const contBits = new ShardBits(table.maxId, nShards);
    for (const c of containments) {
      const s = shardOfStruct.get(c.structId);
      if (s === undefined) continue;
      for (const e of c.elements) {
        if (e < 0 || e > table.maxId) continue;
        contBits.set(e, s);
        if (!ownerOf[e]) ownerOf[e] = s + 1;
      }
    }

    // ---- aggregates with non-spatial children: rewrite per shard ------------
    const slotType = (id: number): string | null => {
      if (id < 0 || id > table.maxId) return null;
      const slot = table.slotOf[id];
      return slot === -1 ? null : (headerAt(fd, table.starts.at(slot)).type ?? "");
    };
    const isSpatialId = (id: number): boolean => SPATIAL_TYPES.has(slotType(id) ?? "");
    const aggDropRaw = new Set<number>();
    interface AggRewriteLine {
      headId: number;
      headType: string;
      args: string[];
      keep: number[];
    }
    const aggRewrite = new Map<number, Map<number, AggRewriteLine>>();
    for (const a of table.aggregates) {
      const resolved = a.children.filter((id) => id >= 0 && id <= table.maxId && table.slotOf[id] !== -1);
      const productKids = resolved.filter((id) => !isSpatialId(id));
      if (!productKids.length) continue;
      aggDropRaw.add(a.slot);
      for (const p of productKids) {
        if (!ownerOf[p]) ownerOf[p] = REST + 1;
      }
      const text = readRangeText(fd, table.starts.at(a.slot), table.ends.at(a.slot));
      const head = parseHeader(text);
      const args = splitTopLevelArgs(text);
      if (!args || head.id < 0) continue;
      const spatialKids = resolved.filter((id) => isSpatialId(id));
      for (let s = 0; s < nShards; s++) {
        const keep = [...spatialKids, ...productKids.filter((id) => ownerOf[id] === s + 1)];
        let m = aggRewrite.get(a.slot);
        if (!m) aggRewrite.set(a.slot, (m = new Map()));
        // rendered at write time: `keep` must be filtered by what actually lands in shard s
        m.set(s, { headId: head.id, headType: head.type ?? AGGREGATES_TYPE, args: [...args], keep });
      }
    }

    // ---- closure expansion ---------------------------------------------------
    // Membership is bidirectional: a shard holds the *outgoing* reference
    // closure of its seeds, plus every entity that *references* one of its
    // non-base members (IfcStyledItem chains, pset links, material usages …).
    // Base (spatial) entities never trigger the reverse rule — every shard
    // references them, and containment rels would flood across shards.
    const base = new Uint8Array(table.maxId + 1);
    const bits = new ShardBits(table.maxId, nShards);
    const expand = (seeds: Iterable<number>, mark: (id: number) => boolean, out?: number[]): boolean => {
      const queue = out ?? [];
      const push = (id: number): void => {
        if (id >= 0 && id <= table.maxId && mark(id)) queue.push(id);
      };
      for (const id of seeds) push(id);
      const grew = queue.length > 0;
      for (let qi = 0; qi < queue.length; qi++) {
        const slot = table.slotOf[queue[qi]];
        if (slot === -1) continue;
        for (const r of refsOf(table, slot)) push(r);
      }
      return grew;
    };
    const markBase = (id: number): boolean => {
      if (base[id]) return false;
      base[id] = 1;
      return true;
    };
    const markShard = (s: number) => (id: number): boolean => {
      if (bits.test(id, s)) return false;
      bits.set(id, s);
      return true;
    };

    const baseSeeds: number[] = [];
    for (const slot of table.spatialSlots) baseSeeds.push(table.ids.at(slot));
    for (const c of containments) baseSeeds.push(c.structId);
    for (const a of table.aggregates) {
      if (aggDropRaw.has(a.slot)) continue;
      baseSeeds.push(a.id, a.parent, ...a.children);
    }
    expand(baseSeeds, markBase);

    const shardSeeds: number[][] = structIds.map(() => []);
    for (const c of containments) {
      const s = shardOfStruct.get(c.structId);
      if (s === undefined) continue;
      shardSeeds[s].push(c.id, ...c.elements);
    }
    for (const a of table.aggregates) {
      if (!aggDropRaw.has(a.slot)) continue;
      for (const id of a.children) {
        if (id >= 0 && id <= table.maxId && ownerOf[id] > 0) shardSeeds[ownerOf[id] - 1].push(id);
      }
    }
    const queues: number[][] = Array.from({ length: nShards }, () => []);
    for (let s = 0; s < nStruct; s++) expand(shardSeeds[s], markShard(s), queues[s]);
    opts.onProgress?.(55);

    // ---- reverse reference index (CSR: target id -> referrer ids) ------------
    const inStart = new Int32Array(table.maxId + 2);
    for (let k = 0; k < table.refsFlat.n; k++) {
      const r = table.refsFlat.at(k);
      if (r >= 0 && r <= table.maxId) inStart[r + 1]++;
    }
    for (let i = 0; i <= table.maxId; i++) inStart[i + 1] += inStart[i];
    const revSrc = new Int32Array(inStart[table.maxId + 1]);
    {
      // real copy: filling through a subarray would advance inStart itself
      const cursor = Int32Array.from(inStart.subarray(0, table.maxId + 1));
      for (let slot = 0; slot < table.n; slot++) {
        const src = table.ids.at(slot);
        if (src < 0 || src > table.maxId) continue;
        const off = table.refsOff.at(slot);
        const len = table.refsLen.at(slot);
        for (let k = 0; k < len; k++) {
          const r = table.refsFlat.at(off + k);
          if (r >= 0 && r <= table.maxId) revSrc[cursor[r]++] = src;
        }
      }
    }

    // Drain a shard's frontier: every referrer of a newly-marked non-base
    // entity joins the shard (foreign-owned products excluded — they would be
    // filtered out of the file anyway, leaving dangling references behind).
    const attract = (s: number, q: number[]): void => {
      for (let qi = 0; qi < q.length; qi++) {
        const e = q[qi];
        if (base[e]) continue;
        for (let k = inStart[e]; k < inStart[e + 1]; k++) {
          const x = revSrc[k];
          if (base[x] || bits.test(x, s)) continue;
          if (ownerOf[x] > 0 && ownerOf[x] - 1 !== s && !contBits.test(x, s)) continue;
          expand([x], markShard(s), q);
        }
      }
    };
    for (let s = 0; s < nStruct; s++) attract(s, queues[s]);

    // ---- leftover detection + REST closure ------------------------------------
    // Entities owned by no storey shard (uncontained products, relationships
    // that reference nothing sharded) land in the trailing leftover shard.
    const restSeeds: number[] = [];
    for (let slot = 0; slot < table.n; slot++) {
      const id = table.ids.at(slot);
      if (id < 0 || aggDropRaw.has(slot)) continue;
      if (!base[id] && !bits.any(id)) restSeeds.push(id);
    }
    let hasRest = restSeeds.length > 0;
    for (const a of table.aggregates) {
      if (!aggDropRaw.has(a.slot)) continue;
      for (const id of a.children) if (id >= 0 && id <= table.maxId && ownerOf[id] === REST + 1) hasRest = true;
    }
    if (hasRest) {
      expand(restSeeds, markShard(REST), queues[REST]);
      attract(REST, queues[REST]);
    }
    const liveShards = hasRest ? nShards : nStruct;
    // release fixed-point temporaries before the allocation-heavy write phase
    for (const q of queues) q.length = 0;
    shardSeeds.length = 0;
    restSeeds.length = 0;
    const owned = new Array<number>(nShards).fill(0);
    for (let id = 1; id <= table.maxId; id++) if (ownerOf[id] > 0) owned[ownerOf[id] - 1]++;

    // ---- write phase ----------------------------------------------------------
    fs.mkdirSync(shardDir, { recursive: true });
    const shardPath = (index: number): string => path.join(shardDir, `shard-${String(index).padStart(4, "0")}.ifc`);
    const headerBuf = readRange(fd, 0, sec.dataStart); // includes the DATA; line
    const footerBuf = readRange(fd, sec.dataEnd, size); // ENDSEC; ... END-ISO;
    const newline = Buffer.from("\n", "latin1");

    const BATCH = 32;
    /** does entity `id` physically appear in shard `s`'s output file? */
    const included = (id: number, s: number): boolean => {
      if (id < 0) return true;
      if (base[id]) return true;
      if (!bits.test(id, s)) return false;
      // foreign-owned element pulled in by a shared relationship
      return !(ownerOf[id] > 0 && ownerOf[id] - 1 !== s && !contBits.test(id, s));
    };
    for (let b = 0; b < liveShards; b += BATCH) {
      const batchEnd = Math.min(b + BATCH, liveShards);
      const fds: number[] = [];
      for (let s = b; s < batchEnd; s++) fds.push(fs.openSync(shardPath(s), "w"));
      for (const fdW of fds) fs.writeSync(fdW, headerBuf);
      let slot = -1;
      scanStatements(
        fd,
        sec.dataStart,
        sec.dataEnd,
        { collectRefs: false, wantText: false },
        (start, end, _refs, _text) => {
          slot++;
          const id = table.ids.at(slot);
          const rw = aggRewrite.get(slot);
          for (let s = b; s < batchEnd; s++) {
            const fdS = fds[s - b];
            if (rw) {
              const line = rw.get(s);
              if (line) {
                const keep = line.keep.filter((k) => included(k, s));
                const args = [...line.args];
                args[5] = keep.length ? `(${keep.map((k) => `#${k}`).join(",")})` : "$";
                fs.writeSync(fdS, Buffer.from(`#${line.headId}=${line.headType}(${args.join(",")});\n`, "latin1"));
              }
              continue;
            }
            if (!included(id, s)) continue;
            const len = end - start;
            const chunk = Buffer.allocUnsafe(len);
            fs.readSync(fd, chunk, 0, len, start);
            fs.writeSync(fdS, chunk);
            fs.writeSync(fdS, newline);
          }
        }
      );
      for (const fdW of fds) {
        fs.writeSync(fdW, footerBuf);
        fs.closeSync(fdW);
      }
    }
    opts.onProgress?.(100);

    const infos: PresplitShardInfo[] = [];
    for (let s = 0; s < liveShards; s++) {
      const p = shardPath(s);
      infos.push({
        index: s,
        path: p,
        structureExpressID: s < nStruct ? structIds[s] : null,
        ownedElements: owned[s],
        sizeBytes: fs.statSync(p).size,
      });
    }
    return infos;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// GLB read/write helpers (aggregation rewrites JSON only; the BIN is copied)
// ---------------------------------------------------------------------------

interface GlbNodeDef {
  translation?: number[];
  extras?: { bucket?: number };
  [k: string]: unknown;
}
interface GlbDoc {
  json: { nodes?: GlbNodeDef[]; [k: string]: unknown };
  bin: Buffer;
}

export function readGlbFile(p: string): GlbDoc {
  const b = fs.readFileSync(p);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) {
    throw new IfcConversionError(`${path.basename(p)} is not a GLB file`, "PARSE_FAILED");
  }
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString("utf8", 20, 20 + jsonLen)) as GlbDoc["json"];
  let bin = Buffer.alloc(0);
  const binHeader = 20 + jsonLen;
  if (b.length >= binHeader + 8) {
    const binLen = b.readUInt32LE(binHeader);
    bin = b.subarray(binHeader + 8, binHeader + 8 + binLen);
  }
  return { json, bin };
}

export function writeGlbFile(p: string, json: GlbDoc["json"], bin: Buffer): void {
  const jsonText = JSON.stringify(json);
  const jsonPad = (4 - (jsonText.length % 4)) % 4;
  const jsonBytes = Buffer.alloc(jsonText.length + jsonPad, 0x20);
  jsonBytes.write(jsonText, 0, jsonText.length, "utf8");
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBytes = Buffer.alloc(bin.length + binPad);
  bin.copy(binBytes);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonBytes.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binBytes.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(p, Buffer.concat([head, jsonBytes, binHead, binBytes]));
}

// ---------------------------------------------------------------------------
// shard artifact aggregation
// ---------------------------------------------------------------------------

export interface PresplitShardArtifact {
  shardIndex: number;
  structureExpressID: number | null;
  /** shard meta.json written by the shard conversion */
  metaPath: string;
  /** directory holding the shard's model.glb and/or chunks/ */
  artifactDir: string;
}

type Box6 = [number, number, number, number, number, number];
type V3 = [number, number, number];

function shiftBox(box: Box6, d: V3): Box6 {
  return [box[0] + d[0], box[1] + d[1], box[2] + d[2], box[3] + d[0], box[4] + d[1], box[5] + d[2]];
}

function mergeSpatial(a: SpatialNode, b: SpatialNode): void {
  for (const childB of b.children) {
    const childA = a.children.find((c) => c.expressID === childB.expressID);
    if (childA) mergeSpatial(childA, childB);
    else a.children.push(childB);
  }
}

/**
 * Merge shard artifacts into one manifest-contract artifact written next to
 * out.glbPath (chunks/<id>.glb; a single model.glb when only one chunk
 * survives). Returns the merged ConversionMeta; the caller persists it.
 */
export function aggregatePresplitShards(
  artifacts: PresplitShardArtifact[],
  out: { glbPath: string }
): ConversionMeta {
  const shards = [...artifacts].sort((a, b) => a.shardIndex - b.shardIndex);
  const metas = shards.map((s) => {
    const m = JSON.parse(fs.readFileSync(s.metaPath, "utf8")) as ConversionMeta;
    return { art: s, m };
  });
  const withGeom = metas.filter((x) => (x.m.buckets?.length ?? 0) > 0);
  if (!metas.length || !metas.some((x) => (x.m.buckets?.length ?? 0) > 0 || Object.keys(x.m.elements ?? {}).length)) {
    throw new IfcConversionError("no elements or geometry found across presplit shards", "EMPTY_MODEL");
  }
  const originGlobal: V3 = withGeom.length > 0 ? ([...withGeom[0].m.origin] as V3) : ([0, 0, 0] as V3);

  const baseMeta = metas[0].m;
  const bucketsOut: ConversionMeta["buckets"] = [];
  const elementsOut: Record<string, ElementMeta> = {};
  const chunkEntries: ChunkManifestEntry[] = [];
  const outDir = path.dirname(out.glbPath);
  const chunkDir = path.join(outDir, "chunks");
  let fallbackViews = 0;
  let codec: "meshopt" | "none" = "none";

  for (const { art, m } of metas) {
    const o = m.origin ?? [0, 0, 0];
    const delta: V3 = [o[0] - originGlobal[0], o[1] - originGlobal[1], o[2] - originGlobal[2]];
    const bucketBase = bucketsOut.length;
    for (const b of m.buckets ?? []) bucketsOut.push(b);
    fallbackViews += m.glbCompression?.fallbackViews ?? 0;
    if (m.glbCompression?.codec === "meshopt") codec = "meshopt";

    interface LocalEntry {
      localId: number;
      src: string;
      storeyExpressID: number | null;
      storeyGuid: string | null;
      bbox: Box6;
      triangles: number;
      buckets: number[];
      overflowed?: boolean;
    }
    let locals: LocalEntry[] = [];
    if ((m.artifactFormat ?? "single") === "chunked" && m.chunks?.length) {
      locals = m.chunks.map((c) => ({
        localId: c.id,
        src: path.join(art.artifactDir, "chunks", `${c.id}.glb`),
        storeyExpressID: c.storeyExpressID,
        storeyGuid: c.storeyGuid,
        bbox: [...c.bbox] as Box6,
        triangles: c.triangles,
        buckets: [...c.buckets],
        ...(c.overflowed ? { overflowed: true } : {}),
      }));
    } else if ((m.buckets?.length ?? 0) > 0) {
      // single-format shard: its whole model.glb becomes one synthesized chunk
      const storey = art.structureExpressID;
      let storeyGuid: string | null = null;
      let bbox: Box6 | null = null;
      let tris = 0;
      for (const el of Object.values(m.elements ?? {})) {
        if (!storeyGuid && el.storeyExpressID === storey && el.storeyGuid) storeyGuid = el.storeyGuid;
        if (!el.bbox) continue;
        if (!bbox) bbox = [...el.bbox] as Box6;
        else {
          for (let k = 0; k < 3; k++) bbox[k] = Math.min(bbox[k], el.bbox[k]);
          for (let k = 3; k < 6; k++) bbox[k] = Math.max(bbox[k], el.bbox[k]);
        }
      }
      for (const b of m.buckets) for (const r of b.ranges) tris += r.count / 3;
      locals = [
        {
          localId: 0,
          src: path.join(art.artifactDir, "model.glb"),
          storeyExpressID: storey,
          storeyGuid,
          bbox: bbox ?? ([0, 0, 0, 0, 0, 0] as Box6),
          triangles: Math.round(tris),
          buckets: m.buckets.map((_, i) => i),
        },
      ];
    }

    const localToGlobalChunk = new Map<number, number>();
    for (const loc of locals) {
      const gid = chunkEntries.length;
      localToGlobalChunk.set(loc.localId, gid);
      const src = readGlbFile(loc.src);
      for (const node of src.json.nodes ?? []) {
        if (node.translation && node.translation.length === 3) {
          node.translation = [node.translation[0] + delta[0], node.translation[1] + delta[1], node.translation[2] + delta[2]];
        }
        if (node.extras && typeof node.extras.bucket === "number") {
          node.extras.bucket += bucketBase;
        }
      }
      fs.mkdirSync(chunkDir, { recursive: true });
      const dest = path.join(chunkDir, `${gid}.glb`);
      writeGlbFile(dest, src.json, src.bin);
      const entry: ChunkManifestEntry = {
        id: gid,
        storeyExpressID: loc.storeyExpressID,
        storeyGuid: loc.storeyGuid,
        bbox: shiftBox(loc.bbox, delta),
        triangles: loc.triangles,
        bytes: fs.statSync(dest).size,
        buckets: loc.buckets.map((i) => i + bucketBase),
      };
      if (loc.overflowed) entry.overflowed = true;
      chunkEntries.push(entry);
    }

    for (const [key, el] of Object.entries(m.elements ?? {})) {
      const merged: ElementMeta = { ...el };
      if (merged.bbox) merged.bbox = shiftBox(merged.bbox, delta);
      if (merged.chunkId !== undefined) {
        const g = localToGlobalChunk.get(merged.chunkId);
        if (g !== undefined) merged.chunkId = g;
        else delete merged.chunkId;
      }
      elementsOut[key] = merged; // later shards win: payloads are identical anyway
    }
  }

  const spatial: SpatialNode = JSON.parse(JSON.stringify(baseMeta.spatial)) as SpatialNode;
  for (let k = 1; k < metas.length; k++) mergeSpatial(spatial, metas[k].m.spatial);

  const triangles = metas.reduce((sum, x) => sum + (x.m.stats?.triangles ?? 0), 0);
  const single = chunkEntries.length === 1;
  let artifactFormat: "single" | "chunked";
  fs.mkdirSync(outDir, { recursive: true });
  if (single) {
    fs.copyFileSync(path.join(chunkDir, "0.glb"), out.glbPath);
    fs.rmSync(chunkDir, { recursive: true, force: true });
    artifactFormat = "single";
  } else {
    fs.rmSync(out.glbPath, { force: true });
    artifactFormat = "chunked";
  }
  const meta: ConversionMeta = {
    schema: baseMeta.schema,
    engine: baseMeta.engine ?? "wasm",
    units: baseMeta.units,
    origin: originGlobal,
    crs: baseMeta.crs,
    stats: { elements: Object.keys(elementsOut).length, triangles },
    glbCompression: { codec, fallbackViews },
    artifactFormat,
    chunks: single ? undefined : chunkEntries,
    buckets: bucketsOut,
    spatial,
    elements: elementsOut,
  };
  return meta;
}

// ---------------------------------------------------------------------------
// in-process convenience pipeline (sequential; the API fans shards out
// across the worker pool instead)
// ---------------------------------------------------------------------------

export interface PresplitConvertOptions extends ConvertOptions {
  /** directory for shard files + artifacts; a temp dir when omitted */
  shardDir?: string;
  /** keep shard .ifc files + per-shard artifacts after aggregation */
  keepShards?: boolean;
  /** called after each finished shard with (doneCount, totalShards) */
  onShard?: (done: number, total: number) => void;
}

export async function convertIfcFilePresplit(
  inputPath: string,
  glbPath: string,
  opts: PresplitConvertOptions = {}
): Promise<ConversionMeta> {
  const dir = opts.shardDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openbim-presplit-"));
  const createdNewShardDir = !opts.shardDir;
  try {
    const shards = presplitIfcFile(inputPath, path.join(dir, "shards"));
    const artifacts: PresplitShardArtifact[] = [];
    let done = 0;
    for (const s of shards) {
      const artifactDir = path.join(dir, `shard-${s.index}`);
      try {
        const meta = await convertIfcFile(s.path, path.join(artifactDir, "model.glb"), {
          meshopt: opts.meshopt,
          maxVerticesPerPrimitive: opts.maxVerticesPerPrimitive,
          loader: opts.loader,
          chunking: opts.chunking,
        });
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "meta.json"), Buffer.from(JSON.stringify(meta)));
        artifacts.push({
          shardIndex: s.index,
          structureExpressID: s.structureExpressID,
          metaPath: path.join(artifactDir, "meta.json"),
          artifactDir,
        });
      } catch (err) {
        if ((err as IfcConversionError).code !== "EMPTY_MODEL") throw err; // else: structure without geometry, skip
      }
      opts.onShard?.(++done, shards.length);
    }
    return aggregatePresplitShards(artifacts, { glbPath });
  } finally {
    if (createdNewShardDir && !opts.keepShards) fs.rmSync(dir, { recursive: true, force: true });
  }
}
