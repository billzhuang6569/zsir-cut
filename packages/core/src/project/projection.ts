// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by project schema or local checks.
import { add, compare, div, type Rational, rational, sub } from "../rational.js";
import { clipTimeMap, mapSourceTimeToClip } from "./time-map.js";
import type { Clip, Cue, Project, TimeMapPoint, Token, Transcript } from "./types.js";

export interface ProjectedCue {
  track_id: string;
  cue_id: string;
  clip_id: string | null;
  occurrence_id: string | null;
  piece: number;
  start: Rational;
  end: Rational;
  text: string;
  lines: string[];
  style_id: string;
  token_ids: string[];
}

export interface UnprojectedToken {
  clip_id: string;
  token_id: string;
}

export type CueSourceRange = (cue: Cue, transcript: Transcript) => { start: Rational; end: Rational } | undefined;

const zero = rational(0n);
const half = rational(2n);
const min = (a: Rational, b: Rational) => (compare(a, b) < 0 ? a : b);
const max = (a: Rational, b: Rational) => (compare(a, b) > 0 ? a : b);
const overlap = (a: Rational, b: Rational, c: Rational, d: Rational) => max(zero, sub(min(b, d), max(a, c)));
const midpoint = (a: Rational, b: Rational) => div(add(a, b), half);

function segments(clip: Clip) {
  const points = clipTimeMap(clip);
  return points.slice(0, -1).map((first, index) => ({ first, last: points[index + 1]! }));
}

function selectForwardSegment(source: Rational, start: Rational, end: Rational, parts: ReturnType<typeof segments>) {
  const forwards = parts.filter(({ first, last }) => compare(last.source, first.source) > 0);
  const contained = forwards.find(
    ({ first, last }) => compare(source, first.source) >= 0 && compare(source, last.source) <= 0,
  );
  if (contained) return contained;
  return forwards
    .filter(({ first, last }) => compare(overlap(start, end, first.source, last.source), zero) > 0)
    .reduce<(typeof forwards)[number] | undefined>((best, part) => {
      if (!best) return part;
      return compare(
        overlap(start, end, part.first.source, part.last.source),
        overlap(start, end, best.first.source, best.last.source),
      ) > 0
        ? part
        : best;
    }, undefined);
}

