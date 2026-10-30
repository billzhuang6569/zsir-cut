import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseProject, printRational } from "../../core/src/index.js";
import { applyEdit } from "../../core/src/project/edit.js";
import type { ProjectView } from "../src/connection.js";
import { add, frameAt, frameTime, parseRational } from "../src/timeline.js";
import { moveGroup, moveOverlaps, moveTarget } from "../src/timelineMove.js";

const bytes = readFileSync("fixtures/regressions/move-snap-ntsc.zcut.json", "utf8");
function fixture() {
  const parsed = parseProject(bytes);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const timeline = parsed.project.timelines[0];
  if (!timeline) throw new Error("fixture timeline");
  const view: ProjectView = {
    id: timeline.id,
    name: timeline.name,
    revision: parsed.project.revision,
    edit_rate: printRational(timeline.edit_rate),
    start_timecode: timeline.start_timecode,
    drop_frame: timeline.drop_frame,
    duration: { t: "10s" },
    cues: [],
    styles: [],
    media: [],
    markers: timeline.markers.map((marker) => ({ ...marker, at: { t: printRational(marker.at, true) } })),
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
          source_in: { t: "0s" },
          source_out: { t: printRational(clip.duration, true) },
        })),
      })),
  };
  return { project: parsed.project, timeline, view };
}

it("keeps the earliest linked offset rational at 30000/1001 through core move and frame grid", () => {
  const { project, timeline, view } = fixture();
  const group = moveGroup(view, ["clp_v1"], "clp_v1");
  expect(group.moving.map((clip) => clip.id)).toEqual(["clp_v1", "clp_a1"]);
  const target = moveTarget(view, group, 48, 48, false, "0s");
  expect(target.to).toBe("1001/500s");
  expect(frameAt(target.to, view.edit_rate)).toBe(60n);
  applyEdit(project, [{ op: "move", clip_ids: ["clp_v1"], to: target.to }], {}, "test");
  const starts = timeline.tracks.flatMap((track) =>
    track.kind === "subtitle" ? [] : track.clips.map((clip) => printRational(clip.timeline_start, true)),
  );
  expect(starts).toEqual([frameTime(90n, view.edit_rate), frameTime(60n, view.edit_rate)]);
  for (const pixels of [-1000, -48, 0, 1, 47, 48, 500]) {
    const result = moveTarget(view, group, pixels, 48, true, "0s");
    expect(frameTime(frameAt(result.to, view.edit_rate), view.edit_rate)).toBe(result.to);
    expect(parseRational(result.to, true).numerator).toBeGreaterThanOrEqual(0n);
  }
});

it("chooses the truly nearest candidate regardless of iteration order, including playhead and both edges", () => {
  const { view } = fixture();
  const group = moveGroup(view, [], "clp_v1");
  const result = moveTarget(view, group, 95, 48, true, "0s");
  expect(result.line).toBe("3003/500s");
  const reverse = { ...view, markers: [...view.markers].reverse() };
  expect(moveTarget(reverse, group, 95, 48, true, "0s")).toEqual(result);
  expect(moveTarget(view, group, 95, 48, false, "0s").line).toBeNull();
  expect(moveTarget({ ...view, markers: [] }, group, 95, 48, true, "3003/500s").line).toBe("3003/500s");
  expect(moveTarget({ ...view, markers: [] }, group, 95, 48, true, "10s").line).toBeNull();
});

it.each([
  { ids: ["clp_v1"], track: "trk_v2", error: null },
  { ids: ["clp_v1"], track: "trk_a1", error: "Destination track kind differs" },
  { ids: ["clp_v1", "clp_a1"], track: "trk_v2", error: "Track change requires a single requested clip" },
])("leaves cross-track limits to core: $track, $ids", ({ ids, track, error }) => {
  const { project, timeline } = fixture();
  const edit = () => applyEdit(project, [{ op: "move", clip_ids: ids, to: "1001/500s", track_id: track }], {}, "test");
  if (error) expect(edit).toThrow(error);
  else {
    edit();
    expect(timeline.tracks.find((item) => item.id === track)?.kind).toBe("video");
    const target = timeline.tracks.find((item) => item.id === track);
    expect(target?.kind !== "subtitle" && target?.clips[0]?.id).toBe("clp_v1");
  }
});

