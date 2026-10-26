// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by schema or test setup.
import { add, compare, div, mul, type Rational, rational, sub } from "../rational.js";
import type { ProjectIssue } from "./io.js";
import type { Clip, Project } from "./types.js";

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  ids: string[];
}

const zero = rational(0n);
const one = rational(1n);
const lt = (a: Rational, b: Rational) => compare(a, b) < 0;
const eq = (a: Rational, b: Rational) => compare(a, b) === 0;
const grid = (time: Rational, rate: Rational) => mul(time, rate).denominator === 1n;
const end = (clip: Clip) => add(clip.timeline_start, clip.duration);

function mapped(clip: Clip, at: Rational): Rational {
  if (!clip.time_map) return add(clip.source_start, at);
  const points = clip.time_map;
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i]!;
    const next = points[i + 1]!;
    if (compare(at, next.at) <= 0) {
      if (current.interp === "hold" && !eq(at, next.at)) return current.source;
      return add(
        current.source,
        mul(sub(at, current.at), div(sub(next.source, current.source), sub(next.at, current.at))),
      );
    }
  }
  return points.at(-1)!.source;
}

function boundary(clip: Clip, side: "start" | "end"): { source: Rational; speed: Rational } {
  if (!clip.time_map || clip.time_map.length < 2) {
    return { source: side === "start" ? clip.source_start : add(clip.source_start, clip.duration), speed: one };
  }
  const points = clip.time_map;
  const first = side === "start" ? points[0]! : points[points.length - 2]!;
  const last = side === "start" ? points[1]! : points.at(-1)!;
  return {
    source: side === "start" ? first.source : last.source,
    speed: first.interp === "hold" ? zero : div(sub(last.source, first.source), sub(last.at, first.at)),
  };
}

