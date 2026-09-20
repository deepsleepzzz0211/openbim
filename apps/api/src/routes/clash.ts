/**
 * Clash detection: axis-aligned bounding box (AABB) overlap test between the
 * elements of two model versions (or within one version), using sweep-and-prune
 * on the X axis so 100k×100k element sets stay tractable.
 *
 * Bboxes were computed by the conversion pipeline in world space (metres, Y-up).
 * A clash requires overlap on all three axes strictly greater than `tolerance`
 * (metres) — touching faces (overlap = 0) are NOT clashes.
 */
import { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth, authUser } from "../auth";

interface Box {
  expressID: number;
  guid: string;
  ifcType: string;
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

interface ClashHit {
  a: { expressID: number; guid: string; type: string; name: string };
  b: { expressID: number; guid: string; type: string; name: string };
  /** overlap extents per axis in metres */
  overlap: [number, number, number];
  /** centre of the overlap box in world metres (Y-up) */
  center: [number, number, number];
  /** overlap volume in m³ */
  volume: number;
}

function parseBox(row: { expressID: number; guid: string; ifcType: string; name: string; bboxJson: string | null }): Box | null {
  if (!row.bboxJson) return null;
  try {
    const v = JSON.parse(row.bboxJson) as number[];
    if (!Array.isArray(v) || v.length !== 6 || v.some((n) => !Number.isFinite(n))) return null;
    return {
      expressID: row.expressID,
      guid: row.guid,
      ifcType: row.ifcType,
      name: row.name,
      min: [v[0], v[1], v[2]],
      max: [v[3], v[4], v[5]],
    };
  } catch {
    return null;
  }
}

/** Parse Version.originJson (absent on legacy rows -> zero offset). */
export function parseOrigin(originJson: string | null): [number, number, number] {
  if (!originJson) return [0, 0, 0];
  try {
    const v = JSON.parse(originJson) as number[];
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(n))) return [0, 0, 0];
    return [v[0], v[1], v[2]];
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Element bboxes live in each version's shifted (GLB) frame. To compare two
 * versions in A's frame, translate B's boxes by the origin delta, exactly like
 * the federated viewer re-positions models.
 */
export function translateBoxes(boxes: Box[], delta: [number, number, number]): Box[] {
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return boxes;
  return boxes.map((b) => ({
    ...b,
    min: [b.min[0] + delta[0], b.min[1] + delta[1], b.min[2] + delta[2]] as [number, number, number],
    max: [b.max[0] + delta[0], b.max[1] + delta[1], b.max[2] + delta[2]] as [number, number, number],
  }));
}

/** Sweep-and-prune on X, full test on Y/Z. Complexity ≈ O(n log n + k). */
function findClashes(a: Box[], b: Box[], tolerance: number, sameModel: boolean): ClashHit[] {
  const sortedB = [...b].sort((p, q) => p.min[0] - q.min[0]);
  const bMinX = sortedB.map((box) => box.min[0]);
  const hits: ClashHit[] = [];

  const lowerBound = (value: number): number => {
    let lo = 0;
    let hi = bMinX.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bMinX[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (const boxA of a) {
    if (boxA.min[0] === Infinity) continue;
    // every box in B whose minX <= boxA.maxX + tolerance may overlap on X
    let hi = sortedB.length;
    {
      // upper bound search: first index with minX > boxA.maxX + tolerance
      let lo = 0;
      let high = sortedB.length;
      const limit = boxA.max[0] + tolerance;
      while (lo < high) {
        const mid = (lo + high) >> 1;
        if (bMinX[mid] <= limit) lo = mid + 1;
        else high = mid;
      }
      hi = lo;
    }
    for (let idx = lowerBound(boxA.min[0] - tolerance); idx < hi; idx++) {
      const boxB = sortedB[idx];
      if (sameModel && boxA.expressID === boxB.expressID) continue;
      const ox = Math.min(boxA.max[0], boxB.max[0]) - Math.max(boxA.min[0], boxB.min[0]);
      if (ox <= tolerance) continue;
      const oy = Math.min(boxA.max[1], boxB.max[1]) - Math.max(boxA.min[1], boxB.min[1]);
      if (oy <= tolerance) continue;
      const oz = Math.min(boxA.max[2], boxB.max[2]) - Math.max(boxA.min[2], boxB.min[2]);
      if (oz <= tolerance) continue;
      hits.push({
        a: { expressID: boxA.expressID, guid: boxA.guid, type: boxA.ifcType, name: boxA.name },
        b: { expressID: boxB.expressID, guid: boxB.guid, type: boxB.ifcType, name: boxB.name },
        overlap: [ox, oy, oz],
        center: [
          Math.max(boxA.min[0], boxB.min[0]) + ox / 2,
          Math.max(boxA.min[1], boxB.min[1]) + oy / 2,
          Math.max(boxA.min[2], boxB.min[2]) + oz / 2,
        ],
        volume: ox * oy * oz,
      });
    }
  }
  return hits;
}

async function assertVersionAccess(app: FastifyInstance, request: FastifyRequest, versionId: string): Promise<string> {
  const version = await app.db.version.findUnique({
    where: { id: versionId },
    select: { model: { select: { projectId: true } } },
  });
  const projectId = version?.model.projectId;
  if (!projectId) throw Object.assign(new Error("version not found"), { statusCode: 404 });
  const user = authUser(request);
  const membership = await app.db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.sub } },
  });
  if (!membership && user.platformRole !== "ADMIN") {
    throw Object.assign(new Error("not a project member"), { statusCode: 403 });
  }
  return projectId;
}

