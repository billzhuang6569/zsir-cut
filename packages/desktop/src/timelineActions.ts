import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "./connection.js";
import { add, compare, frameAt, frameTime, parseRational, printRational, sub } from "./timeline.js";
import { moveGroup } from "./timelineMove.js";
import { trimGroup } from "./timelineTrim.js";

export function keyboardKey(event: KeyboardEvent) {
  const names: Record<string, string> = {
    " ": "Space",
    Backspace: "Delete",
    Delete: "ForwardDelete",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    "+": "=",
    "<": ",",
    ">": ".",
    "{": "[",
    "}": "]",
    _: "-",
    "|": "\\",
  };
  const codes: Record<string, string> = {
    Comma: ",",
    Period: ".",
    BracketLeft: "[",
    BracketRight: "]",
    Equal: "=",
    Minus: "-",
    Backslash: "\\",
  };
  const key =
    event.altKey && event.code.startsWith("Key")
      ? event.code.slice(3)
      : (codes[event.code] ?? names[event.key] ?? event.key.toUpperCase());
  return `${event.ctrlKey ? "⌃" : ""}${event.altKey ? "⌥" : ""}${event.shiftKey ? "⇧" : ""}${event.metaKey ? "⌘" : ""}${key}`;
}

export function timelineMarks(
  action: "mark_in" | "mark_out" | "clear_in_out",
  state: UiState,
  at: string,
  project: ProjectView,
): UiState {
  if (action === "clear_in_out") return { ...state, timelineMarks: null, range: null };
  const end = parseRational(project.duration.t, true);
  const head = frameTime(frameAt(at, project.edit_rate), project.edit_rate);
  const time = parseRational(head, true);
  const marks = { in: null, out: null, ...state.timelineMarks };
  if (action === "mark_in") {
    if (compare(time, end) >= 0) return state;
    marks.in = head;
    if (marks.out && compare(time, parseRational(marks.out, true)) >= 0) marks.out = null;
  } else {
    if (compare(time, parseRational("0s", true)) <= 0) return state;
    marks.out = head;
    if (marks.in && compare(time, parseRational(marks.in, true)) <= 0) marks.in = null;
  }
  return { ...state, timelineMarks: marks, range: markedTimelineRange(marks, project.duration.t) };
}

export function markedTimelineRange(marks: NonNullable<UiState["timelineMarks"]>, timelineEnd: string) {
  const start = marks.in ?? "0s";
  const duration = sub(parseRational(marks.out ?? timelineEnd, true), parseRational(start, true));
  return duration.numerator > 0n ? { start, duration: printRational(duration, true) } : null;
}

export function editPoints(project: ProjectView) {
  return project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) =>
      track.clips.flatMap((left) => {
        const right = track.clips.find(
          (right) =>
            right.id !== left.id &&
            compare(parseRational(left.timeline_out.t, true), parseRational(right.timeline_in.t, true)) === 0,
        );
        return right ? [{ track_id: track.id, at: left.timeline_out.t, clip_id: left.id, right_id: right.id }] : [];
      }),
    );
}

function crossingAt(project: ProjectView, cut: string) {
  return project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        compare(parseRational(clip.timeline_in.t, true), parseRational(cut, true)) < 0 &&
        compare(parseRational(clip.timeline_out.t, true), parseRational(cut, true)) > 0,
    );
}

export function splitAllAt(project: ProjectView, at: string) {
  const cut = frameTime(frameAt(at, project.edit_rate), project.edit_rate);
  return crossingAt(project, cut).map((clip) => ({ op: "split", clip_id: clip.id, at: cut, linked: false }));
}

