import type { Action } from "../../app-host/src/keymap.js";

export const actionLabels: Record<Action, string> = {
  play_pause: "播放 · 停止",
  shuttle_back: "倒放",
  shuttle_stop: "停止",
  shuttle_fwd: "快放",
  step_back: "前一帧",
  step_fwd: "后一帧",
  prev_edit: "上一个剪点",
  next_edit: "下一个剪点",
  next_review: "下一个待审处",
  mark_in: "标入点",
  mark_out: "标出点",
  zoom_in: "水平放大",
  zoom_out: "水平缩小",
  zoom_fit: "缩放到整条",
  track_taller: "轨道变高",
  track_shorter: "轨道变矮",
  tool_select: "选择工具",
  tool_blade: "切割工具",
  tool_roll: "移动剪点（滚动编辑）",
  split_at_playhead: "在播放头切一刀",
  split_all_at_playhead: "所有轨道一起切",
  nudge_edit_back: "剪点前移 1 帧",
  nudge_edit_fwd: "剪点后移 1 帧",
  trim_start_to_playhead: "剪到播放头：去掉前段",
  trim_end_to_playhead: "剪到播放头：去掉后段",
  extend_edit: "把剪点延到播放头",
  ripple_delete: "删除并合拢",
  lift_delete: "删除留空隙",
  toggle_snap: "吸附开关",
  toggle_magnetic: "磁性开关",
  toggle_skimming: "浏览条开关",
  add_marker: "加标记",
  undo: "撤销",
  redo: "重做",
  toggle_history: "历史悬浮窗",
  open_settings: "设置",
};
export function recordedKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">,
) {
  const aliases: Record<string, string> = {
    " ": "Space",
    Backspace: "Delete",
    Delete: "ForwardDelete",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
  };
  // macOS Option changes event.key; physical letters still record the intended shortcut.
  const punctuation: Record<string, string> = {
    Equal: "=",
    Minus: "-",
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    BracketLeft: "[",
    BracketRight: "]",
  };
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : (punctuation[event.code] ?? aliases[event.key] ?? event.key.toUpperCase());
  if (!/^(?:[A-Z0-9=\-\\,.[\]]|Space|Delete|ForwardDelete|Left|Right|Up|Down)$/.test(key)) return null;
  return `${event.ctrlKey ? "⌃" : ""}${event.altKey ? "⌥" : ""}${event.shiftKey ? "⇧" : ""}${event.metaKey ? "⌘" : ""}${key}`;
}
export function displayKey(key: string | null) {
  return (
    key
      ?.replace("ForwardDelete", "⌦")
      .replace("Delete", "⌫")
      .replace("Space", "空格")
      .replace("Left", "←")
      .replace("Right", "→")
      .replace("Up", "↑")
      .replace("Down", "↓") ?? "未设置"
  );
}
