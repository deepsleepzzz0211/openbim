import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildBcfZip, parseBcfZip, BcfTopic } from "../src";

const topics: BcfTopic[] = [
  {
    guid: "0123456789abcdef0123456789abcdef",
    title: "Wall clashes with slab <detail>",
    description: "Run a clash check & fix",
    status: "OPEN",
    priority: "HIGH",
    author: "alice@example.com",
    createdAt: new Date("2026-09-01T10:00:00Z"),
    comments: [
      {
        guid: "fedcba9876543210fedcba9876543210",
        author: "bob@example.com",
        date: new Date("2026-09-02T11:30:00Z"),
        body: "Fixed on site",
      },
    ],
  },
];

describe("BCF 2.1 writer", () => {
  it("produces a valid BCF 2.1 zip structure", async () => {
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "Demo & Co <test>" }, topics);
    const zip = await JSZip.loadAsync(zipBytes);

    const version = await zip.file("bcf.version")!.async("string");
    expect(version).toContain('VersionId="2.1"');

    const extensions = await zip.file("extensions.xml")!.async("string");
    expect(extensions).toContain("<Priority>major</Priority>");

    const project = await zip.file("project.bcfp")!.async("string");
    expect(project).toContain('ProjectId="P1"');
    expect(project).toContain("Demo &amp; Co &lt;test&gt;");

    const markupPath = Object.keys(zip.files).find((f) => f.endsWith("markup.bcf"))!;
    expect(markupPath).toBe("0123456789abcdef0123456789abcdef/markup.bcf");
    const markup = await zip.file(markupPath)!.async("string");
    expect(markup).toContain("Wall clashes with slab &lt;detail&gt;");
    expect(markup).toContain("<Priority>major</Priority>");
    expect(markup).toContain("<Author>bob@example.com</Author>");
    expect(markup).toContain("<CreationDate>2026-09-01T10:00:00Z</CreationDate>");
  });

  it("escapes XML entities in all text fields", async () => {
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "x" }, [
      { ...topics[0], title: `a"b&c<d`, comments: [] },
    ]);
    const zip = await JSZip.loadAsync(zipBytes);
    const markupPath = Object.keys(zip.files).find((f) => f.endsWith("markup.bcf"))!;
    const markup = await zip.file(markupPath)!.async("string");
    expect(markup).toContain("a&quot;b&amp;c&lt;d");
  });

  it("works with no topics", async () => {
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "x" }, []);
    const zip = await JSZip.loadAsync(zipBytes);
    expect(zip.file("bcf.version")).toBeTruthy();
    expect(Object.keys(zip.files).some((f) => f.endsWith("markup.bcf"))).toBe(false);
  });

  it("writes viewpoint.bcfv + snapshot and links them from markup", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const withVp: BcfTopic = {
      ...topics[0],
      viewpoint: {
        guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        camera: {
          viewPoint: [10.5, -3.25, 12],
          viewUp: [0, 1, 0],
          viewDirection: [0, 0.2, -1],
          fieldOfView: 55,
        },
        snapshot: png,
        selected: ["1r6PQPPXvATBmG_rT2sJiC"],
      },
    };
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "x" }, [withVp]);
    const zip = await JSZip.loadAsync(zipBytes);
    const folder = "0123456789abcdef0123456789abcdef";
    const vpi = await zip.file(`${folder}/viewpoint.bcfv`)!.async("string");
    expect(vpi).toContain("<ViewPoint>10.500000,-3.250000,12.000000</ViewPoint>");
    expect(vpi).toContain("<IfcGuid>1r6PQPPXvATBmG_rT2sJiC</IfcGuid>");
    const snap = await zip.file(`${folder}/snapshot.png`)!;
    expect(await snap.async("uint8array")).toEqual(png);
    const markup = await zip.file(`${folder}/markup.bcf`)!.async("string");
    expect(markup).toContain(`<Viewpoint Guid="${withVp.viewpoint.guid}"/>`);
  });
});

describe("BCF reader (round-trip)", () => {
  it("reads back topics, comments, viewpoints and snapshots", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 9, 9, 9, 9]);
    const withVp: BcfTopic = {
      ...topics[0],
      viewpoint: {
        guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        camera: { viewPoint: [1, 2, 3], viewUp: [0, 1, 0], viewDirection: [0, 0, -1], fieldOfView: 60 },
        snapshot: png,
        selected: ["2r6PQPPXvATBmG_rT2sJiC"],
      },
    };
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "Round & Trip" }, [withVp]);
    const file = await parseBcfZip(zipBytes);

    expect(file.version).toBe("2.1");
    expect(file.projectId).toBe("P1");
    expect(file.projectName).toBe("Round & Trip");
    expect(file.topics).toHaveLength(1);

    const topic = file.topics[0];
    expect(topic.guid).toBe("0123456789abcdef0123456789abcdef");
    expect(topic.title).toContain("slab");
    expect(topic.status).toBe("open");
    expect(topic.priority).toBe("major");
    expect(topic.comments).toHaveLength(1);
    expect(topic.comments[0].author).toBe("bob@example.com");

    expect(topic.viewpoint).not.toBeNull();
    expect(topic.viewpoint!.camera.viewPoint).toEqual([1, 2, 3]);
    expect(topic.viewpoint!.camera.viewDirection).toEqual([0, 0, -1]);
    expect(Array.from(topic.viewpoint!.snapshot!)).toEqual(Array.from(png));
  });

  it("reads zips without viewpoints or comments", async () => {
    const zipBytes = await buildBcfZip({ projectId: "P1", name: "x" }, [
      { ...topics[0], comments: [] },
    ]);
    const file = await parseBcfZip(zipBytes);
    expect(file.topics[0].viewpoint).toBeNull();
    expect(file.topics[0].comments).toHaveLength(0);
  });

  it("maps status/priority through the shared converters", async () => {
    const { statusFromBcf, priorityFromBcf } = await import("../src");
    expect(statusFromBcf("closed")).toBe("CLOSED");
    expect(statusFromBcf("open")).toBe("OPEN");
    expect(statusFromBcf(undefined)).toBe("OPEN");
    expect(priorityFromBcf("critical")).toBe("CRITICAL");
    expect(priorityFromBcf("minor")).toBe("LOW");
    expect(priorityFromBcf("weird")).toBe("NORMAL");
  });
});
