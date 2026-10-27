import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  fingerprint,
  type Project,
  parseProject,
  runExport,
  serializeProject,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const fixtures = ["std-25", "std-2997-df", "std-2997-ndf"];
const profiles = ["fcp-11-fcpxml-1.13", "fcp-10.6-fcpxml-1.11"] as const;
const mediaRoot = pathToFileURL(resolve("fixtures/.media")).href;
async function generate(path: string, profile: (typeof profiles)[number]) {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`Invalid fixture: ${path}`);
  const project: Project = parsed.project;
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  const paths = new Map(project.media.map((media) => [media.id, resolve(dirname(path), media.path)]));
  const result = await exporter.generate(project, timeline, profile, paths);
  return { project, timeline, xml: result.data.toString() };
}

describe("FCPXML", () => {
  for (const file of [
    ...fixtures.map((name) => `fixtures/projects/${name}.zcut.json`),
    "examples/minimal.zcut.json",
    "examples/interview.zcut.json",
  ]) {
    for (const profile of profiles) {
      it(`${file} ${profile} reads back every cut exactly`, async () => {
        const { project, timeline, xml } = await generate(file, profile);
        const expected = cuttingList(project, timeline, profile);
        const actual = await exporter.readBack(xml, timeline);
        expect(actual).toEqual(expected);
        expect(compareCuttingLists(expected, actual).zero_frame_deviation).toBe(true);
        expect(await exporter.validate(xml)).toBe(true);
        expect(
          (
            await exporter.generate(
              project,
              timeline,
              profile,
              new Map(project.media.map((media) => [media.id, resolve(dirname(file), media.path)])),
            )
          ).data,
        ).toBe(xml);
      });
    }
  }
  for (const name of fixtures) {
    it(`${name} matches normalized 1.13 golden`, async () => {
      const { xml } = await generate(`fixtures/projects/${name}.zcut.json`, profiles[0]);
      const expected = await readFile(`fixtures/golden/fcpxml/${name}-1.13.fcpxml`, "utf8");
      expect(xml.replaceAll(mediaRoot, "file:///__MEDIA_ROOT__")).toBe(expected);
    });
  }
  it("rejects FCP import hazards in a standard project", async () => {
    const { xml } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    const bad = [
      xml.replace('<video ref="r12"', '<asset-clip ref="r12"'),
      xml.replace('<format id="r4" name="FFVideoFormatRateUndefined" width="960" height="540"/>', '<format id="r4"/>'),
      xml.replace(
        'id="r11" name="外录音频.wav" start="35998s" duration="125s" hasAudio="1"',
        'id="r11" name="外录音频.wav" start="35998s" duration="125s" hasAudio="1" format="r4"',
      ),
      xml.replace('start="900278/25s" duration="10s"', 'start="900278/25s" duration="1000s"'),
      xml.replace('start="901537/25s" duration="16s"', 'start="901537/25s" duration="1000s"'),
    ];
    for (const candidate of bad) {
      expect(candidate).not.toBe(xml);
      expect(await exporter.validate(candidate)).toBe(false);
      expect(exporter.validationNotes).toContain("导入安全检查失败");
    }
  });
  it("reads static frame IDs from its clip metadata", async () => {
    const { timeline, xml } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    expect(xml).toMatch(
      /<clip lane="1"[^>]*name="静帧">\s*<video ref="r12"[^>]*\/>\s*<metadata>\s*<md key="com.zsir-cut.clip-id" value="clp_still"\/>\s*<md key="com.zsir-cut.occurrence-id" value="occ_11"\/>/,
    );
    expect((await exporter.readBack(xml, timeline)).some((row) => row.clip_id === "clp_still")).toBe(true);
    await expect(exporter.readBack(xml.replace('value="occ_11"', 'value=""'), timeline)).rejects.toThrow(
      "Missing occurrence ID metadata",
    );
  });
  it("uses video for a static frame on the primary storyline", async () => {
    const { project, timeline } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    const primary = timeline.tracks.find((track) => track.id === "trk_v1");
    if (!primary || primary.kind !== "video") throw new Error("Missing primary track");
    const first = primary.clips[0];
    if (!first) throw new Error("Missing primary clip");
    first.media_id = "med_STILL";
    first.source_start = { numerator: 0n, denominator: 1n };
    const paths = new Map(project.media.map((media) => [media.id, resolve("fixtures/projects", media.path)]));
    const xml = (await exporter.generate(project, timeline, profiles[0], paths)).data;
    expect(xml).toMatch(/<spine>\s*<clip offset="3600s"[^>]*>\s*<video ref="r12"/);
    expect(await exporter.validate(xml)).toBe(true);
    expect(await exporter.readBack(xml, timeline)).toEqual(cuttingList(project, timeline, profiles[0]));
  });
  it("writes J cut, connected lane, hold, dissolve, captions, and encoded media URL", async () => {
    const { xml } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    expect(xml).toMatch(
      /<asset-clip[^>]*audioStart="180198\/5s" audioDuration="62\/5s">[\s\S]*?<md key="com.zsir-cut.clip-id" value="clp_v2"\/>/,
    );
    expect(xml).toMatch(
      /<asset-clip[^>]*lane="1"[^>]*offset="900378\/25s"[\s\S]*?<md key="com.zsir-cut.clip-id" value="clp_b1"\/>/,
    );
    expect(xml).toMatch(
      /<clip[^>]*duration="6s"[\s\S]*?<timept time="4s" value="3s" interp="linear"\/>\s*<timept time="5s" value="3s" interp="linear"\/>/,
    );
    expect(xml).toContain('uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"');
    expect(xml).toMatch(/value="clp_v2"[\s\S]*?<transition name="Cross Dissolve"[\s\S]*?value="clp_v3"/);
    expect(xml).toContain('<caption lane="2"');
    expect(xml).toContain('role="SRT?captionFormat=SRT.zh-Hans"');
    expect(xml.match(/zsir-cut cue=cue_zh_03/g)).toHaveLength(1);
    expect(xml).toContain("%E7%B4%A0%E6%9D%90%20%E7%9B%98/100%25%20%E5%8E%9F%E7%89%87");
    expect(xml).toContain('key="com.zsir-cut.audio-clip-id" value="clp_a2"');
    expect(xml).toMatch(
      /<asset[^>]*>[\s\S]*?<media-rep[^>]*\/>\s*<metadata>\s*<md key="com.zsir-cut.media-id" value="med_A"\/>/,
    );
  });
  it("readBack catches a changed source in the emitted XML", async () => {
    const { project, timeline, xml } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    const changed = xml.replace('start="900278/25s" duration="10s"', 'start="900279/25s" duration="10s"');
    expect(changed).not.toBe(xml);
    expect(
      compareCuttingLists(cuttingList(project, timeline, profiles[0]), await exporter.readBack(changed, timeline))
        .zero_frame_deviation,
    ).toBe(false);
  });
  it("keeps a paired reverse audio clip at the video timeline position", async () => {
    const { project, timeline } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    const video = timeline.tracks.find((track) => track.id === "trk_v1");
    const audio = timeline.tracks.find((track) => track.id === "trk_a1");
    if (!video || video.kind !== "video" || !audio || audio.kind !== "audio") throw new Error("Missing tracks");
    const reverse = video.clips.find((clip) => clip.id === "clp_v7");
    if (!reverse) throw new Error("Missing reverse clip");
    audio.clips.push({ ...reverse, id: "clp_reverse_audio" });
    const xml = (
      await exporter.generate(
        project,
        timeline,
        profiles[0],
        new Map(project.media.map((media) => [media.id, resolve("fixtures/projects", media.path)])),
      )
    ).data;
    const rows = await exporter.readBack(xml, timeline);
    expect(rows).toEqual(cuttingList(project, timeline, profiles[0]));
  });
  it("reports style, unprojected words, non-primary transitions, audio frame boundaries, and ext", async () => {
    const { project, timeline } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
    const secondVideo = timeline.tracks.find((track) => track.id === "trk_v2");
    const firstAudio = timeline.tracks.find((track) => track.id === "trk_a1");
    if (!secondVideo || secondVideo.kind !== "video" || !firstAudio || firstAudio.kind !== "audio")
      throw new Error("Missing tracks");
    secondVideo.transitions.push({
      id: "trn_extra",
      type: "cross_dissolve",
      from_clip: "clp_b1",
      to_clip: "clp_still",
      duration: { numerator: 1n, denominator: 25n },
      alignment: "center",
    });
    const firstClip = firstAudio.clips[0];
    if (!firstClip) throw new Error("Missing audio clip");
    firstClip.timeline_start = { numerator: 1n, denominator: 100n };
    firstClip.ext = { sample: true };
    const losses = exporter.losses(project, timeline, profiles[0]);
    expect(losses.some((item) => item.feature === "subtitle_style" && item.status === "approximated")).toBe(true);
    expect(losses.some((item) => item.reason_code === "R_SUB_UNPROJECTED")).toBe(true);
    expect(
      losses.filter((item) => item.reason_code === "R_SUB_UNPROJECTED").every((item) => item.severity === "warning"),
    ).toBe(true);
    expect(losses.some((item) => item.entity_id === "trn_extra" && item.status === "unsupported")).toBe(true);
    expect(
      losses.some(
        (item) => item.entity_id === "clp_a1" && item.feature === "clip_cut" && item.status === "approximated",
      ),
    ).toBe(true);
    expect(losses.some((item) => item.entity_id === "clp_a1" && item.reason_code === "R_EXT_DROPPED")).toBe(true);
  });
  it("exports std-25 without accept_losses and records Git SHA or an explained fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-fcpxml-loss-"));
    try {
      const { project } = await generate("fixtures/projects/std-25.zcut.json", profiles[0]);
      const mediaDir = join(directory, "media");
      await mkdir(mediaDir);
      for (const media of project.media) {
        const path = join(mediaDir, `${media.id}.bin`);
        const bytes = Buffer.from(media.id);
        await writeFile(path, bytes);
        media.path = `media/${media.id}.bin`;
        media.size_bytes = bytes.length;
        media.fingerprint = await fingerprint(path);
      }
      const projectPath = join(directory, "std-25.zcut.json");
      await writeFile(projectPath, serializeProject(project));
      const input = { project: projectPath, output: join(directory, "good") };
      const withSha = { ...exporter, gitSha: async () => "abcdef0" };
      const good = await runExport(project, input, withSha, "exp_test", "2026-10-27T00:00:00.000Z", profiles[0]);
      expect(good.rejected).toBe(false);
      if (good.rejected) throw new Error("Export rejected");
      expect(good.report.summary.worst_severity).toBe("warning");
      expect(good.manifest.exporter.git_sha).toBe("abcdef0");
      expect(good.manifest.validation.schema.status).toBe("pass");
      const fallback = await runExport(
        project,
        { ...input, output: join(directory, "fallback") },
        {
          ...exporter,
          gitSha: async () => {
            throw new Error("No repository");
          },
        },
        "exp_fallback",
        "2026-10-27T00:00:00.000Z",
        profiles[0],
      );
      if (fallback.rejected) throw new Error("Fallback export rejected");
      expect(fallback.manifest.exporter.git_sha).toBe("0000000");
      expect(fallback.manifest.validation.schema.notes).toContain("无法读取仓库当前提交");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(!existsSync("/Applications/Final Cut Pro.app"))("passes installed FCP DTDs for both versions", async () => {
    for (const profile of profiles) {
      const { xml } = await generate("fixtures/projects/std-25.zcut.json", profile);
      expect(await exporter.validate(xml)).toBe(true);
      expect(exporter.validationNotes).toContain("DTD 校验通过");
    }
  });
});
