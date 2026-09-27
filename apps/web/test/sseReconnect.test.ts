import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTokens, setUnauthorizedHandler } from "../src/api/authTransport";
import { subscribeVersions } from "../src/api/client";

// node env: modules only touch browser globals inside functions
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  setItem: (k: string, v: string) => store.set(k, v),
  getItem: (k: string) => store.get(k) ?? null,
  removeItem: (k: string) => store.delete(k),
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  fail(): void {
    this.onerror?.();
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenOf(es: FakeEventSource): string {
  const query = es.url.slice(es.url.indexOf("?") + 1);
  return new URLSearchParams(query).get("token") ?? "";
}

interface Stub {
  refreshCount: number;
  probeFailsWithNetwork?: boolean;
  probeAuthExpired?: boolean;
  refreshRejects?: boolean;
}

function stubBackend(s: Stub): void {
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        s.refreshCount++;
        const body = JSON.parse(String(init?.body));
        if (s.refreshRejects || body.refreshToken !== "R1") return jsonResponse({ message: "revoked" }, 401);
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      // the session probe: 401s the stale token only in tests that declare it expired
      const auth = ((init?.headers as Record<string, string>)?.authorization) ?? "";
      if (s.probeFailsWithNetwork) throw new TypeError("network gone");
      if (s.probeAuthExpired && auth === "Bearer A1") return jsonResponse({ message: "expired" }, 401);
      return jsonResponse({ user: {} });
    }
  );
}

describe("subscribeVersions reconnects through the auth module", () => {
  let s: Stub;

  beforeEach(() => {
    FakeEventSource.instances = [];
    store.clear();
    setTokens({ accessToken: "A1", refreshToken: "R1" });
    vi.stubGlobal("EventSource", FakeEventSource);
    s = { refreshCount: 0 };
    stubBackend(s);
  });

  it("rebuilds the connection with the rotated token after a 401 error", async () => {
    s.probeAuthExpired = true;
    const updates: Array<{ versionId: string; status: string; progress: number }> = [];
    const unsubscribe = subscribeVersions(["v1", "v2"], (u) => updates.push(u));

    const first = FakeEventSource.instances[0];
    expect(tokenOf(first)).toBe("A1");
    first.fail(); // server rejected the expired token

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(first.closed).toBe(true); // stale connection is closed, no auto-reconnect race
    expect(s.refreshCount).toBe(1); // exactly one shared refresh
    const second = FakeEventSource.instances[1];
    expect(tokenOf(second)).toBe("A2"); // rebuilt with the rotated token

    second.receive({ versionId: "v1", status: "READY", progress: 100 });
    expect(updates).toEqual([{ versionId: "v1", status: "READY", progress: 100 }]);

    unsubscribe();
    expect(second.closed).toBe(true);
  });

  it("a network drop reconnects on the same token without spending a refresh", async () => {
    s.probeFailsWithNetwork = true;
    const unsubscribe = subscribeVersions(["v1"], () => {}, { backoffMs: 5 });

    FakeEventSource.instances[0].fail();
    // probe itself fails on the network: back off, never refresh, never reconnect
    await new Promise((r) => setTimeout(r, 20));
    expect(s.refreshCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    // network returns with the same (still valid) token: next probe succeeds
    s.probeFailsWithNetwork = false;
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(s.refreshCount).toBe(0); // no refresh token was spent on a network blip
    expect(tokenOf(FakeEventSource.instances[1])).toBe("A1");
    unsubscribe();
  });

  it("a dead session logs out and stops reconnecting instead of looping forever", async () => {
    s.refreshRejects = true; // refresh token already spent/revoked server-side
    s.probeAuthExpired = true; // access token rejected too
    const onU = vi.fn();
    setUnauthorizedHandler(onU);
    const unsubscribe = subscribeVersions(["v1"], () => {});

    FakeEventSource.instances[0].fail(); // 401 -> probe 401 -> refresh fails

    await vi.waitFor(() => expect(onU).toHaveBeenCalledTimes(1));
    expect(store.has("obh.tokens")).toBe(false); // logged out per the shared invariant
    expect(s.refreshCount).toBe(1); // exactly one attempt, no retry loop
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeEventSource.instances).toHaveLength(1); // no further reconnects
    unsubscribe();
  });

  it("unsubscribing during the probe window cancels the rebuild", async () => {
    // hold the probe in flight across the unsubscribe
    let releaseProbe: ((v: Response) => void) | null = null;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        return jsonResponse({ accessToken: "A2", refreshToken: "R2" });
      }
      return new Promise<Response>((resolve) => {
        releaseProbe = resolve;
      });
    });
    const unsubscribe = subscribeVersions(["v1"], () => {});
    FakeEventSource.instances[0].fail();

    await vi.waitFor(() => expect(releaseProbe).not.toBeNull());
    unsubscribe(); // cancel while the probe is still in flight
    releaseProbe!(jsonResponse({ user: {} }));

    await new Promise((r) => setTimeout(r, 20));
    expect(FakeEventSource.instances).toHaveLength(1); // the pending rebuild was cancelled
  });
});
