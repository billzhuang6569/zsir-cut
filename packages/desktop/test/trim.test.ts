// biome-ignore-all lint/style/noNonNullAssertion: Test fixture entities are known and asserted in setup.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dispatch, parseProject, printRational, projectSubtitles, serializeProject } from "../../core/src/index.js";
import { applyEdit } from "../../core/src/project/edit.js";
import { inspect } from "../../core/src/read-views.js";
import type { ProjectView } from "../src/connection.js";
import { add, frameAt, frameTime, parseRational, rational, sub, type TranscriptView } from "../src/timeline.js";
import { cueTrimTarget, trimGroup, trimTarget } from "../src/timelineTrim.js";

function fixture() {
  const parsed = parseProject(readFileSync("fixtures/regressions/trim-source-ntsc.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const timeline = parsed.project.timelines[0];
  if (!timeline) throw new Error("fixture");
  const view: ProjectView = {
    id: timeline.id,
    name: timeline.name,
    revision: parsed.project.revision,
    edit_rate: printRational(timeline.edit_rate),
    start_timecode: timeline.start_timecode,
    drop_frame: false,
    duration: { t: "10s" },
    cues: [],
    styles: [],
    markers: [],
    media: parsed.project.media.map((media) => ({
      id: media.id,
      kind: media.kind,
      duration: printRational(media.duration, true),
    })),
    tracks: timeline.tracks
      .filter((track) => track.kind !== "subtitle")
      .map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          label: null,
          enabled: true,
          speed: "1",
          timeline_in: { t: printRational(clip.timeline_start, true) },
          timeline_out: { t: printRational(add(clip.timeline_start, clip.duration), true) },
          source_in: { t: printRational(clip.source_start, true) },
          source_out: { t: printRational(add(clip.source_start, clip.duration), true) },
        })),
      })),
  };
  const anchor = view.tracks[0]?.clips[0];
  if (!anchor) throw new Error("fixture clip");
  return { project: parsed.project, timeline, view, anchor };
}

it.each(["in", "out"] as const)("keeps %s trim exact on 30000/1001 through core", (edge) => {
  const { project, timeline, view, anchor } = fixture();
  const result = trimTarget(view, anchor, edge, true, 48, 48, false, "0s");
  expect(result.blocked).toBe(false);
  expect(result.to).toBe(frameTime(edge === "in" ? 90n : 150n, view.edit_rate));
  applyEdit(
    project,
    [{ op: "trim", clip_id: anchor.id, edge, to: result.to, linked: true, ripple: false }],
    {},
    "test",
  );
  for (const track of timeline.tracks) {
    if (track.kind === "subtitle") continue;
    expect(printRational(track.clips[0]?.duration ?? parseRational("0s", true), true)).toBe(
      frameTime(edge === "in" ? 30n : 90n, view.edit_rate),
    );
  }
});

it("clamps source ends inward, preserves a frame, and blocks releases outside the legal range", () => {
  const { view, anchor } = fixture();
  const target = (edge: "in" | "out", pixels: number) => trimTarget(view, anchor, edge, true, pixels, 48, false, "0s");
  expect(target("in", -200)).toMatchObject({ to: "1001/1000s", blocked: true });
  expect(target("out", 1000)).toMatchObject({ to: "7007/1000s", blocked: true });
  expect(target("in", 1000)).toMatchObject({ to: frameTime(119n, view.edit_rate), blocked: true });
  expect(target("out", -1000)).toMatchObject({ to: frameTime(61n, view.edit_rate), blocked: true });
  for (const edge of ["in", "out"] as const)
    for (const pixels of [-1000, -48, -1, 0, 1, 48, 1000]) {
      const result = target(edge, pixels);
      expect(frameTime(frameAt(result.to, view.edit_rate), view.edit_rate)).toBe(result.to);
    }
});

