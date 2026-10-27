import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  fingerprint,
  parseProject,
  runExport,
  serializeProject,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const fixtures = ["std-25", "std-2997-df", "std-2997-ndf"];
const files = [
  ...fixtures.map((name) => `fixtures/projects/${name}.zcut.json`),
  "examples/minimal.zcut.json",
  "examples/interview.zcut.json",
];
const mediaRoot = pathToFileURL(resolve("fixtures/.media")).href;

async function generate(path: string, profile: "resolve-18.5-otio" | "resolve-21-fcpxml-1.11") {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`Invalid fixture: ${path}`);
  const project = parsed.project;
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  const paths = new Map(project.media.map((media) => [media.id, resolve(dirname(path), media.path)]));
  const output = await exporter.generate(project, timeline, profile, paths);
  return { project, timeline, paths, data: output.data.toString() };
}

describe("Resolve OTIO", () => {
  for (const path of files) {
    it(`${path} reads back every cut and loads in OpenTimelineIO`, async () => {
      const { project, timeline, paths, data } = await generate(path, "resolve-18.5-otio");
      const expected = cuttingList(project, timeline, "resolve-18.5-otio");
      const actual = await exporter.readBack(data, timeline);
      expect(actual).toEqual(expected);
      expect(compareCuttingLists(expected, actual).zero_frame_deviation).toBe(true);
      expect(await exporter.validate(data)).toBe(true);
      expect((await exporter.generate(project, timeline, "resolve-18.5-otio", paths)).data).toBe(data);
    });
  }
  for (const name of fixtures) {
    it(`${name} matches normalized OTIO golden`, async () => {
      const { data } = await generate(`fixtures/projects/${name}.zcut.json`, "resolve-18.5-otio");
      expect(data.replaceAll(mediaRoot, "file:///__MEDIA_ROOT__")).toBe(
        await readFile(`fixtures/golden/otio/${name}.otio`, "utf8"),
      );
    });
  }
  it("writes segmented speed, reverse, dissolve, frame rate, and losses", async () => {
    const { project, timeline, data } = await generate("fixtures/projects/std-25.zcut.json", "resolve-18.5-otio");
    const root = JSON.parse(data) as {
      tracks: { markers: unknown[]; children: { children: Record<string, unknown>[] }[] };
    };
    const children = root.tracks.children[0]?.children ?? [];
    const clips = children.filter((child) => child.OTIO_SCHEMA === "Clip.2");
    const zsir = (clip: Record<string, unknown>) => (clip.metadata as { zsir: Record<string, unknown> }).zsir;
    const effects = (clip: Record<string, unknown>) => clip.effects as { OTIO_SCHEMA: string; time_scalar?: number }[];
    const segmented = clips.filter((clip) => zsir(clip).clip_id === "clp_v8");
    expect(segmented.map((clip) => zsir(clip).segment)).toEqual([0, 1, 2, 3]);
    expect(segmented.every((clip) => zsir(clip).occurrence_id === "occ_9")).toBe(true);
    expect(segmented.map((clip) => effects(clip)[0]?.time_scalar ?? 1)).toEqual([1, 0.5, 0, 2]);
    expect(effects(clips.find((clip) => zsir(clip).clip_id === "clp_v7") ?? {})[0]?.time_scalar).toBe(-1);
    expect(clips.filter((clip) => zsir(clip).clip_id === "clp_v9")).toHaveLength(2);
    const dissolve = children.find((child) => child.OTIO_SCHEMA === "Transition.1") as {
      in_offset: { value: number };
      out_offset: { value: number };
    };
    expect([dissolve.in_offset.value, dissolve.out_offset.value]).toEqual([6, 6]);
    expect(root.tracks.markers.length).toBeGreaterThan(0);
    const losses = exporter.losses(project, timeline, "resolve-18.5-otio");
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "speed_smooth", entity_id: "clp_v9", reason_code: "R_SPLIT_FOR_RETIME" }),
        expect.objectContaining({ feature: "transform", status: "unsupported" }),
        expect.objectContaining({ feature: "gain", status: "unsupported" }),
        expect.objectContaining({ feature: "subtitle_text_timing", reason_code: "R_SUB_MANUAL_IMPORT" }),
      ]),
    );
  });
  it("uses the exact 30000/1001 double rate", async () => {
    const { data } = await generate("fixtures/projects/std-2997-df.zcut.json", "resolve-18.5-otio");
    const root = JSON.parse(data) as { global_start_time: { rate: number } };
    expect(root.global_start_time.rate).toBe(30000 / 1001);
  });
  it("readBack notices a changed source frame", async () => {
    const { project, timeline, data } = await generate("fixtures/projects/std-25.zcut.json", "resolve-18.5-otio");
    const root = JSON.parse(data) as {
      tracks: { children: { children: { OTIO_SCHEMA: string; source_range: { start_time: { value: number } } }[] }[] };
    };
    const clip = root.tracks.children[0]?.children.find((child) => child.OTIO_SCHEMA === "Clip.2");
    if (!clip) throw new Error("Missing clip");
    clip.source_range.start_time.value++;
    expect(
      compareCuttingLists(
        cuttingList(project, timeline, "resolve-18.5-otio"),
        await exporter.readBack(JSON.stringify(root), timeline),
      ).zero_frame_deviation,
    ).toBe(false);
  });
});

