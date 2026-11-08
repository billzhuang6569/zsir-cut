import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "./connection.js";
import { compare, frameAt, frameTime, parseRational, printRational } from "./timeline.js";
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

export function editPoints(project: ProjectView) {
  return project.tracks
    .filter((track) => track.kind !== "subtitle")
    .flatMap((track) =>
      track.clips.flatMap((left) =>
        track.clips.some(
          (right) =>
            right.id !== left.id &&
            compare(parseRational(left.timeline_out.t, true), parseRational(right.timeline_in.t, true)) === 0,
        )
          ? [{ track_id: track.id, at: left.timeline_out.t, clip_id: left.id }]
          : [],
      ),
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
  if (action === "ripple_delete" || action === "lift_delete")
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
        : [],
    };
  if (action === "trim_start_to_playhead" || action === "trim_end_to_playhead") {
    const edge = action === "trim_start_to_playhead" ? "in" : "out";
    const targets = selected.filter((clip) => crossing.includes(clip));
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
  if (action === "extend_edit" || action === "nudge_edit_back" || action === "nudge_edit_fwd") {
    const delta = action === "nudge_edit_back" ? -1n : 1n;
    if (point)
      return {
        label: action === "extend_edit" ? "把剪点延到播放头" : "移动剪点一帧",
        ops: [
          {
            op: "roll",
            clip_id: point.clip_id,
            edge: "out",
            to:
              action === "extend_edit"
                ? cut
                : frameTime(frameAt(point.at, project.edit_rate) + delta, project.edit_rate),
          },
        ],
      };
    if (action !== "extend_edit" && selected.length) {
      const group = moveGroup(project, state.selected, selected[0]?.id ?? "");
      return {
        label: "移动片段一帧",
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
