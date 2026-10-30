// Adapted from OpenCut-app/opencut-classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// element-interaction-controller.ts (move group/grab offset), snapping/resolve.ts (nearest distance).
// Copyright 2025-2026 OpenCut. See THIRD_PARTY_NOTICES.md.
// Also adapted from xzdarcy/react-timeline-editor (MIT), 4148f4a837dd767ea66807560d05bc7b65c7e578:
// components/row_rnd/row_rnd.tsx (both-edge snapping). Copyright (c) 2021 zdarcy.
import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  compare,
  div,
  floor,
  frameTime,
  mul,
  parseRational,
  pixelAt,
  printRational,
  rational,
  sub,
} from "./timeline.js";

export function moveGroup(project: ProjectView, selected: string[], anchor: string) {
  const clips = project.tracks.filter((track) => track.kind !== "subtitle").flatMap((track) => track.clips);
  const requested = clips.filter((clip) =>
    selected.includes(anchor) ? selected.includes(clip.id) : clip.id === anchor,
  );
  const moving = clips.filter((clip) =>
    requested.some(
      (item) => item.id === clip.id || (!!item.occurrence_id && item.occurrence_id === clip.occurrence_id),
    ),
  );
  const first = moving[0];
  if (!first) throw new Error("No media clips to move");
  const earliest = moving.reduce(
    (time, clip) =>
      compare(parseRational(clip.timeline_in.t, true), time) < 0 ? parseRational(clip.timeline_in.t, true) : time,
    parseRational(first.timeline_in.t, true),
  );
  return { requested, moving, earliest };
}

export function moveTarget(
  project: ProjectView,
  group: ReturnType<typeof moveGroup>,
  pixels: number,
  scale: number,
  snap: boolean,
  playhead: string,
) {
  const to = add(group.earliest, div(rational(BigInt(Math.round(pixels))), rational(BigInt(scale))));
  return snapEdges(
    project,
    group.moving.map((clip) => clip.id),
    group.moving.flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t]),
    group.earliest,
    to,
    scale,
    snap,
    playhead,
  );
}

export function snapEdges(
  project: ProjectView,
  excluded: string[],
  edges: string[],
  origin: ReturnType<typeof rational>,
  raw: ReturnType<typeof rational>,
  scale: number,
  snap: boolean,
  playhead: string,
) {
  const rate = parseRational(project.edit_rate);
  const grid = (time: ReturnType<typeof rational>) =>
    parseRational(frameTime(floor(add(mul(time, rate), rational(1n, 2n))), project.edit_rate), true);
  const to = grid(raw);
  let nearest = Number.POSITIVE_INFINITY;
  let line: string | null = null;
  let snapped = to;
  const points = [
    playhead,
    ...project.markers.map((marker) => marker.at.t),
    ...project.tracks
      .filter((track) => track.kind !== "subtitle")
      .flatMap((track) => track.clips)
      .filter((clip) => !excluded.includes(clip.id))
      .flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t]),
  ];
  if (snap) {
    for (const edge of edges) {
      const offset = sub(parseRational(edge, true), origin);
      for (const point of points) {
        const candidate = sub(parseRational(point, true), offset);
        if (candidate.numerator < 0n) continue;
        const distance = Math.abs(pixelAt(printRational(add(to, offset), true), scale) - pixelAt(point, scale));
        if (distance <= 8 && distance < nearest) {
          nearest = distance;
          line = point;
          snapped = grid(candidate);
          // Keep comparing against the unsnapped position, not the previous candidate.
        }
      }
    }
    if (line !== null)
      return {
        to: printRational(snapped, true),
        delta: sub(snapped, origin),
        line,
        distance: nearest,
      };
  }
  return {
    to: printRational(to, true),
    delta: sub(to, origin),
    line: null,
    distance: null,
  };
}

export function moveOverlaps(
  project: ProjectView,
  group: ReturnType<typeof moveGroup>,
  delta: ReturnType<typeof rational>,
  anchor: string,
  trackId: string,
) {
  return project.tracks.some((source) =>
    source.clips.some((clip) => {
      if (!group.moving.some((item) => item.id === clip.id)) return false;
      const destination = clip.id === anchor ? project.tracks.find((track) => track.id === trackId) : source;
      const start = add(parseRational(clip.timeline_in.t, true), delta);
      const end = add(parseRational(clip.timeline_out.t, true), delta);
      return destination?.clips.some(
        (other) => !group.moving.some((item) => item.id === other.id) && clipsOverlap(start, end, other),
      );
    }),
  );
}

export function clipsOverlap(start: ReturnType<typeof rational>, end: ReturnType<typeof rational>, other: ClipView) {
  return (
    compare(start, parseRational(other.timeline_out.t, true)) < 0 &&
    compare(parseRational(other.timeline_in.t, true), end) < 0
  );
}
