import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { compareCuttingLists, cuttingList, parseProject, rational } from "../../core/src/index.js";
import exporter from "../src/index.js";

for (const profile of [
  "fcp-11-fcpxml-1.13",
  "fcp-10.6-fcpxml-1.11",
  "resolve-18.5-otio",
  "premiere-25-xmeml-5",
] as const) {
  it(`${profile} preserves three linked splits and an audio-only split at every cut`, async () => {
    const parsed = parseProject(await readFile("fixtures/regressions/split-occurrence-export.zcut.json", "utf8"));
    if (!parsed.ok || !parsed.project.timelines[0]) throw new Error("Invalid split fixture");
    const project = parsed.project;
    const timeline = project.timelines[0];
    const paths = new Map(project.media.map((media) => [media.id, resolve("fixtures/.media/split.mov")]));
    const { data } = await exporter.generate(project, timeline, profile, paths);
    const expected = cuttingList(project, timeline, profile);
    const actual = await exporter.readBack(data, timeline);
    expect(actual.map(({ timeline_in_exact: _in, timeline_out_exact: _out, ...row }) => row)).toEqual(expected);
    expect(actual).toHaveLength(9);
    expect(compareCuttingLists(expected, actual).zero_frame_deviation).toBe(true);
    expect(await exporter.validate(data)).toBe(true);
    expect((await exporter.generate(project, timeline, profile, paths)).data).toBe(data);
    const changed = actual.map((row, index) => (index === 1 ? { ...row, source_out: row.source_out + 1 } : row));
    expect(compareCuttingLists(expected, changed).zero_frame_deviation).toBe(false);
    expect(
      compareCuttingLists(
        expected,
        actual.map((row) => ({ ...row, clip_id: "wrong_clip" })),
      ).zero_frame_deviation,
    ).toBe(false);
    if (profile.startsWith("fcp-")) {
      expect(data.toString().match(/srcEnable="all"/g)).toHaveLength(3);
      expect(data.toString()).toContain('value="clp_a3"');
      expect(data.toString()).not.toContain('key="com.zsir-cut.audio-clip-id" value="clp_a4"');
    }
  });
}

it("does not pair ambiguous or differently mapped audio segments", async () => {
  const parsed = parseProject(await readFile("fixtures/regressions/split-occurrence-export.zcut.json", "utf8"));
  if (!parsed.ok || !parsed.project.timelines[0]) throw new Error("Invalid split fixture");
  const project = parsed.project;
  const timeline = project.timelines[0];
  const audio = timeline.tracks.find((track) => track.kind === "audio");
  if (!audio || audio.kind === "subtitle" || !audio.clips[0]) throw new Error("Missing audio");
  const paths = new Map(project.media.map((media) => [media.id, resolve("fixtures/.media/split.mov")]));
  const first = audio.clips[0];
  audio.clips.push({ ...first, id: "clp_ambiguous" });
  let result = await exporter.generate(project, timeline, "fcp-11-fcpxml-1.13", paths);
  expect(result.data.toString()).not.toContain('key="com.zsir-cut.audio-clip-id" value="clp_a1"');
  audio.clips.pop();
  first.source_start = { numerator: 1n, denominator: 1n };
  result = await exporter.generate(project, timeline, "fcp-11-fcpxml-1.13", paths);
  expect(result.data.toString()).not.toContain('key="com.zsir-cut.audio-clip-id" value="clp_a1"');
});

it.each([
  [30n, 1n, 150, 6, 102],
  [60n, 1n, 300, 12, 204],
  [60000n, 1001n, 60000, 2400, 40800],
])(
  "preserves exact subframe starts at %s/%s fps with the smallest integer multiplier",
  async (n, d, rate, start, duration) => {
    const parsed = parseProject(await readFile("fixtures/regressions/split-occurrence-export.zcut.json", "utf8"));
    if (!parsed.ok) throw new Error("Invalid split fixture");
    const project = parsed.project;
    const media = project.media[0];
    const timeline = project.timelines[0];
    if (!media?.video || !timeline) throw new Error("Missing media or timeline");
    media.video.rate = rational(n, d);
    const paths = new Map([[media.id, resolve("fixtures/.media/split.mov")]]);
    const { data } = await exporter.generate(project, timeline, "resolve-18.5-otio", paths);
    const root = JSON.parse(data.toString());
    for (const track of root.tracks.children) {
      expect(track.children[1].source_range).toMatchObject({
        start_time: { rate, value: start },
        duration: { rate, value: duration },
      });
      expect(track.children[1].media_references.DEFAULT_MEDIA.available_range.start_time.rate).toBe(
        Number(n) / Number(d),
      );
    }
    const expected = cuttingList(project, timeline, "resolve-18.5-otio");
    expect(await exporter.readBack(data, timeline)).toEqual(expected);
    expect(await exporter.validate(data)).toBe(true);
    root.tracks.children[0].children[1].source_range.start_time.value += rate / (Number(n) / Number(d));
    expect(
      compareCuttingLists(expected, await exporter.readBack(JSON.stringify(root), timeline)).zero_frame_deviation,
    ).toBe(false);
  },
);

it("uses the least common denominator for subframe start and duration, including reverse and media timecode", async () => {
  const parsed = parseProject(await readFile("fixtures/regressions/split-occurrence-export.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("Invalid split fixture");
  const project = parsed.project;
  const media = project.media[0];
  const timeline = project.timelines[0];
  const track = timeline?.tracks[0];
  if (!media || !timeline || !track || track.kind === "subtitle" || !track.clips[0]) throw new Error("Missing clip");
  media.start_timecode = "00:00:01:00";
  timeline.tracks = [track];
  track.clips = [track.clips[0]];
  const clip = track.clips[0];
  clip.source_start = rational(1n, 90n);
  const paths = new Map([[media.id, resolve("fixtures/.media/split.mov")]]);
  for (const reverse of [false, true]) {
    if (reverse) {
      clip.source_start = rational(23n, 450n);
      clip.time_map = [
        { at: rational(0n), source: clip.source_start, interp: "linear" },
        { at: clip.duration, source: rational(1n, 90n), interp: "linear" },
      ];
    }
    const { data } = await exporter.generate(project, timeline, "resolve-18.5-otio", paths);
    const outer = JSON.parse(data.toString()).tracks.children[0].children[0];
    const child = reverse ? outer.children[0].children[0] : outer;
    expect(child.source_range).toMatchObject({
      start_time: { rate: 450, value: 455 },
      duration: { rate: 450, value: 18 },
    });
    expect(await exporter.readBack(data, timeline)).toEqual(cuttingList(project, timeline, "resolve-18.5-otio"));
    expect(await exporter.validate(data)).toBe(true);
  }
});