describe("Resolve FCPXML candidate", () => {
  for (const path of files) {
    it(`${path} matches the FCP 1.11 body and reads back exactly`, async () => {
      const candidate = await generate(path, "resolve-21-fcpxml-1.11");
      const fcp = await exporter.generate(
        candidate.project,
        candidate.timeline,
        "fcp-10.6-fcpxml-1.11",
        candidate.paths,
      );
      expect(candidate.data).toBe(fcp.data);
      expect(await exporter.readBack(candidate.data, candidate.timeline)).toEqual(
        cuttingList(candidate.project, candidate.timeline, "resolve-21-fcpxml-1.11"),
      );
      expect(await exporter.validate(candidate.data)).toBe(true);
    });
  }
  it("changes the handoff manifest profile while keeping the FCPXML body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-resolve-profile-"));
    try {
      const { project } = await generate("examples/minimal.zcut.json", "resolve-21-fcpxml-1.11");
      await mkdir(join(directory, "media"));
      for (const media of project.media) {
        const path = join(directory, "media", `${media.id}.bin`);
        await writeFile(path, media.id);
        media.path = `media/${media.id}.bin`;
        media.size_bytes = Buffer.byteLength(media.id);
        media.fingerprint = await fingerprint(path);
      }
      const projectPath = join(directory, "minimal.zcut.json");
      await writeFile(projectPath, serializeProject(project));
      const candidate = await runExport(
        project,
        { project: projectPath, output: join(directory, "candidate") },
        exporter,
        "exp_candidate",
        "2026-10-27T00:00:00.000Z",
        "resolve-21-fcpxml-1.11",
      );
      const fcp = await runExport(
        project,
        { project: projectPath, output: join(directory, "fcp") },
        exporter,
        "exp_fcp",
        "2026-10-27T00:00:00.000Z",
        "fcp-10.6-fcpxml-1.11",
      );
      if (candidate.rejected || fcp.rejected) throw new Error("Export rejected");
      expect(candidate.manifest.profile.id).toBe("resolve-21-fcpxml-1.11");
      expect(fcp.manifest.profile.id).toBe("fcp-10.6-fcpxml-1.11");
      const name = `${project.timelines[0]?.name}.fcpxml`;
      expect(await readFile(join(candidate.package, "timeline", name), "utf8")).toBe(
        await readFile(join(fcp.package, "timeline", name), "utf8"),
      );
      const otio = await runExport(
        project,
        { project: projectPath, output: join(directory, "otio") },
        exporter,
        "exp_otio",
        "2026-10-27T00:00:00.000Z",
        "resolve-18.5-otio",
      );
      if (otio.rejected) throw new Error("OTIO export rejected");
      const exchange = JSON.parse(
        await readFile(join(otio.package, "timeline", `${project.timelines[0]?.name}.otio`), "utf8"),
      ) as { metadata: { zsir: { export_id: string } } };
      expect(exchange.metadata.zsir.export_id).toBe(otio.manifest.export_id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
