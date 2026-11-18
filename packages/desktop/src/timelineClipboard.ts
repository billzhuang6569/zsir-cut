import type { ProjectView } from "./connection.js";
import type { UiState } from "./state.js";
import { add, type ClipView, compare, frameAt, frameTime, parseRational, printRational, sub } from "./timeline.js";
import { clipsOverlap } from "./timelineMove.js";

const time = (value: string) => parseRational(value, true);
const print = (value: ReturnType<typeof time>) => printRational(value, true);

export function copyClips(project: ProjectView, ids: string[]) {
  const clips = project.tracks.flatMap(({ kind, id, clips }) =>
    kind === "subtitle" ? [] : clips.filter((clip) => ids.includes(clip.id)).map((clip) => ({ kind, track: id, clip })),
  );
  clips.sort((a, b) => compare(time(a.clip.timeline_in.t), time(b.clip.timeline_in.t)));
  const groups = new Map<string, [(typeof clips)[number], ...(typeof clips)[number][]]>();
  for (const item of clips) {
    const key = item.clip.occurrence_id ?? item.clip.id;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return structuredClone([...groups.values()]);
}

type Target = Pick<ClipView, "timeline_in" | "timeline_out"> & { track: string };
const overlaps = (target: Target, clip: Pick<ClipView, "timeline_in" | "timeline_out">) =>
  clipsOverlap(time(target.timeline_in.t), time(target.timeline_out.t), clip);

export function planPaste(
  project: ProjectView,
  clipboard: ReturnType<typeof copyClips>,
  at: string,
  magnetic: boolean,
  { drag, editTargets }: { drag?: { anchor: string; track: string }; editTargets?: UiState["editTargets"] } = {},
) {
  const first = clipboard[0]?.[0];
  if (!first) return { error: "剪贴板为空" };
  const start = time(frameTime(frameAt(at, project.edit_rate), project.edit_rate));
  const origin = time(first.clip.timeline_in.t);
  const groups = [];
  const targets: Target[] = [];
  let staging = start;
  if (!magnetic)
    for (const track of project.tracks)
      for (const clip of track.kind === "subtitle" ? [] : track.clips)
        if (compare(time(clip.timeline_out.t), staging) > 0) staging = time(clip.timeline_out.t);
  for (const [first, ...linked] of clipboard) {
    const { clip } = first;
    const groupStart = time(clip.timeline_in.t);
    const source = time(clip.source_in.t);
    const destination = add(start, sub(groupStart, origin));
    const still = project.media.find((media) => media.id === clip.media_id)?.kind === "image";
    const items: {
      clip: ClipView;
      kind: "audio" | "video";
      track: string;
      start: ReturnType<typeof time>;
      stop: ReturnType<typeof time>;
      target: Target;
    }[] = [];
    let duration = sub(time(clip.timeline_out.t), groupStart);
    for (const item of [first, ...linked]) {
      const { clip: member, kind } = item;
      const offset = sub(time(member.timeline_in.t), groupStart);
      const out = sub(time(member.timeline_out.t), groupStart);
      if (
        items.some((other) => other.kind === kind) ||
        member.media_id !== clip.media_id ||
        compare(time(member.source_in.t), still ? source : add(source, offset)) !== 0
      )
        return { error: "这组联动片段的轨道或源范围无法用一次放置复制" };
      const dragTrack = drag?.anchor === member.id ? drag.track : undefined;
      const peers = project.tracks.filter((track) => track.kind === kind);
      const track = dragTrack
        ? peers.find((track) => track.id === dragTrack)
        : (peers.find((track) => track.id === editTargets?.[kind]) ??
          peers.find((track) => track.id === item.track) ??
          peers[0]);
      if (!track) return { error: drag ? "只能复制到同类轨道" : "找不到同类轨道" };
      if (track.locked) return { error: `轨道「${track.name}」已锁定` };
      const from = add(destination, offset);
      const to = add(destination, out);
      if (targets.some((other) => other.track === track.id && clipsOverlap(from, to, other)))
        return { error: `副本会在轨道「${track.name}」上互相重叠` };
      const target = { track: track.id, timeline_in: { t: print(from) }, timeline_out: { t: print(to) } };
      targets.push(target);
      items.push({ clip: member, kind, track: track.id, start: offset, stop: out, target });
      if (compare(out, duration) > 0) duration = out;
      if (compare(to, staging) > 0) staging = to;
    }
    groups.push({ clip, items, destination, duration });
  }
  const covered = magnetic
    ? []
    : project.tracks.flatMap((track) =>
        track.clips.filter((clip) => targets.some((target) => target.track === track.id && overlaps(target, clip))),
      );
  const originalIds = new Set(clipboard.flat().map(({ clip }) => clip.id));
  if (drag && covered.some((clip) => originalIds.has(clip.id))) return { error: "副本会覆盖原片段" };

  const placements = [];
  let end = start;
  let originals =
    drag && magnetic
      ? clipboard.flat().map(({ clip }) => ({
          start: time(clip.timeline_in.t),
          stop: time(clip.timeline_out.t),
        }))
      : [];
  const clear: Target[] = [];
  for (const { clip, items, destination, duration } of groups) {
    const uneven = items.some((item) => item.start.numerator !== 0n || compare(item.stop, duration) !== 0);
    const stagedOverwrite = !magnetic && uneven;
    // Insert after earlier copies to avoid splitting them. Stage uneven overwrites beyond the timeline to avoid clearing their unused margins.
    const at = stagedOverwrite ? staging : magnetic && compare(destination, end) < 0 ? end : destination;
    end = add(at, duration);
    if (stagedOverwrite) {
      staging = end;
      clear.push(...items.map((item) => item.target));
    }
    if (originals.some(({ start, stop }) => compare(start, at) < 0 && compare(at, stop) < 0))
      return { error: "插入会切开原片段" };
    originals = originals.map((span) =>
      compare(span.start, at) >= 0 ? { start: add(span.start, duration), stop: add(span.stop, duration) } : span,
    );
    placements.push({ clip, items, at, destination, duration });
  }
  const clearing = clear.length
    ? project.tracks.flatMap((track) =>
        track.clips.flatMap((clip) => {
          const ranges = clear
            .filter((target) => target.track === track.id && overlaps(target, clip))
            .sort((a, b) => compare(time(a.timeline_in.t), time(b.timeline_in.t)));
          return ranges.length ? [{ clip, ranges }] : [];
        }),
      )
    : [];
  const warning = covered.length
    ? `将覆盖：${covered
        .map((clip) => clip.label ?? project.media.find((media) => media.id === clip.media_id)?.name ?? clip.id)
        .join("、")}`
    : null;
  return { targets, placements, clearing, warning, mode: magnetic ? "insert" : "overwrite" };
}

export function pasteOps(plan: Extract<ReturnType<typeof planPaste>, { placements: unknown }>) {
  const ops: Record<string, unknown>[] = [];
  const moves: Record<string, unknown>[] = [];
  const clipId = () => `clp_${crypto.randomUUID()}`;
  const removed: string[] = [];
  for (const { clip, ranges } of plan.clearing) {
    let id = clip.id;
    let from = time(clip.timeline_in.t);
    const end = time(clip.timeline_out.t);
    const split = (at: ReturnType<typeof time>) => {
      const next = clipId();
      ops.push({ op: "split", clip_id: id, new_id: next, at: print(at), linked: false });
      id = next;
    };
    for (const range of ranges) {
      const start = time(range.timeline_in.t);
      const stop = time(range.timeline_out.t);
      if (compare(from, start) < 0) split(start);
      removed.push(id);
      if (compare(stop, end) < 0) split(stop);
      from = stop;
    }
  }
  if (removed.length) ops.push({ op: "remove", clip_ids: removed });
  for (const { clip: original, items, at, destination, duration } of plan.placements) {
    const place: Record<string, unknown> = {
      op: "place",
      mode: plan.mode,
      media_id: original.media_id,
      source_start: original.source_in.t,
      at: print(at),
      duration: print(duration),
    };
    ops.push(place);
    const ids = items.map(({ clip, kind, track, start, stop }) => {
      const id = clipId();
      place[`${kind}_track`] = track;
      place[`${kind}_clip_id`] = id;
      if (kind === "audio" && clip.source_channels) place.source_channels = clip.source_channels;
      if (start.numerator !== 0n)
        ops.push({ op: "trim", clip_id: id, edge: "in", to: print(add(at, start)), linked: false });
      if (compare(stop, duration) !== 0)
        ops.push({ op: "trim", clip_id: id, edge: "out", to: print(add(at, stop)), linked: false });
      ops.push({
        op: "set_clip",
        clip_id: id,
        label: clip.label,
        enabled: clip.enabled,
        ...(kind === "audio" && clip.gain_db != null ? { gain_db: clip.gain_db } : {}),
        ...(kind === "video" && clip.transform ? { transform: clip.transform } : {}),
        ...(clip.sync_broken ? { sync_broken: true } : {}),
        ...(clip.time_map
          ? {
              time_map: clip.time_map.map(({ at, source, interp }) => ({
                at: print(sub(time(at.t), time(clip.timeline_in.t))),
                source: source.t,
                interp,
              })),
            }
          : {}),
      });
      return id;
    });
    if (compare(at, destination) !== 0)
      moves.push({ op: "move", clip_ids: ids, to: print(destination), mode: "place" });
  }
  return [...ops, ...moves];
}
