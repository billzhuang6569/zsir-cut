import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  fingerprint,
  parseProject,
  runExport,
  serializeProject,
  sub,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const profile = "premiere-25-xmeml-5";
const fixtures = ["std-25", "std-2997-df", "std-2997-ndf"];
const mediaRoot = pathToFileURL(resolve("fixtures/.media")).href.replace("file:///", "file://localhost/");
const previewStub: NonNullable<Parameters<typeof runExport>[6]> = async (_project, _timeline, _path, options) => {
  const data = Buffer.from("preview test placeholder");
  await writeFile(options.output, data);
  return { path: options.output, sha256: createHash("sha256").update(data).digest("hex"), frames: "0" };
};
const clipitem = (xml: string, id: string) => {
  const item = xml.match(new RegExp(`<clipitem id="${id}">[\\s\\S]*?</clipitem>`))?.[0];
  if (!item) throw new Error(`Missing clipitem ${id}`);
  return item;
};
const parameterValue = (xml: string, id: string) => {
  const raw = xml.match(
    new RegExp(`<parameterid>${id}</parameterid>\\s*<name>[^<]*</name>\\s*<value>([^<]+)</value>`),
  )?.[1];
  if (raw === undefined) throw new Error(`Missing parameter ${id}`);
  return raw;
};

async function generate(path: string) {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`Invalid fixture ${path}`);
  const project = parsed.project;
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  const paths = new Map(project.media.map((media) => [media.id, resolve(dirname(path), media.path)]));
  const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
  return { project, timeline, paths, xml };
}

