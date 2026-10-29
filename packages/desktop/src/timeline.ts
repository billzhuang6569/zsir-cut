import { mapClipTimeToSource } from "../../core/src/project/time-map.ts";
import {
  add,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  type Rational,
  rational,
  sub,
} from "../../core/src/rational.ts";
import { frameToTimecode } from "../../core/src/timecode.ts";
export { add, compare, div, floor, mul, parseRational, printRational, rational, sub };
export const zero = rational(0n);
export type Time = { t: string; tc?: string };
export interface ClipView {
  occurrence_id?: string;
  id: string;
  media_id: string;
  label: string | null;
  enabled: boolean;
  timeline_in: Time;
  timeline_out: Time;
  source_in: Time;
  source_out: Time;
  speed: string;
  time_map?: { at: Time; source: Time; interp: string }[];
  gain_db?: number | null;
}
export interface TrackView {
  id: string;
  name: string;
  kind: "video" | "audio" | "subtitle";
  enabled: boolean;
  clips: ClipView[];
}
export interface TimelineView {
  id: string;
  edit_rate: string;
  start_timecode: string;
  drop_frame: boolean;
  duration: Time;
  tracks: TrackView[];
  markers: { id: string; at: Time; text: string; kind: string; level?: 1 | 2 }[];
}
export interface CueView {
  cue_id: string;
  track_id: string;
  start: string;
  end: string;
  text: string;
  style_id: string;
  piece: number;
}
export interface StyleView {
  id: string;
  font_family: string;
  font_size: number;
  font_weight?: number;
  color: string;
  outline?: { color: string; width: number };
  box?: { color: string; padding?: number };
  position?: { anchor: string; margin_v: number };
}
export interface MediaView {
  uses?: number;
  id: string;
  name?: string;
  kind: string;
  path?: string;
  duration?: string;
  start_timecode?: string;
  reel?: string;
  video?: { rate: string; width: number; height: number };
  audio?: { sample_rate: string; channels: number };
  organize?: { note?: string; link?: string; tags?: string[]; folders?: string[]; rating?: number };
}
export interface PreviewData {
  media: MediaView[];
  cues: CueView[];
  styles: StyleView[];
}
// Numbers are used only at browser pixel/media API boundaries; timeline state remains rational.
export const numberOf = (value: Rational) => Number(value.numerator) / Number(value.denominator);
export const pixelAt = (at: string, scale: number) => numberOf(mul(parseRational(at, true), rational(BigInt(scale))));
export const frameTime = (frame: bigint, rate: string) =>
  printRational(div(rational(frame < 0n ? 0n : frame), parseRational(rate)), true);
export const frameAt = (at: string, rate: string) => floor(mul(parseRational(at, true), parseRational(rate)));
export function pointerTime(pixels: number, scale: number, rate: string): string {
  const time = div(rational(BigInt(Math.max(0, Math.round(pixels * 1000)))), rational(BigInt(scale * 1000)));
  return frameTime(floor(add(mul(time, parseRational(rate)), rational(1n, 2n))), rate);
}
export function timecode(at: string, timeline: TimelineView) {
  return frameToTimecode(
    frameAt(at, timeline.edit_rate),
    timeline.edit_rate,
    timeline.drop_frame,
    timeline.start_timecode,
  );
}
export const contains = (start: string, end: string, at: string) =>
  compare(parseRational(at, true), parseRational(start, true)) >= 0 &&
  compare(parseRational(at, true), parseRational(end, true)) < 0;
export function sourceAt(clip: ClipView, at: string): Rational {
  const start = parseRational(clip.timeline_in.t, true);
  return mapClipTimeToSource(
    {
      id: clip.id,
      occurrence_id: clip.id,
      media_id: clip.media_id,
      timeline_start: start,
      duration: sub(parseRational(clip.timeline_out.t, true), start),
      source_start: parseRational(clip.source_in.t, true),
      ...(clip.time_map
        ? {
            time_map: clip.time_map.map((point) => ({
              at: sub(parseRational(point.at.t, true), start),
              source: parseRational(point.source.t, true),
              interp: point.interp as "linear" | "smooth" | "hold",
            })),
          }
        : {}),
    },
    sub(parseRational(at, true), start),
  );
}
export function sourceSpeed(clip: ClipView, at: string): number {
  if (!clip.time_map) return 1;
  const points = clip.time_map;
  const index = points.findIndex(
    (point, i) => i > 0 && compare(parseRational(at, true), parseRational(point.at.t, true)) < 0,
  );
  const first = points[index - 1],
    last = points[index];
  if (!first || !last || first.interp === "hold") return 0;
  return numberOf(
    div(
      sub(parseRational(last.source.t, true), parseRational(first.source.t, true)),
      sub(parseRational(last.at.t, true), parseRational(first.at.t, true)),
    ),
  );
}
export function seekTarget(timeline: TimelineView, cues: CueView[], target: { at: string } | { id: string }): string {
  if ("at" in target)
    return compare(parseRational(target.at, true), parseRational(timeline.duration.t, true)) > 0
      ? timeline.duration.t
      : target.at;
  return (
    timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === target.id)?.timeline_in.t ??
    timeline.markers.find((marker) => marker.id === target.id)?.at.t ??
    cues.find((cue) => cue.cue_id === target.id)?.start ??
    "0s"
  );
}
