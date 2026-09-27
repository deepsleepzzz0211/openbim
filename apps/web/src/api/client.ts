/** Minimal API client. Token state and the 401 single-flight refresh protocol live in authTransport. */
import { ApiError, BASE, getAccessToken, setTokens, setUnauthorizedHandler, withAuthRetry } from "./authTransport";

export { setTokens, setUnauthorizedHandler, getAccessToken };
export { ApiError };

async function rawRequest(method: string, url: string, body?: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
  const token = getAccessToken();
  if (auth && token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  return res;
}

/** Best-effort read of the backend's error message off a 401 response body. */
async function messageOf(res: Response): Promise<string | undefined> {
  try {
    return (await res.json()).message;
  } catch {
    return undefined;
  }
}

/** Same, for XHR response text. */
function messageFromText(text: string): string | undefined {
  try {
    return JSON.parse(text).message;
  } catch {
    return undefined;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  return withAuthRetry(async () => {
    const res = await rawRequest(method, url, body);
    if (res.status === 401) return { auth: "failed", message: await messageOf(res) };
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (await res.json()).message ?? message;
      } catch {
        /* keep statusText */
      }
      throw new ApiError(res.status, message);
    }
    return { auth: "ok", status: res.status, value: (await res.json()) as T };
  });
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  delete: <T>(url: string) => request<T>("DELETE", url),
};

/** sha256 of a whole Blob via WebCrypto; null when unavailable (insecure context). */
async function sha256Hex(blob: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export async function uploadVersion(
  modelId: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ version: { id: string; status: string } }> {
  // 秒传: identical bytes already uploaded to this project skip the transfer
  const sha = await sha256Hex(file);
  if (sha) {
    try {
      const hit = await api.post<{ version: { id: string; status: string } }>(
        `/models/${modelId}/versions/fast-import`,
        { sha256: sha, sizeBytes: file.size, fileName: file.name }
      );
      onProgress?.(100);
      return hit;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      /* no stored copy: fall through to a real upload */
    }
  }
  // large files go through chunked upload (16 MiB parts)
  if (file.size > 48 * 1024 * 1024) {
    return uploadVersionChunked(modelId, file, onProgress);
  }
  const form = new FormData();
  form.append("file", file, file.name);
  const send = (): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/models/${modelId}/versions`);
      xhr.setRequestHeader("authorization", `Bearer ${getAccessToken() ?? ""}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, "network error"));
      xhr.send(form);
    });
  return withAuthRetry(async () => {
    const res = await send();
    if (res.status === 401) return { auth: "failed", message: messageFromText(res.text) };
    if (res.status !== 202) throw new ApiError(res.status, res.text || "upload failed");
    return { auth: "ok", status: res.status, value: JSON.parse(res.text) as { version: { id: string; status: string } } };
  });
}

const PART_SIZE = 16 * 1024 * 1024;

/** Authed XHR returning the response text; 401 goes through the shared refresh, other non-2xx throw. */
async function authedXhr(
  method: string,
  url: string,
  body: Blob | null,
  extraHeaders?: Record<string, string>,
  failLabel?: string
): Promise<string> {
  const send = (): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${BASE}${url}`);
      xhr.setRequestHeader("authorization", `Bearer ${getAccessToken() ?? ""}`);
      if (body) xhr.setRequestHeader("content-type", "application/octet-stream");
      for (const [k, v] of Object.entries(extraHeaders ?? {})) xhr.setRequestHeader(k, v);
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, "network error"));
      xhr.send(body);
    });
  return withAuthRetry(async () => {
    const res = await send();
    if (res.status === 401) return { auth: "failed", message: messageFromText(res.text) };
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, failLabel ? `${failLabel}: ${res.text}` : res.text);
    }
    return { auth: "ok", status: res.status, value: res.text };
  });
}

async function uploadVersionChunked(
  modelId: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ version: { id: string; status: string } }> {
  const partsTotal = Math.ceil(file.size / PART_SIZE);
  const create = await api.post<{ uploadId: string; partSize: number }>(`/models/${modelId}/uploads`, {
    fileName: file.name,
    partSize: PART_SIZE,
    partsTotal,
  });
  for (let p = 1; p <= partsTotal; p++) {
    const slice = file.slice((p - 1) * PART_SIZE, p * PART_SIZE);
    const partSha = await sha256Hex(slice);
    await authedXhr(
      "PUT",
      `/models/${modelId}/uploads/${create.uploadId}/parts/${p}`,
      slice,
      partSha ? { "x-part-sha256": partSha } : undefined,
      `part ${p} upload failed`
    );
    onProgress?.(Math.round((p / partsTotal) * 100));
  }
  return api.post<{ version: { id: string; status: string } }>(
    `/models/${modelId}/uploads/${create.uploadId}/complete`
  );
}

/** Authenticated binary download (e.g. GLB, meta.json, original IFC). */
export async function downloadBinary(url: string): Promise<ArrayBuffer> {
  return withAuthRetry(async () => {
    const res = await rawRequest("GET", url);
    if (res.status === 401) return { auth: "failed", message: await messageOf(res) };
    if (!res.ok) throw new ApiError(res.status, `download failed: ${url}`);
    return { auth: "ok", status: res.status, value: await res.arrayBuffer() };
  });
}

/** Authenticated download saved via the browser. */
export async function downloadToFile(url: string, filename: string): Promise<void> {
  const buf = await downloadBinary(url);
  const blob = new Blob([buf]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Upload a .bcfzip and import its topics as issues. */
export async function importBcfZip(
  projectId: string,
  file: File
): Promise<{ imported: number; skipped: number; version: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  return withAuthRetry(async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/issues/import.bcfzip`, {
      method: "POST",
      headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
      body: form,
    });
    if (res.status === 401) return { auth: "failed", message: await messageOf(res) };
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).message ?? msg;
      } catch {
        /* keep */
      }
      throw new ApiError(res.status, msg);
    }
    return { auth: "ok", status: res.status, value: await res.json() };
  });
}

