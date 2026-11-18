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
import { intervalIndex, visibleIntervals } from "./timelineViewport.js";

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

type SnapPoint = { at: string; clipId?: string };
const snapIndexes = new WeakMap<
  ProjectView,
  {
    tracks: ProjectView["tracks"];
    markers: ProjectView["markers"];
    length: number;
    clips: { items: ClipView[]; length: number }[];
    index: ReturnType<typeof intervalIndex<SnapPoint>>;
  }
>();
function snapIndex(project: ProjectView) {
  const cached = snapIndexes.get(project);
  if (
    cached?.tracks === project.tracks &&
    cached.markers === project.markers &&
    cached.length === project.markers.length &&
    cached.clips.length === project.tracks.length &&
    project.tracks.every((track, i) => {
      const entry = cached.clips[i];
      return entry?.items === track.clips && entry.length === track.clips.length;
    })
  )
    return cached.index;
  const points: SnapPoint[] = project.markers.map((marker) => ({ at: marker.at.t }));
  for (const track of project.tracks) {
    if (track.kind === "subtitle") continue;
    for (const clip of track.clips) {
      points.push({ at: clip.timeline_in.t, clipId: clip.id }, { at: clip.timeline_out.t, clipId: clip.id });
    }
  }
  const index = intervalIndex(points, ({ at }) => {
    const time = pixelAt(at, 1);
    return [time, time];
  });
  snapIndexes.set(project, {
    tracks: project.tracks,
    markers: project.markers,
    length: project.markers.length,
    clips: project.tracks.map((track) => ({ items: track.clips, length: track.clips.length })),
    index,
  });
  return index;
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
  if (snap) {
    const index = snapIndex(project);
    const ignored = new Set(excluded);
    for (const edge of edges) {
      const offset = sub(parseRational(edge, true), origin);
      const edgeAt = pixelAt(printRational(add(to, offset), true), scale);
      const points = visibleIntervals(
        index,
        (edgeAt - SNAP_DISTANCE - 1) / scale,
        (edgeAt + SNAP_DISTANCE + 1) / scale,
      );
      for (const { at: point, clipId } of [{ at: playhead, clipId: undefined }, ...points]) {
        if (clipId && ignored.has(clipId)) continue;
        const candidate = sub(parseRational(point, true), offset);
        if (candidate.numerator < 0n) continue;
        const distance = Math.abs(edgeAt - pixelAt(point, scale));
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

export function moveCoverage(
  project: ProjectView,
  group: ReturnType<typeof moveGroup>,
  delta: ReturnType<typeof rational>,
  anchor: string,
  trackId: string,
) {
  const moving = new Set(group.moving.map((clip) => clip.id));
  const target = project.tracks.find((track) => track.id === trackId);
  return project.tracks.flatMap((source) =>
    source.clips
      .filter((clip) => moving.has(clip.id))
      .flatMap((clip) => {
        const destination = clip.id === anchor ? target : source;
        const start = add(parseRational(clip.timeline_in.t, true), delta);
        const end = add(parseRational(clip.timeline_out.t, true), delta);
        return (destination?.clips ?? [])
          .filter((other) => !moving.has(other.id) && clipsOverlap(start, end, other))
          .map((other) => {
            const left = parseRational(other.timeline_in.t, true);
            const right = parseRational(other.timeline_out.t, true);
            return {
              clipId: clip.id,
              offset: printRational(compare(left, start) > 0 ? sub(left, start) : rational(0n), true),
              duration: printRational(
                sub(compare(right, end) < 0 ? right : end, compare(left, start) > 0 ? left : start),
                true,
              ),
            };
          });
      }),
  );
}

export function moveOverlaps(...args: Parameters<typeof moveCoverage>) {
  return moveCoverage(...args).length > 0;
}

export function moveBlockReason(
  project: ProjectView,
  group: ReturnType<typeof moveGroup>,
  target: ReturnType<typeof moveTarget>,
  anchor: string,
  trackId: string,
  mode: "place" | "insert" | "overwrite",
) {
  const source = project.tracks.find((track) => track.clips.some((clip) => clip.id === anchor));
  const destination = project.tracks.find((track) => track.id === trackId);
  if (mode === "insert" && new Set(group.moving.map((clip) => clip.occurrence_id ?? clip.id)).size !== 1)
    return "一次只能插入一组片段";
  if (source !== destination) {
    if (group.requested.length !== 1) return "一次只能跨轨移动一个选中的片段";
    if (
      project.tracks
        .filter((track) => track.kind === source?.kind)
        .flatMap((track) => track.clips)
        .filter((clip) => group.moving.includes(clip)).length !== 1
    )
      return "联动组中有多个同类型片段，无法跨轨移动";
    if (!destination || destination.kind !== source?.kind) return "目标轨道类型与片段不匹配";
    if (destination.locked) return "请解锁目标轨道后再移动片段";
    if (source?.locked) return "请解锁源轨道后再移动片段";
  }
  if (mode === "insert" || target.to !== printRational(group.earliest, true)) {
    if (project.tracks.some((track) => track.locked && track.clips.some((clip) => group.moving.includes(clip))))
      return "请解锁片段所在轨道后再移动";
  }
  if (mode === "place" && moveOverlaps(project, group, target.delta, anchor, trackId)) return "这里有别的片段";
  if (mode === "insert") {
    const { at, close, stop } = insertGeometry(project, group, target.to);
    const locked = project.tracks.find(
      (track) =>
        track.kind !== "subtitle" &&
        track.locked &&
        track.clips.some((clip) => {
          const start = parseRational(clip.timeline_in.t, true);
          if (close && compare(start, stop) >= 0) return true;
          return compare(parseRational(clip.timeline_out.t, true), at) > 0;
        }),
    );
    if (locked) return `插入会改动锁定轨道「${locked.name}」`;
  }
  return null;
}

export function clipsOverlap(
  start: ReturnType<typeof rational>,
  end: ReturnType<typeof rational>,
  other: Pick<ClipView, "timeline_in" | "timeline_out">,
) {
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
  const insert = insertGeometry(project, group, boundary);
  return {
    ...target,
    to: boundary,
    delta: sub(insert.at, group.earliest),
    line: null,
    distance: null,
    insert,
  };
}

function insertGeometry(project: ProjectView, group: ReturnType<typeof moveGroup>, to: string) {
  const stop = group.moving.reduce((end, clip) => {
    const time = parseRational(clip.timeline_out.t, true);
    return compare(time, end) > 0 ? time : end;
  }, group.earliest);
  const duration = sub(stop, group.earliest);
  const close = !project.tracks.some(
    (track) =>
      track.kind !== "subtitle" &&
      track.clips.some((clip) => !group.moving.includes(clip) && clipsOverlap(group.earliest, stop, clip)),
  );
  const before = parseRational(to, true);
  const at =
    close && compare(before, stop) >= 0
      ? sub(before, duration)
      : close && compare(before, group.earliest) > 0
        ? group.earliest
        : before;
  return { at, duration, stop, close };
}

export function moveClipPreview(
  clip: ClipView,
  ids: string[],
  delta: ReturnType<typeof rational>,
  insert?: NonNullable<ReturnType<typeof moveInsert>>["insert"],
): ClipView[] {
  const moving = ids.includes(clip.id);
  if (!moving && !insert) return [clip];
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
  if (moving) return [piece(start, end, delta)];
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