it("checks linked source limits and both-track neighbors, while J/L cut edges stay independent", () => {
  const { view, anchor } = fixture();
  const audio = view.tracks[1]?.clips[0];
  if (!audio || !view.tracks[1]) throw new Error("audio fixture");
  audio.media_id = "short";
  view.media.push({ id: "short", kind: "audio", duration: "1001/250s" });
  expect(trimTarget(view, anchor, "out", true, 96, 48, false, "0s")).toMatchObject({ to: "1001/200s", blocked: true });
  expect(trimTarget(view, anchor, "out", false, 96, 48, false, "0s").blocked).toBe(false);
  view.tracks[1].clips.push({
    ...audio,
    id: "neighbor",
    occurrence_id: "other",
    timeline_in: { t: "1001/200s" },
    timeline_out: { t: "3003/500s" },
  });
  audio.media_id = anchor.media_id;
  expect(trimTarget(view, anchor, "out", true, 96, 48, false, "0s")).toMatchObject({
    to: "1001/200s",
    blocked: true,
    reason: "这里修剪不了：会和其他片段重叠",
  });
  audio.timeline_out.t = "3003/1000s";
  expect(trimGroup(view, anchor, "out", true).map((clip) => clip.id)).toEqual([anchor.id]);
  expect(trimGroup(view, anchor, "in", true).map((clip) => clip.id)).toEqual([anchor.id, audio.id]);
});

it("snaps the moving edge to nearest markers, playhead and stationary clip edges, with the existing toggle", () => {
  const { view, anchor } = fixture();
  view.markers = [{ id: "m", at: { t: "3003/500s" }, text: "标记", kind: "review" }];
  const target = (snap: boolean, head = "0s") => trimTarget(view, anchor, "out", true, 95, 48, snap, head);
  expect(target(true)).toMatchObject({ to: "3003/500s", line: "3003/500s", blocked: false });
  expect(target(false).line).toBeNull();
  view.markers = [];
  expect(target(true, "3003/500s").line).toBe("3003/500s");
  view.tracks[0]?.clips.push({
    ...anchor,
    id: "other",
    occurrence_id: "other",
    timeline_in: { t: "3003/500s" },
    timeline_out: { t: "7s" },
  });
  expect(target(true)).toMatchObject({ line: "3003/500s", blocked: false });
});

it("refuses a linked time map and safely handles missing source metadata and image source zero", () => {
  const { view, anchor } = fixture();
  const audio = view.tracks[1]?.clips[0];
  if (!audio) throw new Error("audio");
  audio.time_map = [];
  expect(trimTarget(view, anchor, "out", true, 48, 48, false, "0s").reason).toBe("变速片段暂不支持拖动修剪");
  expect(trimTarget(view, anchor, "out", false, 48, 48, false, "0s").blocked).toBe(false);
  view.media = [];
  expect(trimTarget(view, anchor, "out", false, 48, 48, false, "0s").blocked).toBe(true);
  view.media = [{ id: anchor.media_id, kind: "image", duration: "10s" }];
  const result = trimTarget(view, anchor, "in", false, -48, 48, false, "0s");
  expect(result.blocked).toBe(false);
  expect(sub(parseRational(anchor.timeline_out.t, true), parseRational(result.to, true)).numerator).toBeGreaterThan(0n);
});

it("stops leftward expansion at linked left neighbors, allowing touching edges", () => {
  const { view, anchor } = fixture();
  const audioTrack = view.tracks[1];
  if (!audioTrack) throw new Error("audio fixture");
  audioTrack.clips.push({
    ...anchor,
    id: "left",
    occurrence_id: "other",
    enabled: false,
    timeline_in: { t: "0s" },
    timeline_out: { t: "1001/750s" },
  });
  expect(trimTarget(view, anchor, "in", true, -96, 48, false, "0s")).toMatchObject({
    to: "1001/750s",
    blocked: true,
    reason: "这里修剪不了：会和其他片段重叠",
  });
  const result = trimTarget(view, anchor, "in", true, -32, 48, true, "0s");
  expect(result).toMatchObject({ to: "1001/750s", blocked: false });
});

