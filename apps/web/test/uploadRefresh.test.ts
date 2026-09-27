import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTokens, setUnauthorizedHandler, uploadVersion } from "../src/api/client";

// node env: client.ts only touches browser globals inside functions
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  setItem: (k: string, v: string) => store.set(k, v),
  getItem: (k: string) => store.get(k) ?? null,
  removeItem: (k: string) => store.delete(k),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Minimal XHR double: resolves via onload after send(), records auth headers. */
class FakeXHR {
  static sent: FakeXHR[] = [];
  static nextStatus = 401;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  upload = { onprogress: undefined as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | undefined };
  headers: Record<string, string> = {};

  constructor() {
    FakeXHR.sent.push(this);
  }
  open(_method: string, _url: string): void {}
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  send(_body?: unknown): void {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
      const stale = this.headers.authorization === "Bearer A1" && FakeXHR.nextStatus !== 202;
      if (stale) {
        this.status = FakeXHR.nextStatus;
        this.responseText = "expired";
      } else {
        this.status = 202;
        this.responseText = JSON.stringify({ version: { id: "v9", status: "PENDING" } });
      }
      this.onload?.();
    }, 0);
  }
}

function fileOf(bytes: number): File {
  return new File([new Uint8Array(bytes)], "model.ifc");
}

describe("uploadVersion small-file XHR refresh", () => {
  let refreshCount: number;

  beforeEach(() => {
    FakeXHR.sent = [];
    FakeXHR.nextStatus = 401;
    refreshCount = 0;
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    vi.stubGlobal(
      "fetch",
      async (url: string, init?: RequestInit) => {
        // fast-import must miss without touching the 401 path (sha stage)
        if (url.includes("/fast-import")) return jsonResponse({ message: "no stored copy" }, 404);
        if (url.endsWith("/auth/refresh")) {
          refreshCount++;
          const body = JSON.parse(String(init?.body));
          if (body.refreshToken !== "R1") return jsonResponse({ message: "reused token: session revoked" }, 401);
          return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
        }
        return jsonResponse({ ok: true });
      }
    );
  });

  it("retries a 401 upload through one single-flight refresh", async () => {
    const onProgress = vi.fn();
    const res = await uploadVersion("m1", fileOf(10), onProgress);
    expect(res).toEqual({ version: { id: "v9", status: "PENDING" } });
    expect(refreshCount).toBe(1);
    // stale token first, rotated token on the retry
    expect(FakeXHR.sent.map((x) => x.headers.authorization)).toEqual(["Bearer A1", "Bearer A2"]);
    // progress still reported (both attempts) and rotation persisted
    expect(onProgress).toHaveBeenCalled();
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
  });

  it("failed refresh clears tokens, fires onUnauthorized, throws 401", async () => {
    setTokens({ accessToken: "A1", refreshToken: "STALE" });
    const onU = vi.fn();
    setUnauthorizedHandler(onU);
    const err = await uploadVersion("m1", fileOf(10)).catch((e) => e);
    expect(err.status).toBe(401);
    expect(refreshCount).toBe(1);
    expect(onU).toHaveBeenCalledTimes(1);
    expect(store.has("obh.tokens")).toBe(false);
    // no second attempt with the same dead token
    expect(FakeXHR.sent).toHaveLength(1);
  });

  it("202 on the first attempt never triggers a refresh", async () => {
    FakeXHR.nextStatus = 202;
    const res = await uploadVersion("m1", fileOf(10));
    expect(res).toEqual({ version: { id: "v9", status: "PENDING" } });
    expect(refreshCount).toBe(0);
    expect(FakeXHR.sent).toHaveLength(1);
  });
});