export function validateProjectSemantics(project: Project, parseIssues: ProjectIssue[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = parseIssues.map((issue) => {
    let item: unknown = project;
    let id = project.id;
    for (const segment of issue.location.split("/").slice(1, -1)) {
      item = (item as Record<string, unknown> | undefined)?.[segment];
      if (item && typeof item === "object" && "id" in item && typeof item.id === "string") id = item.id;
    }
    return { code: issue.code, severity: issue.severity, message: issue.location, ids: [id] };
  });
  const report = (code: string, severity: "error" | "warning", message: string, ...ids: string[]) =>
    issues.push({ code, severity, message, ids });
  const ids = new Set<string>();
  const addId = (id: string) => {
    if (ids.has(id)) report("E_ID_DUP", "error", "ID is used more than once", id);
    ids.add(id);
  };
  const media = new Map(project.media.map((item) => [item.id, item]));
  const styles = new Set(project.subtitle_styles.map((item) => item.id));
  const occurrences = new Map<string, string>();
  const occurrenceClips = new Map<string, Clip[]>();
  addId(project.id);
  addId(project.revision.id);
  for (const item of project.media) {
    addId(item.id);
    if (item.video?.vfr) report("W_VFR", "warning", "Variable frame rate media", item.id);
  }
  for (const item of project.subtitle_styles) addId(item.id);

  for (const timeline of project.timelines) {
    addId(timeline.id);
    const tracks = new Map(timeline.tracks.map((track) => [track.id, track]));
    for (const track of timeline.tracks) {
      addId(track.id);
      if (track.kind === "subtitle") {
        if (!styles.has(track.default_style_id))
          report("E_REF", "error", "Missing default style", track.id, track.default_style_id);
        for (const carrier of track.carrier_tracks)
          if (tracks.get(carrier)?.kind !== "audio")
            report("E_REF", "error", "Missing audio carrier track", track.id, carrier);
        for (const cue of track.free_cues) {
          addId(cue.id);
          if (cue.style_id && !styles.has(cue.style_id))
            report("E_REF", "error", "Missing style", cue.id, cue.style_id);
        }
        for (const override of track.overrides)
          if (override.style_id && !styles.has(override.style_id))
            report("E_REF", "error", "Missing override style", track.id, override.style_id);
        continue;
      }
      const clips = new Map(track.clips.map((clip) => [clip.id, clip]));
      const sorted = [...track.clips].sort((a, b) => compare(a.timeline_start, b.timeline_start));
      for (let i = 1; i < sorted.length; i++)
        if (lt(sorted[i]!.timeline_start, end(sorted[i - 1]!)))
          report("E_OVERLAP", "error", "Clips overlap on one track", sorted[i - 1]!.id, sorted[i]!.id);
      for (const clip of track.clips) {
        addId(clip.id);
        const otherMedia = occurrences.get(clip.occurrence_id);
        if (otherMedia && otherMedia !== clip.media_id)
          report("E_REF", "error", "Occurrence refers to different media", clip.id, clip.occurrence_id);
        occurrences.set(clip.occurrence_id, clip.media_id);
        occurrenceClips.set(clip.occurrence_id, [...(occurrenceClips.get(clip.occurrence_id) ?? []), clip]);
        const source = media.get(clip.media_id);
        if (!source) report("E_REF", "error", "Missing media", clip.id, clip.media_id);
        const validMap =
          !clip.time_map ||
          (clip.time_map.length >= 2 &&
            eq(clip.time_map[0]!.at, zero) &&
            eq(clip.time_map[0]!.source, clip.source_start) &&
            eq(clip.time_map.at(-1)!.at, clip.duration) &&
            clip.time_map.every((point, index) => index === 0 || lt(clip.time_map![index - 1]!.at, point.at)));
        if (!validMap) report("E_TIMEMAP", "error", "Invalid time map", clip.id);
        if (
          !grid(clip.timeline_start, timeline.edit_rate) &&
          (track.kind === "video" || !grid(clip.timeline_start, timeline.audio_rate))
        )
          report("E_GRID", "error", "Clip start is off grid", clip.id);
        if (!grid(end(clip), timeline.edit_rate) && (track.kind === "video" || !grid(end(clip), timeline.audio_rate)))
          report("E_GRID", "error", "Clip end is off grid", clip.id);
        if (clip.time_map) {
          for (const point of clip.time_map) {
            if (!grid(point.at, timeline.edit_rate))
              report("E_GRID", "error", "Time map point is off frame grid", clip.id);
          }
          if (clip.time_map.slice(0, -1).some((point) => point.interp === "smooth"))
            report("W_TIMEMAP_APPROX", "warning", "Smooth time map uses linear approximation", clip.id);
        }
        if (source) {
          const positions = clip.time_map?.map((point) => point.source) ?? [
            clip.source_start,
            add(clip.source_start, clip.duration),
          ];
          if (
            positions.some((position) => lt(position, zero) || compare(position, source.duration) > 0) ||
            (source.kind === "image" && !eq(clip.source_start, zero))
          )
            report("E_SOURCE_RANGE", "error", "Source range exceeds media", clip.id, source.id);
        }
      }
      for (const transition of track.transitions) {
        addId(transition.id);
        const from = clips.get(transition.from_clip);
        const to = clips.get(transition.to_clip);
        if (!from || !to) {
          report(
            "E_REF",
            "error",
            "Transition references missing clip",
            transition.id,
            transition.from_clip,
            transition.to_clip,
          );
          continue;
        }
        if (!eq(end(from), to.timeline_start)) {
          report("E_HANDLES", "error", "Transition clips do not meet", transition.id, from.id, to.id);
          continue;
        }
        if ((from.time_map && from.time_map.length < 2) || (to.time_map && to.time_map.length < 2)) continue;
        const outgoing =
          transition.alignment === "end"
            ? zero
            : transition.alignment === "center"
              ? div(transition.duration, rational(2n))
              : transition.duration;
        const incoming =
          transition.alignment === "start"
            ? zero
            : transition.alignment === "center"
              ? div(transition.duration, rational(2n))
              : transition.duration;
        const fromEdge = boundary(from, "end");
        const toEdge = boundary(to, "start");
        const fromNeeded = add(fromEdge.source, mul(outgoing, fromEdge.speed));
        const toNeeded = sub(toEdge.source, mul(incoming, toEdge.speed));
        const fromMedia = media.get(from.media_id);
        const toMedia = media.get(to.media_id);
        if (
          (fromMedia && (lt(fromNeeded, zero) || compare(fromNeeded, fromMedia.duration) > 0)) ||
          (toMedia && (lt(toNeeded, zero) || compare(toNeeded, toMedia.duration) > 0))
        )
          report("E_HANDLES", "error", "Insufficient transition source handles", transition.id, from.id, to.id);
      }
    }
    for (const marker of timeline.markers) addId(marker.id);
  }

  for (const [occurrence, clips] of occurrenceClips) {
    for (let i = 0; i < clips.length; i++)
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i]!;
        const b = clips[j]!;
        if (a.sync_broken || b.sync_broken) continue;
        let outOfSync = false;
        if (!a.time_map && !b.time_map)
          outOfSync = !eq(sub(a.timeline_start, a.source_start), sub(b.timeline_start, b.source_start));
        else if ((!a.time_map || a.time_map.length >= 2) && (!b.time_map || b.time_map.length >= 2)) {
          const start = compare(a.timeline_start, b.timeline_start) > 0 ? a.timeline_start : b.timeline_start;
          const stop = compare(end(a), end(b)) < 0 ? end(a) : end(b);
          if (lt(start, stop)) {
            const cuts = [
              start,
              stop,
              ...[a, b].flatMap((clip) => clip.time_map?.map((point) => add(clip.timeline_start, point.at)) ?? []),
            ]
              .filter((time) => compare(time, start) >= 0 && compare(time, stop) <= 0)
              .sort(compare);
            const samples = [
              ...cuts,
              ...cuts.slice(1).map((time, index) => div(add(time, cuts[index]!), rational(2n))),
            ];
            outOfSync = samples.some(
              (time) => !eq(mapped(a, sub(time, a.timeline_start)), mapped(b, sub(time, b.timeline_start))),
            );
          }
        }
        if (outOfSync)
          report("W_SYNC", "warning", "Occurrence clips map to different source times", occurrence, a.id, b.id);
      }
  }

  for (const transcript of project.transcripts) {
    addId(transcript.id);
    if (!media.has(transcript.media_id))
      report("E_REF", "error", "Transcript references missing media", transcript.id, transcript.media_id);
    const tokens = new Map(transcript.tokens.map((token, index) => [token.id, index]));
    const runs = new Set(transcript.raw_runs.map((run) => run.id));
    for (const run of transcript.raw_runs) addId(run.id);
    for (let i = 0; i < transcript.tokens.length; i++) {
      const token = transcript.tokens[i]!;
      addId(token.id);
      if (!runs.has(token.align.run))
        report("E_REF", "error", "Token references missing run", token.id, token.align.run);
      if (
        !lt(token.align.start, token.align.end) ||
        (i > 0 && lt(token.align.start, transcript.tokens[i - 1]!.align.end))
      )
        report("W_TOKEN_TIME", "warning", "Token has invalid or overlapping time", token.id);
      if (token.align.conf !== undefined && token.align.conf < 0.6)
        report("W_LOW_CONF", "warning", "Low alignment confidence", token.id);
    }
    for (const cue of transcript.cues) {
      addId(cue.id);
      const first = tokens.get(cue.first_token);
      const last = tokens.get(cue.last_token);
      if (first === undefined || last === undefined || first > last)
        report("E_TOKEN_RANGE", "error", "Invalid cue token range", cue.id, cue.first_token, cue.last_token);
      for (const token of cue.breaks ?? [])
        if (!tokens.has(token)) report("E_REF", "error", "Cue break references missing token", cue.id, token);
      if (cue.style_id && !styles.has(cue.style_id))
        report("E_REF", "error", "Cue references missing style", cue.id, cue.style_id);
    }
  }
  const cueIds = new Set(project.transcripts.flatMap((transcript) => transcript.cues.map((cue) => cue.id)));
  for (const timeline of project.timelines)
    for (const track of timeline.tracks) {
      if (track.kind !== "subtitle") continue;
      for (const override of track.overrides) {
        if (!occurrences.has(override.occurrence_id))
          report("E_REF", "error", "Override references missing occurrence", track.id, override.occurrence_id);
        if (!cueIds.has(override.cue_id))
          report("E_REF", "error", "Override references missing cue", track.id, override.cue_id);
      }
    }
  // Subtitle projection warnings belong to 1.3; width, duration and CPS warnings belong to 1.7.
  return issues;
}
