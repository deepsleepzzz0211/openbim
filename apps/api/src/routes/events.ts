/**
 * Server-Sent Events for live version status/progress (replaces polling).
 * EventSource cannot send Authorization headers, so the access token is
 * accepted via the `token` query parameter (short-lived JWT).
 */
import { FastifyInstance, FastifyRequest } from "fastify";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/versions/events",
    {
      schema: {
        hide: true,
        querystring: {
          type: "object",
          properties: {
            token: { type: "string", minLength: 16, maxLength: 4096, pattern: "^[A-Za-z0-9-_.]+$" },
            ids: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply) => {
    const { token, ids } = request.query as { token?: string; ids?: string };
    if (!token) {
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "token query parameter required" });
    }
    try {
      app.jwt.verify(token);
    } catch {
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "invalid token" });
    }
    const watched = new Set((ids ?? "").split(",").filter((s) => s.length > 0));

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");

    const send = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const onVersion = (update: { versionId: string; status: string; progress: number }): void => {
      if (watched.size === 0 || watched.has(update.versionId)) send(update);
    };
    app.events.on("version", onVersion);

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 25000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      app.events.off("version", onVersion);
    });
  });
}
