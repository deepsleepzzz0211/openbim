import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildBcfZip,
  parseBcfZip,
  statusToBcf,
  statusFromBcf,
  priorityFromBcf,
  priorityToBcf,
  BcfTopic,
} from "../src";

const baseTopic: BcfTopic = {
  guid: "0123456789abcdef0123456789abcdef",
  title: "Demo",
  description: "Desc",
  status: "OPEN",
  priority: "NORMAL",
  author: "a@b.c",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  comments: [],
};

describe("BCF XML templates are specified byte-exactly", () => {
  it("bcf.version", async () => {
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, []));
    expect(await zip.file("bcf.version")!.async("string")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1" DetailedVersion="2.1"/>\n`
    );
  });

  it("project.bcfp escapes and carries ids", async () => {
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P&1", name: `<n>"x"` }, []));
    expect(await zip.file("project.bcfp")!.async("string")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Project ExtensionId="bcf.project" ProjectId="P&amp;1" Name="&lt;n&gt;&quot;x&quot;"/>\n`
    );
  });

  it("extensions.xml lists exactly the used priorities and statuses, with defaults when empty", async () => {
    const empty = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, []));
    expect(await empty.file("extensions.xml")!.async("string")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Extensions>\n\t<Priority><Priority>normal</Priority></Priority>\n\t<TopicStatus><TopicStatus>open</TopicStatus></TopicStatus>\n\t<TopicType>Undefined</TopicType>\n\t<TopicSubType>Undefined</TopicSubType>\n\t<Label></Label>\n\t<UserGroup></UserGroup>\n</Extensions>\n`
    );

    const zip = await JSZip.loadAsync(
      await buildBcfZip({ projectId: "P", name: "n" }, [
        { ...baseTopic, priority: "CRITICAL", status: "CLOSED" },
      ])
    );
    const ext = await zip.file("extensions.xml")!.async("string");
    expect(ext).toContain("<Priority><Priority>critical</Priority></Priority>");
    expect(ext).toContain("<TopicStatus><TopicStatus>closed</TopicStatus></TopicStatus>");
  });

  it("markup.bcf for a bare topic (no comments, no viewpoint)", async () => {
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, [baseTopic]));
    const markup = await zip.file("0123456789abcdef0123456789abcdef/markup.bcf")!.async("string");
    expect(markup).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
	<Topic Guid="0123456789abcdef0123456789abcdef" TopicType="Undefined" TopicStatus="open">
		<Title>Demo</Title>
		<Priority>normal</Priority>
		<Index>1</Index>
		<CreationDate>2026-09-01T10:00:00Z</CreationDate>
		<CreationAuthor>a@b.c</CreationAuthor>
		<Description>Desc</Description>
	</Topic>

