/**
 * Version diff: compares two versions element-by-element using the IFC GlobalId
 * as the stable identity (expressIDs are not stable across exports).
 * Change detection covers type, name and property-set content (pset hash).
 */
import * as crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { requireAuth, authUser } from "../auth";

interface ElementRow {
  guid: string;
  expressID: number;
  ifcType: string;
  name: string;
  storeyGuid: string | null;
  psetsJson: string | null;
}

export interface DiffEntry {
  guid: string;
  a?: { expressID: number; type: string; name: string };
  b?: { expressID: number; type: string; name: string };
  changes?: string[];
}

export function diffElements(rowsA: ElementRow[], rowsB: ElementRow[]): {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  unchanged: number;
} {
  const mapA = new Map<string, ElementRow>();
  for (const r of rowsA) mapA.set(r.guid, r);
  const mapB = new Map<string, ElementRow>();
  for (const r of rowsB) mapB.set(r.guid, r);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let unchanged = 0;

  for (const [guid, rowB] of mapB) {
    const rowA = mapA.get(guid);
    if (!rowA) {
      added.push({ guid, b: { expressID: rowB.expressID, type: rowB.ifcType, name: rowB.name } });
      continue;
    }
    const changes: string[] = [];
    if (rowA.ifcType !== rowB.ifcType) changes.push("type");
    if (rowA.name !== rowB.name) changes.push("name");
    if (hash(rowA.psetsJson) !== hash(rowB.psetsJson)) changes.push("psets");
    if (rowA.storeyGuid !== rowB.storeyGuid) changes.push("storey");
    if (changes.length > 0) {
      changed.push({
        guid,
        a: { expressID: rowA.expressID, type: rowA.ifcType, name: rowA.name },
        b: { expressID: rowB.expressID, type: rowB.ifcType, name: rowB.name },
        changes,
      });
    } else {
      unchanged++;
    }
  }
  for (const [guid, rowA] of mapA) {
    if (!mapB.has(guid)) {
      removed.push({ guid, a: { expressID: rowA.expressID, type: rowA.ifcType, name: rowA.name } });
    }
  }
  return { added, removed, changed, unchanged };
}

function hash(json: string | null): string {
  return crypto.createHash("sha1").update(json ?? "").digest("hex");
}

async function loadRows(app: FastifyInstance, versionId: string): Promise<ElementRow[]> {
  return app.db.element.findMany({
    where: { versionId },
    select: { guid: true, expressID: true, ifcType: true, name: true, storeyGuid: true, psetsJson: true },
  });
}

async function assertVersionAccess(app: FastifyInstance, request: Parameters<typeof requireAuth>[1], versionId: string): Promise<void> {
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
}

export async function diffRoutes(app: FastifyInstance): Promise<void> {
  app.get("/versions/:versionAId/diff/:versionBId", async (request) => {
    await requireAuth(app, request);
    const { versionAId, versionBId } = request.params as { versionAId: string; versionBId: string };
    await assertVersionAccess(app, request, versionAId);
    await assertVersionAccess(app, request, versionBId);

    const [rowsA, rowsB] = await Promise.all([loadRows(app, versionAId), loadRows(app, versionBId)]);
    const result = diffElements(rowsA, rowsB);

    const cap = (arr: DiffEntry[]) => ({ total: arr.length, items: arr.slice(0, 200) });
    return {
      added: cap(result.added),
      removed: cap(result.removed),
      changed: cap(result.changed),
      unchanged: result.unchanged,
    };
  });
}
