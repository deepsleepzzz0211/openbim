import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTokens, uploadVersion } from "../src/api/client";

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

/** Minimal XHR double: 401 under the stale token, success under the rotated one. */
class FakeXHR {
  static sent: FakeXHR[] = [];
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  upload = { onprogress: undefined as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | undefined };
  headers: Record<string, string> = {};

  constructor() {
    FakeXHR.sent.push(this);
  }
  open(_method: string, url: string): void {
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  send(_body?: unknown): void {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
      if (this.headers.authorization === "Bearer A1") {
        this.status = 401;
        this.responseText = "expired";
      } else {
        this.status = this.url.includes("/parts/") ? 200 : 202;
        this.responseText = JSON.stringify({ version: { id: "v9", status: "PENDING" } });
      }
      this.onload?.();
    }, 0);
  }
  url = "";
}

const refreshStub = () =>
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit) => {
      // fast-import must miss without touching the 401 path (sha stage)
      if (url.includes("/fast-import")) return jsonResponse({ message: "no stored copy" }, 404);
      if (url.endsWith("/auth/refresh")) {
        const body = JSON.parse(String(init?.body));
        if (body.refreshToken !== "R1") return jsonResponse({ message: "reused token: session revoked" }, 401);
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      if (url.includes("/complete")) return jsonResponse({ version: { id: "v9", status: "PENDING" } });
      return jsonResponse({ uploadId: "u1", partSize: 16 * 1024 * 1024 });
    }
  );

describe("upload transports go through the auth module (smoke)", () => {
  beforeEach(() => {
    FakeXHR.sent = [];
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    refreshStub();
  });

  it("small-file upload: 401 -> one shared refresh -> retried with the rotated token", async () => {
    const res = await uploadVersion("m1", new File([new Uint8Array(10)], "model.ifc"));
    expect(res).toEqual({ version: { id: "v9", status: "PENDING" } });
    // stale attempt first, rotated attempt on the retry
    expect(FakeXHR.sent.map((x) => x.headers.authorization)).toEqual(["Bearer A1", "Bearer A2"]);
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
  });

  it("chunked upload: 401 on a part -> refresh -> part retried with the rotated token", async () => {
    const big = new File([new Uint8Array(48 * 1024 * 1024 + 1)], "big.ifc"); // 4 parts
    const res = await uploadVersion("m1", big);
    expect(res).toEqual({ version: { id: "v9", status: "PENDING" } });
    const puts = FakeXHR.sent.filter((x) => x.url.includes("/parts/"));
    // 4 parts + exactly one retried part: the refresh happened once, no part
    // ever replayed the stale token after the rotation
    expect(puts).toHaveLength(5);
    expect(puts.filter((x) => x.headers.authorization === "Bearer A1")).toHaveLength(1);
    expect(JSON.parse(store.get("obh.tokens") ?? "{}").accessToken).toBe("A2");
  });
});
