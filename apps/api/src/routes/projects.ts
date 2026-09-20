import { FastifyInstance } from "fastify";
import { requireAuth, requireProjectRole, authUser, audit } from "../auth";

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.get("/projects", async (request) => {
    await requireAuth(app, request);
    const memberships = await db.projectMember.findMany({
      where: { userId: authUser(request).sub },
      include: { project: true },
      orderBy: { project: { createdAt: "desc" } },
    });
    return { projects: memberships.map((m) => ({ ...m.project, role: m.role })) };
  });

  app.post(
    "/projects",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "key"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$", description: "URL-safe unique project key" },
            description: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      await requireAuth(app, request);
      const body = request.body as { name: string; key: string; description?: string };
      try {
        const project = await db.project.create({
          data: {
            name: body.name,
            key: body.key,
            description: body.description ?? "",
            createdById: authUser(request).sub,
            members: { create: { userId: authUser(request).sub, role: "OWNER" } },
          },
        });
        await audit(app, request, "project.create", "project", project.id, { projectId: project.id });
        return reply.code(201).send({ project });
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "project key already exists" });
        }
        throw err;
      }
    }
  );

  app.get("/projects/:projectId", async (request, reply) => {
    await requireProjectRole(app, request, "VIEWER");
    const { projectId } = request.params as { projectId: string };
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
    });
    if (!project) return reply.code(404).send(notFound());
    return { project };
  });

  app.patch("/projects/:projectId", async (request, reply) => {
    await requireProjectRole(app, request, "ADMIN");
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { name?: string; description?: string };
    const project = await db.project.update({
      where: { id: projectId },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}) },
    }).catch(() => null);
    if (!project) return reply.code(404).send(notFound());
    return { project };
  });

  app.delete("/projects/:projectId", async (request) => {
    await requireProjectRole(app, request, "ADMIN");
    const { projectId } = request.params as { projectId: string };
    await db.project.delete({ where: { id: projectId } }).catch(() => null);
    return { ok: true };
  });

  // ---- members ------------------------------------------------------------
  app.get("/projects/:projectId/members", async (request) => {
    await requireProjectRole(app, request, "VIEWER");
    const { projectId } = request.params as { projectId: string };
    const members = await db.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return { members: members.map((m) => ({ userId: m.userId, role: m.role, user: m.user })) };
  });

  app.post(
    "/projects/:projectId/members",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "role"],
          properties: {
            email: { type: "string", format: "email" },
            role: { enum: ["OWNER", "ADMIN", "EDITOR", "VIEWER"] },
          },
        },
      },
    },
    async (request, reply) => {
      await requireProjectRole(app, request, "ADMIN");
      const { projectId } = request.params as { projectId: string };
      const { email, role } = request.body as { email: string; role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" };
      const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (!user) return reply.code(404).send({ statusCode: 404, error: "NotFound", message: "no user with that email" });
      await db.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        create: { projectId, userId: user.id, role },
        update: { role },
      });
      return reply.code(201).send({ userId: user.id, role });
    }
  );

  app.patch("/projects/:projectId/members/:userId", async (request) => {
    await requireProjectRole(app, request, "ADMIN");
    const { projectId, userId } = request.params as { projectId: string; userId: string };
    const { role } = request.body as { role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" };
    await db.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role },
    });
    return { ok: true };
  });

  app.delete("/projects/:projectId/members/:userId", async (request) => {
    await requireProjectRole(app, request, "ADMIN");
    const { projectId, userId } = request.params as { projectId: string; userId: string };
    await db.projectMember.delete({ where: { projectId_userId: { projectId, userId } } }).catch(() => null);
    return { ok: true };
  });
}

function notFound() {
  return { statusCode: 404, error: "NotFound", message: "project not found" };
}
