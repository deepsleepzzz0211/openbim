/** Spatial structure node (Project -> Site -> Building -> Storey). */
export interface SpatialNode {
  guid: string;
  expressID: number;
  type: string;
  name: string;
  children: SpatialNode[];
}

/** Per-element metadata stored in meta.json and imported into the DB. */
export interface ElementMeta {
  guid: string;
  type: string;
  name: string;
  storeyExpressID: number | null;
  storeyGuid: string | null;
  attributes: Record<string, unknown>;
  psets: Record<string, Record<string, unknown>>;
  /** world-space AABB in metres [minX,minY,minZ,maxX,maxY,maxZ] (Y-up); present when the element has geometry */
  bbox?: [number, number, number, number, number, number];
  /** chunk (ticket 05 manifest id) holding this element's geometry; set for chunked artifacts */
  chunkId?: number;
}

/** A contiguous index range inside a merged geometry bucket that belongs to one element. */
export interface BucketRange {
  expressID: number;
  /** offset into the bucket's index buffer (in indices, not triangles) */
  start: number;
  count: number;
}

/** Merged geometry bucket: one draw call per (storey, color) combination. */
export interface GeometryBucket {
  storeyExpressID: number | null;
  color: [number, number, number, number];
  transparent: boolean;
  ranges: BucketRange[];
}

/** Coordinate reference system taken from IfcProjectedCRS / IfcMapConversion. */
export interface ConversionCrs {
  /** "ABSENT" when the file declares no projected CRS: coordinates are local. */
  source: "IFCPROJECTEDCRS" | "ABSENT";
  /** IfcProjectedCRS.Name verbatim (e.g. "EPSG:25832", "OSGB36 / British National Grid") */
  name: string | null;
  /** EPSG registry code parsed from the name, when one is stated */
  epsg: number | null;
  /** map conversion of the local origin into the projected CRS (metres) */
  mapConversion: { x0: number; y0: number } | null;
}

/** Which transport compression actually reached the GLB artifact. */
export interface GlbCompression {
  /** "meshopt" when a KHR_meshopt_compression encoder was active. */
  codec: "meshopt" | "none";
  /** bufferViews where encoding failed at runtime and raw bytes were kept. */
  fallbackViews: number;
}

/** One downloadable piece of a chunked artifact (ticket 05). */
export interface ChunkManifestEntry {
  /** stable chunk index; the file is `chunks/<id>.glb` */
  id: number;
  storeyExpressID: number | null;
  storeyGuid: string | null;
  /** world-space AABB (metres, same frame as GLB vertices) */
  bbox: [number, number, number, number, number, number];
  triangles: number;
  /** written GLB size in bytes (0 before the file pass) */
  bytes: number;
  /** global indices into ConversionMeta.buckets sealed into this chunk */
  buckets: number[];
  /** true when the split-depth cap could not keep the chunk under budget */
  overflowed?: boolean;
}

export interface ConversionMeta {
  schema: string;
  /**
   * Which triangulation engine produced this artifact. One model must never
   * mix engines across versions (geometry would not compare cleanly), so the
   * API records the decision on the version row and the native worker stamps
   * its artifacts with "native" (ticket 09). Absent on legacy artifacts = "wasm".
   */
  engine?: "wasm" | "native";
  /**
   * Unit info of the SOURCE IFC file. Geometry in the GLB is always normalised
   * to metres and Y-up (web-ifc does the conversion internally).
   */
  units: { sourceName: string; sourcePrefix: string | null; scaleToMetre: number };
  /**
   * World coordinates (metres, Y-up — same frame as the GLB vertices) that the
   * COORDINATE_TO_ORIGIN load subtracted from every vertex. `true world = glb
   * + origin`; federated viewers use it to re-position models relative to each
   * other. Legacy meta.json artifacts may lack the field (treat as [0,0,0]).
   */
  origin: [number, number, number];
  crs: ConversionCrs;
  stats: { elements: number; triangles: number };
  /**
   * Transport compression actually applied to model.glb. Absent on legacy
   * artifacts (pre-meshopt = "none").
   */
  glbCompression?: GlbCompression;
  /**
   * On-disk layout of the geometry artifact: legacy single model.glb, or
   * per-storey chunk GLBs (absent on legacy meta.json = "single").
   */
  artifactFormat?: "single" | "chunked";
  chunks?: ChunkManifestEntry[];
  buckets: GeometryBucket[];
  spatial: SpatialNode;
  elements: Record<string, ElementMeta>;
}

export interface ConversionResult {
  /** Single-format artifact. Chunked conversions leave this empty — see `chunks`. */
  glb: Uint8Array;
  meta: ConversionMeta;
  /** Final GLB bytes per manifest chunk id (chunked format only). */
  chunks?: Uint8Array[];
}