it("rejects a cross-track move when linked clips include multiple clips of the anchor kind", () => {
  const { project, timeline } = fixture();
  const track = timeline.tracks[0];
  if (!track || track.kind === "subtitle" || !track.clips[0]) throw new Error("fixture");
  track.clips.push({ ...track.clips[0], id: "clp_extra", timeline_start: parseRational("1001/100s", true) });
  expect(() =>
    applyEdit(project, [{ op: "move", clip_ids: ["clp_v1"], to: "0s", track_id: "trk_v2" }], {}, "test"),
  ).toThrow("Linked group has multiple clips of this track kind");
});

it("snaps to stationary clip edges and rounds off-grid marker targets onto the timeline grid", () => {
  const { view } = fixture();
  const first = view.tracks[0]?.clips[0];
  if (!first) throw new Error("fixture");
  view.markers = [];
  view.tracks.push({
    id: "other",
    name: "Other",
    kind: "video",
    enabled: true,
    clips: [
      {
        ...first,
        id: "stationary",
        occurrence_id: "other",
        timeline_in: { t: "3003/500s" },
        timeline_out: { t: "1001/125s" },
      },
    ],
  });
  const group = moveGroup(view, [], "clp_v1");
  expect(moveTarget(view, group, 95, 48, true, "10s").line).toBe("3003/500s");
  view.tracks.pop();
  view.markers = [{ id: "offgrid", kind: "review", text: "Off grid", at: { t: "6s" } }];
  const result = moveTarget(view, group, 95, 48, true, "10s");
  expect(result.line).toBe("6s");
  expect(frameTime(frameAt(result.to, view.edit_rate), view.edit_rate)).toBe(result.to);
});

it("uses an inclusive 8px distance threshold", () => {
  const { view } = fixture();
  view.edit_rate = "25";
  view.markers = [{ id: "marker", kind: "review", text: "Marker", at: { t: "6s" } }];
  const video = view.tracks[0]?.clips[0];
  if (!video) throw new Error("fixture");
  video.timeline_in.t = "2s";
  video.timeline_out.t = "4s";
  delete video.occurrence_id;
  const group = moveGroup(view, [], video.id);
  expect(moveTarget(view, group, 92, 50, true, "10s").distance).toBe(8);
  expect(moveTarget(view, group, 90, 50, true, "10s").line).toBeNull();
});

it("checks rational overlap on destination and linked tracks, including disabled clips, excluding the move group", () => {
  const { view } = fixture();
  const group = moveGroup(view, [], "clp_v1");
  const video = view.tracks[0];
  const audio = view.tracks.find((track) => track.kind === "audio");
  const destination = view.tracks.find((track) => track.id === "trk_v2");
  const first = video?.clips[0];
  const firstAudio = audio?.clips[0];
  if (!video || !audio || !destination || !first || !firstAudio) throw new Error("fixture");
  const delta = parseRational("1001/1000s", true);
  expect(moveOverlaps(view, group, delta, first.id, video.id)).toBe(false);
  destination.clips.push({
    ...first,
    id: "stationary",
    enabled: false,
    timeline_in: { t: "1001/200s" },
    timeline_out: { t: "7007/1000s" },
  });
  // Moving video ends at 1001/200s: touching is legal, one NTSC frame later overlaps.
  expect(moveOverlaps(view, group, delta, first.id, destination.id)).toBe(false);
  expect(moveOverlaps(view, group, add(delta, parseRational("1001/30000s", true)), first.id, destination.id)).toBe(
    true,
  );
  expect(moveOverlaps(view, group, delta, first.id, video.id)).toBe(false);
  audio.clips.push({ ...firstAudio, id: "stationary-audio", timeline_in: { t: "2s" }, timeline_out: { t: "3s" } });
  expect(moveOverlaps(view, group, delta, first.id, video.id)).toBe(true);
});
