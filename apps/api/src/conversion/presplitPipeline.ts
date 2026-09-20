/**
 * Ticket 10: presplit conversion pipeline (API side).
 *
 * GB-scale wasm jobs are sliced into per-structure shard IFCs
 * (`presplitIfcFile`), each shard is converted through the ordinary
 * ConversionService (the worker pool fans them out), and the shard
 * artifacts are stitched back into one manifest-contract artifact
 * (`aggregatePresplitShards`).
 *
 * A plan file (`<base>/presplit/plan.json`) tracks per-shard status so a
 * crashed or interrupted run resumes exactly the shards that did not
 * finish — partially-done shards keep their artifacts, failed shards are
 * the only ones resubmitted on retry. The plan directory is deleted after
 * a successful aggregation, so the version dir ends up identical to a
 * whole-model conversion (model.glb / chunks/ + meta.json).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  aggregatePresplitShards,
  presplitIfcFile,
  type PresplitShardArtifact,
} from "@openbim-hub/ifc";
import type { ConversionOutcome, ConversionService } from "./index";

export type PresplitShardStatus = "PENDING" | "DONE" | "SKIP" | "FAILED";

export interface PresplitPlanShard {
  index: number;
  structureExpressID: number | null;
  /** absolute path of the shard .ifc file written by the slicer */
  file: string;
  sizeBytes: number;
  status: PresplitShardStatus;
  code?: string;
  message?: string;
}

export interface PresplitPlan {
  versionId: string;
  sizeBytes: number;
  shards: PresplitPlanShard[];
}

export interface PresplitConversionRequest {
  versionId: string;
  /** original IFC on local disk */
  inputPath: string;
  /** version artifact directory: model.glb / chunks/ / meta.json land here */
  baseDir: string;
  meshopt: boolean;
  chunking?: { maxTrianglesPerChunk: number };
  /** overall percent 0..100 plus shard-granular counters */
  onProgress(percent: number, shards: { done: number; total: number }): void;
}

function shardArtifactDir(presplitDir: string, index: number): string {
  return path.join(presplitDir, `shard-${index}`);
}

