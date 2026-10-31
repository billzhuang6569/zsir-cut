// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by schema or local checks.

import { createHash } from "node:crypto";
import { add, ceil, compare, div, floor, mul, parseRational, type Rational, rational, sub } from "../rational.ts";
import { diffProjectEntities } from "./entities.ts";
import { newId } from "./id.ts";
import { projectSubtitles } from "./projection.ts";
import { applySubtitleEdit } from "./subtitle-edit.ts";
import { clipTimeMap, mapClipTimeToSource, mapSourceTimeToClip } from "./time-map.ts";
import { automaticTrackName } from "./track-name.ts";
import type { Clip, Marker, Media, MediaTrack, Project, Timeline, TimeMapPoint, Token, Track } from "./types.ts";

export class EditError extends Error {
  readonly code: "E_MIXED_DOMAIN" | "E_VALIDATION" | "E_NOT_FOUND" | "E_UNSUPPORTED" | "E_LOCKED" | "E_SESSION_STATE";
  constructor(code: EditError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Op = Record<string, unknown> & { op: string };
const zero = rational(0n);
const lt = (a: Rational, b: Rational) => compare(a, b) < 0;
const eq = (a: Rational, b: Rational) => compare(a, b) === 0;
const min = (a: Rational, b: Rational) => (lt(a, b) ? a : b);
const end = (clip: Clip) => add(clip.timeline_start, clip.duration);
const time = (value: unknown) => {
  try {
    return parseRational(value as string, true);
  } catch {
    return fail("E_VALIDATION", `Invalid time: ${String(value)}`);
  }
};
const id = (value: unknown, prefix: string, generate: (prefix: string) => string) =>
  typeof value === "string" ? value : generate(prefix);
const fail = (code: EditError["code"], message: string): never => {
  throw new EditError(code, message);
};

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
    item.transitions = item.transitions.filter((transition) => {
      const from = item.clips.find((entry) => entry.id === transition.from_clip);
      const to = item.clips.find((entry) => entry.id === transition.to_clip);
      return from && to && eq(end(from), to.timeline_start);
    });
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
      if (compare(target.timeline_start, at) >= 0) target.timeline_start = add(target.timeline_start, amount);
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
    for (const target of [...item.clips]) {
      if (excluded.has(target.id)) continue;
      if (lt(target.timeline_start, start) && lt(start, end(target))) splitOne(item, target, start, generate("clp_"));
    }
    for (const target of [...item.clips]) {
      if (excluded.has(target.id)) continue;
      if (lt(target.timeline_start, stop) && lt(stop, end(target))) splitOne(item, target, stop, generate("clp_"));
    }
    item.clips = item.clips.filter(
      (target) => excluded.has(target.id) || lt(target.timeline_start, start) || !lt(target.timeline_start, stop),
    );
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
  if (selection.clip_id) clip(timeline, selection.clip_id);
  const cues = projectSubtitles(project, timeline.id, undefined, false).cues;
  const starts = new Set(cues.filter((cue) => cue.token_ids.includes(selection.from_token)).map((cue) => cue.clip_id));
  const ends = new Set(cues.filter((cue) => cue.token_ids.includes(selection.to_token)).map((cue) => cue.clip_id));
  const candidates = [...starts].filter(
    (value) => value && ends.has(value) && (!selection.clip_id || selection.clip_id === value),
  );
  if (candidates.length !== 1) fail("E_VALIDATION", "Token range must project onto exactly one clip");
  const target = clip(timeline, candidates[0]).clip;
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
    const shown = new Set(cues.filter((cue) => cue.clip_id === target.id).flatMap((cue) => cue.token_ids));
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
function applyOne(project: Project, timeline: Timeline, op: Op, generate: (prefix: string) => string): void {
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
      for (const item of mediaTracks(timeline)) item.clips = item.clips.filter((entry) => !ids.has(entry.id));
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
        current.clips = current.clips.filter((item) => item.id !== requested[0]!.id);
        (target as MediaTrack).clips.push(requested[0]!);
      }
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
      for (const item of moving.values()) item.timeline_start = add(item.timeline_start, delta);
      cleanTransitions(timeline);
      break;
    }
    case "set_clip": {
      const { clip: target, track: owner } = clip(timeline, op.clip_id);
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
      });
      break;
    case "update_marker": {
      const marker =
        timeline.markers.find((item) => item.id === op.marker_id) ?? fail("E_NOT_FOUND", "Marker not found");
      if (!["at", "duration", "kind", "text", "level"].some((field) => Object.hasOwn(op, field)))
        fail("E_VALIDATION", "No marker field supplied");
      const converted = { ...op };
      if (op.at !== undefined) converted.at = t("at");
      if (op.duration !== undefined) converted.duration = t("duration");
      setFields(marker, converted, ["at", "duration", "kind", "text", "level"]);
      break;
    }
    case "remove_marker": {
      if (!timeline.markers.some((item) => item.id === op.marker_id)) fail("E_NOT_FOUND", "Marker not found");
      timeline.markers = timeline.markers.filter((item) => item.id !== op.marker_id);
      break;
    }
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
  const trackKinds = new Map(timeline.tracks.map((track) => [track.id, track.kind]));
  let subtitleDomain: boolean | undefined;
  for (const op of ops) {
    const isSubtitle =
      SUBTITLE_OPS.has(op.op) || (op.op === "rename_track" && trackKinds.get(op.track_id as string) === "subtitle");
    if (subtitleDomain !== undefined && subtitleDomain !== isSubtitle)
      fail("E_MIXED_DOMAIN", "Editing and subtitle operations cannot be mixed");
    subtitleDomain = isSubtitle;
    if (typeof op.id === "string" && (op.op === "add_track" || op.op === "add_subtitle_track"))
      trackKinds.set(op.id, op.op === "add_subtitle_track" ? "subtitle" : (op.kind as "video" | "audio"));
    if (op.op === "remove_track") trackKinds.delete(op.track_id as string);
  }
  for (const op of ops) {
    const before = structuredClone(project);
    if (SUBTITLE_OPS.has(op.op)) applySubtitleEdit(project, timeline, op, generate, allowForce, warnings, authorName);
    else applyOne(project, timeline, op, generate);
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
  }
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