describe("Premiere xmeml v5", () => {
  for (const name of fixtures) {
    it(`${name} round trips every cut and matches golden`, async () => {
      const path = `fixtures/projects/${name}.zcut.json`;
      const { project, timeline, paths, xml } = await generate(path);
      const expected = cuttingList(project, timeline, profile);
      expect(await exporter.readBack(xml, timeline)).toEqual(expected);
      expect(compareCuttingLists(expected, await exporter.readBack(xml, timeline)).zero_frame_deviation).toBe(true);
      expect(await exporter.validate(xml)).toBe(true);
      expect((await exporter.generate(project, timeline, profile, paths)).data).toBe(xml);
      expect(xml.replaceAll(mediaRoot, "file://localhost/__MEDIA_ROOT__")).toBe(
        await readFile(`fixtures/golden/xmeml/${name}.xml`, "utf8"),
      );
    });
  }
  for (const path of [
    "fixtures/regressions/parent-25-on-2997.zcut.json",
    "fixtures/regressions/otio-2997-fcpxml-grid.zcut.json",
    "fixtures/regressions/xmeml-sequence-grid.zcut.json",
    "examples/minimal.zcut.json",
    "examples/interview.zcut.json",
  ]) {
    it(`${path} reads back at zero frames`, async () => {
      const { project, timeline, xml } = await generate(path);
      expect(
        compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(xml, timeline))
          .zero_frame_deviation,
      ).toBe(true);
      expect(await exporter.validate(xml)).toBe(true);
    });
  }
  it("writes native file rates, links, filters, marker, transition, and fixed losses", async () => {
    const { project, timeline, xml } = await generate("fixtures/projects/std-25.zcut.json");
    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain("<pathurl>file://localhost/");
    expect(xml).toContain("<linkclipref>clp_a1</linkclipref>");
    expect(xml).toContain("<effectid>Cross Dissolve</effectid>");
    expect(xml).toContain("<effectid>timeremap</effectid>");
    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<effectid>basic</effectid>");
    expect(xml).toContain("<effectid>crop</effectid>");
    expect(clipitem(xml, "clp_vfr")).toMatch(/<in>0<\/in>\s*<out>100<\/out>/);
    expect(clipitem(xml, "clp_ext")).toMatch(/<in>328<\/in>\s*<out>568<\/out>/);
    for (const [id, speed, reverse, freeze] of [
      ["clp_v6", "200", "FALSE", "FALSE"],
      ["clp_v7", "100", "TRUE", "FALSE"],
      ["clp_v8-s2", "0", "FALSE", "TRUE"],
    ]) {
      const item = clipitem(xml, id);
      expect(parameterValue(item, "speed")).toBe(speed);
      expect(parameterValue(item, "reverse")).toBe(reverse);
      expect(parameterValue(item, "freeze")).toBe(freeze);
    }
    expect(xml).toContain("<marker id=");
    expect(xml).toContain("segment=3");
    const losses = exporter.losses(project, timeline, profile);
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "subtitle_text_timing", reason_code: "R_SUB_MANUAL_IMPORT" }),
        expect.objectContaining({ feature: "subtitle_style", reason_code: "R_STYLE_NOT_REPRESENTABLE" }),
        expect.objectContaining({ feature: "speed_segmented", reason_code: "R_SPLIT_FOR_RETIME" }),
        expect.objectContaining({ feature: "speed_smooth", reason_code: "R_SPLIT_FOR_RETIME" }),
      ]),
    );
    expect(losses.some((item) => item.feature === "gain" || item.feature === "transform")).toBe(false);
  });
  it("rounds video and audio source cuts on the sequence grid, with half frames upward", async () => {
    const { project, timeline, xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    for (const id of ["clp_vfr", "clp_ext"]) {
      const item = clipitem(xml, id);
      expect(item).toMatch(/<rate>\s*<timebase>25<\/timebase>\s*<ntsc>FALSE<\/ntsc>\s*<\/rate>/);
      expect(item).toMatch(/<in>1<\/in>\s*<out>26<\/out>/);
    }
    expect(clipitem(xml, "clp_vfr")).toMatch(/<file id="med_VFR">[\s\S]*?<timebase>30<\/timebase>/);
    expect(clipitem(xml, "clp_ext")).toMatch(/<file id="med_EXT">[\s\S]*?<timebase>48000<\/timebase>/);
    const losses = exporter.losses(project, timeline, profile).filter((item) => item.reason_code === "R_GRID_ROUNDED");
    expect(losses).toHaveLength(2);
    for (const id of ["clp_vfr", "clp_ext"])
      expect(losses).toContainEqual(
        expect.objectContaining({
          entity_id: id,
          feature: "clip_cut",
          status: "approximated",
          severity: "warning",
        }),
      );
    const rows = await exporter.readBack(xml, timeline);
    expect(rows.find((row) => row.clip_id === "clp_ext")).toMatchObject({ source_in: 1920, source_out: 49920 });
  });
  it("converts motion and crop ratios into FCP7 units and keeps audio level linear", async () => {
    const { xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    const motion = clipitem(xml, "clp_vfr");
    expect(parameterValue(motion, "scale")).toBe("50");
    expect(parameterValue(motion, "rotation")).toBe("-15");
    expect(motion).toMatch(
      /<parameterid>center<\/parameterid>\s*<name>Center<\/name>\s*<value>\s*<horiz>-0.4<\/horiz>\s*<vert>0.5<\/vert>\s*<\/value>/,
    );
    for (const [side, amount] of [
      ["left", "10"],
      ["right", "20"],
      ["top", "5"],
      ["bottom", "15"],
    ])
      expect(parameterValue(motion, side)).toBe(amount);
    expect(Number(parameterValue(clipitem(xml, "clp_ext"), "level"))).toBeCloseTo(0.5011872336272722);
  });
  it("rejects noninteger source frames and clip rates different from the sequence", async () => {
    const { xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    for (const [from, to] of [
      ["<in>1</in>", "<in>1.5</in>"],
      ["<out>26</out>", "<out>26.5</out>"],
      ["<timebase>25</timebase>", "<timebase>30</timebase>"],
      ["<ntsc>FALSE</ntsc>", "<ntsc>TRUE</ntsc>"],
    ]) {
      const item = clipitem(xml, "clp_vfr");
      const altered = xml.replace(item, item.replace(from, to));
      expect(altered).not.toBe(xml);
      expect(await exporter.validate(altered)).toBe(false);
    }
    const item = clipitem(xml, "clp_vfr");
    expect(await exporter.validate(xml.replace(item, item.replace(/<rate>[\s\S]*?<\/rate>/, "")))).toBe(false);
  });
  it("checks mixed-rate source limits in sequence frames, including file references", async () => {
    const { project, timeline, paths } = await generate("fixtures/regressions/parent-25-on-2997.zcut.json");
    const track = timeline.tracks[0];
    const media = project.media.find((entry) => entry.id === "med_DUP1");
    if (track?.kind !== "video" || !track.clips[0] || !media) throw new Error("Missing mixed-rate clip");
    const clip = track.clips[0];
    clip.source_start = sub(media.duration, clip.duration);
    const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
    const item = clipitem(xml, clip.id);
    expect(item).toMatch(/<in>298<\/in>\s*<out>300<\/out>/);
    expect(await exporter.validate(xml)).toBe(true);
    expect(await exporter.validate(xml.replace(item, item.replace("<out>300</out>", "<out>301</out>")))).toBe(false);
    const { xml: referenced } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    const tail = clipitem(referenced, "clp_tail");
    expect(tail).toContain('<file id="med_VFR"/>');
    expect(await exporter.validate(referenced.replace(tail, tail.replace("<out>750</out>", "<out>751</out>")))).toBe(
      false,
    );
  });
  it("reports audio and source grid rounding plus dropped extension data", async () => {
    const { project, timeline, paths } = await generate("fixtures/projects/std-2997-df.zcut.json");
    const video = timeline.tracks.find((track) => track.kind === "video");
    if (video?.kind !== "video" || !video.clips[0]) throw new Error("Missing video clip");
    video.clips[0].source_start = { numerator: 557n, denominator: 50n };
    const audio = timeline.tracks.find(
      (track) => track.kind === "audio" && track.clips.some((clip) => clip.id === "clp_ext"),
    );
    if (audio?.kind !== "audio") throw new Error("Missing audio clip");
    const clip = audio.clips.find((item) => item.id === "clp_ext");
    if (!clip) throw new Error("Missing external audio clip");
    clip.timeline_start = { numerator: 1n, denominator: 48000n };
    clip.ext = { note: "kept only in source" };
    const losses = exporter.losses(project, timeline, profile);
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: video.clips[0].id, feature: "clip_cut", reason_code: "R_GRID_ROUNDED" }),
        expect.objectContaining({ entity_id: clip.id, feature: "av_sync", reason_code: "R_GRID_ROUNDED" }),
        expect.objectContaining({ entity_id: clip.id, feature: "ext_data", reason_code: "R_EXT_DROPPED" }),
      ]),
    );
    const xml = (await exporter.generate(project, timeline, profile, paths)).data;
    expect(
      compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(xml, timeline))
        .zero_frame_deviation,
    ).toBe(true);
  });
  it("rejects broken references, source overflow, and a changed source frame", async () => {
    const { project, timeline, xml } = await generate("fixtures/projects/std-25.zcut.json");
    expect(
      await exporter.validate(
        xml.replace("<linkclipref>clp_a1</linkclipref>", "<linkclipref>clp_missing</linkclipref>"),
      ),
    ).toBe(false);
    expect(await exporter.validate(xml.replace("<out>528</out>", "<out>999999</out>"))).toBe(false);
    const altered = xml.replace("<in>278</in>", "<in>279</in>");
    expect(altered).not.toBe(xml);
    expect(
      compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(altered, timeline))
        .zero_frame_deviation,
    ).toBe(false);
  });
  it("creates a handoff package with SRT and a passing local validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-xmeml-"));
    try {
      const { project } = await generate("fixtures/projects/std-25.zcut.json");
      await mkdir(join(directory, "media"));
      for (const media of project.media) {
        const path = join(directory, "media", `${media.id}.bin`);
        await writeFile(path, media.id);
        media.path = `media/${media.id}.bin`;
        media.size_bytes = Buffer.byteLength(media.id);
        media.fingerprint = await fingerprint(path);
      }
      const projectPath = join(directory, "std-25.zcut.json");
      await writeFile(projectPath, serializeProject(project));
      const result = await runExport(
        project,
        { project: projectPath, output: directory },
        { ...exporter, gitSha: async () => "abcdef0" },
        "exp_xmeml_test",
        "2026-10-27T00:00:00.000Z",
        profile,
        previewStub,
      );
      if (result.rejected) throw new Error("Export rejected");
      expect(result.manifest.profile.id).toBe(profile);
      expect(result.manifest.validation.schema.status).toBe("pass");
      expect(result.manifest.validation.media_resolved.status).toBe("pass");
      expect(await readFile(join(result.package, "timeline", `${project.timelines[0]?.name}.xml`), "utf8")).toContain(
        '<xmeml version="5">',
      );
      expect(await readFile(join(result.package, "loss-report.json"), "utf8")).toContain("premiere-25-xmeml-5");
      expect(await readFile(join(result.package, "subtitles", "zh-Hans.srt"), "utf8")).toContain("-->");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("accepts the Premiere profile through the CLI export dry run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-xmeml-cli-"));
    try {
      const requestPath = join(directory, "request.json");
      await writeFile(
        requestPath,
        JSON.stringify({
          base_revision: "rev_fixture_1",
          idempotency_key: "xmeml-cli-dry-run",
          author: { kind: "agent", name: "test" },
          profile,
          dry_run: true,
          accept_losses: true,
        }),
      );
      const { stdout } = await promisify(execFile)(process.execPath, [
        resolve("packages/cli/dist/index.js"),
        "export",
        resolve("fixtures/projects/std-25.zcut.json"),
        "--input",
        requestPath,
      ]);
      const response = JSON.parse(stdout) as { status: string; result: { profile: string } };
      expect(response.status).toBe("dry_run");
      expect(response.result.profile).toBe(profile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
