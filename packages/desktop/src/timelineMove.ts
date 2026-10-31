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
  sourceAt,
  sub,
} from "./timeline.js";

export const SNAP_DISTANCE = 8;

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
        if (distance <= SNAP_DISTANCE && distance < nearest) {
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

export function moveInsert(
  project: ProjectView,
  group: ReturnType<typeof moveGroup>,
  target: ReturnType<typeof moveTarget>,
  anchor: string,
  trackId: string,
  pointer: ReturnType<typeof rational>,
) {
  if (!moveOverlaps(project, group, target.delta, anchor, trackId)) return null;
  const stationary = project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) => track.clips)
    .filter((clip) => !group.moving.some((item) => item.id === clip.id));
  const lane = project.tracks.find((track) => track.id === trackId);
  const under = lane?.clips.find(
    (clip) =>
      stationary.includes(clip) &&
      compare(pointer, parseRational(clip.timeline_in.t, true)) >= 0 &&
      compare(pointer, parseRational(clip.timeline_out.t, true)) <= 0,
  );
  const candidates = under
    ? [under]
    : stationary.filter((clip) =>
        group.moving.some((item) => {
          const destination =
            item.id === anchor ? lane : project.tracks.find((track) => track.clips.some((clip) => clip.id === item.id));
          return (
            destination?.clips.includes(clip) &&
            clipsOverlap(
              add(parseRational(item.timeline_in.t, true), target.delta),
              add(parseRational(item.timeline_out.t, true), target.delta),
              clip,
            )
          );
        }),
      );
  const edges = candidates.flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t]);
  const abs = (value: ReturnType<typeof rational>) => (value.numerator < 0n ? sub(rational(0n), value) : value);
  const boundary = edges.reduce<string | undefined>(
    (best, edge) =>
      best === undefined ||
      compare(abs(sub(pointer, parseRational(edge, true))), abs(sub(pointer, parseRational(best, true)))) < 0
        ? edge
        : best,
    undefined,
  );
  if (boundary === undefined) return null;
  const stop = group.moving.reduce((end, clip) => {
    const time = parseRational(clip.timeline_out.t, true);
    return compare(time, end) > 0 ? time : end;
  }, group.earliest);
  const duration = sub(stop, group.earliest);
  const close = !stationary.some((clip) => clipsOverlap(group.earliest, stop, clip));
  const before = parseRational(boundary, true);
  const at =
    close && compare(before, stop) >= 0
      ? sub(before, duration)
      : close && compare(before, group.earliest) > 0
        ? group.earliest
        : before;
  return {
    ...target,
    to: boundary,
    delta: sub(at, group.earliest),
    line: null,
    distance: null,
    insert: { at, duration, stop, close },
  };
}

export function moveClipPreview(
  clip: ClipView,
  ids: string[],
  delta: ReturnType<typeof rational>,
  insert?: NonNullable<ReturnType<typeof moveInsert>>["insert"],
): ClipView[] {
  let start = parseRational(clip.timeline_in.t, true);
  let end = parseRational(clip.timeline_out.t, true);
  const originalStart = start;
  const piece = (
    a: ReturnType<typeof rational>,
    b: ReturnType<typeof rational>,
    shift: ReturnType<typeof rational>,
  ) => ({
    ...clip,
    timeline_in: { t: printRational(add(a, shift), true) },
    timeline_out: { t: printRational(add(b, shift), true) },
    source_in: { t: printRational(sourceAt(clip, printRational(add(originalStart, sub(a, start)), true)), true) },
    source_out: { t: printRational(sourceAt(clip, printRational(add(originalStart, sub(b, start)), true)), true) },
    ...(clip.time_map
      ? {
          time_map: clip.time_map.map((point) => ({
            ...point,
            at: { t: printRational(add(parseRational(point.at.t, true), add(sub(start, originalStart), shift)), true) },
          })),
        }
      : {}),
  });
  if (ids.includes(clip.id)) return [piece(start, end, delta)];
  if (!insert) return [clip];
  if (insert.close && compare(start, insert.stop) >= 0) {
    start = sub(start, insert.duration);
    end = sub(end, insert.duration);
  }
  if (compare(start, insert.at) < 0 && compare(insert.at, end) < 0)
    return [
      piece(start, insert.at, rational(0n)),
      { ...piece(insert.at, end, insert.duration), id: `${clip.id}-insert-preview` },
    ];
  return [piece(start, end, compare(start, insert.at) >= 0 ? insert.duration : rational(0n))];
}
