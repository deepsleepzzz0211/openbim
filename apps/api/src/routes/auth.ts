import { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword, newRefreshToken, hashToken, requireAuth, authUser, audit } from "../auth";

const credentialsSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8, maxLength: 128 },
  },
} as const;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.post(
    "/auth/register",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["email", "name", "password"],
          properties: {
            email: { type: "string", format: "email" },
            name: { type: "string", minLength: 1, maxLength: 100 },
            password: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, name, password } = request.body as { email: string; name: string; password: string };
      const normalizedEmail = email.trim().toLowerCase();
      const existing = await db.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "email already registered" });
      }
      const isFirstUser = (await db.user.count()) === 0;
      const user = await db.user.create({
        data: {
          email: normalizedEmail,
          name,
          passwordHash: await hashPassword(password),
          role: isFirstUser ? "ADMIN" : "USER",
        },
      });
      const accessToken = app.jwt.sign({ sub: user.id, email: user.email, platformRole: user.role });
      const { refreshToken, expiresAt } = await createRefreshToken(app, user.id);
      await audit(app, request, "user.register", "user", user.id);
      return reply.code(201).send({ accessToken, refreshToken, expiresAt, user: publicUser(user) });
    }
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { body: credentialsSchema } },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };
      const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "invalid credentials" });
      }
      const accessToken = app.jwt.sign({ sub: user.id, email: user.email, platformRole: user.role });
      const { refreshToken, expiresAt } = await createRefreshToken(app, user.id);
      await audit(app, request, "user.login", "user", user.id);
      return reply.send({ accessToken, refreshToken, expiresAt, user: publicUser(user) });
    }
  );

  app.post(
    "/auth/refresh",
    { schema: { body: { type: "object", required: ["refreshToken"], properties: { refreshToken: { type: "string" } } } } },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      const tokenHash = hashToken(refreshToken);
      const stored = await db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "invalid refresh token" });
      }
      // rotate
      await db.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      const accessToken = app.jwt.sign({ sub: stored.user.id, email: stored.user.email, platformRole: stored.user.role });
      const fresh = await createRefreshToken(app, stored.user.id);
      return reply.send({ accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt, user: publicUser(stored.user) });
    }
  );

  app.post(
    "/auth/logout",
    { schema: { body: { type: "object", required: ["refreshToken"], properties: { refreshToken: { type: "string" } } } } },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string };
      await db.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true };
    }
  );

  app.get("/auth/me", async (request) => {
    await requireAuth(app, request);
    const user = await db.user.findUnique({ where: { id: authUser(request).sub } });
    return { user: publicUser(user!) };
  });
}

function publicUser(user: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}

async function createRefreshToken(app: FastifyInstance, userId: string) {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + app.config.refreshTokenDays * 24 * 3600 * 1000);
  await app.db.refreshToken.create({
    data: { userId, tokenHash: hashToken(refreshToken), expiresAt },
  });
  return { refreshToken, expiresAt };
}
