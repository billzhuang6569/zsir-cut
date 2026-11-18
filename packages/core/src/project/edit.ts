// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by schema or local checks.

import { createHash } from "node:crypto";
import {
  add,
  ceil,
  compare,
  div,
  floor,
  mul,
  parseRational,
  parseSignedSeconds,
  printRational,
  type Rational,
  rational,
  sub,
} from "../rational.ts";
import { diffProjectEntities } from "./entities.ts";
import { newId } from "./id.ts";
import { type ProjectedToken, projectSubtitles } from "./projection.ts";
import { applySubtitleEdit } from "./subtitle-edit.ts";
import { clipTimeMap, mapClipTimeToSource, mapSourceTimeToClip } from "./time-map.ts";
import { automaticTrackName } from "./track-name.ts";
import type {
  Author,
  Clip,
  Marker,
  Media,
  MediaTrack,
  Project,
  Timeline,
  TimeMapPoint,
  Token,
  Track,
} from "./types.ts";

export class EditError extends Error {
  readonly code: "E_MIXED_DOMAIN" | "E_VALIDATION" | "E_NOT_FOUND" | "E_UNSUPPORTED" | "E_LOCKED" | "E_SESSION_STATE";
  readonly details: Record<string, unknown> | undefined;
  constructor(code: EditError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type Op = Record<string, unknown> & { op: string };
const zero = rational(0n);
const lt = (a: Rational, b: Rational) => compare(a, b) < 0;
const eq = (a: Rational, b: Rational) => compare(a, b) === 0;
const min = (a: Rational, b: Rational) => (lt(a, b) ? a : b);
const max = (a: Rational, b: Rational) => (lt(a, b) ? b : a);
const end = (clip: Clip) => add(clip.timeline_start, clip.duration);
const time = (value: unknown, signed = false) => {
  try {
    return signed ? parseSignedSeconds(value as string) : parseRational(value as string, true);
  } catch {
    return fail("E_VALIDATION", `Invalid time: ${String(value)}`);
  }
};
const id = (value: unknown, prefix: string, generate: (prefix: string) => string) =>
  typeof value === "string" ? value : generate(prefix);
const fail = (code: EditError["code"], message: string): never => {
  throw new EditError(code, message);
};

export function requireUnlocked(track: Track): void {
  if (track.locked) throw new EditError("E_LOCKED", "Track is locked", { track_id: track.id });
}

function checkOffset(by: Rational, lower: Rational, upper?: Rational): void {
  if (lt(by, lower) || (upper && lt(upper, by)))
    throw new EditError("E_VALIDATION", "Offset is outside the available range", {
      min_by: printRational(lower, true),
      max_by: upper ? printRational(upper, true) : null,
    });
}

function onGrid(value: Rational, timeline: Timeline): void {
  if (mul(value, timeline.edit_rate).denominator !== 1n) fail("E_VALIDATION", "Time is off the video frame grid");
}
function mediaTracks(timeline: Timeline): MediaTrack[] {
  return timeline.tracks.filter((track): track is MediaTrack => track.kind !== "subtitle");
}
function track(timeline: Timeline, value: unknown): Track {
  return timeline.tracks.find((item) => item.id === value) ?? fail("E_NOT_FOUND", `Track ${String(value)} not found`);
}
function clip(timeline: Timeline, value: unknown): { track: MediaTrack; clip: Clip } {
  for (const item of mediaTracks(timeline)) {
    const found = item.clips.find((entry) => entry.id === value);
    if (found) return { track: item, clip: found };
  }
  return fail("E_NOT_FOUND", `Clip ${String(value)} not found`);
}
function cleanTransitions(timeline: Timeline): void {
  for (const item of mediaTracks(timeline)) {
    const transitions = item.transitions.filter((transition) => {
      const from = item.clips.find((entry) => entry.id === transition.from_clip);
      const to = item.clips.find((entry) => entry.id === transition.to_clip);
      return from && to && eq(end(from), to.timeline_start);
    });
    if (transitions.length !== item.transitions.length) requireUnlocked(item);
    item.transitions = transitions;
  }
}
function partMap(points: TimeMapPoint[], start: Rational, stop: Rational): TimeMapPoint[] {
  const boundary = (at: Rational): TimeMapPoint => {
    const exact = points.find((point) => eq(point.at, at));
    if (exact) return { ...exact };
    const index = points.findIndex((point) => lt(at, point.at));
    const previous = points[index - 1];
    const next = points[index];
    if (!previous || !next) return fail("E_VALIDATION", "Time-map boundary is outside clip");
    const source =
      previous.interp === "hold"
        ? previous.source
        : add(
            previous.source,
            mul(sub(at, previous.at), div(sub(next.source, previous.source), sub(next.at, previous.at))),
          );
    return { at, source, interp: previous.interp };
  };
  return [boundary(start), ...points.filter((point) => lt(start, point.at) && lt(point.at, stop)), boundary(stop)].map(
    (point) => ({ ...point, at: sub(point.at, start) }),
  );
}
function slice(clip: Clip, start: Rational, stop: Rational, newIdValue?: string): Clip {
  const offset = sub(start, clip.timeline_start);
  const until = sub(stop, clip.timeline_start);
  return {
    ...clip,
    id: newIdValue ?? clip.id,
    timeline_start: start,
    duration: sub(stop, start),
    source_start: mapClipTimeToSource(clip, offset),
    ...(clip.time_map ? { time_map: partMap(clip.time_map, offset, until) } : {}),
  };
}
function splitOne(item: MediaTrack, target: Clip, at: Rational, rightId: string): Clip {
  if (!lt(target.timeline_start, at) || !lt(at, end(target))) fail("E_VALIDATION", "Split must be inside clip");
  requireUnlocked(item);
  const right = slice(target, at, end(target), rightId);
  const left = slice(target, target.timeline_start, at);
  Object.assign(target, left);
  item.clips.push(right);
  for (const transition of item.transitions) if (transition.from_clip === target.id) transition.from_clip = right.id;
  return right;
}
function splitAcross(timeline: Timeline, at: Rational, generate: (prefix: string) => string): void {
  for (const item of mediaTracks(timeline)) {
    for (const target of [...item.clips]) {
      if (lt(target.timeline_start, at) && lt(at, end(target))) splitOne(item, target, at, generate("clp_"));
    }
  }
}
function splitMetadata(timeline: Timeline, at: Rational, generate: (prefix: string) => string): void {
  const split = <T extends { id: string; duration: Rational }>(
    items: T[],
    start: (item: T) => Rational,
    setStart: (item: T, value: Rational) => void,
    prefix: string,
  ) => {
    for (const item of [...items]) {
      const a = start(item),
        b = add(a, item.duration);
      if (!lt(a, at) || !lt(at, b)) continue;
      const right = { ...item, id: generate(prefix), duration: sub(b, at) };
      setStart(right, at);
      item.duration = sub(at, a);
      items.push(right);
    }
  };
  split(
    timeline.markers,
    (item) => item.at,
    (item, value) => {
      item.at = value;
    },
    "mrk_",
  );
  for (const item of timeline.tracks)
    if (item.kind === "subtitle")
      split(
        item.free_cues,
        (cue) => cue.timeline_start,
        (cue, value) => {
          cue.timeline_start = value;
        },
        "cue_",
      );
}
function shift(timeline: Timeline, at: Rational, amount: Rational, selected?: Set<string>): void {
  if (eq(amount, zero)) return;
  for (const item of mediaTracks(timeline)) {
    if (selected && !selected.has(item.id)) continue;
    for (const target of item.clips)
      if (compare(target.timeline_start, at) >= 0) {
        requireUnlocked(item);
        target.timeline_start = add(target.timeline_start, amount);
      }
  }
  if (!selected) {
    for (const marker of timeline.markers) if (compare(marker.at, at) >= 0) marker.at = add(marker.at, amount);
    for (const item of timeline.tracks)
      if (item.kind === "subtitle")
        for (const cue of item.free_cues)
          if (compare(cue.timeline_start, at) >= 0) cue.timeline_start = add(cue.timeline_start, amount);
  }
}
function cutIntervals<T extends { id: string; duration: Rational }>(
  items: T[],
  start: Rational,
  stop: Rational,
  at: (item: T) => Rational,
  setAt: (item: T, value: Rational) => void,
  prefix: string,
  generate: (prefix: string) => string,
): T[] {
  const result: T[] = [];
  for (const item of items) {
    const a = at(item),
      b = add(a, item.duration);
    if (eq(item.duration, zero)) {
      if (!lt(a, start) && lt(a, stop)) continue;
      result.push(item);
      continue;
    }
    if (!lt(a, stop) || !lt(start, b)) {
      result.push(item);
      continue;
    }
    if (lt(a, start)) {
      if (lt(stop, b)) {
        const right = { ...item, id: generate(prefix), duration: sub(b, stop) };
        setAt(right, stop);
        result.push(right);
      }
      item.duration = sub(start, a);
      result.push(item);
    } else if (lt(stop, b)) {
      setAt(item, stop);
      item.duration = sub(b, stop);
      result.push(item);
    }
  }
  return result;
}
function clearSpan(
  timeline: Timeline,
  start: Rational,
  stop: Rational,
  selected: Set<string>,
  ripple: boolean,
  generate: (prefix: string) => string,
  metadata = true,
  excluded = new Set<string>(),
): void {
  for (const item of mediaTracks(timeline)) {
    if (!selected.has(item.id)) continue;
    const trimmedIn = new Set<string>();
    const trimmedOut = new Map<string, string | undefined>();
    item.clips = item.clips.flatMap((target) => {
      const first = target.timeline_start;
      const last = end(target);
      if (excluded.has(target.id) || !lt(first, stop) || !lt(start, last)) return [target];
      requireUnlocked(item);
      if (lt(first, start) && lt(stop, last)) {
        const right = slice(target, stop, last, generate("clp_"));
        trimmedOut.set(target.id, right.id);
        return [slice(target, first, start), right];
      }
      if (lt(first, start)) {
        trimmedOut.set(target.id, undefined);
        return [slice(target, first, start)];
      }
      if (lt(stop, last)) {
        trimmedIn.add(target.id);
        return [slice(target, stop, last)];
      }
      return [];
    });
    item.transitions = item.transitions.filter((transition) => {
      if (trimmedIn.has(transition.to_clip)) return false;
      if (!trimmedOut.has(transition.from_clip)) return true;
      const right = trimmedOut.get(transition.from_clip);
      if (!right) return false;
      transition.from_clip = right;
      return true;
    });
  }
  if (metadata)
    timeline.markers = cutIntervals(
      timeline.markers,
      start,
      stop,
      (item) => item.at,
      (item, value) => {
        item.at = value;
      },
      "mrk_",
      generate,
    );
  for (const item of metadata ? timeline.tracks : [])
    if (item.kind === "subtitle")
      item.free_cues = cutIntervals(
        item.free_cues,
        start,
        stop,
        (cue) => cue.timeline_start,
        (cue, value) => {
          cue.timeline_start = value;
        },
        "cue_",
        generate,
      );
  cleanTransitions(timeline);
  if (ripple)
    shift(timeline, stop, sub(start, stop), selected.size === mediaTracks(timeline).length ? undefined : selected);
}
function tokenRange(project: Project, timeline: Timeline, op: Op): [Rational, Rational] {
  const selection = op.tokens as {
    transcript_id: string;
    from_token: string;
    to_token: string;
    clip_id?: string;
    pause?: string;
  };
  const transcript =
    project.transcripts.find((item) => item.id === selection.transcript_id) ??
    fail("E_NOT_FOUND", "Transcript not found");
  if (
    !transcript.tokens.some((token) => token.id === selection.from_token) ||
    !transcript.tokens.some((token) => token.id === selection.to_token)
  )
    fail("E_NOT_FOUND", "Token not found");
  const selected = selection.clip_id ? clip(timeline, selection.clip_id).clip : undefined;
  const projected = projectedTokens(project, timeline).filter((item) => item.transcript.id === transcript.id);
  const starts = new Set(
    projected.filter((item) => item.token.id === selection.from_token).map((item) => item.clip.id),
  );
  const ends = new Set(projected.filter((item) => item.token.id === selection.to_token).map((item) => item.clip.id));
  const linked = (a: Clip, b: Clip) =>
    a.occurrence_id === b.occurrence_id && lt(a.timeline_start, end(b)) && lt(b.timeline_start, end(a));
  const carriers = [...starts]
    .filter((value) => value && ends.has(value))
    .map((value) => clip(timeline, value).clip)
    .sort((a, b) => compare(a.timeline_start, b.timeline_start));
  const groups: Clip[][] = [];
  // Start order ensures an overlapping carrier cannot bridge two already separate groups.
  for (const carrier of carriers) {
    const group = groups.find((items) => items.some((item) => linked(item, carrier)));
    if (group) group.push(carrier);
    else groups.push([carrier]);
  }
  const candidates = groups.filter((items) => !selected || items.some((item) => linked(item, selected)));
  if (candidates.length !== 1) fail("E_VALIDATION", "Token range must project onto exactly one clip");
  const target = candidates[0]!.find((item) => item.id === selected?.id) ?? candidates[0]![0]!;
  const first = transcript.tokens.find((token) => token.id === selection.from_token)!;
  const last = transcript.tokens.find((token) => token.id === selection.to_token)!;
  if (!lt(first.align.start, last.align.end)) fail("E_VALIDATION", "Token range is reversed");
  const points = clipTimeMap(target);
  const projectEndpoint = (token: Token, edge: "start" | "end"): Rational => {
    const segments = points
      .slice(0, -1)
      .map((a, index) => ({ a, b: points[index + 1]! }))
      .filter(({ a, b }) => lt(a.source, b.source));
    const midpoint = div(add(token.align.start, token.align.end), rational(2n));
    const overlap = ({ a, b }: (typeof segments)[number]) => {
      const start = compare(token.align.start, a.source) > 0 ? token.align.start : a.source;
      const stop = compare(token.align.end, b.source) < 0 ? token.align.end : b.source;
      return lt(start, stop) ? sub(stop, start) : zero;
    };
    const segment =
      segments.find(({ a, b }) => compare(midpoint, a.source) >= 0 && compare(midpoint, b.source) <= 0) ??
      segments.reduce<(typeof segments)[number] | undefined>(
        (best, candidate) => (!best || compare(overlap(candidate), overlap(best)) > 0 ? candidate : best),
        undefined,
      );
    if (!segment || eq(overlap(segment), zero))
      return fail("E_VALIDATION", "Token is not on a forward time-map segment");
    const position = mapSourceTimeToClip(token.align[edge], segment.a, segment.b);
    if (!position) return fail("E_VALIDATION", "Token endpoint cannot be projected");
    return add(target.timeline_start, position);
  };
  const firstIndex = transcript.tokens.indexOf(first);
  const lastIndex = transcript.tokens.indexOf(last);
  if (firstIndex > lastIndex) fail("E_VALIDATION", "Token range is reversed");
  let start = projectEndpoint(first, "start");
  let stop = projectEndpoint(last, "end");
  if (selection.pause !== undefined) {
    const shown = new Set(projected.filter((item) => item.clip.id === target.id).map((item) => item.token.id));
    const previous = transcript.tokens.slice(0, firstIndex).findLast((token) => token.text && shown.has(token.id));
    const following = transcript.tokens.slice(lastIndex + 1).find((token) => token.text && shown.has(token.id));
    const p = previous ? projectEndpoint(previous, "end") : target.timeline_start;
    const n = following ? projectEndpoint(following, "start") : end(target);
    const half = div(time(selection.pause), rational(2n));
    const left = lt(start, p) ? zero : sub(start, p);
    const right = lt(n, stop) ? zero : sub(n, stop);
    start = add(p, min(left, half));
    stop = sub(n, min(right, half));
  }
  return [start, stop];
}
function snap(value: Rational, rate: Rational, mode: "floor" | "ceil" | "nearest"): Rational {
  const frames = mul(value, rate);
  const frame =
    mode === "floor" ? floor(frames) : mode === "ceil" ? ceil(frames) : floor(add(frames, rational(1n, 2n)));
  return div(rational(frame), rate);
}
function placeTokenRange(project: Project, timeline: Timeline, source: Media, op: Op): [Rational, Rational] {
  const selection = op.tokens as { transcript_id: string; from_token: string; to_token: string; pause?: string };
  const transcript =
    project.transcripts.find((item) => item.id === selection.transcript_id) ??
    fail("E_NOT_FOUND", "Transcript not found");
  if (transcript.media_id !== source.id) fail("E_VALIDATION", "Transcript media does not match place media");
  const firstIndex = transcript.tokens.findIndex((token) => token.id === selection.from_token);
  const lastIndex = transcript.tokens.findIndex((token) => token.id === selection.to_token);
  if (firstIndex < 0 || lastIndex < 0) fail("E_NOT_FOUND", "Token not found");
  if (firstIndex > lastIndex) fail("E_VALIDATION", "Token range is reversed");
  let start = transcript.tokens[firstIndex]!.align.start;
  let stop = transcript.tokens[lastIndex]!.align.end;
  if (selection.pause !== undefined) {
    const previous = transcript.tokens.slice(0, firstIndex).findLast((token) => token.text);
    const following = transcript.tokens.slice(lastIndex + 1).find((token) => token.text);
    const p = previous?.align.end ?? zero;
    const n = following?.align.start ?? source.duration;
    const half = div(time(selection.pause), rational(2n));
    const left = lt(start, p) ? zero : sub(start, p);
    const right = lt(n, stop) ? zero : sub(n, stop);
    start = sub(start, min(left, half));
    stop = add(stop, min(right, half));
  }
  start = snap(start, source.video?.rate ?? timeline.edit_rate, "floor");
  const duration = min(
    snap(sub(stop, start), timeline.edit_rate, "ceil"),
    snap(sub(source.duration, start), timeline.edit_rate, "floor"),
  );
  if (lt(start, zero) || !lt(zero, duration)) fail("E_VALIDATION", "Token source range is empty or outside media");
  return [start, duration];
}
function setFields<T extends object>(entity: T, op: Op, fields: string[]): void {
  for (const field of fields)
    if (Object.hasOwn(op, field)) {
      if (op[field] === null) delete (entity as Record<string, unknown>)[field];
      else (entity as Record<string, unknown>)[field] = op[field];
    }
}
function applyOne(
  project: Project,
  timeline: Timeline,
  op: Op,
  generate: (prefix: string) => string,
  authorKind: Author["kind"],
  warnings: Record<string, unknown>[],
): void {
  const t = (field: string) => time(op[field]);
  switch (op.op) {
    case "place": {
      const source = project.media.find((item) => item.id === op.media_id) ?? fail("E_NOT_FOUND", "Media not found");
      const at =
        op.at === "end"
          ? mediaTracks(timeline)
              .flatMap((item) => item.clips)
              .reduce((latest, item) => (lt(latest, end(item)) ? end(item) : latest), zero)
          : t("at");
      const [sourceStart, duration] = op.tokens
        ? placeTokenRange(project, timeline, source, op)
        : [t("source_start"), t("duration")];
      onGrid(at, timeline);
      onGrid(duration, timeline);
      if (source.kind === "image" && !eq(sourceStart, zero)) fail("E_VALIDATION", "Image source start must be 0s");
      const targets: MediaTrack[] = [];
      for (const [field, kind] of [
        ["video_track", "video"],
        ["audio_track", "audio"],
      ] as const)
        if (op[field]) {
          const item = track(timeline, op[field]);
          if (item.kind !== kind) fail("E_VALIDATION", "Media and track kind do not match");
          if ((kind === "video" && !source.video && source.kind !== "image") || (kind === "audio" && !source.audio))
            continue;
          targets.push(item as MediaTrack);
        }
      if (!targets.length) fail("E_VALIDATION", "Place needs a compatible target track");
      for (const item of targets) requireUnlocked(item);
      if (
        op.source_channels &&
        (!source.audio || (op.source_channels as number[]).some((channel) => channel >= (source.audio?.channels ?? 0)))
      )
        fail("E_VALIDATION", "Source channel does not exist");
      if (
        op.occurrence_id &&
        mediaTracks(timeline).some((item) => item.clips.some((entry) => entry.occurrence_id === op.occurrence_id))
      )
        fail("E_VALIDATION", "Occurrence ID already exists");
      if (op.mode === "insert") {
        splitAcross(timeline, at, generate);
        splitMetadata(timeline, at, generate);
        shift(timeline, at, duration);
        cleanTransitions(timeline);
      } else {
        for (const item of targets)
          clearSpan(timeline, at, add(at, duration), new Set([item.id]), false, generate, false);
      }
      const occurrence = id(op.occurrence_id, "occ_", generate);
      for (const item of targets)
        item.clips.push({
          id: id(item.kind === "video" ? op.video_clip_id : op.audio_clip_id, "clp_", generate),
          occurrence_id: occurrence,
          media_id: source.id,
          timeline_start: at,
          duration,
          source_start: sourceStart,
          ...(item.kind === "audio" && op.source_channels ? { source_channels: op.source_channels as number[] } : {}),
        });
      break;
    }
    case "remove": {
      const targets = (op.clip_ids as string[]).map((value) => clip(timeline, value).clip);
      const ids = new Set(targets.map((item) => item.id));
      if (op.linked === true)
        for (const item of mediaTracks(timeline).flatMap((entry) => entry.clips))
          if (targets.some((target) => target.occurrence_id === item.occurrence_id)) ids.add(item.id);
      const all = mediaTracks(timeline).flatMap((item) => item.clips);
      const removed = all.filter((item) => ids.has(item.id));
      const start = removed.reduce((value, item) => min(value, item.timeline_start), targets[0]!.timeline_start);
      const stop = removed.reduce((value, item) => (lt(value, end(item)) ? end(item) : value), start);
      for (const item of mediaTracks(timeline)) {
        if (item.clips.some((entry) => ids.has(entry.id))) requireUnlocked(item);
        item.clips = item.clips.filter((entry) => !ids.has(entry.id));
      }
      if (op.ripple === true) {
        const blocking = all.filter(
          (item) => !ids.has(item.id) && lt(item.timeline_start, stop) && lt(start, end(item)),
        );
        if (blocking.length) warnings.push({ code: "W_RIPPLE_SKIPPED", clip_ids: blocking.map((item) => item.id) });
        else shift(timeline, stop, sub(start, stop));
      }
      cleanTransitions(timeline);
      break;
    }
    case "remove_span": {
      let start: Rational, stop: Rational;
      if (op.range) {
        const range = op.range as { start: string; duration: string };
        start = time(range.start);
        stop = add(start, time(range.duration));
      } else [start, stop] = tokenRange(project, timeline, op);
      const mode = (op.snap ??
        ((op.tokens as { pause?: string } | undefined)?.pause !== undefined ? "nearest" : "out")) as
        | "out"
        | "in"
        | "nearest";
      start = snap(start, timeline.edit_rate, mode === "out" ? "floor" : mode === "in" ? "ceil" : "nearest");
      stop = snap(stop, timeline.edit_rate, mode === "out" ? "ceil" : mode === "in" ? "floor" : "nearest");
      if (!lt(start, stop)) fail("E_VALIDATION", "Remove span is empty");
      const selected =
        op.tracks === undefined || op.tracks === "all"
          ? new Set(mediaTracks(timeline).map((item) => item.id))
          : new Set(op.tracks as string[]);
      for (const value of selected)
        if (track(timeline, value).kind === "subtitle") fail("E_VALIDATION", "Subtitle track is not a media track");
      if (project.transcripts.some((item) => item.tokens.some((token) => token.state === "approved"))) {
        const selectedClips = new Set(
          mediaTracks(timeline)
            .filter((item) => selected.has(item.id))
            .flatMap((item) => item.clips.map((clip) => clip.id)),
        );
        if (
          projectedTokens(project, timeline).some(
            (item) =>
              selectedClips.has(item.clip.id) &&
              item.token.state === "approved" &&
              lt(start, item.end) &&
              lt(item.start, stop),
          )
        )
          fail("E_LOCKED", "Approved token cannot be removed");
      }
      clearSpan(timeline, start, stop, selected, op.ripple !== false, generate);
      break;
    }
    case "trim": {
      const { clip: target } = clip(timeline, op.clip_id);
      const edge = op.edge as "in" | "out";
      const from = edge === "in" ? target.timeline_start : end(target);
      const to = t("to");
      onGrid(to, timeline);
      const rippleAnchor = edge === "in" ? end(target) : from;
      const delta = edge === "out" ? sub(to, from) : sub(from, to);
      const targets =
        op.linked === false
          ? [target]
          : mediaTracks(timeline)
              .flatMap((item) => item.clips)
              .filter(
                (item) =>
                  item.occurrence_id === target.occurrence_id &&
                  eq(edge === "in" ? item.timeline_start : end(item), from),
              );
      if (!eq(delta, zero)) for (const item of targets) requireUnlocked(clip(timeline, item.id).track);
      if (targets.some((item) => item.time_map)) fail("E_UNSUPPORTED", "Trim of time-mapped clip is unsupported");
      if (op.ripple === true && lt(zero, delta)) {
        splitAcross(timeline, rippleAnchor, generate);
        splitMetadata(timeline, rippleAnchor, generate);
      }
      for (const item of targets) {
        const oldEnd = end(item);
        if (edge === "out") item.duration = sub(to, item.timeline_start);
        else {
          item.timeline_start = op.ripple === true ? from : to;
          item.duration = sub(oldEnd, to);
          item.source_start = add(item.source_start, sub(to, from));
        }
        if (!lt(zero, item.duration)) fail("E_VALIDATION", "Trim would make an empty clip");
      }
      if (op.ripple === true) {
        if (lt(delta, zero))
          clearSpan(
            timeline,
            edge === "out" ? to : from,
            edge === "out" ? from : to,
            new Set(mediaTracks(timeline).map((item) => item.id)),
            true,
            generate,
            true,
            new Set(targets.map((item) => item.id)),
          );
        else shift(timeline, rippleAnchor, delta);
      }
      cleanTransitions(timeline);
      break;
    }
    case "split": {
      const { clip: target } = clip(timeline, op.clip_id);
      const at = t("at");
      onGrid(at, timeline);
      if (!lt(target.timeline_start, at) || !lt(at, end(target))) fail("E_VALIDATION", "Split must be inside clip");
      const targets =
        op.linked === false
          ? [target]
          : mediaTracks(timeline)
              .flatMap((item) => item.clips)
              .filter(
                (item) =>
                  item.occurrence_id === target.occurrence_id && lt(item.timeline_start, at) && lt(at, end(item)),
              );
      for (const item of targets)
        splitOne(
          clip(timeline, item.id).track,
          item,
          at,
          item.id === target.id ? id(op.new_id, "clp_", generate) : generate("clp_"),
        );
      break;
    }
    case "roll": {
      const { clip: target, track: owner } = clip(timeline, op.clip_id);
      const out = op.edge === "out";
      const from = out ? end(target) : target.timeline_start;
      const to = t("to");
      onGrid(to, timeline);
      const neighbor =
        owner.clips.find((item) => item !== target && eq(out ? item.timeline_start : end(item), from)) ??
        fail("E_VALIDATION", "Roll requires adjacent clips");
      const left = out ? target : neighbor;
      const right = out ? neighbor : target;
      if (left.time_map || right.time_map) fail("E_UNSUPPORTED", "Roll of time-mapped clip is unsupported");
      const pairs = new Map<Clip, Clip>([[left, right]]);
      if (op.linked !== false) {
        for (const item of mediaTracks(timeline)) {
          const lefts = item.clips.filter(
            (entry) => entry.occurrence_id === left.occurrence_id && eq(end(entry), from),
          );
          const rights = item.clips.filter(
            (entry) => entry.occurrence_id === right.occurrence_id && eq(entry.timeline_start, from),
          );
          for (const entry of lefts) {
            const partner =
              rights.find((candidate) => candidate !== entry) ??
              fail("E_VALIDATION", "Linked roll requires adjacent partners");
            pairs.set(entry, partner);
          }
          for (const entry of rights)
            if (!lefts.some((candidate) => candidate !== entry))
              fail("E_VALIDATION", "Linked roll requires adjacent partners");
        }
      }
      if ([...pairs].some(([a, b]) => a.time_map || b.time_map))
        fail("E_UNSUPPORTED", "Roll of time-mapped clip is unsupported");
      const delta = sub(to, from);
      for (const [a, b] of pairs) {
        if (!eq(delta, zero)) requireUnlocked(clip(timeline, a.id).track);
        const stop = end(b);
        if (!lt(a.timeline_start, to) || !lt(to, stop)) fail("E_VALIDATION", "Roll would make an empty clip");
        a.duration = sub(to, a.timeline_start);
        b.timeline_start = to;
        b.duration = sub(stop, to);
        b.source_start = add(b.source_start, delta);
        for (const entry of [a, b]) {
          const media = project.media.find((item) => item.id === entry.media_id)!;
          if (
            media.kind !== "image" &&
            (lt(entry.source_start, zero) || lt(media.duration, add(entry.source_start, entry.duration)))
          )
            fail("E_VALIDATION", "Roll source range is outside media");
        }
      }
      break;
    }
    case "move": {
      const requested = (op.clip_ids as string[]).map((value) => clip(timeline, value).clip);
      const moving = new Map(requested.map((item) => [item.id, item]));
      if (op.linked !== false)
        for (const item of mediaTracks(timeline).flatMap((entry) => entry.clips))
          if (requested.some((target) => target.occurrence_id === item.occurrence_id)) moving.set(item.id, item);
      const earliest = [...moving.values()].reduce(
        (value, item) => min(value, item.timeline_start),
        requested[0]!.timeline_start,
      );
      let to = t("to");
      onGrid(to, timeline);
      if (op.mode === "insert" && new Set([...moving.values()].map((item) => item.occurrence_id)).size !== 1)
        fail("E_VALIDATION", "Insert move requires a single occurrence");
      if (op.track_id) {
        if (requested.length !== 1) fail("E_VALIDATION", "Track change requires a single requested clip");
        const current = clip(timeline, requested[0]!.id).track;
        if ([...moving.values()].filter((item) => clip(timeline, item.id).track.kind === current.kind).length !== 1)
          fail("E_VALIDATION", "Linked group has multiple clips of this track kind");
        const target = track(timeline, op.track_id);
        if (target.kind !== current.kind) fail("E_VALIDATION", "Destination track kind differs");
        if (current !== target) {
          requireUnlocked(current);
          requireUnlocked(target);
          current.clips = current.clips.filter((item) => item.id !== requested[0]!.id);
          (target as MediaTrack).clips.push(requested[0]!);
        }
      }
      if (op.mode === "insert" || !eq(to, earliest))
        for (const item of moving.values()) requireUnlocked(clip(timeline, item.id).track);
      if (op.mode === "insert") {
        const stop = [...moving.values()].reduce((value, item) => (lt(value, end(item)) ? end(item) : value), earliest);
        const duration = sub(stop, earliest);
        const tracks = mediaTracks(timeline);
        const owners = new Map([...moving.values()].map((item) => [item.id, clip(timeline, item.id).track]));
        for (const owner of tracks) owner.clips = owner.clips.filter((item) => !moving.has(item.id));
        const occupied = tracks.some((owner) =>
          owner.clips.some((item) => lt(item.timeline_start, stop) && lt(earliest, end(item))),
        );
        if (!occupied) {
          shift(timeline, stop, sub(zero, duration));
          if (compare(to, stop) >= 0) to = sub(to, duration);
          else if (lt(earliest, to)) to = earliest;
        }
        splitAcross(timeline, to, generate);
        splitMetadata(timeline, to, generate);
        shift(timeline, to, duration);
        for (const item of moving.values()) owners.get(item.id)!.clips.push(item);
      }
      const delta = sub(to, earliest);
      if (op.mode === "overwrite") {
        const excluded = new Set(moving.keys());
        for (const owner of mediaTracks(timeline)) {
          const landings = owner.clips
            .filter((item) => moving.has(item.id))
            .sort((a, b) => compare(a.timeline_start, b.timeline_start));
          const ranges: { start: Rational; stop: Rational }[] = [];
          for (const item of landings) {
            const start = add(item.timeline_start, delta);
            const stop = add(end(item), delta);
            const prior = ranges.at(-1);
            if (prior && compare(start, prior.stop) <= 0) prior.stop = max(prior.stop, stop);
            else ranges.push({ start, stop });
          }
          for (const { start, stop } of ranges)
            clearSpan(timeline, start, stop, new Set([owner.id]), false, generate, false, excluded);
        }
      }
      for (const item of moving.values()) item.timeline_start = add(item.timeline_start, delta);
      cleanTransitions(timeline);
      break;
    }
    case "slip":
    case "slide": {
      const { clip: target } = clip(timeline, op.clip_id);
      const by = time(op.by, true);
      const owners = mediaTracks(timeline);
      const targets = new Set(
        op.linked === false
          ? [target]
          : owners.flatMap((owner) => owner.clips.filter((item) => item.occurrence_id === target.occurrence_id)),
      );
      if (!eq(by, zero)) for (const item of targets) requireUnlocked(clip(timeline, item.id).track);

      if (op.op === "slip") {
        let lower: Rational | undefined;
        let upper: Rational | undefined;
        for (const item of targets) {
          const media = project.media.find((source) => source.id === item.media_id)!;
          if (item.time_map || media.kind === "image")
            fail("E_UNSUPPORTED", "Cannot slip a time-mapped clip or still image");
          const rate = media.video?.rate ?? timeline.edit_rate;
          if (mul(by, rate).denominator !== 1n) fail("E_VALIDATION", "Slip offset is off the source frame grid");
          const first = snap(sub(zero, item.source_start), rate, "ceil");
          const last = snap(sub(media.duration, add(item.source_start, item.duration)), rate, "floor");
          lower = lower ? max(lower, first) : first;
          upper = upper ? min(upper, last) : last;
        }
        checkOffset(by, lower!, upper!);
        for (const item of targets) item.source_start = add(item.source_start, by);
        break;
      }

      const rate =
        owners.some((owner) => owner.kind === "video" && owner.clips.some((item) => targets.has(item))) ||
        mul(by, timeline.edit_rate).denominator === 1n
          ? timeline.edit_rate
          : timeline.audio_rate;
      if (mul(by, rate).denominator !== 1n) fail("E_VALIDATION", "Slide offset is off the timeline grid");
      if (eq(by, zero)) break;
      let lower = sub(zero, target.timeline_start);
      let upper: Rational | undefined;
      const limitRight = (value: Rational) => {
        upper = upper ? min(upper, value) : value;
      };
      const inEdges = new Set<Clip>();
      const outEdges = new Set<Clip>();
      for (const owner of owners) {
        const ordered = [...owner.clips].sort((a, b) => compare(a.timeline_start, b.timeline_start));
        for (const [index, item] of ordered.entries()) {
          if (!targets.has(item)) continue;
          const left = ordered[index - 1];
          const right = ordered[index + 1];
          lower = max(lower, sub(zero, item.timeline_start));
          if (left && !targets.has(left)) {
            const gap = sub(end(left), item.timeline_start);
            if (eq(gap, zero)) outEdges.add(left);
            else lower = max(lower, gap);
          }
          if (right && !targets.has(right)) {
            const gap = sub(right.timeline_start, end(item));
            if (eq(gap, zero)) inEdges.add(right);
            else limitRight(gap);
          }
        }
      }
      // Keep a trimmed neighbor strictly longer than zero on the edit grid.
      const maxTrim = (duration: Rational) => div(rational(ceil(mul(duration, rate)) - 1n), rate);
      const neighbors = new Set([...inEdges, ...outEdges]);
      for (const item of neighbors) {
        if (item.time_map) fail("E_UNSUPPORTED", "Cannot slide against a time-mapped neighbor");
        const media = project.media.find((source) => source.id === item.media_id)!;
        const movesIn = inEdges.has(item);
        const movesOut = outEdges.has(item);
        if (media.kind === "image") {
          const extension = sub(media.duration, item.duration);
          if (movesIn && !movesOut) lower = max(lower, sub(zero, extension));
          if (movesOut && !movesIn) limitRight(extension);
        } else {
          if (movesIn) lower = max(lower, sub(zero, item.source_start));
          if (movesOut) limitRight(sub(media.duration, add(item.source_start, item.duration)));
        }
        if (movesIn && !movesOut) limitRight(maxTrim(item.duration));
        if (movesOut && !movesIn) lower = max(lower, sub(zero, maxTrim(item.duration)));
      }
      checkOffset(by, snap(lower, rate, "ceil"), upper && snap(upper, rate, "floor"));
      for (const item of neighbors) {
        if (inEdges.has(item)) {
          item.timeline_start = add(item.timeline_start, by);
          item.source_start = add(item.source_start, by);
          item.duration = sub(item.duration, by);
        }
        if (outEdges.has(item)) item.duration = add(item.duration, by);
      }
      for (const item of targets) item.timeline_start = add(item.timeline_start, by);
      break;
    }
    case "set_clip": {
      const { clip: target, track: owner } = clip(timeline, op.clip_id);
      requireUnlocked(owner);
      const fields = ["label", "enabled", "gain_db", "source_channels", "transform", "time_map", "sync_broken"];
      if (!fields.some((field) => Object.hasOwn(op, field))) fail("E_VALIDATION", "No clip field supplied");
      if ((Object.hasOwn(op, "gain_db") || Object.hasOwn(op, "source_channels")) && owner.kind !== "audio")
        fail("E_VALIDATION", "Audio field on video clip");
      if (Object.hasOwn(op, "transform") && owner.kind !== "video") fail("E_VALIDATION", "Transform on audio clip");
      if (Array.isArray(op.source_channels)) {
        const channels = project.media.find((item) => item.id === target.media_id)?.audio?.channels ?? 0;
        if ((op.source_channels as number[]).some((channel) => channel >= channels))
          fail("E_VALIDATION", "Source channel does not exist");
      }
      const converted = { ...op };
      if (Array.isArray(op.time_map))
        converted.time_map = (op.time_map as { at: string; source: string; interp: TimeMapPoint["interp"] }[]).map(
          (point) => ({ at: time(point.at), source: time(point.source), interp: point.interp }),
        );
      if (Array.isArray(converted.time_map)) {
        const points = converted.time_map as TimeMapPoint[];
        if (
          !points.length ||
          !eq(points[0]!.at, zero) ||
          !eq(points[0]!.source, target.source_start) ||
          !eq(points.at(-1)!.at, target.duration) ||
          points.some((point, index) => index > 0 && !lt(points[index - 1]!.at, point.at))
        )
          fail("E_VALIDATION", "Time map must span the current clip duration");
      }
      setFields(target, converted, fields);
      break;
    }
    case "add_transition": {
      const from = clip(timeline, op.from_clip),
        to = clip(timeline, op.to_clip);
      if (from.track !== to.track || !eq(end(from.clip), to.clip.timeline_start))
        fail("E_VALIDATION", "Transition clips must meet on one track");
      requireUnlocked(from.track);
      from.track.transitions.push({
        id: id(op.id, "trn_", generate),
        type: "cross_dissolve",
        from_clip: from.clip.id,
        to_clip: to.clip.id,
        duration: t("duration"),
        alignment: op.alignment as "center" | "start" | "end",
      });
      break;
    }
    case "remove_transition": {
      const owner =
        mediaTracks(timeline).find((item) => item.transitions.some((entry) => entry.id === op.transition_id)) ??
        fail("E_NOT_FOUND", "Transition not found");
      requireUnlocked(owner);
      owner.transitions = owner.transitions.filter((entry) => entry.id !== op.transition_id);
      break;
    }
    case "add_marker":
      timeline.markers.push({
        id: id(op.id, "mrk_", generate),
        at: t("at"),
        duration: t("duration"),
        kind: op.kind as Marker["kind"],
        text: op.text as string,
        ...(op.level !== undefined ? { level: op.level as 1 | 2 } : {}),
        ...(op.description !== undefined ? { description: op.description as string } : {}),
        ...(authorKind === "human" && op.kind === "chapter" ? { ext: { "zsir.user_edited": true } } : {}),
      });
      break;
    case "update_marker": {
      const marker =
        timeline.markers.find((item) => item.id === op.marker_id) ?? fail("E_NOT_FOUND", "Marker not found");
      if (!["at", "duration", "kind", "text", "level", "description"].some((field) => Object.hasOwn(op, field)))
        fail("E_VALIDATION", "No marker field supplied");
      const userEdited =
        authorKind === "human" &&
        (op.kind ?? marker.kind) === "chapter" &&
        ["text", "description"].some(
          (field) => Object.hasOwn(op, field) && op[field] !== marker[field as "text" | "description"],
        );
      const converted = { ...op };
      if (op.at !== undefined) converted.at = t("at");
      if (op.duration !== undefined) converted.duration = t("duration");
      setFields(marker, converted, ["at", "duration", "kind", "text", "level", "description"]);
      if (userEdited) marker.ext = { ...marker.ext, "zsir.user_edited": true };
      break;
    }
    case "remove_marker": {
      if (!timeline.markers.some((item) => item.id === op.marker_id)) fail("E_NOT_FOUND", "Marker not found");
      timeline.markers = timeline.markers.filter((item) => item.id !== op.marker_id);
      break;
    }
    case "set_track":
      setFields(track(timeline, op.track_id), op, ["enabled", "locked"]);
      break;
    case "rename_track":
      track(timeline, op.track_id).name = op.name as string;
      break;
    case "update_media": {
      const media = project.media.find((item) => item.id === op.media_id) ?? fail("E_NOT_FOUND", "Media not found");
      media.organize ??= {};
      setFields(media.organize, op, ["tags", "folders", "rating", "note", "link"]);
      if (media.organize.tags) media.organize.tags = [...new Set(media.organize.tags)];
      break;
    }
    case "add_track": {
      const index = (op.index as number | undefined) ?? timeline.tracks.length;
      if (index > timeline.tracks.length) fail("E_VALIDATION", "Track index is out of range");
      timeline.tracks.splice(index, 0, {
        id: id(op.id, "trk_", generate),
        kind: op.kind as "video" | "audio",
        name: (op.name as string | undefined) ?? automaticTrackName(timeline.tracks, op.kind as "video" | "audio"),
        enabled: true,
        clips: [],
        transitions: [],
      });
      break;
    }
    case "remove_track": {
      const owner = track(timeline, op.track_id);
      if (
        (owner.kind !== "subtitle" && (owner.clips.length || owner.transitions.length)) ||
        timeline.tracks.some((item) => item.kind === "subtitle" && item.carrier_tracks.includes(owner.id))
      )
        fail("E_VALIDATION", "Track is not removable");
      timeline.tracks = timeline.tracks.filter((item) => item.id !== owner.id);
      break;
    }
    default:
      fail("E_UNSUPPORTED", `Operation ${op.op} is not implemented`);
  }
}

export function assertEditDomain(ops: Op[], tracks: Timeline["tracks"]): void {
  const trackKinds = new Map(tracks.map((track) => [track.id, track.kind]));
  let subtitleDomain: boolean | undefined;
  for (const op of ops) {
    const isSubtitle =
      SUBTITLE_OPS.has(op.op) ||
      (["rename_track", "set_track"].includes(op.op) && trackKinds.get(op.track_id as string) === "subtitle");
    if (subtitleDomain !== undefined && subtitleDomain !== isSubtitle)
      fail("E_MIXED_DOMAIN", "Editing and subtitle operations cannot be mixed");
    subtitleDomain = isSubtitle;
    if (typeof op.id === "string" && (op.op === "add_track" || op.op === "add_subtitle_track"))
      trackKinds.set(op.id, op.op === "add_subtitle_track" ? "subtitle" : (op.kind as "video" | "audio"));
    if (op.op === "remove_track") trackKinds.delete(op.track_id as string);
  }
}

const MACROS = new Set(["tighten_pauses", "remove_fillers", "keep_tokens", "close_gaps"]);

function projectedTokens(project: Project, timeline: Timeline): ProjectedToken[] {
  const tokens = new Map<string, ProjectedToken>();
  projectSubtitles(project, timeline.id, undefined, false, (item) => {
    tokens.set(`${item.clip.id}:${item.token.id}`, item);
  });
  return [...tokens.values()];
}

function expandMacro(project: Project, timeline: Timeline, op: Op): Op[] {
  const tracks = mediaTracks(timeline);
  const clips = tracks.flatMap((item) => item.clips);
  const scope = op.scope as { range?: { start: string; duration: string }; clip_ids?: string[] } | undefined;
  const scopeClips = scope?.clip_ids?.map((id) => clip(timeline, id).clip);
  const rangeStart = scope?.range ? time(scope.range.start) : zero;
  const scopeRanges = (
    scopeClips
      ? scopeClips.map((item) => ({ start: item.timeline_start, stop: end(item) }))
      : [
          {
            start: rangeStart,
            stop: scope?.range
              ? add(rangeStart, time(scope.range.duration))
              : clips.reduce((last, item) => max(last, end(item)), zero),
          },
        ]
  ).sort((a, b) => compare(a.start, b.start));
  const ranges: typeof scopeRanges = [];
  for (const range of scopeRanges) {
    const previous = ranges.at(-1);
    if (previous && !lt(previous.stop, range.start)) previous.stop = max(previous.stop, range.stop);
    else ranges.push(range);
  }
  const contains = (start: Rational, stop: Rational) =>
    ranges.some((range) => !lt(start, range.start) && !lt(range.stop, stop));
  const cuts: { start: Rational; operation: Op }[] = [];
  const cut = (
    start: Rational,
    stop: Rational,
    selected: string[] | "all" = "all",
    mode: "nearest" | "out" | "in" = "nearest",
  ) => {
    if (!lt(start, stop)) return;
    const rate = timeline.edit_rate;
    if (mode === "nearest" && eq(snap(start, rate, mode), snap(stop, rate, mode))) return;
    if (mode === "in" && !lt(snap(start, rate, "ceil"), snap(stop, rate, "floor"))) return;
    cuts.push({
      start,
      operation: {
        op: "remove_span",
        range: { start: printRational(start, true), duration: printRational(sub(stop, start), true) },
        tracks: selected,
        ripple: true,
        snap: mode,
      },
    });
  };
  if (op.op === "close_gaps") {
    clips.sort((a, b) => compare(a.timeline_start, b.timeline_start));
    const gap = (start: Rational, stop: Rational) => {
      const rate = timeline.edit_rate;
      const onFrames = eq(start, snap(start, rate, "floor")) && eq(stop, snap(stop, rate, "floor"));
      cut(start, stop, "all", onFrames ? "out" : "in");
    };
    for (const range of ranges) {
      let cursor = range.start;
      for (const item of clips) {
        if (!lt(item.timeline_start, range.stop)) break;
        if (!lt(cursor, end(item))) continue;
        gap(cursor, item.timeline_start);
        cursor = end(item);
      }
      gap(cursor, range.stop);
    }
  } else {
    const projected = projectedTokens(project, timeline);
    const groups = new Map<string, ProjectedToken[]>();
    for (const item of projected) {
      const key = `${item.clip.id}:${item.transcript.id}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    if (op.op === "keep_tokens") {
      const target = clip(timeline, op.clip_id).clip;
      const selection = op.keep as { from_token: string; to_token: string }[];
      const linked = clips.filter(
        (item) =>
          item.occurrence_id === target.occurrence_id &&
          lt(item.timeline_start, end(target)) &&
          lt(target.timeline_start, end(item)),
      );
      const available = new Set(project.transcripts.flatMap((item) => item.tokens.map((token) => token.id)));
      if (selection.some(({ from_token, to_token }) => !available.has(from_token) || !available.has(to_token)))
        fail("E_NOT_FOUND", "Token not found");
      const candidates = [...groups.values()].filter(
        (items) =>
          linked.includes(items[0]!.clip) &&
          selection.every(
            ({ from_token, to_token }) =>
              items.some((item) => item.token.id === from_token) && items.some((item) => item.token.id === to_token),
          ),
      );
      const words = candidates.find((items) => items[0]!.clip.id === target.id) ?? candidates[0];
      if (!words) return fail("E_VALIDATION", "Keep tokens must project onto the same clip and transcript");
      const selected = tracks
        .filter((item) => item.clips.some((entry) => linked.includes(entry)))
        .map((item) => item.id);
      const first = linked.reduce((value, item) => min(value, item.timeline_start), target.timeline_start);
      const last = linked.reduce((value, item) => max(value, end(item)), end(target));
      const half = div(time(op.pause ?? "0s"), rational(2n));
      const cutScoped = (start: Rational, stop: Rational) => {
        for (const range of ranges) cut(max(start, range.start), min(stop, range.stop), selected, "in");
      };
      let cursor = first;
      let previous = -1;
      let previousEnd = first;
      for (const { from_token, to_token } of selection) {
        const a = words.findIndex((item) => item.token.id === from_token);
        const b = words.findIndex((item) => item.token.id === to_token);
        const start = words[a]!.start;
        const stop = words[b]!.end;
        if (a <= previous || b < a || lt(start, previousEnd) || !lt(start, stop))
          fail("E_VALIDATION", "Keep token ranges must be ordered and non-overlapping");
        const before = words.slice(0, a).findLast((item) => item.token.text)?.end ?? first;
        const after = words.slice(b + 1).find((item) => item.token.text)?.start ?? last;
        cutScoped(cursor, max(before, sub(start, half)));
        cursor = max(cursor, min(after, add(stop, half)));
        previous = b;
        previousEnd = stop;
      }
      cutScoped(cursor, last);
    } else if (op.op === "tighten_pauses") {
      const limit = time(op.max_pause);
      const threshold = max(limit, time(op.min_gap ?? op.max_pause));
      const half = div(limit, rational(2n));
      for (const items of groups.values()) {
        const words = items.filter((item) => item.token.text);
        for (let i = 1; i < words.length; i++) {
          const { end: left } = words[i - 1]!;
          const { start: right } = words[i]!;
          if (lt(threshold, sub(right, left)) && contains(left, right)) cut(add(left, half), sub(right, half));
        }
      }
    } else {
      const words = new Set(
        (op.words as string[] | undefined) ??
          project.recognition?.filler_words ?? ["嗯", "啊", "呃", "额", "哦", "唉", "哎", "诶"],
      );
      const pause = printRational(time(op.pause ?? "1/5s"), true);
      for (const items of groups.values()) {
        let first: ProjectedToken | undefined;
        let last: ProjectedToken | undefined;
        const flush = () => {
          if (!first || !last) return;
          cuts.push({
            start: first.start,
            operation: {
              op: "remove_span",
              tokens: {
                transcript_id: first.transcript.id,
                from_token: first.token.id,
                to_token: last.token.id,
                clip_id: first.clip.id,
                pause,
              },
              ripple: true,
            },
          });
          first = last = undefined;
        };
        for (const item of items) {
          const match = [item.token.heard, item.token.text].some(
            (value) => value !== undefined && words.has(value.trim().replace(/^\p{P}+|\p{P}+$/gu, "")),
          );
          if (!match || !contains(item.start, item.end)) {
            flush();
            continue;
          }
          if (last && item.transcript.tokens.indexOf(item.token) !== item.transcript.tokens.indexOf(last.token) + 1)
            flush();
          first ??= item;
          last = item;
        }
        flush();
      }
    }
  }
  // Overlapping carrier pauses describe the same timeline interval. Cut the union
  // before rippling so that an earlier cut cannot consume material shifted in by a later one.
  if (op.op === "tighten_pauses") {
    const rate = timeline.edit_rate;
    const pauses = cuts.splice(0).sort((a, b) => compare(a.start, b.start));
    let pending: { start: Rational; stop: Rational } | undefined;
    for (const { start, operation } of pauses) {
      const stop = add(start, time((operation.range as { duration: string }).duration));
      if (pending && lt(snap(start, rate, "nearest"), snap(pending.stop, rate, "nearest"))) {
        pending.stop = max(pending.stop, stop);
      } else {
        if (pending) cut(pending.start, pending.stop);
        pending = { start, stop };
      }
    }
    if (pending) cut(pending.start, pending.stop);
  }
  const unique = new Set<string>();
  // Later cuts leave the positions of independent earlier cuts intact.
  return cuts
    .sort((a, b) => compare(b.start, a.start))
    .flatMap(({ operation }) => {
      const key = JSON.stringify(
        operation.tokens
          ? tokenRange(project, timeline, operation).map((value) => printRational(value, true))
          : operation,
      );
      if (unique.has(key)) return [];
      unique.add(key);
      return [operation];
    });
}

export function applyEdit(
  project: Project,
  ops: Op[],
  entityOps: Record<string, string>,
  seed: string,
  timelineId?: string,
  allowForce = false,
  idTime?: string,
  result: Record<string, unknown> = {},
  authorName = project.revision.author.name,
  authorKind: Author["kind"] = "system",
): void {
  const warnings: Record<string, unknown>[] = [];
  let serial = 0;
  const generate = (prefix: string) =>
    newId(prefix, {
      now: () => Date.parse(idTime ?? project.revision.created_at),
      randomBytes: () => createHash("sha256").update(`${seed}:${serial++}:${prefix}`).digest().subarray(0, 10),
    });
  if (!timelineId && project.timelines.length !== 1)
    fail("E_VALIDATION", "Edit requires timeline_id when the project has multiple timelines");
  const timeline =
    (timelineId ? project.timelines.find((item) => item.id === timelineId) : project.timelines[0]) ??
    fail("E_NOT_FOUND", `Timeline ${timelineId} does not exist`);
  const imageIds = new Set(project.media.filter((media) => media.kind === "image").map((media) => media.id));
  assertEditDomain(ops, timeline.tracks);
  const expanded = ops.some((op) => MACROS.has(op.op)) ? ([] as Op[]) : undefined;
  const execute = (op: Op) => {
    expanded?.push(op);
    const before = structuredClone(project);
    if (SUBTITLE_OPS.has(op.op)) applySubtitleEdit(project, timeline, op, generate, allowForce, warnings, authorName);
    else applyOne(project, timeline, op, generate, authorKind, warnings);
    const oldClips = before.timelines.flatMap((item) => mediaTracks(item).flatMap((track) => track.clips));
    const oldById = new Map(oldClips.map((clip) => [clip.id, clip]));
    const liveClips = project.timelines.flatMap((item) => mediaTracks(item).flatMap((track) => track.clips));
    for (const clip of liveClips) {
      const prior = oldById.get(clip.id);
      if (imageIds.has(clip.media_id) && (!prior || !eq(prior.source_start, clip.source_start)))
        clip.source_start = zero;
    }
    const liveIds = new Set(liveClips.map((clip) => clip.id));
    const removed = oldClips.filter((clip) => !liveIds.has(clip.id));
    if (removed.length) {
      const removedIds = new Set(removed.map((clip) => clip.id));
      const liveOccurrences = new Set(liveClips.map((clip) => clip.occurrence_id));
      const emptyOccurrences = new Set(
        removed.map((clip) => clip.occurrence_id).filter((occurrence) => !liveOccurrences.has(occurrence)),
      );
      for (const item of project.timelines)
        for (const track of item.tracks)
          if (track.kind === "subtitle")
            track.overrides = track.overrides.filter((override) => !emptyOccurrences.has(override.occurrence_id));
          else
            track.transitions = track.transitions.filter(
              (transition) => !removedIds.has(transition.from_clip) && !removedIds.has(transition.to_clip),
            );
    }
    for (const change of diffProjectEntities(before, project)) entityOps[change.key] = op.op;
  };
  for (const op of ops) {
    if (MACROS.has(op.op)) {
      for (const basic of expandMacro(project, timeline, op)) execute(basic);
    } else execute(op);
  }
  if (expanded) result.expanded_ops = expanded;
  if (warnings.length) result.warnings = warnings;
}

export const SUBTITLE_OPS = new Set([
  "add_overlay",
  "update_overlay",
  "remove_overlay",
  "edit_text",
  "mark_proofread",
  "replace_text",
  "set_recognition",
  "hide_tokens",
  "set_token_state",
  "resegment",
  "set_cue",
  "split_token",
  "split_cue",
  "merge_cues",
  "set_override",
  "remove_override",
  "add_free_cue",
  "remove_free_cue",
  "add_style",
  "update_style",
  "add_subtitle_track",
]);
