import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  ceil,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  rational,
  sub,
  zero,
} from "./timeline.js";

const time = (value: string) => parseRational(value, true);
const min = (a: typeof zero, b: typeof zero) => (compare(a, b) < 0 ? a : b);
const max = (a: typeof zero, b: typeof zero) => (compare(a, b) > 0 ? a : b);

export function slideGesture(project: ProjectView, anchor: ClipView, tool: "slip" | "slide") {
  const tracks = project.tracks.filter((track) => track.kind !== "subtitle");
  const linked = (clip: ClipView) =>
    clip.id === anchor.id || (!!anchor.occurrence_id && clip.occurrence_id === anchor.occurrence_id);
  const clips = tracks.flatMap((track) => track.clips.filter(linked));
  const inEdges = new Set<ClipView>();
  const outEdges = new Set<ClipView>();
  const editRate = parseRational(project.edit_rate);
  let rate = editRate;
  let lower = sub(zero, time(anchor.timeline_in.t));
  let upper: typeof zero | undefined;
  const limit = (limit: typeof zero) => {
    upper = upper ? min(upper, limit) : limit;
  };
  const snap = (value: typeof zero, grid: typeof zero, round: typeof ceil) =>
    div(rational(round(mul(value, grid))), grid);
  let unavailable = tracks.some((track) => track.locked && track.clips.some(linked)) ? "请先解锁关联轨道" : null;

  if (tool === "slip") {
    lower = sub(zero, time(anchor.source_in.t));
    let common: typeof zero | undefined;
    for (const clip of clips) {
      const media = project.media.find((media) => media.id === clip.media_id);
      if (!media?.duration || media.kind === "image" || clip.time_map) {
        unavailable ??= !media?.duration ? "缺少素材时长，无法滑动" : "静帧或变速片段无法滑动内容";
        continue;
      }
      const grid = media.video ? parseRational(media.video.rate) : editRate;
      if (!common) common = grid;
      else {
        let a = common.numerator * grid.denominator;
        let b = grid.numerator * common.denominator;
        while (b) [a, b] = [b, a % b];
        common = rational(a, common.denominator * grid.denominator);
      }
      const duration = sub(time(clip.timeline_out.t), time(clip.timeline_in.t));
      const start = time(clip.source_in.t);
      lower = max(lower, snap(sub(zero, start), grid, ceil));
      limit(snap(sub(time(media.duration), add(start, duration)), grid, floor));
    }
    rate = common ?? rate;
  } else {
    for (const track of tracks) {
      const ordered = [...track.clips].sort((a, b) => compare(time(a.timeline_in.t), time(b.timeline_in.t)));
      for (const [index, clip] of ordered.entries()) {
        if (!linked(clip)) continue;
        const start = time(clip.timeline_in.t);
        const end = time(clip.timeline_out.t);
        lower = max(lower, sub(zero, start));
        const left = ordered[index - 1];
        const right = ordered[index + 1];
        if (left && !linked(left)) {
          const gap = sub(time(left.timeline_out.t), start);
          if (gap.numerator === 0n) outEdges.add(left);
          else lower = max(lower, gap);
        }
        if (right && !linked(right)) {
          const gap = sub(time(right.timeline_in.t), end);
          if (gap.numerator === 0n) inEdges.add(right);
          else limit(gap);
        }
      }
    }
    for (const clip of new Set([...inEdges, ...outEdges])) {
      const media = project.media.find((media) => media.id === clip.media_id);
      if (clip.time_map || !media?.duration) {
        unavailable ??= !media?.duration ? "缺少相邻素材时长，无法滑动" : "相邻片段有变速，无法滑动";
        continue;
      }
      const movesIn = inEdges.has(clip);
      const movesOut = outEdges.has(clip);
      const duration = sub(time(clip.timeline_out.t), time(clip.timeline_in.t));
      const maxTrim = div(rational(ceil(mul(duration, rate)) - 1n), rate);
      const source = time(clip.source_in.t);
      const extension = sub(time(media.duration), duration);
      if (media.kind === "image") {
        if (movesIn && !movesOut) lower = max(lower, sub(zero, extension));
        if (movesOut && !movesIn) limit(extension);
      } else {
        if (movesIn) lower = max(lower, sub(zero, source));
        if (movesOut) limit(sub(extension, source));
      }
      if (movesIn && !movesOut) limit(maxTrim);
      if (movesOut && !movesIn) lower = max(lower, sub(zero, maxTrim));
    }
  }

  lower = snap(lower, rate, ceil);
  if (upper) upper = snap(upper, rate, floor);
  const affected = new Set([...clips, ...inEdges, ...outEdges]);
  const images = new Set(project.media.filter((media) => media.kind === "image").map((media) => media.id));
  return (pixels: number, scale: number) => {
    const raw = div(rational(BigInt(Math.round(pixels))), rational(BigInt(scale)));
    const requested = snap(add(raw, div(rational(1n, 2n), rate)), rate, floor);
    const by =
      unavailable || (upper && compare(lower, upper) > 0)
        ? zero
        : max(lower, upper ? min(requested, upper) : requested);
    const shift = (value: ClipView["timeline_in"]) => ({ t: printRational(add(time(value.t), by), true) });
    const result = new Map(
      [...affected].map((clip) => {
        const moves = linked(clip);
        const start = tool === "slide" && (moves || inEdges.has(clip)) ? shift(clip.timeline_in) : clip.timeline_in;
        const end = tool === "slide" && (moves || outEdges.has(clip)) ? shift(clip.timeline_out) : clip.timeline_out;
        const image = images.has(clip.media_id);
        return [
          clip.id,
          {
            ...clip,
            timeline_in: start,
            timeline_out: end,
            source_in: !image && (tool === "slip" || inEdges.has(clip)) ? shift(clip.source_in) : clip.source_in,
            source_out:
              image && (inEdges.has(clip) || outEdges.has(clip))
                ? { t: printRational(sub(time(end.t), time(start.t)), true) }
                : tool === "slip" || outEdges.has(clip)
                  ? shift(clip.source_out)
                  : clip.source_out,
            ...(moves && clip.time_map && tool === "slide"
              ? { time_map: clip.time_map.map((point) => ({ ...point, at: shift(point.at) })) }
              : {}),
          },
        ] as const;
      }),
    );
    const reason =
      unavailable ??
      (compare(by, requested) !== 0 ? (tool === "slip" ? "已到素材边界" : "已到相邻片段或空隙边界") : null);
    return { by, clips: result, blocked: reason !== null, reason };
  };
}
