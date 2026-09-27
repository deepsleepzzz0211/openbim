/**
 * Auth transport module: owns token state and the single-flight refresh
 * protocol. Every network transport (fetch JSON, XHR upload, binary download,
 * SSE) expresses its 401 handling as a call to withAuthRetry
 * instead of reimplementing the protocol.
 *
 * Why single-flight: the backend rotates refresh tokens single-use — a second
 * request replaying the same token revokes the whole session. Concurrent 401s
 * (e.g. parallel chunk downloads) must share ONE in-flight refresh.
 */

export const BASE = "/api/v1";

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let tokens: Tokens | null = null;
let onUnauthorized: (() => void) | null = null;

/** Persist tokens so a refresh survives reloads (called on every rotation). */
function persistTokens(): void {
  if (tokens) {
    localStorage.setItem("obh.tokens", JSON.stringify(tokens));
  } else {
    localStorage.removeItem("obh.tokens");
  }
}

export function setTokens(t: Tokens | null): void {
  tokens = t;
  persistTokens();
}

export function getAccessToken(): string | null {
  return tokens?.accessToken ?? null;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function clearTokens(): void {
  tokens = null;
  persistTokens();
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = tokens?.refreshToken;
  if (!refreshToken) return false;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(BASE + "/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
      persistTokens();
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * The op contract: either report "failed" (the only outcome the module acts
 * on; carry the backend message when the transport could read one), or return
 * the parsed success value. Any other failure mode throws from inside the op.
 */
export type AuthedAttempt<T> =
  | { auth: "failed"; message?: string }
  | { auth: "ok"; status: number; value: T };

/**
 * Run an authentication-bearing operation with the shared 401 protocol: on a
 * failed attempt, refresh once (single-flight) and re-run the op; failed again
 * after a successful refresh or a failed refresh (clear tokens + notify)
 * surfaces as ApiError(401). Network errors are never retried — they
 * propagate from the op.
 */
export async function withAuthRetry<T>(op: () => Promise<AuthedAttempt<T>>): Promise<T> {
  const first = await op();
  if (first.auth === "ok") return first.value;
  if (tokens?.refreshToken && (await refreshTokens())) {
    const second = await op();
    if (second.auth === "ok") return second.value;
    throw new ApiError(401, second.message ?? "unauthorized after refresh");
  }
  if (tokens?.refreshToken) {
    // refresh attempted and failed: session is gone
    clearTokens();
    onUnauthorized?.();
  }
  throw new ApiError(401, first.message ?? "unauthorized");
}
