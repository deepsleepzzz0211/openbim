import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, downloadBinary, setTokens, setUnauthorizedHandler } from "../src/api/client";

// node env: client.ts only touches browser globals inside functions
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  setItem: (k: string, v: string) => store.set(k, v),
  getItem: (k: string) => store.get(k) ?? null,
  removeItem: (k: string) => store.delete(k),
};

interface Call {
  url: string;
  auth: string;
  refreshBody?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("single-flight token refresh", () => {
  let calls: Call[];
  let refreshCount: number;

  beforeEach(() => {
    calls = [];
    refreshCount = 0;
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const auth = ((init?.headers as Record<string, string>)?.authorization) ?? "";
      const rec: Call = { url, auth };
      calls.push(rec);
      if (url.endsWith("/auth/refresh")) {
        refreshCount++;
        rec.refreshBody = String(init?.body);
        // slow on purpose: forces concurrent 401 handlers to overlap
        await new Promise((r) => setTimeout(r, 10));
        const body = JSON.parse(String(init?.body));
        if (body.refreshToken !== "R1") return jsonResponse({ message: "reused token: session revoked" }, 401);
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      if (auth === "Bearer A1") return jsonResponse({ message: "expired" }, 401);
      if (url.includes("/download")) return new Response(new Uint8Array([1, 2, 3]));
      return jsonResponse({ ok: true });
    });
  });

  it("concurrent 401s (request + chunk downloads) trigger exactly one refresh", async () => {
    const results = await Promise.all([
      api.get<{ ok: boolean }>("/a"),
      api.get<{ ok: boolean }>("/b"),
      downloadBinary("/download/1"),
      downloadBinary("/download/2"),
    ]);
    expect(refreshCount).toBe(1);
    expect(results[0]).toEqual({ ok: true });
    expect(new Uint8Array(results[2])[0]).toBe(1);
    // rotation persisted, second refresh never replays the spent token
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
    const retries = calls.filter((c) => !c.url.endsWith("/auth/refresh") && c.auth === "Bearer A2");
    expect(retries).toHaveLength(4);
  });

  it("failed refresh clears persisted tokens and fires onUnauthorized", async () => {
    setTokens({ accessToken: "A1", refreshToken: "STALE" });
    const onU = vi.fn();
    setUnauthorizedHandler(onU);
    const err = await api.get("/b").catch((e) => e);
    expect(err.status).toBe(401);
    expect(refreshCount).toBe(1);
    expect(onU).toHaveBeenCalledTimes(1);
    expect(store.has("obh.tokens")).toBe(false);
  });
});