function subtitleFixture() {
  const view: ProjectView = {
    id: "tl",
    name: "字幕时间",
    revision: { id: "rev", seq: 0 },
    edit_rate: "25",
    start_timecode: "00:00:00:00",
    drop_frame: false,
    duration: { t: "30s" },
    markers: [],
    media: [],
    styles: [],
    tracks: [
      {
        id: "a",
        name: "声音 A",
        kind: "audio",
        enabled: true,
        clips: [
          {
            id: "clip",
            occurrence_id: "occ",
            media_id: "media",
            label: null,
            enabled: true,
            speed: "1",
            timeline_in: { t: "10s" },
            timeline_out: { t: "20s" },
            source_in: { t: "20s" },
            source_out: { t: "30s" },
          },
        ],
      },
      { id: "s", name: "字幕 A", kind: "subtitle", enabled: true, clips: [] },
    ],
    cues: [
      { cue_id: "before", track_id: "s", start: "10s", end: "11s", text: "前", piece: 0, style_id: "style" },
      {
        cue_id: "cue",
        track_id: "s",
        transcript_id: "tr",
        clip_ids: ["clip"],
        occurrence_id: "occ",
        start: "12s",
        end: "14s",
        text: "字幕",
        piece: 0,
        style_id: "style",
      },
      { cue_id: "after", track_id: "s", start: "15s", end: "16s", text: "后", piece: 0, style_id: "style" },
    ],
    transcripts: [
      {
        id: "tr",
        media_id: "media",
        tokens: [
          { id: "p", text: "前", align: { start: "20s", end: "21s" } },
          { id: "t1", text: "字", align: { start: "22s", end: "23s" } },
          { id: "t2", text: "幕", align: { start: "233/10s", end: "24s" } },
          { id: "n", text: "后", align: { start: "25s", end: "26s" } },
        ],
        cues: [{ id: "cue", first_token: "t1", last_token: "t2", timing: { end: "24s", locked: true } }],
      },
    ],
  };
  const cue = view.cues[1];
  if (!cue) throw new Error("subtitle fixture");
  return { view, cue };
}

it("snaps subtitle edges to exact unquantized word boundaries, preserving the other manual edge", () => {
  const { view, cue } = subtitleFixture();
  expect(cueTrimTarget(view, cue, "out", -32, 48, true, "0s")).toMatchObject({
    to: "133/10s",
    line: "133/10s",
    op: { op: "set_cue", cue_id: "cue", timing: { end: "233/10s", locked: true } },
  });
  expect(cueTrimTarget(view, cue, "out", -32, 48, false, "0s")).toMatchObject({ to: "333/25s", line: null });
  expect(cueTrimTarget(view, cue, "in", -46, 48, true, "0s")).toMatchObject({
    to: "11s",
    line: "11s",
    op: { timing: { start: "21s", end: "24s", locked: true } },
  });
});

it.each(["in", "out"] as const)("clamps subtitle %s to neighbors and a frame, including NTSC", (edge) => {
  const { view, cue } = subtitleFixture();
  const target = (pixels: number) => cueTrimTarget(view, cue, edge, pixels, 48, false, "0s");
  expect(target(edge === "in" ? -1000 : 1000)?.to).toBe(edge === "in" ? "11s" : "15s");
  expect(target(edge === "in" ? 1000 : -1000)?.to).toBe(edge === "in" ? "349/25s" : "301/25s");
  view.edit_rate = "30000/1001";
  expect(target(edge === "in" ? 1000 : -1000)?.to).toBe(edge === "in" ? "418999/30000s" : "361001/30000s");
  view.cues = [cue];
  expect(target(edge === "in" ? -1000 : 1000)?.to).toBe(edge === "in" ? "10s" : "20s");
});

