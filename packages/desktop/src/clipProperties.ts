import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  compare,
  contains,
  div,
  mul,
  parseRational,
  printRational,
  rational,
  sub,
} from "./timeline.js";

export type ClipEdit = (label: string, ops: unknown[]) => void;
export type GainPreview = { ids: string[]; db: number };

export function selectedClips(project: ProjectView, ids: string[]) {
  return project.tracks.flatMap((track) =>
    track.kind === "subtitle" ? [] : track.clips.filter(({ id }) => ids.includes(id)).map((clip) => ({ clip, track })),
  );
}

export function setClips(ids: string[], fields: Record<string, unknown>) {
  return ids.map((clip_id) => ({ op: "set_clip", clip_id, ...fields }));
}

const seconds = (value: string) => parseRational(value, true);
const duration = (clip: ClipView) => sub(seconds(clip.timeline_out.t), seconds(clip.timeline_in.t));

export function currentClipRate(clip: ClipView) {
  if (!clip.time_map) return "1";
  const start = seconds(clip.source_in.t);
  const at = seconds(clip.timeline_in.t);
  const rate = div(sub(seconds(clip.source_out.t), start), duration(clip));
  const constant =
    rate.numerator !== 0n &&
    clip.time_map.every(
      (point, index, points) =>
        (index === points.length - 1 || point.interp === "linear") &&
        compare(seconds(point.source.t), add(start, mul(sub(seconds(point.at.t), at), rate))) === 0,
    );
  return constant ? printRational(rate) : null;
}

export function clipRateChange(clip: ClipView, input: string, mediaDuration?: string) {
  const match = /^(-?)(\d+)(?:\.(\d+)|\/([1-9]\d*))?$/.exec(input.trim());
  if (!match) throw new Error("输入倍速，例如 1.5、3/2 或 -1");
  const [, sign = "", whole = "", fraction = "", denominator] = match;
  const rate = rational(
    BigInt(sign + whole + fraction),
    denominator ? BigInt(denominator) : 10n ** BigInt(fraction.length),
  );
  if (rate.numerator === 0n) throw new Error("倍速必须大于或小于 0");
  const span = duration(clip);
  const start = seconds(clip.source_in.t);
  const end = add(start, mul(span, rate));
  if (end.numerator < 0n || (mediaDuration && compare(end, seconds(mediaDuration)) > 0))
    throw new Error("当前源入点没有足够素材，请调整倍速或源入点");
  return {
    rate: printRational(rate),
    time_map:
      rate.numerator === rate.denominator
        ? null
        : [
            { at: "0s", source: clip.source_in.t, interp: "linear" },
            { at: printRational(span, true), source: printRational(end, true), interp: "linear" },
          ],
  };
}

export function timelineGain(
  project: ProjectView | null,
  clip: ClipView | undefined,
  at: string,
  preview?: GainPreview | null,
) {
  if (!clip) return 0;
  const audio = clip.occurrence_id
    ? project?.tracks
        .filter((track) => track.kind === "audio" && track.enabled)
        .flatMap((track) => track.clips)
        .find(
          (item) =>
            item.enabled &&
            item.occurrence_id === clip.occurrence_id &&
            item.media_id === clip.media_id &&
            contains(item.timeline_in.t, item.timeline_out.t, at),
        )
    : undefined;
  if (preview && (preview.ids.includes(clip.id) || (audio && preview.ids.includes(audio.id)))) return preview.db;
  return audio?.gain_db ?? clip.gain_db ?? 0;
}
