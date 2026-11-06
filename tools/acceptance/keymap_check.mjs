// 对照 desktop-host.md 3.1 逐项核对 app-host 的 keymap.ts：两套默认都有、键一致、同套没有重复。
// 用法：先 pnpm typecheck，再 node tools/acceptance/keymap_check.mjs
const SPEC = {
  play_pause: ["Space", "Space"], shuttle_back: ["J", "J"], shuttle_stop: ["K", "K"], shuttle_fwd: ["L", "L"],
  step_back: ["Left", "Left"], step_fwd: ["Right", "Right"], prev_edit: ["Up", "Up"], next_edit: ["Down", "Down"],
  next_review: ["⌥Down", "⌥Down"], mark_in: ["I", "I"], mark_out: ["O", "O"],
  zoom_in: ["=", "⌘="], zoom_out: ["-", "⌘-"], zoom_fit: ["\\", "⇧Z"],
  track_taller: ["⌘=", "⌃⌥Up"], track_shorter: ["⌘-", "⌃⌥Down"],
  tool_select: ["V", "A"], tool_blade: ["C", "B"], tool_roll: ["N", "T"],
  split_at_playhead: ["⌘K", "⌘B"], split_all_at_playhead: ["⇧⌘K", "⇧⌘B"],
  nudge_edit_back: ["⌥Left", ","], nudge_edit_fwd: ["⌥Right", "."],
  trim_start_to_playhead: ["Q", "⌥["], trim_end_to_playhead: ["W", "⌥]"], extend_edit: ["E", "⇧X"],
  ripple_delete: ["⌥Delete", "Delete"], lift_delete: ["Delete", "⇧Delete"],
  toggle_snap: ["S", "N"], toggle_magnetic: ["⇧M", "P"], add_marker: ["M", "M"],
  undo: ["⌘Z", "⌘Z"], redo: ["⇧⌘Z", "⇧⌘Z"], toggle_history: ["⌥⌘H", "⌥⌘H"], open_settings: ["⌘,", "⌘,"],
};
const root = process.argv[2] ? new URL(`file://${process.argv[2].replace(/\/?$/, "/")}`) : new URL("../../", import.meta.url);
const mod = await import(new URL("packages/app-host/dist/keymap.js", root));
const presets = mod.PRESETS ?? mod.presets ?? mod.KEYMAP_PRESETS ?? mod.default;
if (!presets?.premiere || !presets?.fcp) {
  console.log("找不到两套默认，导出的名字：", Object.keys(mod));
  process.exit(2);
}
let bad = 0;
for (const [i, name] of [[0, "premiere"], [1, "fcp"]]) {
  const p = presets[name];
  const seen = new Map();
  for (const [action, keys] of Object.entries(SPEC)) {
    if (p[action] !== keys[i]) { console.log(name, action, JSON.stringify(p[action]), "want", keys[i]); bad++; }
  }
  for (const [action, key] of Object.entries(p)) {
    if (!(action in SPEC)) { console.log(name, "规格里没有的动作", action); bad++; }
    if (key && seen.has(key)) { console.log(name, "重复的键", key, seen.get(key), action); bad++; }
    seen.set(key, action);
  }
}
console.log(bad ? `${bad} 处不一致` : `OK（${Object.keys(SPEC).length} 个动作 × 2 套）`);
process.exit(bad ? 1 : 0);
