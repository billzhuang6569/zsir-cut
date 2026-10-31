// biome-ignore-all lint/style/noNonNullAssertion: Fixture IDs and indexed entries are checked by test setup.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Clip,
  compare,
  displayRanges,
  mapClipTimeToSource,
  mapSourceTimeToClip,
  type Project,
  parseProject,
  printRational,
  projectSubtitles,
  rational,
  validateProjectSemantics,
} from "../src/index.js";

const seconds = (numerator: bigint, denominator = 1n) => rational(numerator, denominator);
function fixture(name: string, directory = "projects"): Project {
  const result = parseProject(
    readFileSync(new URL(`../../../fixtures/${directory}/${name}.zcut.json`, import.meta.url), "utf8"),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.project;
}
const compact = ({ words: _words, ...cue }: ReturnType<typeof projectSubtitles>["cues"][number]) => ({
  ...cue,
  start: printRational(cue.start, true),
  end: printRational(cue.end, true),
});

describe("time map", () => {
  it("evaluates original speed, 200%, segmented speed, hold, reverse and smooth approximation exactly", () => {
    const clip: Clip = {
      id: "clp_test",
      occurrence_id: "occ_test",
      media_id: "med_test",
      timeline_start: seconds(0n),
      duration: seconds(6n),
      source_start: seconds(10n),
    };
    expect(mapClipTimeToSource(clip, seconds(3n, 2n))).toEqual(seconds(23n, 2n));
    clip.time_map = [
      { at: seconds(0n), source: seconds(10n), interp: "linear" },
      { at: seconds(6n), source: seconds(22n), interp: "linear" },
    ];
    expect(mapClipTimeToSource(clip, seconds(3n, 2n))).toEqual(seconds(13n));
    expect(mapSourceTimeToClip(seconds(13n), clip.time_map[0]!, clip.time_map[1]!)).toEqual(seconds(3n, 2n));
    clip.time_map = [
      { at: seconds(0n), source: seconds(10n), interp: "linear" },
      { at: seconds(2n), source: seconds(14n), interp: "hold" },
      { at: seconds(3n), source: seconds(14n), interp: "smooth" },
      { at: seconds(4n), source: seconds(15n), interp: "linear" },
      { at: seconds(6n), source: seconds(11n), interp: "linear" },
    ];
    expect(mapClipTimeToSource(clip, seconds(1n))).toEqual(seconds(12n));
    expect(mapClipTimeToSource(clip, seconds(5n, 2n))).toEqual(seconds(14n));
    expect(mapClipTimeToSource(clip, seconds(7n, 2n))).toEqual(seconds(29n, 2n));
    expect(mapClipTimeToSource(clip, seconds(5n))).toEqual(seconds(13n));
    expect(mapSourceTimeToClip(seconds(29n, 2n), clip.time_map[2]!, clip.time_map[3]!)).toEqual(seconds(7n, 2n));
    expect(mapSourceTimeToClip(seconds(14n), clip.time_map[1]!, clip.time_map[2]!)).toBeNull();
    expect(mapSourceTimeToClip(seconds(13n), clip.time_map[3]!, clip.time_map[4]!)).toBeNull();
  });
});

describe("subtitle projection", () => {
  it.each([
    { name: "middle", hidden: [1], start: "6s", end: "7s", lines: ["一起", "切这个瓜"] },
    { name: "first", hidden: [0], start: "31/5s", end: "36/5s", lines: ["啊", "切这个瓜"] },
    { name: "last", hidden: [4], start: "6s", end: "7s", lines: ["一起啊", "切这个"] },
    { name: "all", hidden: [0, 1, 2, 3, 4], start: null, end: null, lines: [] },
  ])("keeps $name hidden tokens in the group and applies display timing", ({ hidden, start, end, lines }) => {
    const project = fixture("hidden-tokens", "regressions");
    const transcript = project.transcripts[0]!;
    for (const [index, token] of transcript.tokens.entries()) token.text = hidden.includes(index) ? "" : token.heard!;
    expect(validateProjectSemantics(project).filter((issue) => issue.severity === "error")).toEqual([]);
    const result = projectSubtitles(project, "tl_main");
    expect(result.unprojected).toEqual([]);
    expect(result.cues.map(compact)).toMatchObject(start ? [{ start, end, text: lines.join("\n"), lines }] : []);
    expect(result.cues).toHaveLength(start ? 1 : 0);
    expect(result.cues[0]?.token_ids).toEqual(
      start ? transcript.tokens.filter((token) => token.text).map((token) => token.id) : undefined,
    );
  });

  it.each([
    { breaks: ["tok_1"], lines: ["一起", "切这个瓜"] },
    { breaks: ["tok_3"], lines: ["一起切这个", "瓜"] },
    { breaks: ["tok_0", "tok_1", "tok_3"], lines: ["一起", "切这个", "瓜"] },
    { breaks: ["tok_4"], lines: ["一起切这个瓜"] },
    { breaks: ["tok_outside"], lines: ["一起切这个瓜"] },
  ])("filters stored breaks $breaks without recomputing them", ({ breaks, lines }) => {
    const project = fixture("hidden-tokens", "regressions");
    project.transcripts[0]!.cues[0]!.breaks = breaks;
    expect(projectSubtitles(project, "tl_main").cues[0]?.lines).toEqual(lines);
  });

  it("drops a leading hidden break and a trailing hidden break moved to the last visible word", () => {
    const project = fixture("hidden-tokens", "regressions");
    const transcript = project.transcripts[0]!;
    transcript.tokens[0]!.text = "";
    transcript.tokens[4]!.text = "";
    transcript.cues[0]!.breaks = ["tok_1", "tok_4"];
    expect(projectSubtitles(project, "tl_main").cues[0]?.lines).toEqual(["切这个"]);
  });

  it("filters original breaks again after merging jump cuts", () => {
    const project = fixture("hidden-tokens", "regressions");
    const transcript = project.transcripts[0]!;
    transcript.tokens[1]!.align.end = seconds(31n, 25n);
    transcript.tokens[2]!.align.start = seconds(31n, 25n);
    const track = project.timelines[0]!.tracks.find((track) => track.kind === "audio")!;
    if (track.kind !== "audio") throw new Error("Missing audio track");
    const clip = track.clips[0]!;
    track.clips = [
      { ...clip, source_start: seconds(1n), duration: seconds(1n, 5n) },
      {
        ...clip,
        id: "clp_jump",
        occurrence_id: "occ_jump",
        source_start: seconds(6n, 5n),
        timeline_start: seconds(26n, 5n),
        duration: seconds(4n, 5n),
      },
    ];
    transcript.cues[0]!.breaks = ["tok_0", "tok_1", "tok_3"];
    expect(projectSubtitles(project, "tl_main", undefined, false).cues.map((cue) => cue.lines)).toEqual([
      ["一起"],
      ["切这个", "瓜"],
    ]);
    const cues = projectSubtitles(project, "tl_main").cues;
    expect(cues).toHaveLength(1);
    expect(cues[0]!.clip_ids).toEqual(["clp_a1", "clp_jump"]);
    expect(cues[0]!.lines).toEqual(["一起", "切这个", "瓜"]);
    expect(
      cues[0]!.words?.map((word) => [word.text, printRational(word.start, true), printRational(word.end, true)]),
    ).toEqual([
      ["一起", "0s", "1/5s"],
      ["切", "6/25s", "3/5s"],
      ["这个", "3/5s", "4/5s"],
      ["瓜", "4/5s", "1s"],
    ]);
  });

  it("extends a cue with a hidden first word and preserves explicit timing", () => {
    const project = fixture("hidden-tokens", "regressions");
    const transcript = project.transcripts[0]!;
    transcript.tokens[0]!.text = "";
    const range = displayRanges(transcript)[0]!;
    expect([range.start, range.end]).toEqual([seconds(7n, 5n), seconds(12n, 5n)]);
    expect(projectSubtitles(project, "tl_main").cues.map(compact)).toMatchObject([{ start: "32/5s", end: "37/5s" }]);
    transcript.cues[0]!.timing = { start: seconds(4n, 5n), end: seconds(11n, 5n) };
    expect(projectSubtitles(project, "tl_main").cues.map(compact)).toMatchObject([{ start: "29/5s", end: "36/5s" }]);
  });

  it("keeps freeze-separated cue_zh_19 as two visible cues", () => {
    const cues = projectSubtitles(fixture("std-25"), "tl_std").cues.filter((cue) => cue.cue_id === "cue_zh_19");
    expect(cues).toHaveLength(2);
    expect(cues.map((cue) => cue.text)).toEqual(["哪些能保留", "要重做"]);
    expect(cues.map((cue) => cue.clip_ids)).toEqual([["clp_a8"], ["clp_a8"]]);
    expect(compare(cues[1]!.start, cues[0]!.end)).toBeGreaterThan(0);
  });
  for (const name of ["std-25", "std-2997-df", "std-2997-ndf"]) {
    it(`projects ${name} and matches its complete snapshot`, () => {
      const project = fixture(name);
      const result = projectSubtitles(project, "tl_std");
      expect({ cues: result.cues.map(compact), unprojected: result.unprojected }).toMatchSnapshot();
      expect(result.unprojected).toEqual([
        { clip_id: "clp_a8", token_id: "tok_129" },
        { clip_id: "clp_a8", token_id: "tok_en_19" },
      ]);
      expect(
        result.cues.filter((cue) => cue.cue_id === "cue_zh_19").map((cue) => [cue.clip_id, cue.piece, cue.text]),
      ).toEqual([
        ["clp_a8", 0, "哪些能保留"],
        ["clp_a8", 1, "要重做"],
      ]);
      expect(result.cues.find((cue) => cue.cue_id === "cue_title")).toMatchObject({
        clip_id: null,
        occurrence_id: null,
        text: "zsir-cut 标准测试工程",
        lines: ["zsir-cut 标准测试工程"],
      });
      expect(new Set(validateProjectSemantics(project).map((issue) => issue.code))).toEqual(
        new Set(["W_VFR", "W_TIMEMAP_APPROX", "W_SUB_UNPROJECTED", "W_SUB_TOO_WIDE", "W_SUB_SHORT"]),
      );
    });
  }

  it("clips the Chinese cut, keeps English word spaces and applies occurrence text", () => {
    const { cues } = projectSubtitles(fixture("std-25"), "tl_std");
    expect(cues.find((cue) => cue.cue_id === "cue_zh_04")).toMatchObject({
      clip_id: "clp_a1",
      text: "然后",
      end: seconds(48n, 5n),
      token_ids: ["tok_025"],
    });
    expect(cues.find((cue) => cue.cue_id === "cue_zh_16")?.text).toBe("every cut must be frame accurate");
    expect(cues.find((cue) => cue.cue_id === "cue_zh_08")?.text).toBe("我们希望把这部分交给Agent（改）");
    expect(cues.every((cue) => !cue.text.includes("嗯"))).toBe(true);
    expect(cues.find((cue) => cue.cue_id === "cue_zh_02")?.lines).toEqual(["剪辑师和", "Agent共用的时间线"]);
  });

  it("respects hidden and manual timing, and accepts future source display ranges", () => {
    const project = fixture("std-25");
    const subtitle = project.timelines[0]!.tracks.find((track) => track.id === "trk_sub_zh");
    if (!subtitle || subtitle.kind !== "subtitle") throw new Error("Missing subtitle track");
    subtitle.overrides.push({ occurrence_id: "occ_1", cue_id: "cue_zh_02", hidden: true });
    const transcript = project.transcripts.find((item) => item.language === "zh-Hans")!;
    const cue = transcript.cues.find((item) => item.id === "cue_zh_04")!;
    cue.timing = { start: seconds(20n), end: seconds(22n) };
    const result = projectSubtitles(project, "tl_std", (item) =>
      item.id === "cue_zh_04" ? { start: seconds(19n), end: seconds(23n) } : undefined,
    );
    expect(result.cues.some((item) => item.cue_id === "cue_zh_02")).toBe(false);
    expect(result.cues.find((item) => item.cue_id === "cue_zh_04")?.start).toEqual(seconds(222n, 25n));
    expect(result.cues.find((item) => item.cue_id === "cue_zh_04")?.end).toEqual(seconds(48n, 5n));
    delete cue.timing;
    expect(
      projectSubtitles(project, "tl_std", (item) =>
        item.id === "cue_zh_04" ? { start: seconds(20n), end: seconds(23n) } : undefined,
      ).cues.find((item) => item.cue_id === "cue_zh_04")?.start,
    ).toEqual(seconds(222n, 25n));
  });

  it("uses override, cue and track styles in order, and splits override text on newlines", () => {
    const project = fixture("std-25");
    const subtitle = project.timelines[0]!.tracks.find((track) => track.id === "trk_sub_zh");
    if (!subtitle || subtitle.kind !== "subtitle") throw new Error("Missing subtitle track");
    const override = subtitle.overrides.find((item) => item.cue_id === "cue_zh_08")!;
    const cue = project.transcripts[0]!.cues.find((item) => item.id === "cue_zh_08")!;
    cue.style_id = "sty_en";
    override.style_id = "sty_title";
    override.text = "第一行\nSecond line";
    const projected = () => projectSubtitles(project, "tl_std").cues.find((item) => item.cue_id === "cue_zh_08")!;
    expect(projected()).toMatchObject({
      style_id: "sty_title",
      text: "第一行\nSecond line",
      lines: ["第一行", "Second line"],
    });
    delete override.style_id;
    expect(projected().style_id).toBe("sty_en");
    delete cue.style_id;
    expect(projected().style_id).toBe("sty_zh");
  });

  it("does not project a token dominated by reverse playback", () => {
    const project = fixture("std-25");
    const track = project.timelines[0]!.tracks.find((item) => item.id === "trk_a1");
    if (!track || track.kind !== "audio") throw new Error("Missing audio track");
    const clip = track.clips.find((item) => item.id === "clp_a8")!;
    clip.source_start = seconds(98n);
    clip.time_map = [
      { at: seconds(0n), source: seconds(98n), interp: "linear" },
      { at: seconds(6n), source: seconds(92n), interp: "linear" },
    ];
    const result = projectSubtitles(project, "tl_std");
    expect(result.cues.filter((item) => item.clip_id === "clp_a8")).toEqual([]);
    expect(result.unprojected).toContainEqual({ clip_id: "clp_a8", token_id: "tok_126" });
  });

  it("uses the half-overlap boundary and half-open hold instant", () => {
    const project = fixture("std-25");
    const transcript = project.transcripts.find((item) => item.language === "zh-Hans")!;
    const cut = transcript.tokens.find((item) => item.id === "tok_025")!;
    expect(projectSubtitles(project, "tl_std").cues.some((item) => item.cue_id === "cue_zh_04")).toBe(true);
    cut.align.start = seconds(2051n, 100n);
    expect(projectSubtitles(project, "tl_std").cues.some((item) => item.cue_id === "cue_zh_04")).toBe(false);
    const hold = transcript.tokens.find((item) => item.id === "tok_129")!;
    hold.align.end = seconds(484n, 5n);
    const result = projectSubtitles(project, "tl_std");
    expect(result.unprojected).not.toContainEqual({ clip_id: "clp_a8", token_id: "tok_129" });
  });
});

it("projects visible word alignments relative to each cue, including speed, display punctuation and overrides", () => {
  const project = fixture("hidden-tokens", "regressions");
  const audio = project.timelines[0]!.tracks.find((track) => track.kind === "audio")!;
  if (audio.kind !== "audio") throw new Error("audio");
  audio.clips[0]!.duration = seconds(3n, 2n);
  audio.clips[0]!.time_map = [
    { at: seconds(0n), source: seconds(0n), interp: "linear" },
    { at: seconds(3n, 2n), source: seconds(3n), interp: "linear" },
  ];
  const cue = projectSubtitles(project, "tl_main").cues[0]!;
  expect(cue.start).toEqual(seconds(11n, 2n));
  expect(cue.words?.map((word) => word.text).join("")).toBe(cue.text.replaceAll("\n", ""));
  expect(cue.words?.map((word) => [printRational(word.start, true), printRational(word.end, true)])).toEqual([
    ["0s", "1/10s"],
    ["1/5s", "3/10s"],
    ["3/10s", "2/5s"],
    ["2/5s", "1/2s"],
  ]);
  const track = project.timelines[0]!.tracks.find((track) => track.kind === "subtitle")!;
  if (track.kind !== "subtitle") throw new Error("subtitle");
  track.overrides.push({ occurrence_id: audio.clips[0]!.occurrence_id, cue_id: cue.cue_id, text: "替换" });
  expect(projectSubtitles(project, "tl_main").cues[0]?.words).toBeUndefined();
});
