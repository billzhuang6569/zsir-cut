export const UI_VERBS = ["ui_state", "ui_show_panel", "ui_seek", "ui_select", "ui_play", "ui_pause"] as const;
export const SUBTITLE_VERBS = ["subtitle_tidy", "subtitle_proofread"] as const;
export type SubtitleVerb = (typeof SUBTITLE_VERBS)[number];
export const DESKTOP_VERBS = [...UI_VERBS, ...SUBTITLE_VERBS] as const;
export type DesktopVerb = (typeof DESKTOP_VERBS)[number];
export type UiVerb = (typeof UI_VERBS)[number];
export const PANELS = ["ai", "media", "chapters", "subtitles", "voice"] as const;
export type Panel = (typeof PANELS)[number];
export interface UiState {
  subtitlePass?: import("./subtitle-pass.js").PassState | undefined;
  subtitle_pass?: import("./subtitle-pass.js").SubtitlePassState | null;
  subtitle_selection?: { cue_ids: string[]; editing: string | null } | null;
  project: string | null;
  panel: Panel;
  sub: string | null;
  playhead: { at: string } | { id: string };
  selected: string[];
  playing: boolean;
  range: { start: string; duration: string } | null;
  loop: boolean;
  history?: { open: boolean; revision: string | null; label: string | null } | undefined;
  export?: { open: boolean; sub: string | null; srt: boolean; wav: boolean; active: string | null } | undefined;
  subtitleBrowser?: { search: string; find: string; replace: string; matchCase: boolean } | undefined;
  chapters?: { levels: 1 | 2; timecodes: boolean } | undefined;
  mediaBrowser?: { scope: string; search: string; size: number } | undefined;
  preview?: "media" | "timeline" | undefined;
  media?: { id: string; at: string; in: string | null; out: string | null } | undefined;
}
export interface UiEnvelope {
  ok: boolean;
  status: "no_op" | "accepted" | "failed" | "rejected";
  verb: DesktopVerb;
  request_id: string;
  receipt: null;
  changes: [];
  verification: { level: "none"; passed: boolean; issues: [] };
  result: UiState | { pass_id: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