export async function clashRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/clash-detection",
    {
      schema: {
        body: {
          type: "object",
          required: ["versionAId", "versionBId"],
          properties: {
            versionAId: { type: "string" },
            versionBId: { type: "string" },
            /** minimum overlap depth (metres) to count as a clash; touching faces are ignored */
            tolerance: { type: "number", minimum: 0, maximum: 5 },
            maxResults: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (request, _reply) => {
      await requireAuth(app, request);
      const body = request.body as { versionAId: string; versionBId: string; tolerance?: number; maxResults?: number };
      const tolerance = body.tolerance ?? 0.01;
      const maxResults = body.maxResults ?? 200;

      const projectIdA = await assertVersionAccess(app, request, body.versionAId);
      const projectIdB = await assertVersionAccess(app, request, body.versionBId);

      const [vA, vB] = await Promise.all([
        app.db.version.findUnique({ where: { id: body.versionAId }, select: { originJson: true } }),
        app.db.version.findUnique({ where: { id: body.versionBId }, select: { originJson: true } }),
      ]);
      const originA = parseOrigin(vA?.originJson ?? null);
      const originB = parseOrigin(vB?.originJson ?? null);
      const originDelta: [number, number, number] = [originB[0] - originA[0], originB[1] - originA[1], originB[2] - originA[2]];

      const rowsA = await app.db.element.findMany({
        where: { versionId: body.versionAId, bboxJson: { not: null } },
        select: { expressID: true, guid: true, ifcType: true, name: true, bboxJson: true },
      });
      const rowsB = await app.db.element.findMany({
        where: { versionId: body.versionBId, bboxJson: { not: null } },
        select: { expressID: true, guid: true, ifcType: true, name: true, bboxJson: true },
      });
      const boxesA = rowsA.map(parseBox).filter((b): b is Box => b !== null);
      const boxesB = translateBoxes(rowsB.map(parseBox).filter((b): b is Box => b !== null), originDelta);

      const hits = findClashes(boxesA, boxesB, tolerance, body.versionAId === body.versionBId);
      hits.sort((p, q) => q.volume - p.volume);

      return {
        summary: {
          checkedA: boxesA.length,
          checkedB: boxesB.length,
          clashes: hits.length,
          returned: Math.min(hits.length, maxResults),
          tolerance,
          originDelta,
        },
        clashes: hits.slice(0, maxResults),
        projectIds: { a: projectIdA, b: projectIdB },
      };
    }
  );
}
