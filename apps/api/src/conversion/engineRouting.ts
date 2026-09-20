/**
 * Ticket 09: which triangulation engine converts a version.
 *
 * Two rules:
 *  1. Size route: sources at/above the wasm-safety threshold go to the native
 *     IfcOpenShell worker container (separate process => LGPL boundary and no
 *     WASM heap ceiling). When no worker is configured we degrade to wasm with
 *     a note so small/self-hosted deployments keep working.
 *  2. No mixing: one model keeps the engine of its newest existing version,
 *     otherwise diffs/clashes would compare geometry from two engines. Legacy
 *     versions (engine = null, pre-ticket-09) count as "wasm".
 */

export type ConversionEngine = "wasm" | "native";

export interface EngineRoutingInput {
  sizeBytes: number;
  /** Source size at/above which the wasm engine is considered unsafe. */
  nativeThresholdBytes: number;
  /** True when a native worker container is configured (NATIVE_WORKER_URL). */
  nativeConfigured: boolean;
  /** Engine of the model's newest other version, or null for a fresh model. */
  previousEngine: ConversionEngine | null;
}

export interface EngineDecision {
  engine: ConversionEngine;
  note?: "sticky-model-engine" | "native-not-configured";
}

export function routeEngine(input: EngineRoutingInput): EngineDecision {
  if (input.previousEngine) {
    return { engine: input.previousEngine, note: "sticky-model-engine" };
  }
  if (input.nativeThresholdBytes > 0 && input.sizeBytes >= input.nativeThresholdBytes) {
    return input.nativeConfigured ? { engine: "native" } : { engine: "wasm", note: "native-not-configured" };
  }
  return { engine: "wasm" };
}
