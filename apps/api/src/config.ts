import * as os from "node:os";
import * as path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  dataDir: string;
  jwtSecret: string;
  accessTokenTtl: string;
  refreshTokenDays: number;
  maxUploadBytes: number;
  conversionMode: "worker" | "inline";
  /** KHR_meshopt_compression on GLB artifacts (CONVERSION_MESHOPT=0 disables). */
  meshopt: boolean;
  /** Original IFC size at/above which conversion emits per-storey chunked artifacts. */
  chunkingThresholdBytes: number;
  /** Triangle budget per chunk before spatial bisection kicks in. */
  chunkMaxTriangles: number;
  /**
   * Native IfcOpenShell conversion worker container (ticket 09). Empty URL
   * means no native engine is available and oversized jobs fall back to wasm.
   */
  nativeWorkerUrl: string;
  /** Shared secret for the worker container (NATIVE_WORKER_TOKEN), optional. */
  nativeWorkerToken: string;
  /** Original IFC size at/above which jobs route to the native engine. */
  nativeThresholdBytes: number;
  /**
   * Original IFC size at/above which wasm jobs use the presplit pipeline
   * (slice -> parallel shard conversion -> aggregate, ticket 10). 0 disables
   * it. Sits above nativeThresholdBytes by default: with a native worker
   * configured, oversized models prefer it; presplit is the wasm escape
   * hatch for sticky-wasm models / deployments without containers.
   */
  presplitThresholdBytes: number;
  /** Wall-clock budget for one native conversion before NATIVE_TIMEOUT. */
  nativeTimeoutMs: number;
  concurrency: number;
  logLevel: string;
  /** allowed browser origins for CORS; null = reflect any origin (development default) */
  corsOrigins: string[] | null;
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like int() but 0 is a legal value (used for "0 = disabled" thresholds). */
function nonNegInt(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), "data"));
  const devSecret = "openbim-hub-dev-secret-change-me";
  const corsOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;
  return {
    host: env.HOST || "127.0.0.1",
    port: int(env.PORT, 3001),
    databaseUrl: env.DATABASE_URL || `file:${path.join(dataDir, "app.db")}`,
    dataDir,
    jwtSecret: env.JWT_SECRET || devSecret,
    accessTokenTtl: "15m",
    refreshTokenDays: int(env.REFRESH_TOKEN_DAYS, 30),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 512) * 1024 * 1024,
    conversionMode: env.CONVERSION_MODE === "inline" ? "inline" : "worker",
    meshopt: env.CONVERSION_MESHOPT !== "0",
    chunkingThresholdBytes: int(env.CHUNK_THRESHOLD_BYTES, 32 * 1024 * 1024),
    chunkMaxTriangles: int(env.CHUNK_MAX_TRIANGLES, 500_000),
    nativeWorkerUrl: (env.NATIVE_WORKER_URL ?? "").trim().replace(/\/+$/, ""),
    nativeWorkerToken: (env.NATIVE_WORKER_TOKEN ?? "").trim(),
    // web-ifc's practical safety ceiling is ~256 MiB of source IFC; above that
    // the native IfcOpenShell container takes over when configured (ticket 09).
    nativeThresholdBytes: int(env.NATIVE_THRESHOLD_BYTES, 256 * 1024 * 1024),
    presplitThresholdBytes: nonNegInt(env.PRESPLIT_THRESHOLD_BYTES, 512 * 1024 * 1024),
    nativeTimeoutMs: int(env.NATIVE_WORKER_TIMEOUT_MS, 4 * 60 * 60 * 1000),
    concurrency: Math.max(1, Math.min(int(env.CONCURRENCY, Math.max(1, Math.floor(os.cpus().length / 2))), 8)),
    logLevel: env.LOG_LEVEL || "info",
    corsOrigins,
  };
}

export function isDevSecret(secret: string): boolean {
  return secret === "openbim-hub-dev-secret-change-me";
}
