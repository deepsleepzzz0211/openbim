/**
 * BCF 2.1 (BIM Collaboration Format) writer.
 *
 * Produces a valid BCF 2.1 zip: `bcf.version`, `extensions.xml`,
 * `project.bcfp` and one folder per topic containing `markup.bcf`,
 * plus `viewpoint.bcfv` + `snapshot.png` when a viewpoint is provided.
 */
import JSZip from "jszip";

export * from "./reader";

export type IssuePriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type IssueStatus = "OPEN" | "CLOSED";

export interface BcfComment {
  guid: string;
  author: string;
  date: Date;
  body: string;
}

export interface BcfViewpointCamera {
  /** camera eye position in metres */
  viewPoint: [number, number, number];
  viewUp?: [number, number, number];
  viewDirection?: [number, number, number];
  /** vertical field of view in degrees (BCF uses 45..60 typically) */
  fieldOfView?: number;
}

export interface BcfTopicViewpoint {
  guid: string;
  camera: BcfViewpointCamera;
  /** PNG bytes (JPEG also allowed by the spec; we always emit PNG) */
  snapshot?: Uint8Array | null;
  /** selected component GlobalIds carried in the viewpoint */
  selected?: string[];
}

export interface BcfTopic {
  guid: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  author: string;
  createdAt: Date;
  comments: BcfComment[];
  viewpoint?: BcfTopicViewpoint | null;
}

export interface BcfProjectInfo {
  projectId: string;
  name: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const iso = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

/** Priority names accepted by BCF 2.1 extensions.xml (lowercase). */
const PRIORITY_TO_BCF: Record<IssuePriority, string> = {
  LOW: "minor",
  NORMAL: "normal",
  HIGH: "major",
  CRITICAL: "critical",
};

const PRIORITY_FROM_BCF: Record<string, IssuePriority> = {
  minor: "LOW",
  normal: "NORMAL",
  major: "HIGH",
  critical: "CRITICAL",
};

/** Map our enum onto the BCF priority string used in extensions.xml and markup. */
export function priorityToBcf(priority: IssuePriority): string {
  return PRIORITY_TO_BCF[priority];
}

/** Map a free-form BCF priority string onto our enum (unknown values -> NORMAL). */
export function priorityFromBcf(value: string | undefined): IssuePriority {
  if (!value) return "NORMAL";
  return PRIORITY_FROM_BCF[value.toLowerCase()] ?? "NORMAL";
}

/** Map our IssueStatus onto a BCF TopicStatus string. */
export function statusToBcf(status: IssueStatus): string {
  return status === "CLOSED" ? "closed" : "open";
}

/** Map a BCF TopicStatus string onto our enum (unknown values -> OPEN). */
export function statusFromBcf(value: string | undefined): IssueStatus {
  return value?.toLowerCase() === "closed" ? "CLOSED" : "OPEN";
}

function versionXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" DetailedVersion="2.1"/>
`;
}

function extensionsXml(topics: BcfTopic[]): string {
  const priorities = [...new Set(topics.map((t) => PRIORITY_TO_BCF[t.priority]))];
  const topicStatuses = [...new Set(topics.map((t) => statusToBcf(t.status)))];
  if (priorities.length === 0) priorities.push("normal");
  if (topicStatuses.length === 0) topicStatuses.push("open");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Extensions>
	<Priority>${priorities.map((p) => `<Priority>${esc(p)}</Priority>`).join("")}</Priority>
	<TopicStatus>${topicStatuses.map((s) => `<TopicStatus>${esc(s)}</TopicStatus>`).join("")}</TopicStatus>
	<TopicType>Undefined</TopicType>
	<TopicSubType>Undefined</TopicSubType>
	<Label></Label>
	<UserGroup></UserGroup>
</Extensions>
`;
}

function projectXml(info: BcfProjectInfo): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Project ExtensionId="bcf.project" ProjectId="${esc(info.projectId)}" Name="${esc(info.name)}"/>
`;
}

function viewpointXml(vp: BcfTopicViewpoint): string {
  const c = vp.camera;
  const components =
    vp.selected && vp.selected.length > 0
      ? `	<Components>
		<ViewSetupHints SpaceVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false"/>
		<Selection>
			<Component>${vp.selected
              .map((g) => `<IfcGuid>${esc(g)}</IfcGuid>`)
              .join("")}</Component>
		</Selection>
		<Visibility DefaultVisibility="true"/>
	</Components>
`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${esc(vp.guid)}">
	<PerspectiveCamera>
		<ViewPoint>${c.viewPoint.map((v) => v.toFixed(6)).join(",")}</ViewPoint>
		<ViewUp>${(c.viewUp ?? [0, 1, 0]).map((v) => v.toFixed(6)).join(",")}</ViewUp>
		<ViewDirection>${(c.viewDirection ?? [0, 0, -1]).map((v) => v.toFixed(6)).join(",")}</ViewDirection>
		<FieldOfView>${(c.fieldOfView ?? 60).toFixed(1)}</FieldOfView>
		<AspectRatio>1.0</AspectRatio>
	</PerspectiveCamera>
${components}</VisualizationInfo>
`;
}

function markupXml(topic: BcfTopic): { xml: string; viewpointGuid: string | null } {
  const viewpointGuid = topic.viewpoint?.guid ?? null;
  const comments = topic.comments
    .map(
      (c, i) => `	<Comment Guid="${esc(c.guid)}">
		<Date>${iso(c.date)}</Date>
		<Author>${esc(c.author)}</Author>
		<Comment>${esc(c.body)}</Comment>
		${viewpointGuid && i === 0 ? `<Viewpoint Guid="${esc(viewpointGuid)}"/>` : ""}
		<EditDate>${iso(c.date)}</EditDate>
	</Comment>`
    )
    .join("\n");
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
	<Topic Guid="${esc(topic.guid)}" TopicType="Undefined" TopicStatus="${esc(statusToBcf(topic.status))}">
		<Title>${esc(topic.title)}</Title>
		<Priority>${esc(PRIORITY_TO_BCF[topic.priority])}</Priority>
		<Index>1</Index>
		<CreationDate>${iso(topic.createdAt)}</CreationDate>
		<CreationAuthor>${esc(topic.author)}</CreationAuthor>
		<Description>${esc(topic.description)}</Description>
	</Topic>
${comments}
</Markup>
`,
    viewpointGuid,
  };
}

/** Build a BCF 2.1 zip buffer from project info and topics. */
export async function buildBcfZip(
  project: BcfProjectInfo,
  topics: BcfTopic[]
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("bcf.version", versionXml());
  zip.file("extensions.xml", extensionsXml(topics));
  zip.file("project.bcfp", projectXml(project));
  for (const topic of topics) {
    const { xml } = markupXml(topic);
    zip.file(`${topic.guid.toLowerCase()}/markup.bcf`, xml);
    if (topic.viewpoint) {
      zip.file(`${topic.guid.toLowerCase()}/viewpoint.bcfv`, viewpointXml(topic.viewpoint));
      if (topic.viewpoint.snapshot && topic.viewpoint.snapshot.byteLength > 0) {
        zip.file(`${topic.guid.toLowerCase()}/snapshot.png`, topic.viewpoint.snapshot);
      }
    }
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
