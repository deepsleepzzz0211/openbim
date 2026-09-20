import { FastifyInstance } from "fastify";
import { buildBcfZip, parseBcfZip, BcfTopic, statusFromBcf, priorityFromBcf } from "@openbim-hub/bcf";
import { issueGuid, requireProjectRole, authUser, audit } from "../auth";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.get(
    "/projects/:projectId/issues",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { enum: ["OPEN", "CLOSED"] } },
        },
      },
    },
    async (request) => {
      await requireProjectRole(app, request, "VIEWER");
      const { projectId } = request.params as { projectId: string };
      const { status } = request.query as { status?: "OPEN" | "CLOSED" };
      const issues = await db.issue.findMany({
        where: { projectId, ...(status ? { status } : {}) },
        include: { comments: true, author: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      });
      return { issues };
    }
  );

  app.post(
    "/projects/:projectId/issues",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 5000 },
            priority: { enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"] },
            viewpoint: {
              type: "object",
              properties: {
                camera: {
                  type: "object",
                  required: ["viewPoint"],
                  properties: {
                    viewPoint: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                    viewUp: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                    viewDirection: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                    fieldOfView: { type: "number" },
                  },
                },
                selected: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 50 },
              },
            },
            snapshotBase64: { type: "string", maxLength: MAX_SNAPSHOT_BYTES },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "VIEWER");
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        title: string;
        description?: string;
        priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
        viewpoint?: {
          camera: { viewPoint: number[]; viewUp?: number[]; viewDirection?: number[]; fieldOfView?: number };
          selected?: string[];
        };
        snapshotBase64?: string;
      };
      const guid = issueGuid();
      let snapshotKey: string | null = null;
      if (body.snapshotBase64) {
        const png = Buffer.from(body.snapshotBase64, "base64");
        if (png.byteLength > MAX_SNAPSHOT_BYTES) {
          return reply.code(413).send({ statusCode: 413, error: "PayloadTooLarge", message: "snapshot too large" });
        }
        snapshotKey = `projects/${projectId}/issues/${guid}/snapshot.png`;
        await app.blobs.put(snapshotKey, png);
      }
      const issue = await db.issue.create({
        data: {
          guid,
          projectId,
          title: body.title,
          description: body.description ?? "",
          priority: body.priority ?? "NORMAL",
          viewpointJson: body.viewpoint?.camera
            ? JSON.stringify({
                camera: body.viewpoint.camera,
                selected: body.viewpoint.selected ?? [],
              })
            : null,
          snapshotKey,
          authorId: authUser(request).sub,
        },
        include: { comments: true },
      });
      await audit(app, request, "issue.create", "issue", issue.id, { projectId, meta: { title: body.title } });
      return reply.code(201).send({ issue });
    }
  );

  app.get("/issues/:issueId/snapshot", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { issueId } = request.params as { issueId: string };
    const issue = await db.issue.findUnique({ where: { id: issueId } });
    if (!issue?.snapshotKey) {
      return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "snapshot not found" });
    }
    const png = await app.blobs.get(issue.snapshotKey).catch(() => null);
    if (!png) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "snapshot not found" });
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, max-age=86400");
    return reply.send(png);
  });

  app.patch(
    "/issues/:issueId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            status: { enum: ["OPEN", "CLOSED"] },
            priority: { enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"] },
            title: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "EDITOR");
      const { issueId } = request.params as { issueId: string };
      const body = request.body as {
        status?: "OPEN" | "CLOSED";
        priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
        title?: string;
        description?: string;
      };
      const issue = await db.issue
        .update({
          where: { id: issueId },
          data: {
            ...(body.status ? { status: body.status } : {}),
            ...(body.priority ? { priority: body.priority } : {}),
            ...(body.title ? { title: body.title } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
          include: { comments: true },
        })
        .catch(() => null);
      if (!issue) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "issue not found" });
      await audit(app, request, "issue.update", "issue", issueId, { projectId: issue.projectId, meta: body });
      return { issue };
    }
  );

  app.post(
    "/issues/:issueId/comments",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          properties: { body: { type: "string", minLength: 1, maxLength: 5000 } },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "VIEWER");
      const { issueId } = request.params as { issueId: string };
      const { body } = request.body as { body: string };
      const issue = await db.issue.findUnique({ where: { id: issueId }, select: { id: true } });
      if (!issue) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "issue not found" });
      const comment = await db.issueComment.create({
        data: { issueId, authorId: authUser(request).sub, body },
        include: { author: { select: { id: true, name: true, email: true } } },
      });
      return reply.code(201).send({ comment });
    }
  );

  app.post("/projects/:projectId/issues/import.bcfzip", async (request, reply) => {
    await requireProjectRole(app, request, "EDITOR");
    const { projectId } = request.params as { projectId: string };
    const file = await request.file({ limits: { fileSize: 256 * 1024 * 1024 } });
    if (!file) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: "multipart file field required" });
    }
    if (!file.filename.toLowerCase().endsWith(".bcfzip")) {
      return reply.code(415).send({ statusCode: 415, error: "UnsupportedMediaType", message: "only .bcfzip files are accepted" });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(chunk as Buffer);
    const zipBytes = Buffer.concat(chunks);

    let parsed;
    try {
      parsed = await parseBcfZip(zipBytes);
    } catch (err) {
      return reply.code(400).send({ statusCode: 400, error: "BadRequest", message: `invalid bcfzip: ${(err as Error).message}` });
    }

    let imported = 0;
    let skipped = 0;
    for (const topic of parsed.topics) {
      const exists = await db.issue.findUnique({ where: { guid: topic.guid }, select: { id: true } });
      if (exists) {
        skipped++;
        continue;
      }
      let snapshotKey: string | null = null;
      if (topic.viewpoint?.snapshot && topic.viewpoint.snapshot.byteLength > 0) {
        snapshotKey = `projects/${projectId}/issues/${topic.guid}/snapshot.png`;
        await app.blobs.put(snapshotKey, topic.viewpoint.snapshot);
      }
      const issue = await db.issue.create({
        data: {
          guid: topic.guid,
          projectId,
          title: topic.title.slice(0, 200),
          description: topic.description.slice(0, 5000),
          status: statusFromBcf(topic.status),
          priority: priorityFromBcf(topic.priority),
          viewpointJson: topic.viewpoint ? JSON.stringify({ camera: topic.viewpoint.camera, selected: [] }) : null,
          snapshotKey,
          authorId: authUser(request).sub,
          createdAt: Number.isNaN(topic.createdAt.getTime()) ? new Date() : topic.createdAt,
        },
      });
      if (topic.comments.length > 0) {
        await db.issueComment.createMany({
          data: topic.comments.slice(0, 200).map((c) => ({
            issueId: issue.id,
            authorId: authUser(request).sub,
            body: `[${c.author || "unknown"}] ${c.body}`.slice(0, 5000),
          })),
        });
      }
      imported++;
    }
    await audit(app, request, "issue.import", "project", projectId, {
      projectId,
      meta: { imported, skipped, version: parsed.version },
    });
    return { imported, skipped, version: parsed.version };
  });

  app.get("/projects/:projectId/issues/export.bcfzip", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { projectId } = request.params as { projectId: string };
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "project not found" });
    const issues = await db.issue.findMany({
      where: { projectId },
      include: { comments: { include: { author: { select: { email: true } } } }, author: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    });
    const topics: BcfTopic[] = [];
    for (const i of issues) {
      let viewpoint: BcfTopic["viewpoint"] = null;
      if (i.viewpointJson) {
        try {
          const parsed = JSON.parse(i.viewpointJson) as {
            camera: { viewPoint: number[]; viewUp?: number[]; viewDirection?: number[]; fieldOfView?: number };
            selected?: string[];
          };
          let snapshot: Uint8Array | null = null;
          if (i.snapshotKey) {
            snapshot = await app.blobs.get(i.snapshotKey).catch(() => null);
          }
          viewpoint = {
            guid: i.guid,
            camera: {
              viewPoint: parsed.camera.viewPoint as [number, number, number],
              viewUp: parsed.camera.viewUp as [number, number, number] | undefined,
              viewDirection: parsed.camera.viewDirection as [number, number, number] | undefined,
              fieldOfView: parsed.camera.fieldOfView,
            },
            snapshot,
            selected: parsed.selected ?? [],
          };
        } catch {
          // corrupted viewpoint: export without it
        }
      }
      topics.push({
        guid: i.guid,
        title: i.title,
        description: i.description,
        status: i.status,
        priority: i.priority,
        author: i.author.email,
        createdAt: i.createdAt,
        comments: i.comments.map((c) => ({
          guid: issueGuid(),
          author: c.author.email,
          date: c.createdAt,
          body: c.body,
        })),
        viewpoint,
      });
    }
    const zipBytes = await buildBcfZip({ projectId: project.key, name: project.name }, topics);
    await audit(app, request, "issue.export", "project", projectId, { projectId, meta: { count: topics.length } });
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${project.key}-issues.bcfzip"`);
    return reply.send(zipBytes);
  });

  app.get("/projects/:projectId/audit", async (request) => {
    await requireProjectRole(app, request, "ADMIN");
    const { projectId } = request.params as { projectId: string };
    const entries = await db.auditLog.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { email: true, name: true } } },
    });
    return { entries };
  });
}