it.each(["playhead", "video", "audio", "cue"])("snaps subtitle edges to %s using the clip snap distance", (kind) => {
  const { view, cue } = subtitleFixture();
  let playhead = "0s";
  const at = "29/2s";
  if (kind === "playhead") playhead = at;
  else if (kind === "cue") view.cues[2] = { ...cue, cue_id: "next", start: at, end: "16s" };
  else
    view.tracks.push({
      id: "other",
      name: "other",
      kind,
      enabled: true,
      clips: [{ ...view.tracks[0]!.clips[0]!, id: "other", timeline_in: { t: at }, timeline_out: { t: "16s" } }],
    });
  expect(cueTrimTarget(view, cue, "out", 23, 48, true, playhead)).toMatchObject({ to: at, line: at });
  expect(cueTrimTarget(view, cue, "out", 23, 48, false, playhead)?.line).toBeNull();
});

it("inverts forward speed maps rationally and refuses hold/reverse, missing metadata and free cues", () => {
  const { view, cue } = subtitleFixture();
  const clip = view.tracks[0]!.clips[0]!;
  clip.time_map = [
    { at: { t: "10s" }, source: { t: "20s" }, interp: "smooth" },
    { at: { t: "20s" }, source: { t: "40s" }, interp: "linear" },
  ];
  view.transcripts![0]!.cues[0]!.timing = { end: "28s" };
  expect(cueTrimTarget(view, cue, "in", 24, 48, false, "0s")?.op.timing).toMatchObject({
    start: "626/25s",
    end: "28s",
  });
  clip.time_map[0]!.interp = "hold";
  expect(cueTrimTarget(view, cue, "in", 24, 48, false, "0s")).toBeNull();
  clip.time_map[0]!.interp = "linear";
  clip.time_map[1]!.source.t = "0s";
  expect(cueTrimTarget(view, cue, "in", 24, 48, false, "0s")).toBeNull();
  view.transcripts = [];
  expect(cueTrimTarget(view, cue, "in", 24, 48, false, "0s")).toBeNull();
});

it("chooses the correct source carrier at either end of a jump-cut-merged subtitle", () => {
  const { view, cue } = subtitleFixture();
  const clip = view.tracks[0]!.clips[0]!;
  clip.timeline_out.t = "13s";
  clip.source_out.t = "23s";
  view.tracks[0]!.clips.push({
    ...clip,
    id: "clip2",
    occurrence_id: "occ2",
    timeline_in: { t: "13s" },
    timeline_out: { t: "20s" },
    source_in: { t: "27s" },
    source_out: { t: "34s" },
  });
  cue.clip_ids = ["clip", "clip2"];
  view.transcripts![0]!.tokens[2]!.align = { start: "273/10s", end: "28s" };
  view.transcripts![0]!.cues[0]!.timing = { end: "28s" };
  expect(cueTrimTarget(view, cue, "in", -24, 48, false, "0s")?.op.timing).toMatchObject({ start: "538/25s" });
  expect(cueTrimTarget(view, cue, "out", 24, 48, false, "0s")?.op.timing).toMatchObject({ end: "713/25s" });
});

