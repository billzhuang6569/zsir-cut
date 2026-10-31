// Adapted from OpenCut-app/opencut-classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// timeline/controllers/resize-controller.ts (shared edge bounds, preview/discard/commit).
// Copyright 2025-2026 OpenCut. See THIRD_PARTY_NOTICES.md.
import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  type CueView,
  ceil,
  compare,
  div,
  floor,
  frameTime,
  mul,
  numberOf,
  parseRational,
  printRational,
  rational,
  sub,
} from "./timeline.js";
import { clipsOverlap, SNAP_DISTANCE, snapEdges } from "./timelineMove.js";

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

// Manual timing is source-anchored, even when one cue is projected into several clips.
export function cueTrimTarget(
  project: ProjectView,
  cue: CueView,
  edge: TrimEdge,
  pixels: number,
  scale: number,
  snap: boolean,
  playhead: string,
) {
  const transcript = project.transcripts?.find((item) => item.id === cue.transcript_id);
  const original = transcript?.cues.find((item) => item.id === cue.cue_id);
  if (!transcript || !original) return null;
  const first = transcript.tokens.findIndex((token) => token.id === original.first_token);
  const last = transcript.tokens.findIndex((token) => token.id === original.last_token);
  if (first < 0 || last < first) return null;
  const visible = transcript.tokens.slice(first, last + 1).filter((token) => token.text);
  const shown = cue.tokens?.map((token) => token.id) ?? cue.token_ids;
  // Projection applies manual overrides only to the original cue's visible endpoints.
  if (shown && (edge === "in" ? shown[0] !== visible[0]?.id : shown.at(-1) !== visible.at(-1)?.id)) return null;
  const at = parseRational(edge === "in" ? cue.start : cue.end, true);
  const clips = project.tracks
    .filter((track) => track.kind === "audio")
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        clip.enabled &&
        clip.media_id === transcript.media_id &&
        (cue.clip_ids?.includes(clip.id) ?? (clip.id === cue.clip_id || clip.occurrence_id === cue.occurrence_id)),
    );
  const parts = clips.flatMap((clip) => {
    const points = clip.time_map ?? [
      { at: clip.timeline_in, source: clip.source_in, interp: "linear" },
      { at: clip.timeline_out, source: clip.source_out, interp: "linear" },
    ];
    return points.slice(0, -1).flatMap((first, index) => {
      const last = points[index + 1];
      if (!last || first.interp === "hold") return [];
      const start = parseRational(first.at.t, true),
        end = parseRational(last.at.t, true);
      const sourceStart = parseRational(first.source.t, true),
        sourceEnd = parseRational(last.source.t, true);
      return compare(sourceEnd, sourceStart) > 0 ? [{ start, end, sourceStart, sourceEnd }] : [];
    });
  });
  const endpoint = edge === "in" ? visible[0] : visible.at(-1);
  if (!endpoint) return null;
  const tokenStart = parseRational(endpoint.align.start, true),
    tokenEnd = parseRational(endpoint.align.end, true);
  const midpoint = div(add(tokenStart, tokenEnd), rational(2n));
  const candidates = parts.filter((part) => compare(at, part.start) >= 0 && compare(at, part.end) <= 0);
  const overlap = (part: (typeof parts)[number]) => {
    const start = compare(tokenStart, part.sourceStart) > 0 ? tokenStart : part.sourceStart;
    const end = compare(tokenEnd, part.sourceEnd) < 0 ? tokenEnd : part.sourceEnd;
    return compare(end, start) > 0 ? sub(end, start) : rational(0n);
  };
  const part =
    candidates.find((part) => compare(midpoint, part.sourceStart) >= 0 && compare(midpoint, part.sourceEnd) <= 0) ??
    candidates.sort((a, b) => compare(overlap(b), overlap(a)))[0];
  if (!part || compare(overlap(part), rational(0n)) <= 0) return null;
  const frame = div(rational(1n), parseRational(project.edit_rate));
  let lower = edge === "in" ? part.start : add(parseRational(cue.start, true), frame);
  let upper = edge === "out" ? part.end : sub(parseRational(cue.end, true), frame);
  const neighbors = project.cues.filter(
    (item) =>
      item.track_id === cue.track_id &&
      (item.cue_id !== cue.cue_id || item.piece !== cue.piece || item.start !== cue.start),
  );
  for (const other of neighbors) {
    const start = parseRational(other.start, true),
      end = parseRational(other.end, true);
    if (compare(start, parseRational(cue.start, true)) < 0 && compare(end, lower) > 0) lower = end;
    if (compare(start, parseRational(cue.start, true)) >= 0 && compare(start, upper) < 0) upper = start;
  }
  if (compare(lower, part.start) < 0) lower = part.start;
  if (compare(upper, part.end) > 0) upper = part.end;
  if (compare(lower, upper) > 0) return null;
  const points = [
    playhead,
    ...neighbors.flatMap((item) => [item.start, item.end]),
    ...project.tracks
      .filter((track) => track.kind !== "subtitle")
      .flatMap((track) => track.clips.flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t])),
    ...transcript.tokens.slice(Math.max(0, first - 1), last + 2).flatMap((token) =>
      [token.align.start, token.align.end].flatMap((time) => {
        const source = parseRational(time, true);
        if (compare(source, part.sourceStart) < 0 || compare(source, part.sourceEnd) > 0) return [];
        return [
          printRational(
            add(
              part.start,
              mul(sub(source, part.sourceStart), div(sub(part.end, part.start), sub(part.sourceEnd, part.sourceStart))),
            ),
            true,
          ),
        ];
      }),
    ),
  ];
  const rate = parseRational(project.edit_rate);
  const requested = add(at, div(rational(BigInt(Math.round(pixels))), rational(BigInt(scale))));
  const raw = frameTime(floor(add(mul(requested, rate), rational(1n, 2n))), project.edit_rate);
  const quantized = parseRational(raw, true);
  let to = quantized;
  let line: string | null = null;
  let distance: number | null = null;
  if (snap)
    for (const point of points) {
      const candidate = parseRational(point, true);
      const gap = Math.abs(numberOf(mul(sub(quantized, candidate), rational(BigInt(scale)))));
      if (compare(candidate, lower) < 0 || compare(candidate, upper) > 0) continue;
      if (gap <= SNAP_DISTANCE && (distance === null || gap < distance)) {
        to = candidate;
        line = point;
        distance = gap;
      }
    }
  to = compare(to, lower) < 0 ? lower : compare(to, upper) > 0 ? upper : to;
  const source = add(
    part.sourceStart,
    mul(sub(to, part.start), div(sub(part.sourceEnd, part.sourceStart), sub(part.end, part.start))),
  );
  return {
    to: printRational(to, true),
    line,
    distance,
    op: {
      op: "set_cue",
      cue_id: cue.cue_id,
      timing: { ...original.timing, [edge === "in" ? "start" : "end"]: printRational(source, true) },
    },
  };
}
