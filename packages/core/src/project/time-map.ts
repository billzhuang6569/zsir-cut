// biome-ignore-all lint/style/noNonNullAssertion: Time-map points are validated by project semantics.
import { add, compare, div, mul, type Rational, rational, sub } from "../rational.js";
import type { Clip, TimeMapPoint } from "./types.js";

const zero = rational(0n);

export function clipTimeMap(clip: Clip): TimeMapPoint[] {
  return (
    clip.time_map ?? [
      { at: zero, source: clip.source_start, interp: "linear" },
      { at: clip.duration, source: add(clip.source_start, clip.duration), interp: "linear" },
    ]
  );
}

export function mapClipTimeToSource(clip: Clip, at: Rational): Rational {
  const points = clipTimeMap(clip);
  for (let index = 0; index < points.length - 1; index++) {
    const first = points[index]!;
    const last = points[index + 1]!;
    if (compare(at, last.at) <= 0) {
      if (first.interp === "hold" && compare(at, last.at) < 0) return first.source;
      return add(first.source, mul(sub(at, first.at), div(sub(last.source, first.source), sub(last.at, first.at))));
    }
  }
  return points.at(-1)!.source;
}

/** Source-to-sequence inversion is defined only for a source-increasing segment. */
export function mapSourceTimeToClip(source: Rational, first: TimeMapPoint, last: TimeMapPoint): Rational | null {
  if (compare(last.source, first.source) <= 0) return null;
  const clamped =
    compare(source, first.source) < 0 ? first.source : compare(source, last.source) > 0 ? last.source : source;
  return add(first.at, mul(sub(clamped, first.source), div(sub(last.at, first.at), sub(last.source, first.source))));
}