export function timelineEdit(action: string, project: ProjectView, state: UiState, at: string, magnetic: boolean) {
  if (action === "close_all_gaps") return { label: "合拢全部空隙", ops: [{ op: "close_gaps" }] };
  if ((action === "ripple_delete" || action === "lift_delete") && state.gap) {
    const { start, duration } = state.gap;
    const end = printRational(add(parseRational(start, true), parseRational(duration, true)), true);
    const onGrid = [start, end].every((at) => frameTime(frameAt(at, project.edit_rate), project.edit_rate) === at);
    const current = timelineGaps(project).some((gap) => gap.start === start && gap.duration === duration);
    return {
      label: "合拢这段空隙",
      ops:
        action === "ripple_delete" && current
          ? [{ op: "remove_span", range: state.gap, ripple: true, ...(onGrid ? {} : { snap: "in" }) }]
          : [],
    };
  }
  const clips = project.tracks.filter((track) => track.kind !== "subtitle").flatMap((track) => track.clips);
  const selected = clips.filter((clip) => state.selected.includes(clip.id));
  const cut = frameTime(frameAt(at, project.edit_rate), project.edit_rate);
  const crossing = crossingAt(project, cut);
  const point =
    state.edit_point &&
    editPoints(project).find(
      (point) =>
        point.track_id === state.edit_point?.track_id &&
        compare(parseRational(point.at, true), parseRational(state.edit_point.at, true)) === 0,
    );
  if (action === "split_all_at_playhead") return { label: "所有轨道在播放头切开", ops: splitAllAt(project, cut) };
  if (action === "split_at_playhead") {
    const top = project.tracks.find(
      (track) =>
        track.kind === "video" && track.enabled && track.clips.some((clip) => clip.enabled && crossing.includes(clip)),
    );
    const targets = selected.length
      ? selected.filter((clip) => crossing.includes(clip))
      : (top?.clips.filter((clip) => clip.enabled && crossing.includes(clip)).slice(0, 1) ?? []);
    return {
      label: "在播放头切开",
      ops: targets
        .filter(
          (clip, index) =>
            !clip.occurrence_id || targets.findIndex((other) => other.occurrence_id === clip.occurrence_id) === index,
        )
        .map((clip) => ({ op: "split", clip_id: clip.id, at: cut })),
    };
  }
  if (action === "ripple_delete" || action === "lift_delete") {
    const { in: start, out: stop } = state.timelineMarks ?? {};
    const tracks = project.tracks
      .filter((track) => track.kind !== "subtitle" && !track.locked)
      .map((track) => track.id);
    const duration = start && stop ? sub(parseRational(stop, true), parseRational(start, true)) : null;
    return {
      label: action === "ripple_delete" ? "删除并合拢" : "删除留空隙",
      ops: selected.length
        ? [
            {
              op: "remove",
              clip_ids: selected.map((clip) => clip.id),
              ...(action === "ripple_delete" ? { ripple: true } : {}),
            },
          ]
        : start && duration && duration.numerator > 0n && tracks.length
          ? [
              {
                op: "remove_span",
                range: { start, duration: printRational(duration, true) },
                tracks,
                ripple: action === "ripple_delete",
              },
            ]
          : [],
    };
  }
  if (action === "trim_start_to_playhead" || action === "trim_end_to_playhead") {
    const edge = action === "trim_start_to_playhead" ? "in" : "out";
    const targets = selected.filter((clip) => crossing.includes(clip));
    if (
      targets.some((clip) => trimGroup(project, clip, edge, true).some((item) => item.time_map || item.speed === "map"))
    )
      return { ops: [], label: "", reason: "变速片段无法修剪" };
    return {
      label: edge === "in" ? "剪掉播放头前段" : "剪掉播放头后段",
      ops: targets
        .filter(
          (clip, index) =>
            !targets
              .slice(0, index)
              .some((other) => trimGroup(project, other, edge, true).some((linked) => linked.id === clip.id)),
        )
        .map((clip) => ({ op: "trim", clip_id: clip.id, edge, to: cut, ripple: magnetic })),
    };
  }
  if (["extend_edit", "nudge_edit_back", "nudge_edit_fwd", "nudge_edit_back10", "nudge_edit_fwd10"].includes(action)) {
    const count = action.endsWith("10") ? 10n : 1n;
    const delta = action.startsWith("nudge_edit_back") ? -count : count;
    const selection = state.edit_point;
    const side = action === "extend_edit" ? "both" : selection?.side;
    const edge = side === "right" ? "in" : "out";
    const oneSide = side === "left" || side === "right";
    const selectedEdge = oneSide && selection?.clip_id;
    const clipId = selectedEdge
      ? clips.find(
          (clip) =>
            clip.id === selectedEdge && (edge === "in" ? clip.timeline_in.t : clip.timeline_out.t) === selection.at,
        )?.id
      : side === "right"
        ? point?.right_id
        : point?.clip_id;
    if (selection && clipId) {
      const to =
        action === "extend_edit" ? cut : frameTime(frameAt(selection.at, project.edit_rate) + delta, project.edit_rate);
      return {
        label: action === "extend_edit" ? "把剪点延到播放头" : `移动剪点 ${count} 帧`,
        ops:
          to === selection.at
            ? []
            : [
                {
                  op: oneSide ? "trim" : "roll",
                  clip_id: clipId,
                  edge,
                  to,
                  ...(oneSide ? { ripple: magnetic } : {}),
                },
              ],
      };
    }
    if (action !== "extend_edit" && selected.length) {
      const group = moveGroup(project, state.selected, selected[0]?.id ?? "");
      return {
        label: `移动片段 ${count} 帧`,
        ops: [
          {
            op: "move",
            clip_ids: selected.map((clip) => clip.id),
            to: frameTime(frameAt(printRational(group.earliest, true), project.edit_rate) + delta, project.edit_rate),
            mode: magnetic ? "insert" : "place",
          },
        ],
      };
    }
    return { label: "移动剪点", ops: [] };
  }
  return null;
}

export function timelineGaps(project: ProjectView) {
  const time = (value: string) => parseRational(value, true);
  const clips = project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) => track.clips)
    .sort((a, b) => compare(time(a.timeline_in.t), time(b.timeline_in.t)));
  const gaps: { start: string; duration: string }[] = [];
  let cursor = time("0s");
  for (const clip of clips) {
    const start = time(clip.timeline_in.t);
    const end = time(clip.timeline_out.t);
    if (compare(start, cursor) > 0)
      gaps.push({ start: printRational(cursor, true), duration: printRational(sub(start, cursor), true) });
    if (compare(end, cursor) > 0) cursor = end;
  }
  return gaps;
}
