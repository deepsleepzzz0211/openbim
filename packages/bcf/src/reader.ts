/**
 * BCF 2.1/3.0 reader — parses a bcfzip into structured topics.
 * Viewpoints (camera) and snapshots are extracted when present.
 */
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export interface BcfCamera {
  viewPoint: [number, number, number];
  viewUp?: [number, number, number];
  viewDirection?: [number, number, number];
  fieldOfView?: number;
}

export interface BcfViewpoint {
  guid: string;
  camera: BcfCamera;
  snapshot?: Uint8Array | null;
}

export interface BcfImportedComment {
  guid: string;
  author: string;
  date: Date;
  body: string;
  viewpointGuid?: string | null;
}

export interface BcfImportedTopic {
  guid: string;
  title: string;
  description: string;
  status?: string;
  priority?: string;
  author: string;
  createdAt: Date;
  comments: BcfImportedComment[];
  viewpoint: BcfViewpoint | null;
}

export interface BcfFile {
  version: string;
  projectName?: string;
  projectId?: string;
  topics: BcfImportedTopic[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
});

const ensureArray = <T,>(v: T | T[] | undefined): T[] => {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
};

const num3 = (v: unknown): [number, number, number] | undefined => {
  const s = typeof v === "string" ? v.split(",").map(Number) : [];
  if (s.length >= 3 && s.every((n) => Number.isFinite(n))) {
    return [s[0], s[1], s[2]];
  }
  return undefined;
};

/** Read a BCF zip and return its topics (markup + viewpoints + snapshots). */
export async function parseBcfZip(data: Uint8Array | Buffer): Promise<BcfFile> {
  const zip = await JSZip.loadAsync(data);
  const out: BcfFile = { version: "2.1", topics: [] };

  const versionFile = zip.file("bcf.version");
  if (versionFile) {
    const xml = parser.parse(await versionFile.async("string"));
    out.version = String(xml.Version?.["@VersionId"] ?? "2.1");
  }
  const projectFile = zip.file("project.bcfp");
  if (projectFile) {
    const xml = parser.parse(await projectFile.async("string"));
    out.projectId = xml.Project?.["@ProjectId"];
    out.projectName = xml.Project?.["@Name"];
  }

  // viewpoints: <topicGuid>/viewpoint.bcfv (+ snapshot.<ext>)
  const viewpoints = new Map<string, BcfViewpoint>();
  for (const entry of Object.keys(zip.files)) {
    if (!entry.toLowerCase().endsWith("viewpoint.bcfv")) continue;
    const topicGuid = entry.split("/")[0];
    const xml = parser.parse(await zip.file(entry)!.async("string"));
    const visInfo = xml.VisualizationInfo ?? {};
    const cam = visInfo.PerspectiveCamera ?? {};
    const camera: BcfCamera | undefined =
      num3(cam.ViewPoint) !== undefined
        ? {
            viewPoint: num3(cam.ViewPoint)!,
            viewUp: num3(cam.ViewUp),
            viewDirection: num3(cam.ViewDirection),
            fieldOfView: typeof cam.FieldOfView === "string" ? Number(cam.FieldOfView) : undefined,
          }
        : undefined;
    if (!camera) continue;
    const guid = String(visInfo["@Guid"] ?? topicGuid);
    let snapshot: Uint8Array | null = null;
    const snapshotEntry = Object.keys(zip.files).find((k) =>
      k.toLowerCase().startsWith(`${topicGuid.toLowerCase()}/snapshot.`)
    );
    if (snapshotEntry) {
      snapshot = await zip.file(snapshotEntry)!.async("uint8array");
    }
    viewpoints.set(guid, { guid, camera, snapshot });
    // also index by topic folder for markups that reference the topic's own viewpoint
    if (!viewpoints.has(`topic:${topicGuid}`)) {
      viewpoints.set(`topic:${topicGuid}`, { guid, camera, snapshot });
    }
  }

  for (const entry of Object.keys(zip.files)) {
    if (!entry.toLowerCase().endsWith("markup.bcf")) continue;
    const topicGuid = entry.split("/")[0];
    const xml = parser.parse(await zip.file(entry)!.async("string"));
    const markup = xml.Markup ?? {};
    const topic = markup.Topic ?? {};
    const comments = ensureArray<any>(markup.Comment).map((c) => ({
      guid: String(c["@Guid"] ?? ""),
      author: String(c.Author ?? ""),
      date: new Date(c.Date ?? Date.now()),
      body: String(c.Comment ?? ""),
      viewpointGuid: c.Viewpoint?.["@Guid"] ?? null,
    }));
    // resolve topic viewpoint: referenced by a comment, or the folder's own viewpoint
    let viewpoint: BcfViewpoint | null = null;
    const refGuid = comments.find((c) => c.viewpointGuid)?.viewpointGuid;
    if (refGuid && viewpoints.has(refGuid)) {
      viewpoint = viewpoints.get(refGuid)!;
    } else if (viewpoints.has(`topic:${topicGuid}`)) {
      viewpoint = viewpoints.get(`topic:${topicGuid}`)!;
    }

    out.topics.push({
      guid: String(topic["@Guid"] ?? topicGuid),
      title: String(topic.Title ?? "(untitled)"),
      description: String(topic.Description ?? ""),
      status: topic["@TopicStatus"] ?? undefined,
      priority: topic.Priority ?? undefined,
      author: String(topic.CreationAuthor ?? ""),
      createdAt: new Date(topic.CreationDate ?? Date.now()),
      comments,
      viewpoint,
    });
  }

  return out;
}