export interface ClashHit {
  a: { expressID: number; guid: string; type: string; name: string };
  b: { expressID: number; guid: string; type: string; name: string };
  overlap: [number, number, number];
  center: [number, number, number];
  volume: number;
}

export interface ClashResult {
  summary: { checkedA: number; checkedB: number; clashes: number; returned: number; tolerance: number };
  clashes: ClashHit[];
}

export const apiClash = (versionAId: string, versionBId: string, tolerance: number): Promise<ClashResult> =>
  api.post<ClashResult>("/clash-detection", { versionAId, versionBId, tolerance, maxResults: 200 });

/** Chunked/single artifact manifest (ticket 05). Chunk urls are relative and server-signed. */
export interface VersionManifest {
  versionId: string;
  artifactFormat: "single" | "chunked";
  origin: [number, number, number] | null;
  stats: { elements: number; triangles: number } | null;
  url?: string;
  chunks?: Array<{
    id: number;
    storeyExpressID: number | null;
    storeyGuid: string | null;
    bbox: [number, number, number, number, number, number];
    triangles: number;
    bytes: number;
    buckets: number[];
    overflowed?: boolean;
    url: string;
  }>;
}

export const apiManifest = (versionId: string) => api.get<VersionManifest>(`/versions/${versionId}/manifest`);

export interface ElementSummary {
  expressID: number;
  guid: string;
  type: string;
  name: string;
  storeyGuid: string | null;
  chunkId: number | null;
  attributes: Record<string, unknown>;
  psets: Record<string, Record<string, unknown>>;
  bbox: number[] | null;
}

/** Batch lookup by GUID and/or expressID (+ owning chunk). */
export const apiElementsLookup = (versionId: string, opts: { guids?: string[]; expressIDs?: number[] }) =>
  api.post<{ elements: ElementSummary[] }>(`/versions/${versionId}/elements/lookup`, opts);

/** Whole-model AABB proxy layer (ticket 08): [expressID, storeyGuid, chunkId, min[3], max[3]] tuples. */
export const apiProxy = (versionId: string) =>
  api.get<{ schema: "proxy/1"; boxes: unknown[] }>(`/versions/${versionId}/proxy`);

export interface DiffResult {
  added: { total: number; items: Array<{ guid: string; b?: { expressID: number; type: string; name: string } }> };
  removed: { total: number; items: Array<{ guid: string; a?: { expressID: number; type: string; name: string } }> };
  changed: { total: number; items: Array<{ guid: string; a?: { type: string; name: string }; b?: { type: string; name: string }; changes: string[] }> };
  unchanged: number;
}

export const apiDiff = (versionAId: string, versionBId: string): Promise<DiffResult> =>
  api.get<DiffResult>(`/versions/${versionAId}/diff/${versionBId}`);

/** Backoff between reconnect probes when the session state is unclear (network down). */
const RECONNECT_BACKOFF_MS = 5000;

/** Live version status/progress via SSE (token in query — EventSource cannot set headers). */
export function subscribeVersions(
  ids: string[],
  onUpdate: (update: { versionId: string; status: string; progress: number }) => void,
  opts?: { backoffMs?: number }
): () => void {
  const backoffMs = opts?.backoffMs ?? RECONNECT_BACKOFF_MS;
  let closed = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    const query = new URLSearchParams({ token: getAccessToken() ?? "", ids: ids.join(",") });
    es = new EventSource(`${BASE}/versions/events?${query.toString()}`);
    es.onmessage = (e) => {
      try {
        onUpdate(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    // The server validates the token only at connection time and returns 401
    // for an expired one; EventSource then errors and never auto-reconnects
    // (and a browser reconnect would replay the stale token anyway).
    es.onerror = () => {
      if (closed) return;
      es?.close();
      void reconnect();
    };
  };

  // Probe the session through the shared protocol instead of guessing: a
  // stale token is refreshed here (single-flight, once), a live token
  // reconnects as-is (network blips spend no refresh), and a dead session is
  // logged out by withAuthRetry and stops the loop.
  const reconnect = async (): Promise<void> => {
    if (closed) return;
    try {
      await api.get("/auth/me");
      if (!closed) connect();
    } catch (err) {
      if (closed) return;
      if (err instanceof ApiError && err.status === 401) return; // logged out
      reconnectTimer = setTimeout(() => void reconnect(), backoffMs);
    }
  };

  connect();
  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    es?.close();
  };
}
