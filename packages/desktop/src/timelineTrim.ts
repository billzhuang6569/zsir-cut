// Adapted from OpenCut-app/opencut-classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// timeline/controllers/resize-controller.ts (shared edge bounds, preview/discard/commit).
// Copyright 2025-2026 OpenCut. See THIRD_PARTY_NOTICES.md.
import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  ceil,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  rational,
  sub,
} from "./timeline.js";
import { clipsOverlap, snapEdges } from "./timelineMove.js";

export type TrimEdge = "in" | "out";
const edgeTime = (clip: ClipView, edge: TrimEdge) => (edge === "in" ? clip.timeline_in.t : clip.timeline_out.t);
export function trimGroup(project: ProjectView, anchor: ClipView, edge: TrimEdge, linked: boolean) {
  return project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        clip.id === anchor.id ||
        (linked &&
          !!anchor.occurrence_id &&
          clip.occurrence_id === anchor.occurrence_id &&
          compare(parseRational(edgeTime(clip, edge), true), parseRational(edgeTime(anchor, edge), true)) === 0),
    );
}

export function trimTarget(
  project: ProjectView,
  anchor: ClipView,
  edge: TrimEdge,
  linked: boolean,
  pixels: number,
  scale: number,
  snap: boolean,
  playhead: string,
) {
  const clips = trimGroup(project, anchor, edge, linked);
  const origin = parseRational(edgeTime(anchor, edge), true);
  const rate = parseRational(project.edit_rate);
  const frame = div(rational(1n), rate);
  let lower = rational(0n);
  let upper: ReturnType<typeof rational> | null = null;
  let reason = "已到素材边界或一帧最短时长";
  const bound = (value: ReturnType<typeof rational>, minimum: boolean) => {
    if (minimum ? compare(value, lower) > 0 : upper === null || compare(value, upper) < 0) {
      if (minimum) lower = value;
      else upper = value;
    }
  };
  for (const clip of clips) {
    const start = parseRational(clip.timeline_in.t, true);
    const end = parseRational(clip.timeline_out.t, true);
    const media = project.media.find((media) => media.id === clip.media_id);
    if (clip.time_map || clip.speed === "map" || !media?.duration) {
      return {
        clips,
        to: printRational(origin, true),
        blocked: true,
        reason: clip.time_map || clip.speed === "map" ? "变速片段暂不支持拖动修剪" : "缺少素材时长，暂不能修剪",
        line: null,
        distance: null,
      };
    }
    const image = media.kind === "image";
    if (edge === "in") {
      bound(sub(end, frame), false);
      bound(
        image ? sub(end, parseRational(media.duration, true)) : sub(start, parseRational(clip.source_in.t, true)),
        true,
      );
    } else {
      bound(add(start, frame), true);
      bound(
        add(
          start,
          sub(parseRational(media.duration, true), image ? rational(0n) : parseRational(clip.source_in.t, true)),
        ),
        false,
      );
    }
    const track = project.tracks.find((track) => track.clips.some((item) => item.id === clip.id));
    for (const other of track?.clips ?? []) {
      if (clips.some((item) => item.id === other.id)) continue;
      const otherStart = parseRational(other.timeline_in.t, true);
      const otherEnd = parseRational(other.timeline_out.t, true);
      if (edge === "in" && compare(otherEnd, start) <= 0) bound(otherEnd, true);
      if (edge === "out" && compare(otherStart, end) >= 0) bound(otherStart, false);
    }
  }
  // Round bounds inward so off-grid source and audio boundaries remain legal.
  lower = div(rational(ceil(mul(lower, rate))), rate);
  const maximum = upper === null ? origin : div(rational(floor(mul(upper, rate))), rate);
  const raw = add(origin, div(rational(BigInt(Math.round(pixels))), rational(BigInt(scale))));
  const target = snapEdges(
    project,
    clips.map((clip) => clip.id),
    [printRational(origin, true)],
    origin,
    raw,
    scale,
    snap,
    playhead,
  );
  const requested = parseRational(target.to, true);
  const to = compare(requested, lower) < 0 ? lower : compare(requested, maximum) > 0 ? maximum : requested;
  const overlap = clips.some((clip) => {
    const start = edge === "in" ? requested : parseRational(clip.timeline_in.t, true);
    const end = edge === "out" ? requested : parseRational(clip.timeline_out.t, true);
    return project.tracks
      .find((track) => track.clips.some((item) => item.id === clip.id))
      ?.clips.some((other) => !clips.some((item) => item.id === other.id) && clipsOverlap(start, end, other));
  });
  if (overlap) reason = "这里修剪不了：会和其他片段重叠";
  const blocked = raw.numerator < 0n || compare(to, requested) !== 0 || compare(lower, maximum) > 0 || overlap;
  return {
    clips,
    to: printRational(compare(lower, maximum) > 0 ? origin : to, true),
    blocked,
    reason,
    line: blocked ? null : target.line,
    distance: blocked ? null : target.distance,
  };
}