function writePlan(planPath: string, plan: PresplitPlan): void {
  const tmp = `${planPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 1));
  fs.renameSync(tmp, planPath); // atomic: a crash mid-write never truncates the live plan
}

function loadPlan(planPath: string): PresplitPlan | null {
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as PresplitPlan;
    if (typeof plan.versionId !== "string" || !Array.isArray(plan.shards)) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * Run the presplit pipeline for one version. Returns a ConversionOutcome
 * in the same contract as ConversionService.submit; on success
 * `<baseDir>/meta.json` and the GLB artifact(s) are in place and the
 * intermediate shard files are gone.
 */
export async function runPresplitConversion(
  conversion: ConversionService,
  req: PresplitConversionRequest
): Promise<ConversionOutcome> {
  const presplitDir = path.join(req.baseDir, "presplit");
  const planPath = path.join(presplitDir, "plan.json");
  fs.mkdirSync(presplitDir, { recursive: true });
  fs.mkdirSync(req.baseDir, { recursive: true });

  const totalWeight = (plan: PresplitPlan) =>
    plan.shards.reduce((s, x) => s + Math.max(1, x.sizeBytes), 0);
  const credit = new Map<number, number>(); // shard index -> 0..1 completion

  const emit = (plan: PresplitPlan, lo: number, hi: number) => {
    const total = plan.shards.length;
    const W = totalWeight(plan);
    let acc = 0;
    let done = 0;
    for (const s of plan.shards) {
      if (s.status === "DONE" || s.status === "SKIP") done++;
      acc += Math.max(credit.get(s.index) ?? 0, s.status === "DONE" || s.status === "SKIP" ? 1 : 0) * Math.max(1, s.sizeBytes);
    }
    req.onProgress(Math.round(lo + (hi - lo) * (acc / W)), { done, total });
  };

  // ---- slice (or resume the existing plan) ---------------------------------
  let plan = loadPlan(planPath);
  if (plan) {
    // a DONE artifact whose files were tampered with must convert again
    for (const s of plan.shards) {
      if (s.status === "DONE" && !fs.existsSync(path.join(shardArtifactDir(presplitDir, s.index), "meta.json"))) {
        s.status = "PENDING";
      }
    }
    const missing = plan.shards.some(
      (s) => (s.status === "PENDING" || s.status === "FAILED") && !fs.existsSync(s.file)
    );
    if (missing) {
      // shard inputs lost but the plan is reusable: re-slice in place
      const infos = presplitIfcFile(req.inputPath, path.join(presplitDir, "shards"), {
        onProgress: (p) => req.onProgress(Math.round(1 + p * 0.07), { done: 0, total: plan!.shards.length }),
      });
      if (infos.length !== plan.shards.length) {
        plan = null; // structure set changed underneath us: start clean
      } else {
        plan.shards.forEach((s, i) => {
          s.file = infos[i].path;
          s.sizeBytes = infos[i].sizeBytes;
        });
        writePlan(planPath, plan);
      }
    }
  }
  if (!plan) {
    const infos = presplitIfcFile(req.inputPath, path.join(presplitDir, "shards"), {
      onProgress: (p) => req.onProgress(Math.round(1 + p * 0.07), { done: 0, total: 0 }),
    });
    plan = {
      versionId: req.versionId,
      sizeBytes: fs.statSync(req.inputPath).size,
      shards: infos.map((i) => ({
        index: i.index,
        structureExpressID: i.structureExpressID,
        file: i.path,
        sizeBytes: i.sizeBytes,
        status: "PENDING" as const,
      })),
    };
    writePlan(planPath, plan);
  }
  const total = plan.shards.length;
  req.onProgress(8, { done: plan.shards.filter((s) => s.status === "DONE" || s.status === "SKIP").length, total });

  // ---- fan out the unfinished shards ----------------------------------------
  const pending = plan.shards.filter((s) => s.status === "PENDING" || s.status === "FAILED");
  for (const s of pending) s.status = "PENDING";
  if (pending.length) writePlan(planPath, plan);

  await Promise.all(
    pending.map(async (s) => {
      const artifactDir = shardArtifactDir(presplitDir, s.index);
      fs.mkdirSync(artifactDir, { recursive: true });
      const outcome = await conversion.submit(
        {
          jobId: `${req.versionId}:shard:${s.index}`,
          engine: "wasm",
          inputPath: s.file,
          glbPath: path.join(artifactDir, "model.glb"),
          metaPath: path.join(artifactDir, "meta.json"),
          meshopt: req.meshopt,
          chunking: req.chunking,
        },
        (percent) => {
          credit.set(s.index, Math.max(credit.get(s.index) ?? 0, percent / 100));
          emit(plan!, 8, 90);
        }
      );
      if (outcome.ok) s.status = "DONE";
      else if (outcome.code === "EMPTY_MODEL") s.status = "SKIP"; // structure without geometry
      else {
        s.status = "FAILED";
        s.code = outcome.code ?? "UNKNOWN";
        s.message = outcome.message ?? "";
      }
      credit.set(s.index, 1);
      writePlan(planPath, plan!);
      emit(plan!, 8, 90);
    })
  );

  const failed = plan.shards.find((s) => s.status === "FAILED");
  if (failed) {
    // leave the plan + DONE artifacts on disk: the retry only redoes failures
    return {
      ok: false,
      code: failed.code ?? "SHARD_FAILED",
      message: `presplit shard ${failed.index} failed: ${failed.message ?? "unknown error"}`,
    };
  }

  // ---- aggregate ------------------------------------------------------------
  req.onProgress(90, { done: total, total });
  const artifacts: PresplitShardArtifact[] = plan.shards
    .filter((s) => s.status === "DONE")
    .map((s) => ({
      shardIndex: s.index,
      structureExpressID: s.structureExpressID,
      metaPath: path.join(shardArtifactDir(presplitDir, s.index), "meta.json"),
      artifactDir: shardArtifactDir(presplitDir, s.index),
    }));
  // stale chunk files from an earlier attempt must not shadow the new manifest
  fs.rmSync(path.join(req.baseDir, "chunks"), { recursive: true, force: true });
  let aggregated = false;
  try {
    const meta = aggregatePresplitShards(artifacts, { glbPath: path.join(req.baseDir, "model.glb") });
    fs.writeFileSync(path.join(req.baseDir, "meta.json"), JSON.stringify(meta));
    req.onProgress(99, { done: total, total });
    aggregated = true;
    return { ok: true, engine: "wasm", stats: meta.stats, schema: meta.schema };
  } catch (err) {
    const e = err as Error & { code?: string };
    return { ok: false, code: e.code ?? "AGGREGATE_FAILED", message: e.message };
  } finally {
    // success reclaimed the intermediate bytes; on failure keep them for retry
    if (aggregated) fs.rmSync(presplitDir, { recursive: true, force: true });
  }
}
