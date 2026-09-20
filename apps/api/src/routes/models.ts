import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as fsp from "node:fs/promises";
import * as zlib from "node:zlib";
import { FastifyInstance, FastifyRequest } from "fastify";
import { requireProjectRole, authUser, audit } from "../auth";
import { routeEngine } from "../conversion/engineRouting";
import { runPresplitConversion } from "../conversion/presplitPipeline";

/** Where the original IFC bytes live: the shared content blob, or (legacy)
 *  the version's own directory. */
function originalKeyOf(version: { storageKey: string; blob?: { storageKey: string } | null }): string {
  return version.blob ? version.blob.storageKey : `${version.storageKey}/original.ifc`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

// Shared param validators (CONTRIBUTING: API changes ship with fastify schemas).
const CUID = { type: "string", pattern: "^[a-z0-9]{1,64}$" };
const NUM = { type: "string", pattern: "^[0-9]{1,9}$" };
function paramsSchema(properties: Record<string, unknown>): { schema: { params: object } } {
  return { schema: { params: { type: "object", properties } } };
}

interface VersionManifestMeta {
  artifactFormat?: "single" | "chunked";
  origin?: [number, number, number];
  stats?: { elements: number; triangles: number };
  chunks?: Array<{
    id: number;
    storeyExpressID: number | null;
    storeyGuid: string | null;
    bbox: [number, number, number, number, number, number];
    triangles: number;
    bytes: number;
    buckets: number[];
    overflowed?: boolean;
  }>;
}

/**
 * Register freshly-uploaded bytes (currently at `tmpKey`) in the project's
 * content-addressed blob table. Hits delete the redundant copy and link the
 * existing blob; misses promote the temp file. Returns the blob row with the
 * reference for the new version already counted.
 */
async function linkOrStoreContent(
  app: FastifyInstance,
  projectId: string,
  sha256: string,
  sizeBytes: number,
  tmpKey: string
): Promise<{ id: string; storageKey: string; deduped: boolean }> {
  const db = app.db;
  const key = { projectId_sha256: { projectId, sha256 } } as const;
  const existing = await db.contentBlob.findUnique({ where: key });
  if (existing) {
    await app.blobs.delete(tmpKey);
    const blob = await db.contentBlob.update({ where: { id: existing.id }, data: { refCount: { increment: 1 } } });
    return { id: blob.id, storageKey: blob.storageKey, deduped: true };
  }
  const contentKey = `projects/${projectId}/content/${sha256}.ifc`;
  await app.blobs.move(tmpKey, contentKey);
  try {
    const blob = await db.contentBlob.create({
      data: { projectId, sha256, sizeBytes, storageKey: contentKey, refCount: 1 },
    });
    return { id: blob.id, storageKey: blob.storageKey, deduped: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // concurrent creator won: our promoted file has identical bytes and the
    // winner's blob keeps pointing at it — never delete a live content key
    const winner = await db.contentBlob.findUniqueOrThrow({ where: key });
    await db.contentBlob.update({ where: { id: winner.id }, data: { refCount: { increment: 1 } } });
    return { id: winner.id, storageKey: winner.storageKey, deduped: true };
  }
}

/** Drop one version reference; physically removes the blob at refCount 0. */
async function releaseBlobRef(app: FastifyInstance, blobId: string): Promise<void> {
  let blob;
  try {
    blob = await app.db.contentBlob.update({ where: { id: blobId }, data: { refCount: { decrement: 1 } } });
  } catch {
    return; // blob row already gone
  }
  if (blob.refCount > 0) return;
  await app.blobs.delete(blob.storageKey).catch(() => undefined);
  await app.db.contentBlob.delete({ where: { id: blobId } }).catch(() => null);
}

/**
 * Create a version row with a race-safe versionNumber: concurrent uploads to
 * the same model collide on @@unique([modelId, versionNumber]) and retry.
 */
async function createVersion(
  app: FastifyInstance,
  projectId: string,
  data: { modelId: string } & Record<string, unknown>
) {
  const db = app.db;
  for (let attempt = 0; attempt < 5; attempt++) {
    const top = await db.version.findFirst({
      where: { modelId: data.modelId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const versionNumber = (top?.versionNumber ?? 0) + 1;
    try {
      return await db.version.create({
        data: {
          ...data,
          versionNumber,
          storageKey: `projects/${projectId}/models/${data.modelId}/v${versionNumber}`,
        } as never,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw Object.assign(new Error("could not allocate version number"), { statusCode: 409 });
}

/** Fire-and-forget conversion of a version; updates status/progress and imports elements. */
export async function processVersion(app: FastifyInstance, versionId: string): Promise<void> {
  const db = app.db;
  try {
    const version = await db.version.findUnique({ where: { id: versionId }, include: { blob: true } });
    if (!version || version.status !== "PENDING") return;

    // Engine routing (ticket 09): sticky per model (a model never mixes wasm and
    // native geometry; pre-ticket rows count as wasm), else size-based.
    const newestOther = await db.version.findFirst({
      where: { modelId: version.modelId, id: { not: version.id } },
      orderBy: { versionNumber: "desc" },
      select: { engine: true },
    });
    const decision = routeEngine({
      sizeBytes: version.sizeBytes,
      nativeThresholdBytes: app.config.nativeThresholdBytes,
      nativeConfigured: Boolean(app.config.nativeWorkerUrl),
      previousEngine: newestOther ? (newestOther.engine === "native" ? "native" : "wasm") : null,
    });
    if (decision.note === "native-not-configured") {
      app.log.warn({ versionId, sizeBytes: version.sizeBytes }, "oversized source but no native worker configured; falling back to wasm");
    }
    const engine = version.engine === "native" || version.engine === "wasm" ? version.engine : decision.engine;
    await db.version.update({ where: { id: versionId }, data: { status: "PROCESSING", progress: 1, engine } });
    app.events.emit("version", { versionId, status: "PROCESSING", progress: 1 });

    const base = version.storageKey;
    let lastStored = 0;
    const storeProgress = (percent: number, shards?: { done: number; total: number }) => {
      // throttle DB writes: only on >=4% progress. updateMany guarded by
      // status=PROCESSING so a late in-flight write can never clobber the
      // final READY/FAILED row (fast conversions finish mid-progress-write).
      if (percent - lastStored >= 4) {
        lastStored = percent;
        void db.version
          .updateMany({ where: { id: versionId, status: "PROCESSING" }, data: { progress: percent } })
          .catch(() => undefined);
        app.events.emit("version", { versionId, status: "PROCESSING", progress: percent, ...(shards ? { shards } : {}) });
      }
    };

    // Ticket 10: wasm jobs at/above the presplit threshold run the
    // slice -> parallel shard conversion -> aggregate pipeline. The pipeline
    // writes the same contract artifacts (model.glb/chunks + meta.json) into
    // the version dir, so everything below is format-agnostic.
    // The ticket-09 no-worker fallback (size >= native threshold but wasm
    // anyway) must never run the plain single-thread path: presplit engages
    // there too, closing the gap between the two thresholds.
    const usePresplit =
      engine === "wasm" &&
      app.config.presplitThresholdBytes > 0 &&
      (version.sizeBytes >= app.config.presplitThresholdBytes || decision.note === "native-not-configured");
    const chunking =
      version.sizeBytes >= app.config.chunkingThresholdBytes
        ? { maxTrianglesPerChunk: app.config.chunkMaxTriangles }
        : undefined;
    let outcome: Awaited<ReturnType<typeof app.conversion.submit>>;
    if (usePresplit) {
      app.log.info({ versionId, sizeBytes: version.sizeBytes }, "running presplit shard pipeline");
      outcome = await runPresplitConversion(app.conversion, {
        versionId,
        inputPath: app.blobs.pathFor(originalKeyOf(version)),
        baseDir: path.dirname(app.blobs.pathFor(`${base}/model.glb`)),
        meshopt: app.config.meshopt,
        chunking,
        onProgress: storeProgress,
      });
    } else {
      outcome = await app.conversion.submit(
        {
          jobId: version.id,
          engine,
          inputPath: app.blobs.pathFor(originalKeyOf(version)),
          glbPath: app.blobs.pathFor(`${base}/model.glb`),
          metaPath: app.blobs.pathFor(`${base}/meta.json`),
          meshopt: app.config.meshopt,
          // chunking is decided on the *source* size (known pre-conversion); the
          // converter still degrades to single format if everything fits one chunk
          chunking,
        },
        (percent) => storeProgress(percent)
      );
    }

    if (!outcome.ok) {
      app.log.error({ versionId, code: outcome.code, err: outcome.message }, "conversion failed");
      await db.version.update({
        where: { id: versionId },
        data: { status: "FAILED", errorCode: outcome.code ?? "UNKNOWN" },
      });
      app.events.emit("version", { versionId, status: "FAILED", progress: 100 });
      app.metrics.conversionsTotal.inc({ status: "failed" });
      return;
    }

    // Import element index from meta.json (written by the converter).
    const metaBuf = await app.blobs.get(`${base}/meta.json`);
    const meta = JSON.parse(metaBuf.toString("utf8")) as {
      schema?: string;
      origin?: [number, number, number];
      crs?: unknown;
      glbCompression?: { codec: "meshopt" | "none"; fallbackViews: number };
      artifactFormat?: "single" | "chunked";
      stats?: { elements: number; triangles: number };
      elements?: Record<string, { guid?: string; type?: string; name?: string; storeyGuid?: string | null; chunkId?: number; attributes?: Record<string, unknown>; psets?: Record<string, unknown>; bbox?: number[] }>;
    };
    const rows = Object.entries(meta.elements ?? {}).map(([expressId, el]) => ({
      versionId,
      expressID: Number(expressId),
      guid: (el.guid as string) ?? "",
      ifcType: (el.type as string) ?? "IFCUNKNOWN",
      name: (el.name as string) ?? "",
      storeyGuid: (el.storeyGuid as string | null) ?? null,
      chunkId: el.chunkId ?? null,
      attributesJson: JSON.stringify(el.attributes ?? {}),
      psetsJson: JSON.stringify(el.psets ?? {}),
      bboxJson: el.bbox ? JSON.stringify(el.bbox) : null,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await db.element.createMany({ data: rows.slice(i, i + 200) });
    }

    if ((meta.glbCompression?.fallbackViews ?? 0) > 0) {
      app.log.warn({ versionId, fallbackViews: meta.glbCompression?.fallbackViews }, "meshopt encode fell back to raw bufferViews");
    }
    // Static Brotli sidecar for the glTF download (HTTP content negotiation in
    // sendBlob). Only single-format versions have a model.glb; chunked
    // artifacts ship per-chunk GLBs. Failure is non-fatal: routes serve raw.
    if (meta.artifactFormat !== "chunked") {
      await writeBrotliSidecar(app, `${base}/model.glb`).catch((err) =>
        app.log.warn({ versionId, err: (err as Error).message }, "brotli sidecar failed; serving raw")
      );
    }

    await db.version.update({
      where: { id: versionId },
      data: {
        status: "READY",
        progress: 100,
        schema: outcome.schema ?? meta.schema ?? null,
        statsJson: JSON.stringify(outcome.stats ?? meta.stats ?? {}),
        originJson: meta.origin ? JSON.stringify(meta.origin) : null,
        crsJson: meta.crs ? JSON.stringify(meta.crs) : null,
        errorCode: null,
      },
    });
    app.events.emit("version", { versionId, status: "READY", progress: 100 });
    app.log.info({ versionId, stats: outcome.stats }, "conversion ready");
  } catch (err) {
    app.log.error({ versionId, err: (err as Error).message }, "conversion pipeline error");
    await db.version
      .update({ where: { id: versionId }, data: { status: "FAILED", errorCode: "UNKNOWN" } })
      .catch(() => undefined);
  }
}

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  // ---- models -------------------------------------------------------------
  app.get("/projects/:projectId/models", async (request) => {
    await requireProjectRole(app, request, "VIEWER");
    const { projectId } = request.params as { projectId: string };
    const models = await db.model.findMany({
      where: { projectId },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
      orderBy: { createdAt: "asc" },
    });
    return { models };
  });

  app.post(
    "/projects/:projectId/models",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "EDITOR");
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { name: string; description?: string };
      const model = await db.model.create({
        data: { projectId, name: body.name, description: body.description ?? "" },
      });
      return reply.code(201).send({ model });
    }
  );

  app.get("/models/:modelId", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { modelId } = request.params as { modelId: string };
    const model = await db.model.findUnique({ where: { id: modelId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!model) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "model not found" });
    return { model };
  });

  app.delete("/models/:modelId", async (request) => {
    await requireProjectRole(app, request, "EDITOR");
    const { modelId } = request.params as { modelId: string };
    // collect blob references before the version rows cascade away
    const versions = await db.version.findMany({ where: { modelId }, select: { blobId: true } });
    await db.model.delete({ where: { id: modelId } }).catch(() => null);
    for (const v of versions) {
      if (v.blobId) await releaseBlobRef(app, v.blobId);
    }
    return { ok: true };
  });

  // ---- versions -----------------------------------------------------------
  app.post("/models/:modelId/versions", paramsSchema({ modelId: CUID }), async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { modelId } = request.params as { modelId: string };
    const model = await db.model.findUnique({ where: { id: modelId } });
    if (!model) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "model not found" });

    const file = await request.file({ limits: { fileSize: app.config.maxUploadBytes } });
    if (!file) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "multipart file field required" });
    }
    const name = file.filename || "model.ifc";
    if (!name.toLowerCase().endsWith(".ifc")) {
      return reply.code(415).send({ statusCode: 415, error: "UnsupportedMediaType", message: "only .ifc files are accepted" });
    }

    const tmpKey = `tmp/uploads/${crypto.randomUUID()}/original.ifc`;

    // Stream to blob store while hashing; reject files over the size limit.
    const hash = crypto.createHash("sha256");
    let size = 0;
    const countingStream = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.byteLength;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    file.file.on("limit", () => {
      countingStream.destroy(Object.assign(new Error("file too large"), { statusCode: 413 }));
    });
    try {
      await pipeline(file.file, countingStream, await app.blobs.writeStream(tmpKey));
    } catch (err) {
      await app.blobs.delete(tmpKey).catch(() => undefined);
      const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
      return reply.code(statusCode === 413 ? 413 : 500).send({
        statusCode: statusCode === 413 ? 413 : 500,
        error: statusCode === 413 ? "PayloadTooLarge" : "InternalServerError",
        message: statusCode === 413 ? "file exceeds upload limit" : "upload failed",
      });
    }
    if (size === 0) {
      await app.blobs.delete(tmpKey);
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "empty file" });
    }

    const sha256 = hash.digest("hex");
    const { id: blobId } = await linkOrStoreContent(app, model.projectId, sha256, size, tmpKey);
    const version = await createVersion(app, model.projectId, {
      modelId,
      blobId,
      originalName: name,
      sizeBytes: size,
      sha256,
      status: "PENDING",
      createdById: authUser(request).sub,
    });

    // Kick off conversion without blocking the response.
    void processVersion(app, version.id);
    await audit(app, request, "version.upload", "version", version.id, { projectId: model.projectId, meta: { name, size } });
    return reply.code(202).send({ version });
  });

  // ---- 秒传: register a version from an already-uploaded blob, no bytes ----
  app.post(
    "/models/:modelId/versions/fast-import",
    {
      schema: {
        body: {
          type: "object",
          required: ["sha256", "sizeBytes", "fileName"],
          properties: {
            sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
            sizeBytes: { type: "integer", minimum: 1 },
            fileName: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "EDITOR");
      const { modelId } = request.params as { modelId: string };
      const model = await db.model.findUnique({ where: { id: modelId } });
      if (!model) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "model not found" });
      const body = request.body as { sha256: string; sizeBytes: number; fileName: string };
      if (!body.fileName.toLowerCase().endsWith(".ifc")) {
        return reply.code(415).send({ statusCode: 415, error: "UnsupportedMediaType", message: "only .ifc files are accepted" });
      }
      const sha256 = body.sha256.toLowerCase();
      // dedupe is deliberately scoped to the project: no cross-tenant probing
      const blob = await db.contentBlob.findUnique({
        where: { projectId_sha256: { projectId: model.projectId, sha256 } },
      });
      if (!blob || blob.sizeBytes !== body.sizeBytes) {
        return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "no matching content in this project" });
      }
      const version = await createVersion(app, model.projectId, {
        modelId,
        blobId: blob.id,
        originalName: body.fileName,
        sizeBytes: blob.sizeBytes,
        sha256,
        status: "PENDING",
        createdById: authUser(request).sub,
      });
      await db.contentBlob.update({ where: { id: blob.id }, data: { refCount: { increment: 1 } } });
      void processVersion(app, version.id);
      await audit(app, request, "version.fast-import", "version", version.id, {
        projectId: model.projectId,
        meta: { name: body.fileName, sha256, deduped: true },
      });
      return reply.code(202).send({ version, deduped: true });
    }
  );

  app.delete("/versions/:versionId", async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { versionId } = request.params as { versionId: string };
    const version = await db.version.findUnique({ where: { id: versionId } });
    if (!version) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found" });
    await db.element.deleteMany({ where: { versionId } });
    await db.version.delete({ where: { id: versionId } });
    for (const artifact of ["model.glb", "model.glb.br", "meta.json", "original.ifc"]) {
      await app.blobs.delete(`${version.storageKey}/${artifact}`).catch(() => undefined);
    }
    // chunked artifacts live in a per-version subdirectory (server-generated
    // storage key only, no user input in the path)
    await fsp.rm(app.blobs.pathFor(`${version.storageKey}/chunks`), { recursive: true, force: true }).catch(() => undefined);
    // presplit intermediates (shard IFCs + plan) for a version that failed
    // mid-pipeline; deleted on success, claimed here otherwise
    await fsp.rm(app.blobs.pathFor(`${version.storageKey}/presplit`), { recursive: true, force: true }).catch(() => undefined);
    if (version.blobId) await releaseBlobRef(app, version.blobId);
    await audit(app, request, "version.delete", "version", versionId, { meta: { modelId: version.modelId } });
    return { ok: true };
  });

  // ---- chunked upload (large files / resumable-ish) ------------------------
  app.post(
    "/models/:modelId/uploads",
    {
      schema: {
        body: {
          type: "object",
          required: ["fileName", "partSize", "partsTotal"],
          properties: {
            fileName: { type: "string", minLength: 1, maxLength: 200 },
            partSize: { type: "integer", minimum: 1024, maximum: 32 * 1024 * 1024 },
            partsTotal: { type: "integer", minimum: 1, maximum: 4096 },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "EDITOR");
      const { modelId } = request.params as { modelId: string };
      const model = await db.model.findUnique({ where: { id: modelId } });
      if (!model) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "model not found" });
      const body = request.body as { fileName: string; partSize: number; partsTotal: number };
      if (!body.fileName.toLowerCase().endsWith(".ifc")) {
        return reply.code(415).send({ statusCode: 415, error: "UnsupportedMediaType", message: "only .ifc files are accepted" });
      }
      const estimated = body.partsTotal * body.partSize;
      if (estimated > app.config.maxUploadBytes) {
        return reply.code(413).send({ statusCode: 413, error: "PayloadTooLarge", message: "total size exceeds upload limit" });
      }
      const session = await db.uploadSession.create({
        data: {
          modelId,
          fileName: body.fileName,
          partSize: body.partSize,
          partsTotal: body.partsTotal,
        },
      });
      return reply.code(201).send({ uploadId: session.id, partSize: session.partSize });
    }
  );

  app.put("/models/:modelId/uploads/:uploadId/parts/:part", paramsSchema({ modelId: CUID, uploadId: CUID, part: NUM }), async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { modelId, uploadId, part } = request.params as {
      modelId: string;
      uploadId: string;
      part: string;
    };
    const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
    if (!session || session.modelId !== modelId) {
      return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "upload session not found" });
    }
    const partNo = Number(part);
    if (!Number.isInteger(partNo) || partNo < 1 || partNo > session.partsTotal) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "invalid part number" });
    }
    const data = request.body as Buffer;
    if (!Buffer.isBuffer(data) || data.byteLength === 0) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "empty part body" });
    }
    if (data.byteLength > session.partSize) {
      return reply.code(413).send({ statusCode: 413, error: "PayloadTooLarge", message: "part exceeds declared partSize" });
    }
    // optional per-part integrity check (the full-file sha256 is verified on merge)
    const partSha = request.headers["x-part-sha256"];
    if (typeof partSha === "string" && partSha.length > 0) {
      if (!/^[0-9a-f]{64}$/.test(partSha)) {
        return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "invalid x-part-sha256 header" });
      }
      const actual = crypto.createHash("sha256").update(data).digest("hex");
      if (actual !== partSha) {
        return reply.code(422).send({
          statusCode: 422,
          error: "UnprocessableEntity",
          message: `part checksum mismatch (expected ${partSha}, got ${actual})`,
        });
      }
    }
    await app.blobs.put(`${versionUploadTmpKey(uploadId)}/part-${partNo}`, data);
    return { part: partNo, received: data.byteLength };
  });

  app.post("/models/:modelId/uploads/:uploadId/complete", paramsSchema({ modelId: CUID, uploadId: CUID }), async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { modelId, uploadId } = request.params as { modelId: string; uploadId: string };
    const model = await db.model.findUnique({ where: { id: modelId } });
    const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
    if (!model || !session || session.modelId !== modelId) {
      return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "upload session not found" });
    }

    // assemble parts into a temp blob while hashing; the content-addressed
    // dedupe step below either promotes or discards these bytes
    const tmpKey = `${versionUploadTmpKey(uploadId)}/original.ifc`;
    const hash = crypto.createHash("sha256");
    let size = 0;
    const sink = await app.blobs.writeStream(tmpKey);
    for (let p = 1; p <= session.partsTotal; p++) {
      const partBuf = await app.blobs
        .get(`${versionUploadTmpKey(uploadId)}/part-${p}`)
        .catch(() => null);
      if (!partBuf) {
        await new Promise<void>((resolve) => sink.end(() => resolve()));
        return reply.code(400).send({
          statusCode: 400,
          error: "BadRequest",
          message: `missing part ${p} (of ${session.partsTotal})`,
        });
      }
      size += partBuf.byteLength;
      hash.update(partBuf);
      await new Promise<void>((resolve, reject) => {
        sink.write(partBuf, (err) => (err ? reject(err) : resolve()));
      });
      await app.blobs.delete(`${versionUploadTmpKey(uploadId)}/part-${p}`).catch(() => undefined);
    }
    await new Promise<void>((resolve, reject) => sink.end((err: Error) => (err ? reject(err) : resolve())));

    if (size === 0) {
      await app.blobs.delete(tmpKey);
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "empty file" });
    }

    const sha256 = hash.digest("hex");
    const { id: blobId } = await linkOrStoreContent(app, model.projectId, sha256, size, tmpKey);
    const version = await createVersion(app, model.projectId, {
      modelId,
      blobId,
      originalName: session.fileName,
      sizeBytes: size,
      sha256,
      status: "PENDING",
      createdById: authUser(request).sub,
    });
    await db.uploadSession.delete({ where: { id: uploadId } }).catch(() => undefined);
    void processVersion(app, version.id);
    await audit(app, request, "version.upload.chunks", "version", version.id, { projectId: model.projectId, meta: { name: session.fileName, size } });
    return reply.code(202).send({ version });
  });

  app.get("/models/:modelId/versions", async (request) => {
    await requireProjectRole(app, request, "VIEWER");
    const { modelId } = request.params as { modelId: string };
    const versions = await db.version.findMany({ where: { modelId }, orderBy: { versionNumber: "desc" } });
    return { versions };
  });

  app.get("/versions/:versionId", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { versionId } = request.params as { versionId: string };
    const version = await db.version.findUnique({ where: { id: versionId } });
    if (!version) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found" });
    return { version };
  });

  app.post("/versions/:versionId/reconvert", async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { versionId } = request.params as { versionId: string };
    const version = await db.version.findUnique({ where: { id: versionId } });
    if (!version) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found" });
    if (version.status === "PROCESSING" || version.status === "PENDING") {
      return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "conversion already in progress" });
    }
    await db.element.deleteMany({ where: { versionId } });
    await db.version.update({ where: { id: versionId }, data: { status: "PENDING", errorCode: null } });
    void processVersion(app, versionId);
    return reply.code(202).send({ ok: true });
  });

  // ---- files (authorised streaming) ---------------------------------------
  app.get("/versions/:versionId/file/glTF", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    return sendBlob(app, request, reply, "model.glb", "model/gltf-binary");
  });

  app.get("/versions/:versionId/file/meta", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    return sendBlob(app, request, reply, "meta.json", "application/json");
  });

  app.get("/versions/:versionId/file/original", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    return sendBlob(app, request, reply, "original.ifc", "application/octet-stream");
  });

  // ---- chunked artifacts (manifest + per-chunk download) -------------------
  async function readyVersionAndMeta(request: FastifyRequest) {
    const { versionId } = request.params as { versionId: string };
    const version = await db.version.findUnique({ where: { id: versionId } });
    if (!version || version.status !== "READY") return null;
    const buf = await app.blobs.get(`${version.storageKey}/meta.json`).catch(() => null);
    if (!buf) return null;
    return { version, meta: JSON.parse(buf.toString("utf8")) as VersionManifestMeta };
  }

  app.get("/versions/:versionId/manifest", paramsSchema({ versionId: CUID }), async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const found = await readyVersionAndMeta(request);
    if (!found) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found or not ready" });
    const { version, meta } = found;
    const chunkList = meta.chunks ?? [];
    // URLs are relative and built from server-side numeric chunk ids recorded
    // in meta.json — never from client input.
    if (meta.artifactFormat === "chunked" && chunkList.length > 0) {
      return {
        versionId: version.id,
        artifactFormat: "chunked" as const,
        origin: meta.origin ?? null,
        stats: meta.stats ?? null,
        chunks: chunkList.map((c) => ({
          ...c,
          url: `/api/v1/versions/${version.id}/chunks/${c.id}`,
        })),
      };
    }
    return {
      versionId: version.id,
      artifactFormat: "single" as const,
      origin: meta.origin ?? null,
      stats: meta.stats ?? null,
      url: `/api/v1/versions/${version.id}/file/glTF`,
    };
  });

  app.get("/versions/:versionId/chunks/:chunkId", paramsSchema({ versionId: CUID, chunkId: NUM }), async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { chunkId } = request.params as { chunkId: string };
    if (!/^\d{1,9}$/.test(chunkId)) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "chunkId must be numeric" });
    }
    const found = await readyVersionAndMeta(request);
    if (!found) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found or not ready" });
    const ids = new Set((found.meta.chunks ?? []).map((c) => c.id));
    if (!ids.has(Number(chunkId))) {
      return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "chunk not in manifest" });
    }
    return sendBlob(app, request, reply, `chunks/${chunkId}.glb`, "model/gltf-binary");
  });

  // ---- elements / spatial --------------------------------------------------
  app.get(
    "/versions/:versionId/elements",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            q: { type: "string", maxLength: 100 },
            ifcType: { type: "string", maxLength: 60 },
            storeyGuid: { type: "string", maxLength: 40 },
            page: { type: "integer", minimum: 1, maximum: 10000 },
            pageSize: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      await requireProjectRole(app, request, "VIEWER");
      const { versionId } = request.params as { versionId: string };
      const { q, ifcType, storeyGuid } = request.query as { q?: string; ifcType?: string; storeyGuid?: string };
      const page = Number((request.query as { page?: string }).page ?? 1);
      const pageSize = Number((request.query as { pageSize?: string }).pageSize ?? 50);
      const where = {
        versionId,
        ...(ifcType ? { ifcType: { equals: ifcType.toUpperCase() } } : {}),
        ...(storeyGuid ? { storeyGuid } : {}),
        ...(q ? { OR: [{ name: { contains: q } }, { guid: { equals: q } }] } : {}),
      };
      const [total, elements] = await Promise.all([
        db.element.count({ where }),
        db.element.findMany({
          where,
          orderBy: { expressID: "asc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, expressID: true, guid: true, ifcType: true, name: true, storeyGuid: true },
        }),
      ]);
      return { total, page, pageSize, elements };
    }
  );

  app.get("/versions/:versionId/elements/:expressId", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { versionId, expressId } = request.params as { versionId: string; expressId: string };
    const element = await db.element.findUnique({
      where: { versionId_expressID: { versionId, expressID: Number(expressId) } },
    });
    if (!element) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "element not found" });
    return {
      element: {
        expressID: element.expressID,
        guid: element.guid,
        type: element.ifcType,
        name: element.name,
        storeyGuid: element.storeyGuid,
        chunkId: element.chunkId,
        attributes: JSON.parse(element.attributesJson ?? "{}"),
        psets: JSON.parse(element.psetsJson ?? "{}"),
      },
    };
  });

  // Batch attribute lookup by GUID or expressID — resolves each element's
  // owning chunk so clients pair properties with lazily-downloaded geometry
  // without keeping the full meta.json resident (ticket 05/06).
  app.post(
    "/versions/:versionId/elements/lookup",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guids: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 40 },
              minItems: 1,
              maxItems: 500,
            },
            expressIDs: {
              type: "array",
              items: { type: "integer", minimum: 1 },
              minItems: 1,
              maxItems: 500,
            },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "VIEWER");
      const { versionId } = request.params as { versionId: string };
      const body = request.body as { guids?: string[]; expressIDs?: number[] };
      if (!body.guids?.length && !body.expressIDs?.length) {
        return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "guids or expressIDs required" });
      }
      const elements = await db.element.findMany({
        where: {
          versionId,
          OR: [
            ...(body.guids?.length ? [{ guid: { in: body.guids } }] : []),
            ...(body.expressIDs?.length ? [{ expressID: { in: body.expressIDs } }] : []),
          ],
        },
        select: {
          expressID: true,
          guid: true,
          ifcType: true,
          name: true,
          storeyGuid: true,
          chunkId: true,
          attributesJson: true,
          psetsJson: true,
          bboxJson: true,
        },
      });
      return {
        elements: elements.map((e) => ({
          expressID: e.expressID,
          guid: e.guid,
          type: e.ifcType,
          name: e.name,
          storeyGuid: e.storeyGuid,
          chunkId: e.chunkId,
          attributes: JSON.parse(e.attributesJson ?? "{}"),
          psets: JSON.parse(e.psetsJson ?? "{}"),
          bbox: e.bboxJson ? JSON.parse(e.bboxJson) : null,
        })),
      };
    }
  );

  // Whole-model AABB proxy layer (ticket 08): one compact payload with an
  // axis-aligned box per element that has geometry, so the viewer renders an
  // instant overview (and can select floors/elements) before any real chunk
  // loads. Tuples keep the bytes down: [expressID, storeyGuid, chunkId,
  // minX, minY, minZ, maxX, maxY, maxZ].
  app.get("/versions/:versionId/proxy", paramsSchema({ versionId: CUID }), async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { versionId } = request.params as { versionId: string };
    const version = await db.version.findUnique({ where: { id: versionId } });
    if (!version) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found" });
    const rows = await db.element.findMany({
      where: { versionId, bboxJson: { not: null } },
      orderBy: { expressID: "asc" },
      select: { expressID: true, storeyGuid: true, chunkId: true, bboxJson: true },
    });
    const boxes: Array<[number, string | null, number | null, number, number, number, number, number, number]> = [];
    for (const row of rows) {
      try {
        const bbox = JSON.parse(row.bboxJson!) as number[];
        if (bbox.length !== 6 || bbox.some((n) => !Number.isFinite(n))) continue;
        boxes.push([
          row.expressID,
          row.storeyGuid,
          row.chunkId,
          bbox[0],
          bbox[1],
          bbox[2],
          bbox[3],
          bbox[4],
          bbox[5],
        ]);
      } catch {
        /* malformed bbox rows simply render no proxy box */
      }
    }
    return { schema: "proxy/1", boxes };
  });

  app.get("/versions/:versionId/spatial", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { versionId } = request.params as { versionId: string };
    const buf = await app.blobs.get(`${(await db.version.findUnique({ where: { id: versionId } }))?.storageKey}/meta.json`).catch(() => null);
    if (!buf) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not found or not ready" });
    const meta = JSON.parse(buf.toString("utf8")) as { spatial?: unknown };
    return { spatial: meta.spatial ?? null };
  });
}

