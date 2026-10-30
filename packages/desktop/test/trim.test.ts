import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseProject, printRational } from "../../core/src/index.js";
import { applyEdit } from "../../core/src/project/edit.js";
import type { ProjectView } from "../src/connection.js";
import { add, frameAt, frameTime, parseRational, sub } from "../src/timeline.js";
import { trimGroup, trimTarget } from "../src/timelineTrim.js";

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