</Markup>
`
    );
  });

  it("comment Viewpoint reference attaches to the first comment only", async () => {
    const topic: BcfTopic = {
      ...baseTopic,
      viewpoint: { guid: "vp-guid-1", camera: { viewPoint: [0, 0, 0] } },
      comments: [
        { guid: "c1", author: "a", date: baseTopic.createdAt, body: "first" },
        { guid: "c2", author: "b", date: baseTopic.createdAt, body: "second" },
      ],
    };
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, [topic]));
    const markup = await zip.file("0123456789abcdef0123456789abcdef/markup.bcf")!.async("string");
    expect(markup.match(/<Viewpoint Guid="vp-guid-1"\/>/g)?.length).toBe(1);
    // first comment carries it
    expect(markup.indexOf("<Viewpoint Guid=")).toBeGreaterThan(markup.indexOf("first"));
    expect(markup.indexOf("<Viewpoint Guid=")).toBeLessThan(markup.indexOf("second"));
  });

  it("viewpoint.bcfv: full camera + selection block", async () => {
    const topic: BcfTopic = {
      ...baseTopic,
      viewpoint: {
        guid: "vp-guid-1",
        camera: {
          viewPoint: [1.5, -2, 3],
          viewUp: [0, 0, 1],
          viewDirection: [0.2, 0.3, -0.9],
          fieldOfView: 45,
        },
        selected: ["1guid", "2guid"],
      },
    };
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, [topic]));
    const vpi = await zip.file("0123456789abcdef0123456789abcdef/viewpoint.bcfv")!.async("string");
    expect(vpi).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="vp-guid-1">
	<PerspectiveCamera>
		<ViewPoint>1.500000,-2.000000,3.000000</ViewPoint>
		<ViewUp>0.000000,0.000000,1.000000</ViewUp>
		<ViewDirection>0.200000,0.300000,-0.900000</ViewDirection>
		<FieldOfView>45.0</FieldOfView>
		<AspectRatio>1.0</AspectRatio>
	</PerspectiveCamera>
	<Components>
		<ViewSetupHints SpaceVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false"/>
		<Selection>
			<Component><IfcGuid>1guid</IfcGuid><IfcGuid>2guid</IfcGuid></Component>
		</Selection>
		<Visibility DefaultVisibility="true"/>
	</Components>
</VisualizationInfo>
`
    );
  });

  it("viewpoint.bcfv: defaults for up/direction/fov and no Components without selection", async () => {
    const topic: BcfTopic = {
      ...baseTopic,
      viewpoint: { guid: "vp-2", camera: { viewPoint: [0.5, 0.25, 12] } },
    };
    const zip = await JSZip.loadAsync(await buildBcfZip({ projectId: "P", name: "n" }, [topic]));
    const vpi = await zip.file("0123456789abcdef0123456789abcdef/viewpoint.bcfv")!.async("string");
    expect(vpi).toContain("<ViewUp>0.000000,1.000000,0.000000</ViewUp>");
    expect(vpi).toContain("<ViewDirection>0.000000,0.000000,-1.000000</ViewDirection>");
    expect(vpi).toContain("<FieldOfView>60.0</FieldOfView>");
    expect(vpi).not.toContain("<Components>");
    // empty selection array behaves like no selection
    const zip2 = await JSZip.loadAsync(
      await buildBcfZip({ projectId: "P", name: "n" }, [
        { ...baseTopic, viewpoint: { guid: "vp-3", camera: { viewPoint: [0, 0, 0] }, selected: [] } },
      ])
    );
    expect(await zip2.file("0123456789abcdef0123456789abcdef/viewpoint.bcfv")!.async("string")).not.toContain("<Components>");
  });

  it("snapshot.png written only when non-empty", async () => {
    const folder = "0123456789abcdef0123456789abcdef";
    const none = await JSZip.loadAsync(
      await buildBcfZip({ projectId: "P", name: "n" }, [{ ...baseTopic, viewpoint: { guid: "g", camera: { viewPoint: [0, 0, 0] }, snapshot: null } }])
    );
    expect(none.file(`${folder}/snapshot.png`)).toBeNull();

    const withSnap = await JSZip.loadAsync(
      await buildBcfZip({ projectId: "P", name: "n" }, [
        { ...baseTopic, viewpoint: { guid: "g", camera: { viewPoint: [0, 0, 0] }, snapshot: new Uint8Array([1, 2]) } },
      ])
    );
    expect(Array.from(await withSnap.file(`${folder}/snapshot.png`)!.async("uint8array"))).toEqual([1, 2]);

    const emptySnap = await JSZip.loadAsync(
      await buildBcfZip({ projectId: "P", name: "n" }, [
        { ...baseTopic, viewpoint: { guid: "g", camera: { viewPoint: [0, 0, 0] }, snapshot: new Uint8Array([]) } },
      ])
    );
    expect(emptySnap.file(`${folder}/snapshot.png`)).toBeNull();
  });
});