function versionUploadTmpKey(uploadId: string): string {
  // server-generated key space for in-flight chunked uploads
  return `tmp/uploads/${uploadId}`;
}

/**
 * Stream model.glb through Brotli into `<key>.br` next to it. Streaming keeps
 * memory flat regardless of artifact size; written to a temp file first so
 * concurrent readers never observe a half-written sidecar.
 */
async function writeBrotliSidecar(app: FastifyInstance, key: string): Promise<void> {
  const src = app.blobs.pathFor(key);
  const dest = `${src}.br`;
  const tmp = `${dest}.tmp`;
  try {
    await pipeline(
      fs.createReadStream(src),
      zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
      fs.createWriteStream(tmp)
    );
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function sendBlob(app: FastifyInstance, request: FastifyRequest, reply: import("fastify").FastifyReply, filename: string, contentType: string) {
  const { versionId } = request.params as { versionId: string };
  const version = await app.db.version.findUnique({ where: { id: versionId }, include: { blob: true } });
  if (!version || version.status !== "READY") {
    return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "version not ready" });
  }
  let key = filename === "original.ifc" ? originalKeyOf(version) : `${version.storageKey}/${filename}`;
  // Static-Brotli negotiation for the GLB artifact: serve the pre-compressed
  // sidecar when the client accepts br. Paths are derived from server-generated
  // storage keys and fixed artifact names; the artifact name is never taken
  // from user input, so there is no traversal surface here.
  let servingBr = false;
  if (filename === "model.glb" && /\bbr\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
    const brKey = `${key}.br`;
    if (await app.blobs.exists(brKey)) {
      key = brKey;
      servingBr = true;
    }
  }
  try {
    await app.blobs.get(key); // existence check
  } catch {
    return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "artifact missing" });
  }
  const stat = await fsp.stat(app.blobs.pathFor(key));
  // Artifacts change in place on reconvert while the URL stays the same, so
  // caching must revalidate: ETag(mtime+size) + no-cache -> 304 when unchanged,
  // fresh bytes the moment a reconversion lands. Vary keeps the cache keyed by
  // caller identity (tokens differ per user) and by negotiated encoding.
  const etag = servingBr
    ? `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-br"`
    : `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const varyHeaders = { vary: "Authorization, Accept-Encoding" };
  if (request.headers["if-none-match"] === etag) {
    return reply.code(304).header("etag", etag).headers(varyHeaders).header("cache-control", "private, no-cache").send();
  }
  reply.header("content-type", contentType);
  reply.header("content-length", stat.size);
  reply.header("etag", etag);
  reply.headers(varyHeaders);
  reply.header("cache-control", "private, no-cache");
  if (servingBr) reply.header("content-encoding", "br");
  return reply.send(await app.blobs.getStream(key));
}
