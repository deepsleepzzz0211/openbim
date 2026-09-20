import * as crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { FastifyInstance, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { Db } from "./db";

export const ROLE_ORDER = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 } as const;
export type ProjectRoleName = keyof typeof ROLE_ORDER;

export interface AuthUser {
  sub: string;
  email: string;
  platformRole: string;
}

declare module "fastify" {
  interface FastifyRequest {
    projectRole?: string;
  }
}

/** Narrow the JWT payload attached by @fastify/jwt. */
export function authUser(request: FastifyRequest): AuthUser {
  const u = request.user as unknown;
  if (typeof u === "object" && u !== null && "sub" in (u as Record<string, unknown>)) {
    return u as AuthUser;
  }
  throw Object.assign(new Error("missing or invalid access token"), { statusCode: 401 });
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function newRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function issueGuid(): string {
  // Random 22-char IFC-style guid (base64 variant, first char 0-3).
  const bytes = crypto.randomBytes(16);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  let out = "";
  out += alphabet[(bytes[0] >> 2) & 0x3f];
  out += alphabet[(bytes[0] & 0x3) << 4];
  for (let i = 1; i < 16; i += 3) {
    const b = bytes[i], c = bytes[i + 1], d = bytes[i + 2];
    out += alphabet[(b >> 2) & 0x3f];
    out += alphabet[((b & 0x3) << 4) | ((c >> 4) & 0xf)];
    out += alphabet[((c & 0xf) << 2) | ((d >> 6) & 0x3)];
    out += alphabet[d & 0x3f];
  }
  return out;
}

export function registerAuth(app: FastifyInstance, opts: { secret: string; accessTokenTtl: string }): void {
  app.register(fastifyJwt, {
    secret: opts.secret,
    sign: { expiresIn: opts.accessTokenTtl },
  });
}

/** Verify the bearer token and populate request.user. Throws 401 on failure. */
export async function requireAuth(app: FastifyInstance, request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw Object.assign(new Error("missing or invalid access token"), { statusCode: 401 });
  }
}

/**
 * Verify the token and the caller's project membership (resolving the project
 * from projectId / modelId / versionId / issueId path params as available).
 * Platform admins bypass membership checks.
 */
export async function requireProjectRole(
  app: FastifyInstance,
  request: FastifyRequest,
  minRole: ProjectRoleName
): Promise<void> {
  await requireAuth(app, request);
  const params = request.params as {
    projectId?: string;
    modelId?: string;
    versionId?: string;
    issueId?: string;
  };
  const db = app.db as Db;
  let projectId: string | undefined = params.projectId;
  if (!projectId && params.modelId) {
    const model = await db.model.findUnique({ where: { id: params.modelId }, select: { projectId: true } });
    projectId = model?.projectId;
  }
  if (!projectId && params.versionId) {
    const version = await db.version.findUnique({
      where: { id: params.versionId },
      select: { model: { select: { projectId: true } } },
    });
    projectId = version?.model.projectId;
  }
  if (!projectId && params.issueId) {
    const issue = await db.issue.findUnique({ where: { id: params.issueId }, select: { projectId: true } });
    projectId = issue?.projectId;
  }
  if (!projectId) {
    throw Object.assign(new Error("project not found"), { statusCode: 404 });
  }
  const user = authUser(request);
  const membership = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.sub } },
  });
  if (!membership) {
    if (user.platformRole === "ADMIN") {
      request.projectRole = "OWNER";
      return;
    }
    throw Object.assign(new Error("not a project member"), { statusCode: 403 });
  }
  if (ROLE_ORDER[membership.role as ProjectRoleName] < ROLE_ORDER[minRole]) {
    throw Object.assign(new Error(`requires ${minRole} role or higher`), { statusCode: 403 });
  }
  request.projectRole = membership.role;
}

/** Append an audit trail entry (best-effort; never blocks the request). */
export async function audit(
  app: FastifyInstance,
  request: FastifyRequest,
  action: string,
  entity: string,
  entityId: string,
  extra?: { projectId?: string; meta?: Record<string, unknown> }
): Promise<void> {
  try {
    const user = request.user ? authUser(request) : null;
    await (app.db as Db).auditLog.create({
      data: {
        userId: user?.sub ?? null,
        action,
        entity,
        entityId,
        projectId: extra?.projectId ?? null,
        metaJson: extra?.meta ? JSON.stringify(extra.meta) : null,
        ip: request.ip,
      },
    });
  } catch {
    // audit is best-effort
  }
}