it("writes subtitle timing and restores automatic time through core, undoing each gesture in one step", async () => {
  const directory = await mkdtemp(".subtitle-trim-");
  const path = join(directory, "project.zcut.json");
  try {
    const bytes = readFileSync("fixtures/projects/std-25.zcut.json", "utf8");
    await writeFile(path, bytes);
    const parsed = parseProject(bytes);
    if (!parsed.ok) throw new Error("fixture");
    const project = parsed.project;
    const raw = JSON.parse(serializeProject(project));
    const timeline = await inspect(project, path, { view: "timeline" });
    const cues = projectSubtitles(project, project.timelines[0]!.id).cues.map((cue) => ({
      ...cue,
      start: printRational(cue.start, true),
      end: printRational(cue.end, true),
      transcript_id: raw.transcripts.find((item: TranscriptView) => item.cues.some((row) => row.id === cue.cue_id))?.id,
    }));
    const view = {
      ...timeline,
      cues,
      transcripts: raw.transcripts,
      media: [],
      styles: [],
      revision: project.revision,
    } as ProjectView;
    const cue = cues[0]!;
    const target = cueTrimTarget(view, cue, "in", 8, 48, false, "0s");
    expect(target).not.toBeNull();
    const author = { kind: "human", name: "桌面用户" };
    const edit = await dispatch("edit", {
      project: path,
      base_revision: project.revision.id,
      idempotency_key: "trim",
      author,
      label: "调整字幕时间",
      timeline_id: view.id,
      ops: [target!.op],
    });
    expect(edit.status, JSON.stringify(edit)).toBe("applied");
    const load = async () => {
      const result = parseProject(await readFile(path, "utf8"));
      if (!result.ok) throw new Error("written project");
      return result.project;
    };
    const trimmed = await load();
    const projected = projectSubtitles(trimmed, view.id).cues[0]!;
    expect(printRational(projected.start, true)).toBe(target!.to);
    const journal = (await readFile(join(directory, ".zcut", project.id, "journal.jsonl"), "utf8")).trim().split("\n");
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!)).toMatchObject({ label: "调整字幕时间" });
    const restored = await dispatch("edit", {
      project: path,
      base_revision: trimmed.revision.id,
      idempotency_key: "restore",
      author,
      label: "恢复自动时间",
      ops: [{ op: "set_cue", cue_id: cue.cue_id, timing: null }],
    });
    expect(restored.status, JSON.stringify(restored)).toBe("applied");
    const automatic = await load();
    expect(automatic.transcripts).toEqual(project.transcripts);
    const undo = async (key: string) =>
      dispatch("undo", { project: path, base_revision: (await load()).revision.id, idempotency_key: key, author });
    expect((await undo("undo-restore")).status).toBe("applied");
    expect((await load()).transcripts).toEqual(trimmed.transcripts);
    expect((await undo("undo-trim")).status).toBe("applied");
    const original = await load();
    original.revision = project.revision;
    expect(serializeProject(original)).toBe(serializeProject(project));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps word snapping exact beyond the safe integer range and accepts an equivalent cue view", () => {
  const { view, cue } = subtitleFixture();
  const offset = rational(9007199254740993n);
  const shift = (time: string) => printRational(add(offset, parseRational(time, true)), true);
  for (const item of view.cues) {
    item.start = shift(item.start);
    item.end = shift(item.end);
  }
  for (const clip of view.tracks.flatMap((track) => track.clips))
    for (const time of [clip.timeline_in, clip.timeline_out, clip.source_in, clip.source_out]) time.t = shift(time.t);
  for (const token of view.transcripts![0]!.tokens) {
    token.align.start = shift(token.align.start);
    token.align.end = shift(token.align.end);
  }
  expect(cueTrimTarget(view, { ...cue }, "out", -32, 48, true, "0s")).toMatchObject({
    to: shift("133/10s"),
    line: shift("133/10s"),
    op: { timing: { end: shift("233/10s") } },
  });
});

it("refuses an internal projected edge that set_cue cannot change", () => {
  const { view, cue } = subtitleFixture();
  cue.token_ids = ["t2"];
  expect(cueTrimTarget(view, cue, "in", 8, 48, false, "0s")).toBeNull();
  expect(cueTrimTarget(view, cue, "out", 8, 48, false, "0s")).not.toBeNull();
  cue.token_ids = ["t1"];
  expect(cueTrimTarget(view, cue, "in", 8, 48, false, "0s")).not.toBeNull();
  expect(cueTrimTarget(view, cue, "out", 8, 48, false, "0s")).toBeNull();
});

it("keeps a manual edge at a retime knot on its original token's forward segment", () => {
  const { view, cue } = subtitleFixture();
  const clip = view.tracks[0]!.clips[0]!;
  clip.time_map = [
    { at: { t: "10s" }, source: { t: "20s" }, interp: "linear" },
    { at: { t: "13s" }, source: { t: "23s" }, interp: "linear" },
    { at: { t: "20s" }, source: { t: "37s" }, interp: "linear" },
  ];
  cue.start = "13s";
  expect(cueTrimTarget(view, cue, "in", -24, 48, false, "0s")?.op.timing).toMatchObject({ start: "563/25s" });
  expect(cueTrimTarget(view, cue, "in", 24, 48, false, "0s")?.to).toBe("13s");
});