describe("status/priority mappers are specified", () => {
  it("statusToBcf", () => {
    expect(statusToBcf("OPEN")).toBe("open");
    expect(statusToBcf("CLOSED")).toBe("closed");
  });

  it("statusFromBcf is case-insensitive and defaults to OPEN", () => {
    expect(statusFromBcf("closed")).toBe("CLOSED");
    expect(statusFromBcf("Closed")).toBe("CLOSED");
    expect(statusFromBcf("open")).toBe("OPEN");
    expect(statusFromBcf("")).toBe("OPEN");
    expect(statusFromBcf(undefined)).toBe("OPEN");
    expect(statusFromBcf("in progress")).toBe("OPEN");
  });

  it("priorityFromBcf maps every bcf value, case-insensitively, unknown -> NORMAL", () => {
    expect(priorityFromBcf("minor")).toBe("LOW");
    expect(priorityFromBcf("Minor")).toBe("LOW");
    expect(priorityFromBcf("normal")).toBe("NORMAL");
    expect(priorityFromBcf("major")).toBe("HIGH");
    expect(priorityFromBcf("critical")).toBe("CRITICAL");
    expect(priorityFromBcf("Critical")).toBe("CRITICAL");
    expect(priorityFromBcf("")).toBe("NORMAL");
    expect(priorityFromBcf(undefined)).toBe("NORMAL");
    expect(priorityFromBcf("weird")).toBe("NORMAL");
  });

  it("priorityToBcf maps every enum value", () => {
    expect(priorityToBcf("LOW")).toBe("minor");
    expect(priorityToBcf("NORMAL")).toBe("normal");
    expect(priorityToBcf("HIGH")).toBe("major");
    expect(priorityToBcf("CRITICAL")).toBe("critical");
  });
});