function display(tokens: Token[], breaks: Set<string>): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line && /[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(token.text)) line += " ";
    line += token.text;
    if (breaks.has(token.id)) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function projectSubtitles(
  project: Project,
  timelineId: string,
  sourceRange?: CueSourceRange,
): {
  cues: ProjectedCue[];
  unprojected: UnprojectedToken[];
} {
  const timeline = project.timelines.find((item) => item.id === timelineId);
  if (!timeline) throw new Error(`Unknown timeline: ${timelineId}`);
  const cues: ProjectedCue[] = [];
  const unprojected: UnprojectedToken[] = [];
  const seen = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.kind !== "subtitle" || !track.enabled) continue;
    for (const carrierId of track.carrier_tracks) {
      const carrier = timeline.tracks.find((item) => item.id === carrierId);
      if (!carrier || carrier.kind !== "audio" || !carrier.enabled) continue;
      for (const clip of carrier.clips) {
        if (
          clip.enabled === false ||
          (clip.time_map &&
            (clip.time_map.length < 2 ||
              clip.time_map.some((point, index) => index > 0 && compare(point.at, clip.time_map![index - 1]!.at) <= 0)))
        )
          continue;
        const parts = segments(clip);
        const sourceStart = parts.reduce((value, part) => min(value, part.last.source), parts[0]!.first.source);
        const sourceEnd = parts.reduce((value, part) => max(value, part.last.source), parts[0]!.first.source);
        const clipEnd = add(clip.timeline_start, clip.duration);
        for (const transcript of project.transcripts.filter(
          (item) => item.media_id === clip.media_id && item.language === track.language,
        )) {
          const indexes = new Map(transcript.tokens.map((token, index) => [token.id, index]));
          for (const cue of transcript.cues) {
            const firstIndex = indexes.get(cue.first_token);
            const lastIndex = indexes.get(cue.last_token);
            if (firstIndex === undefined || lastIndex === undefined || firstIndex > lastIndex) continue;
            const tokens = transcript.tokens.slice(firstIndex, lastIndex + 1);
            const replacement = sourceRange?.(cue, transcript);
            const override = track.overrides.find(
              (item) => item.occurrence_id === clip.occurrence_id && item.cue_id === cue.id,
            );
            let group: {
              token: Token;
              start: Rational;
              end: Rational;
              part: { first: TimeMapPoint; last: TimeMapPoint };
            }[] = [];
            let piece = 0;
            const flush = () => {
              if (!group.length) return;
              const first = group[0]!;
              const last = group.at(-1)!;
              const startSource =
                first.token.id === cue.first_token ? (cue.timing?.start ?? replacement?.start) : undefined;
              const endSource = last.token.id === cue.last_token ? (cue.timing?.end ?? replacement?.end) : undefined;
              const start = max(
                clip.timeline_start,
                startSource === undefined
                  ? first.start
                  : add(clip.timeline_start, mapSourceTimeToClip(startSource, first.part.first, first.part.last)!),
              );
              const end = min(
                clipEnd,
                endSource === undefined
                  ? last.end
                  : add(clip.timeline_start, mapSourceTimeToClip(endSource, last.part.first, last.part.last)!),
              );
              if (compare(start, end) < 0 && !override?.hidden) {
                const included = group.map((item) => item.token);
                const lines =
                  override?.text !== undefined ? override.text.split("\n") : display(included, new Set(cue.breaks));
                cues.push({
                  track_id: track.id,
                  cue_id: cue.id,
                  clip_id: clip.id,
                  occurrence_id: clip.occurrence_id,
                  piece,
                  start,
                  end,
                  text: lines.join("\n"),
                  lines,
                  style_id: override?.style_id ?? cue.style_id ?? track.default_style_id,
                  token_ids: included.map((item) => item.id),
                });
                piece++;
              }
              group = [];
            };
            for (const token of tokens) {
              const { start, end } = token.align;
              if (
                !token.text ||
                compare(start, end) >= 0 ||
                compare(overlap(start, end, sourceStart, sourceEnd), div(sub(end, start), half)) < 0
              ) {
                flush();
                continue;
              }
              const excluded = parts.some(
                ({ first, last }) =>
                  (first.interp === "hold" && compare(start, first.source) <= 0 && compare(first.source, end) < 0) ||
                  (compare(last.source, first.source) < 0 &&
                    compare(overlap(start, end, last.source, first.source), div(sub(end, start), half)) >= 0),
              );
              const part = excluded ? undefined : selectForwardSegment(midpoint(start, end), start, end, parts);
              if (!part) {
                const key = `${clip.id}:${token.id}`;
                if (!seen.has(key)) {
                  unprojected.push({ clip_id: clip.id, token_id: token.id });
                  seen.add(key);
                }
                flush();
                continue;
              }
              const mappedStart = add(clip.timeline_start, mapSourceTimeToClip(start, part.first, part.last)!);
              const mappedEnd = add(clip.timeline_start, mapSourceTimeToClip(end, part.first, part.last)!);
              if (group.length && compare(mappedStart, group.at(-1)!.start) < 0) flush();
              group.push({ token, start: mappedStart, end: mappedEnd, part });
            }
            flush();
          }
        }
      }
    }
    for (const cue of track.free_cues) {
      cues.push({
        track_id: track.id,
        cue_id: cue.id,
        clip_id: null,
        occurrence_id: null,
        piece: 0,
        start: cue.timeline_start,
        end: add(cue.timeline_start, cue.duration),
        text: cue.text,
        lines: cue.text.split("\n"),
        style_id: cue.style_id ?? track.default_style_id,
        token_ids: [],
      });
    }
  }
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  cues.sort(
    (a, b) =>
      byId(a.track_id, b.track_id) || compare(a.start, b.start) || byId(a.cue_id, b.cue_id) || a.piece - b.piece,
  );
  return { cues, unprojected };
}
