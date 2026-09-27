import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthedAttempt, setTokens, setUnauthorizedHandler, withAuthRetry } from "../src/api/authTransport";
import { api, downloadBinary } from "../src/api/client";

// node env: modules only touch browser globals inside functions
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  setItem: (k: string, v: string) => store.set(k, v),
  getItem: (k: string) => store.get(k) ?? null,
  removeItem: (k: string) => store.delete(k),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake authed operation: failed under the stale token, success under the rotated one. */
function fakeOp<T>(value: T, log: Array<{ auth: string }>): () => Promise<AuthedAttempt<T>> {
  return async () => {
    const auth = JSON.parse(store.get("obh.tokens") ?? "{}").accessToken as string;
    log.push({ auth });
    if (auth === "A1") return { auth: "failed" };
    return { auth: "ok", status: 200, value };
  };
}

describe("authTransport: withAuthRetry interface", () => {
  let refreshCount: number;

  beforeEach(() => {
    refreshCount = 0;
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCount++;
        // slow on purpose: forces concurrent 401 handlers to overlap
        await new Promise((r) => setTimeout(r, 10));
        const body = JSON.parse(String(init?.body));
        if (body.refreshToken !== "R1") return jsonResponse({ message: "reused token: session revoked" }, 401);
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      return null as unknown as Response; // ops are fake; only refresh hits fetch here
    });
  });

  it("concurrent 401 ops share exactly one refresh and each retries once", async () => {
    const logs: Array<Array<{ auth: string }>> = [[], [], [], []];
    const results = await Promise.all([
      withAuthRetry(fakeOp({ n: 1 }, logs[0])),
      withAuthRetry(fakeOp({ n: 2 }, logs[1])),
      withAuthRetry(fakeOp({ n: 3 }, logs[2])),
      withAuthRetry(fakeOp({ n: 4 }, logs[3])),
    ]);
    expect(results).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(refreshCount).toBe(1);
    // every op saw the stale token then the rotated one (no third attempt)
    for (const log of logs) expect(log.map((l) => l.auth)).toEqual(["A1", "A2"]);
    // rotation persisted, the spent refresh token never replayed
    expect(JSON.parse(store.get("obh.tokens") ?? "{}")).toEqual({ accessToken: "A2", refreshToken: "R2" });
  });

  it("failed refresh clears persisted tokens, fires onUnauthorized, throws ApiError(401)", async () => {
    setTokens({ accessToken: "A1", refreshToken: "STALE" });
    const onU = vi.fn();
    setUnauthorizedHandler(onU);
    const err = await withAuthRetry(fakeOp("x", [])).catch((e) => e);
    expect(err.status).toBe(401);
    expect(refreshCount).toBe(1);
    expect(onU).toHaveBeenCalledTimes(1);
    expect(store.has("obh.tokens")).toBe(false);
  });

  it("a 401 without any refresh token throws without touching the session", async () => {
    setTokens({ accessToken: "A1", refreshToken: null });
    const onU = vi.fn();
    setUnauthorizedHandler(onU);
    const err = await withAuthRetry(fakeOp("x", [])).catch((e) => e);
    expect(err.status).toBe(401);
    expect(refreshCount).toBe(0);
    expect(onU).not.toHaveBeenCalled();
  });
});

describe("client transports go through the module (smoke)", () => {
  beforeEach(() => {
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        const body = JSON.parse(String(init?.body));
        if (body.refreshToken !== "R1") return jsonResponse({ message: "revoked" }, 401);
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      const auth = ((init?.headers as Record<string, string>)?.authorization) ?? "";
      if (auth === "Bearer A1") return jsonResponse({ message: "expired" }, 401);
      if (url.includes("/download")) return new Response(new Uint8Array([1, 2, 3]));
      return jsonResponse({ ok: true });
    });
  });

  it("request() retries a 401 through the shared refresh", async () => {
    const res = await api.get<{ ok: boolean }>("/a");
    expect(res).toEqual({ ok: true });
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
  });

  it("downloadBinary() retries a 401 through the shared refresh", async () => {
    const buf = await downloadBinary("/download/1");
    expect(new Uint8Array(buf)[0]).toBe(1);
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
  });
});
