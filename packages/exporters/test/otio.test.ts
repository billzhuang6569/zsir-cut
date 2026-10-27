import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  fingerprint,
  lossReport,
  parseProject,
  runExport,
  serializeProject,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const fixtures = ["std-25", "std-2997-df", "std-2997-ndf"];
const files = [
  ...fixtures.map((name) => `fixtures/projects/${name}.zcut.json`),
  "fixtures/regressions/parent-25-on-2997.zcut.json",
  "fixtures/regressions/otio-2997-fcpxml-grid.zcut.json",
  "fixtures/regressions/resolve-otio-transform.zcut.json",
  "examples/minimal.zcut.json",
  "examples/interview.zcut.json",
];
const mediaRoot = resolve("fixtures/.media");
const previewStub: NonNullable<Parameters<typeof runExport>[6]> = async (_project, _timeline, _path, options) => {
  const data = Buffer.from("preview test placeholder");
  await writeFile(options.output, data);
  return { path: options.output, sha256: createHash("sha256").update(data).digest("hex"), frames: "0" };
};

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
      expect(data.replaceAll(mediaRoot, "/__MEDIA_ROOT__")).toBe(
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
        expect.objectContaining({ feature: "gain", status: "unsupported" }),
        expect.objectContaining({ feature: "subtitle_text_timing", reason_code: "R_SUB_MANUAL_IMPORT" }),
      ]),
    );
    expect(losses.some((item) => item.feature === "transform")).toBe(false);
  });
  it("uses the exact 30000/1001 double rate", async () => {
    const { data } = await generate("fixtures/projects/std-2997-df.zcut.json", "resolve-18.5-otio");
    const root = JSON.parse(data) as { global_start_time: { rate: number; value: number } };
    expect(root.global_start_time.rate).toBe(30000 / 1001);
    expect(root.global_start_time.value).toBe(108000);
  });
  it("writes raw local paths, nominal DF timeline origin, true media frames, reverse minima and Resolve effects", async () => {
    const path = "fixtures/regressions/resolve-otio-transform.zcut.json";
    const { project, timeline, paths, data } = await generate(path, "resolve-18.5-otio");
    const root = JSON.parse(data);
    expect(root.global_start_time).toMatchObject({ value: 108000, rate: 30000 / 1001 });
    const clips = root.tracks.children[0].children;
    expect(
      clips.map((clip: { source_range: { start_time: { value: number } } }) => clip.source_range.start_time.value),
    ).toEqual([1078980, 1079040, 1079040]);
    const reference = clips[0].media_references.DEFAULT_MEDIA;
    expect(reference.target_url).toBe(paths.get("med_probe"));
    expect(reference.target_url).toContain("素材 盘/100% 原片/literal%20.mov");
    expect(reference.target_url).not.toContain("file:");
    expect(reference.available_range.start_time.value).toBe(1078920);
    expect(reference.available_range.duration.value).toBe(3000);
    const effects = clips[0].effects;
    expect(effects[0]).toMatchObject({ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: -1 });
    expect(effects.slice(1)).toEqual([
      expect.objectContaining({
        OTIO_SCHEMA: "Effect.1",
        name: "",
        effect_name: "Resolve Effect",
        metadata: {
          Resolve_OTIO: {
            "Effect Name": "Transform",
            Name: "变换",
            Enabled: true,
            "Display Type": 1,
            Type: 2,
            Parameters: expect.any(Array),
          },
        },
      }),
      expect.objectContaining({
        OTIO_SCHEMA: "Effect.1",
        name: "",
        effect_name: "Resolve Effect",
        metadata: {
          Resolve_OTIO: {
            "Effect Name": "Cropping",
            Name: "裁切",
            Enabled: true,
            "Display Type": 1,
            Type: 3,
            Parameters: expect.any(Array),
          },
        },
      }),
    ]);
    const parameters = effects
      .slice(1)
      .flatMap(
        (effect: { metadata: { Resolve_OTIO: { Parameters: unknown[] } } }) => effect.metadata.Resolve_OTIO.Parameters,
      );
    const expected = [
      ["transformationZoomX", 0.5, 1, 0, 100],
      ["transformationZoomY", 0.5, 1, 0, 100],
      ["transformationPan", 0.2, 0, -4, 4],
      ["transformationTilt", -0.2, 0, -4, 4],
      ["transformationRotationAngle", 5, 0, -100000, 100000],
      ["cropLeft", 0.1, 0, -1, 1],
      ["cropRight", 0.2, 0, -1, 1],
      ["cropTop", 0.05, 0, -1, 1],
      ["cropBottom", 0.15, 0, -1, 1],
    ];
    expect(parameters).toEqual(
      expected.map(([id, value, defaultValue, min, max]) => ({
        "Parameter ID": id,
        "Parameter Value": value,
        "Default Parameter Value": defaultValue,
        "Variant Type": "Double",
        "Key Frames": {},
        minValue: min,
        maxValue: max,
      })),
    );
    expect(clips[0].metadata.zsir.transform).toEqual(
      timeline.tracks[0]?.kind === "video" ? timeline.tracks[0].clips[0]?.transform : undefined,
    );
    for (const clip of clips.slice(1)) {
      const defaults = clip.effects
        .slice(-2)
        .flatMap(
          (effect: { metadata: { Resolve_OTIO: { Parameters: Record<string, unknown>[] } } }) =>
            effect.metadata.Resolve_OTIO.Parameters,
        );
      expect(defaults).toHaveLength(9);
      for (const parameter of defaults) expect(parameter["Parameter Value"]).toBe(parameter["Default Parameter Value"]);
    }
    expect(await exporter.readBack(data, timeline)).toEqual(cuttingList(project, timeline, "resolve-18.5-otio"));
    const report = await lossReport(
      project,
      "resolve-18.5-otio",
      exporter,
      "exp_fix",
      "preview",
      timeline,
      "2026-10-27T00:00:00Z",
      path,
    );
    expect(report.items.some((item) => item.feature === "transform")).toBe(false);
    expect(report.summary.preserved_by_feature.transform).toBe(2);
    reference.target_url = "file:///encoded%20path.mov";
    await expect(exporter.readBack(JSON.stringify(root), timeline)).rejects.toThrow("local absolute path");
  });
  for (const [name, value] of [
    ["std-25", 90000],
    ["std-2997-ndf", 108000],
  ] as const) {
    it(`${name} keeps its non-drop-frame origin`, async () => {
      const { data } = await generate(`fixtures/projects/${name}.zcut.json`, "resolve-18.5-otio");
      expect(JSON.parse(data).global_start_time.value).toBe(value);
    });
  }
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
  it("keeps a mixed-rate connected cut on the exact timeline grid", async () => {
    const { project, timeline, data } = await generate(
      "fixtures/regressions/parent-25-on-2997.zcut.json",
      "resolve-18.5-otio",
    );
    const expected = cuttingList(project, timeline, "resolve-18.5-otio");
    expect(await exporter.readBack(data, timeline)).toEqual(expected);
    expect(expected.find((row) => row.clip_id === "clp_connected_still")).toMatchObject({
      timeline_in: 1,
      timeline_out: 2,
    });
    expect(
      exporter.losses(project, timeline, "resolve-18.5-otio").some((item) => item.reason_code === "R_GRID_ROUNDED"),
    ).toBe(false);
  });
  it("exports a 29.97 connected clip without FCPXML grid tolerance and reports a real mismatch", async () => {
    const path = "fixtures/regressions/otio-2997-fcpxml-grid.zcut.json";
    const { project, timeline } = await generate(path, "resolve-18.5-otio");
    expect([...exporter.gridTolerances(project, timeline).keys()]).toEqual(["clp_connected"]);
    const directory = await mkdtemp(join(tmpdir(), "zcut-otio-grid-"));
    try {
      const withSha = { ...exporter, gitSha: async () => "abcdef0" };
      const request = { project: path, output: directory, accept_losses: true };
      const result = await runExport(
        project,
        request,
        withSha,
        "exp_otio_grid",
        "2026-10-27T00:00:00.000Z",
        "resolve-18.5-otio",
      );
      expect(result.rejected).toBe(false);
      const mismatched = {
        ...withSha,
        async readBack(data: string | Uint8Array, selected: typeof timeline) {
          const rows = await exporter.readBack(data, selected);
          return rows.map((row) =>
            row.clip_id === "clp_connected" ? { ...row, source_out: row.source_out + 1 } : row,
          );
        },
      };
      await expect(
        runExport(project, request, mismatched, "exp_otio_bad", "2026-10-27T00:00:00.000Z", "resolve-18.5-otio"),
      ).rejects.toThrow(/cutting list:.*clp_connected.*source_out/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Resolve FCPXML candidate", () => {
  for (const path of files) {
    it(`${path} matches the FCP 1.11 body and reads back within reported grid rounding`, async () => {
      const candidate = await generate(path, "resolve-21-fcpxml-1.11");
      const fcp = await exporter.generate(
        candidate.project,
        candidate.timeline,
        "fcp-10.6-fcpxml-1.11",
        candidate.paths,
      );
      expect(candidate.data).toBe(fcp.data);
      const expected = cuttingList(candidate.project, candidate.timeline, "resolve-21-fcpxml-1.11");
      const actual = await exporter.readBack(candidate.data, candidate.timeline);
      const tolerances = exporter.gridTolerances(candidate.project, candidate.timeline);
      expect([...tolerances.keys()].sort()).toEqual(
        exporter
          .losses(candidate.project, candidate.timeline, "resolve-21-fcpxml-1.11")
          .filter((item) => item.reason_code === "R_GRID_ROUNDED")
          .map((item) => item.entity_id)
          .sort(),
      );
      expect(actual.map(({ timeline_in_exact: _in, timeline_out_exact: _out, ...row }) => row)).toEqual(expected);
      expect(compareCuttingLists(expected, actual, new Set(), tolerances).zero_frame_deviation).toBe(true);
      expect(await exporter.validate(candidate.data)).toBe(true);
    });
  }
  it("records the same mixed-rate grid rounding in the Resolve loss report", async () => {
    const path = "fixtures/regressions/parent-25-on-2997.zcut.json";
    const { project, timeline } = await generate(path, "resolve-21-fcpxml-1.11");
    const candidate = await lossReport(
      project,
      "resolve-21-fcpxml-1.11",
      exporter,
      "exp_grid",
      "preview",
      timeline,
      "2026-10-27T00:00:00.000Z",
      path,
    );
    const fcp = await lossReport(
      project,
      "fcp-10.6-fcpxml-1.11",
      exporter,
      "exp_grid",
      "preview",
      timeline,
      "2026-10-27T00:00:00.000Z",
      path,
    );
    const rounded = candidate.items.filter((item) => item.reason_code === "R_GRID_ROUNDED");
    expect(rounded).toMatchObject([
      { entity_id: "clp_connected_still", feature: "clip_cut", status: "approximated", severity: "warning" },
    ]);
    expect(rounded).toEqual(fcp.items.filter((item) => item.reason_code === "R_GRID_ROUNDED"));
  });
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
      const withSha = { ...exporter, gitSha: async () => "abcdef0" };
      const candidate = await runExport(
        project,
        { project: projectPath, output: join(directory, "candidate") },
        withSha,
        "exp_candidate",
        "2026-10-27T00:00:00.000Z",
        "resolve-21-fcpxml-1.11",
        previewStub,
      );
      const fcp = await runExport(
        project,
        { project: projectPath, output: join(directory, "fcp") },
        withSha,
        "exp_fcp",
        "2026-10-27T00:00:00.000Z",
        "fcp-10.6-fcpxml-1.11",
        previewStub,
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
        withSha,
        "exp_otio",
        "2026-10-27T00:00:00.000Z",
        "resolve-18.5-otio",
        previewStub,
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