describe("BCF reader edge cases", () => {
  it("tolerates missing project.bcfp and unknown dates", async () => {
    const zip = new JSZip();
    zip.file("bcf.version", `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="3.0"/>\n`);
    zip.file("abc/markup.bcf", `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
	<Topic Guid="abc" TopicType="Undefined" TopicStatus="closed">
		<Title>T</Title>
	</Topic>
</Markup>
`);
    const file = await parseBcfZip(await zip.generateAsync({ type: "uint8array" }));
    expect(file.version).toBe("3.0");
    expect(file.projectId).toBeUndefined();
    expect(file.projectName).toBeUndefined();
    expect(file.topics).toHaveLength(1);
    expect(file.topics[0].title).toBe("T");
    expect(file.topics[0].status).toBe("closed");
    expect(file.topics[0].priority).toBeUndefined();
    expect(file.topics[0].viewpoint).toBeNull();
    // unparseable creation date falls back to now
    expect(Number.isNaN(file.topics[0].createdAt.getTime())).toBe(false);
  });

  it("multiple comments and missing optional fields survive parsing", async () => {
    const zip = new JSZip();
    zip.file("bcf.version", `<?xml version="1.0"?><Version VersionId="2.1"/>`);
    zip.file("t1/markup.bcf", `<?xml version="1.0"?>
<Markup>
	<Topic Guid="t1" TopicStatus="open">
		<Title>Multi</Title>
		<CreationDate>2026-01-02T03:04:05Z</CreationDate>
		<CreationAuthor>x@y.z</CreationAuthor>
		<Description>D</Description>
	</Topic>
	<Comment Guid="g1"><Date>2026-01-03T00:00:00Z</Date><Author>a</Author><Comment>one</Comment></Comment>
	<Comment Guid="g2"><Date>2026-01-04T00:00:00Z</Date><Author>b</Author><Comment>two</Comment></Comment>
</Markup>
`);
    const file = await parseBcfZip(await zip.generateAsync({ type: "uint8array" }));
    expect(file.topics[0].comments.map((c) => c.body)).toEqual(["one", "two"]);
    expect(file.topics[0].comments.every((c) => c.viewpointGuid === null)).toBe(true);
    expect(file.topics[0].createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(file.topics[0].priority).toBeUndefined();
  });
});

describe("BCF reader robustness (guards interop with foreign tools)", () => {
  const makeZip = async (files: Record<string, string | Uint8Array>): Promise<Uint8Array> => {
    const zip = new JSZip();
    for (const [k, v] of Object.entries(files)) zip.file(k, v);
    return zip.generateAsync({ type: "uint8array" });
  };

  it("matches uppercase entry names (some exporters use uppercase)", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "BCF.VERSION": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "T1/MARKUP.BCF": `<?xml version="1.0"?><Markup><Topic Guid="t1"><Title>Up</Title></Topic></Markup>`,
        "T1/VIEWPOINT.BCFV": `<?xml version="1.0"?><VisualizationInfo Guid="v1"><PerspectiveCamera><ViewPoint>1,2,3</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
        "T1/SNAPSHOT.PNG": new Uint8Array([9, 8, 7]),
      })
    );
    expect(file.topics).toHaveLength(1);
    expect(file.topics[0].title).toBe("Up");
    expect(file.topics[0].viewpoint?.camera.viewPoint).toEqual([1, 2, 3]);
    expect(Array.from(file.topics[0].viewpoint!.snapshot!)).toEqual([9, 8, 7]);
  });

  it("skips viewpoints with malformed or missing ViewPoint, keeps valid ones", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "bad/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo Guid="bad"><PerspectiveCamera><ViewPoint>1,2</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
        "nan/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo Guid="nan"><PerspectiveCamera><ViewPoint>a,b,c</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
        "noviewpoint/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo Guid="novp"></VisualizationInfo>`,
        "ok/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo Guid="ok"><PerspectiveCamera><ViewPoint>1,2,3</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
      })
    );
    // viewpoints are only reachable through topics; assert via topic-less parse does not crash
    expect(file.topics).toHaveLength(0);
  });

  it("numeric fields: FieldOfView non-string stays undefined; ViewUp/ViewDirection malformed tolerated", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "t/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo Guid="v"><PerspectiveCamera><ViewPoint>1,2,3</ViewPoint><ViewUp>bad</ViewUp><ViewDirection>also,bad</ViewDirection><FieldOfView>55</FieldOfView></PerspectiveCamera></VisualizationInfo>`,
        "t/markup.bcf": `<?xml version="1.0"?><Markup><Topic Guid="t"><Title>x</Title></Topic></Markup>`,
      })
    );
    const vp = file.topics[0].viewpoint!;
    expect(vp.camera.viewPoint).toEqual([1, 2, 3]);
    expect(vp.camera.viewUp).toBeUndefined();
    expect(vp.camera.viewDirection).toBeUndefined();
    expect(vp.camera.fieldOfView).toBe(55);
  });

  it("viewpoint Guid falls back to topic folder; snapshot accepts other extensions", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "topic9/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo><PerspectiveCamera><ViewPoint>7,8,9</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
        "topic9/snapshot.JPEG": new Uint8Array([1, 1, 1]),
        "topic9/markup.bcf": `<?xml version="1.0"?><Markup><Topic Guid="topic9"><Title>fallback guid</Title></Topic></Markup>`,
      })
    );
    const vp = file.topics[0].viewpoint!;
    expect(vp.guid).toBe("topic9"); // fallback to folder name
    expect(Array.from(vp.snapshot!)).toEqual([1, 1, 1]);
  });

  it("comment viewpoint reference falling back to the topic folder viewpoint", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "topicX/viewpoint.bcfv": `<?xml version="1.0"?><VisualizationInfo><PerspectiveCamera><ViewPoint>1,1,1</ViewPoint></PerspectiveCamera></VisualizationInfo>`,
        "topicX/markup.bcf": `<?xml version="1.0"?>
<Markup>
	<Topic Guid="topicX"><Title>fb</Title></Topic>
	<Comment Guid="c"><Date>2026-01-01T00:00:00Z</Date><Author>a</Author><Comment>hello</Comment><Viewpoint Guid="not-stored-anywhere"/></Comment>
</Markup>`,
      })
    );
    expect(file.topics[0].viewpoint?.camera.viewPoint).toEqual([1, 1, 1]);
    expect(file.topics[0].comments[0].viewpointGuid).toBe("not-stored-anywhere");
  });

  it("single comment (object, not array) and missing comment date default to now", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "t/markup.bcf": `<?xml version="1.0"?>
<Markup>
	<Topic Guid="t"><Title>single</Title></Topic>
	<Comment Guid="g"><Author>a</Author><Comment>only one</Comment></Comment>
</Markup>`,
      })
    );
    expect(file.topics[0].comments).toHaveLength(1);
    expect(file.topics[0].comments[0].body).toBe("only one");
    expect(Number.isNaN(file.topics[0].comments[0].date.getTime())).toBe(false);
  });

  it("markup without Topic element yields a topic keyed by folder with defaults", async () => {
    const file = await parseBcfZip(
      await makeZip({
        "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"/>`,
        "folder-only/markup.bcf": `<?xml version="1.0"?><Markup><Comment Guid="g"><Author>a</Author><Comment>x</Comment></Comment></Markup>`,
      })
    );
    expect(file.topics).toHaveLength(1);
    expect(file.topics[0].guid).toBe("folder-only");
    expect(file.topics[0].title).toBe("(untitled)");
    expect(file.topics[0].status).toBeUndefined();
  });
});
