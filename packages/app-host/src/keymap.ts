export const premiere = {
  play_pause: "Space",
  shuttle_back: "J",
  shuttle_stop: "K",
  shuttle_fwd: "L",
  step_back: "Left",
  step_fwd: "Right",
  prev_edit: "Up",
  next_edit: "Down",
  next_review: "⌥Down",
  mark_in: "I",
  mark_out: "O",
  zoom_in: "=",
  zoom_out: "-",
  zoom_fit: "\\",
  track_taller: "⌘=",
  track_shorter: "⌘-",
  tool_select: "V",
  tool_blade: "C",
  tool_roll: "N",
  split_at_playhead: "⌘K",
  split_all_at_playhead: "⇧⌘K",
  nudge_edit_back: "⌥Left",
  nudge_edit_fwd: "⌥Right",
  trim_start_to_playhead: "Q",
  trim_end_to_playhead: "W",
  extend_edit: "E",
  ripple_delete: "⌥Delete",
  lift_delete: "Delete",
  toggle_snap: "S",
  toggle_magnetic: "⇧M",
  toggle_skimming: "⇧S",
  add_marker: "M",
  undo: "⌘Z",
  redo: "⇧⌘Z",
  toggle_history: "⌥⌘H",
  open_settings: "⌘,",
} as const;
export type Action = keyof typeof premiere;
export const fcp: Record<Action, string> = {
  ...premiere,
  zoom_in: "⌘=",
  zoom_out: "⌘-",
  zoom_fit: "⇧Z",
  track_taller: "⌃⌥Up",
  track_shorter: "⌃⌥Down",
  tool_select: "A",
  tool_blade: "B",
  tool_roll: "T",
  split_at_playhead: "⌘B",
  split_all_at_playhead: "⇧⌘B",
  nudge_edit_back: ",",
  nudge_edit_fwd: ".",
  trim_start_to_playhead: "⌥[",
  trim_end_to_playhead: "⌥]",
  extend_edit: "⇧X",
  ripple_delete: "Delete",
  lift_delete: "⇧Delete",
  toggle_snap: "N",
  toggle_magnetic: "P",
  toggle_skimming: "S",
};
export const presets = { premiere, fcp };
export const actions = Object.keys(premiere) as Action[];
export const keyNotation = /^⌃?⌥?⇧?⌘?(?:[A-Z0-9=\-\\,.[\]]|Space|Delete|ForwardDelete|Left|Right|Up|Down)$(?![\s\S])/;
export function mergeKeymap(preset: keyof typeof presets, overrides: Partial<Record<Action, string | null>>) {
  const keymap: Record<Action, string | null> = { ...presets[preset] };
  const unbound = new Set<Action>();
  // Fixed action order keeps competing overrides stable across sorted file writes.
  for (const action of actions) {
    if (!Object.hasOwn(overrides, action)) continue;
    const key = overrides[action] ?? null;
    if (key !== null) {
      for (const other of actions) {
        if (other !== action && keymap[other] === key) {
          keymap[other] = null;
          unbound.add(other);
        }
      }
    }
    keymap[action] = key;
    unbound.delete(action);
  }
  return { keymap, unbound: [...unbound] };
}
