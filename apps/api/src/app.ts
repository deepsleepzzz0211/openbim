import Fastify, { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Db } from "./db";
import { AppConfig } from "./config";
import { BlobStore } from "./blobStore";
import { ConversionService } from "./conversion";
import { registerAuth } from "./auth";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { modelRoutes } from "./routes/models";
import { issueRoutes } from "./routes/issues";
import { clashRoutes } from "./routes/clash";
import { diffRoutes } from "./routes/diff";
import { eventRoutes } from "./routes/events";
import { EventEmitter } from "node:events";
import client from "prom-client";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: Db;
    blobs: BlobStore;
    conversion: ConversionService;
    events: EventEmitter;
    metrics: { registry: import("prom-client").Registry; httpTotal: import("prom-client").Counter; conversionsTotal: import("prom-client").Counter };
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  blobs: BlobStore;
  conversion: ConversionService;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: opts.config.logLevel,
      transport: undefined,
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate("config", opts.config);
  app.decorate("db", opts.db);
  app.decorate("blobs", opts.blobs);
  app.decorate("conversion", opts.conversion);
  const events = new EventEmitter();
  events.setMaxListeners(200);
  app.decorate("events", events);

  // Prometheus metrics (scrape target for production deployments)
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpTotal = new client.Counter({ name: "obh_http_requests_total", help: "total HTTP requests", labelNames: ["method", "route", "status"], registers: [registry] });
  const conversionsTotal = new client.Counter({ name: "obh_conversions_total", help: "IFC conversion outcomes", labelNames: ["status"], registers: [registry] });
  app.decorate("metrics", { registry, httpTotal, conversionsTotal });
  app.addHook("onResponse", async (request, reply) => {
    httpTotal.inc({ method: request.method, route: request.routeOptions?.url ?? "unmatched", status: reply.statusCode });
  });

  await app.register(cors, {
    origin: opts.config.corsOrigins ?? true,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
  });
  await app.register(multipart, {
    limits: {
      fileSize: opts.config.maxUploadBytes,
      files: 1,
    },
  });
  // raw binary bodies for chunked upload parts
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 34 * 1024 * 1024 },
    (_req, body, done) => done(null, body)
  );
  registerAuth(app, { secret: opts.config.jwtSecret, accessTokenTtl: opts.config.accessTokenTtl });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "OpenBIM Hub API",
        description: "Open, self-hosted BIM collaboration platform: projects, IFC model versions, elements, and BCF issues.",
        version: "0.1.0",
        license: { name: "Apache-2.0" },
      },
      tags: [
        { name: "auth" },
        { name: "projects" },
        { name: "models" },
        { name: "issues" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/api/v1/docs",
  });

  app.get("/metrics", { schema: { hide: true } }, async () => {
    return app.metrics.registry.metrics();
  });

  app.get("/healthz", { schema: { hide: true } }, async () => {
    await app.db.$queryRaw`SELECT 1`;
    return { ok: true, version: "0.1.0" };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(projectRoutes);
      await api.register(modelRoutes);
      await api.register(issueRoutes);
      await api.register(clashRoutes);
      await api.register(diffRoutes);
      await api.register(eventRoutes);
    },
    { prefix: "/api/v1" }
  );

  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err }, "unhandled error");
    }
    // error responses must never be cached (a cached 401/404 would shadow the
    // real artifact once auth succeeds)
    reply.header("cache-control", "no-store");
    const validation = (err as unknown as { validation?: unknown }).validation;
    reply.code(statusCode).send({
      statusCode,
      error: statusCode >= 500 ? "InternalServerError" : err.name || "BadRequest",
      message: statusCode >= 500 && !validation ? "internal server error" : err.message,
      ...(validation ? { validation } : {}),
    });
  });

  app.addHook("onClose", async () => {
    await app.conversion.close();
    await app.db.$disconnect();
  });

  return app;
}
