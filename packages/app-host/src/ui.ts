export const UI_VERBS = ["ui_state", "ui_show_panel", "ui_seek", "ui_select", "ui_play", "ui_pause"] as const;
export type UiVerb = (typeof UI_VERBS)[number];
export const PANELS = ["ai", "media", "chapters", "subtitles"] as const;
export type Panel = (typeof PANELS)[number];
export interface UiState {
  project: string | null;
  panel: Panel;
  sub: string | null;
  playhead: { at: string } | { id: string };
  selected: string[];
  playing: boolean;
  range: { start: string; duration: string } | null;
  loop: boolean;
  chapters?: { levels: 1 | 2; timecodes: boolean } | undefined;
  mediaBrowser?: { scope: string; search: string; size: number } | undefined;
  preview?: "media" | "timeline" | undefined;
  media?: { id: string; at: string; in: string | null; out: string | null } | undefined;
}
export interface UiEnvelope {
  ok: boolean;
  status: "no_op" | "failed" | "rejected";
  verb: UiVerb;
  request_id: string;
  receipt: null;
  changes: [];
  verification: { level: "none"; passed: boolean; issues: [] };
  result: UiState | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
