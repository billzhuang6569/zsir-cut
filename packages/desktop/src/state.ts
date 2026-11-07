import type { UiState as HostUiState, UiVerb } from "../../app-host/src/ui.js";

export type UiState = HostUiState;

export function initialState(): UiState {
  return {
    project: null,
    panel: "ai",
    sub: null,
    playhead: { at: "0s" },
    selected: [],
    edit_point: null,
    playing: false,
    range: null,
    loop: false,
    history: { open: false, revision: null, viewing: null, label: null },
    chapters: { levels: 2, timecodes: true, view: "outline", zoom: 1, folded: [] },
  };
}

export function applyUi(state: UiState, verb: UiVerb, request: Record<string, unknown>): UiState {
  switch (verb) {
    case "ui_show_panel":
      if (request.panel === "history")
        return {
          ...state,
          history: {
            revision: null,
            label: null,
            ...state.history,
            open: !state.history?.open,
            viewing: state.history?.revision ?? null,
          },
        };
      if (request.panel === "export")
        return {
          ...state,
          playing: false,
          export: {
            srt: true,
            wav: false,
            active: null,
            ...state.export,
            open: true,
            sub: (request.sub as string | undefined) ?? null,
          },
        };
      return {
        ...state,
        panel: request.panel as UiState["panel"],
        ...(request.panel === "chapters"
          ? {
              chapters: {
                levels: 2 as const,
                timecodes: true,
                ...state.chapters,
                view:
                  request.sub === undefined
                    ? (state.chapters?.view ?? "outline")
                    : request.sub === "timeline"
                      ? "timeline"
                      : "outline",
              },
            }
          : {}),
        sub:
          (request.sub as string | undefined) ??
          (request.panel === "chapters" ? (state.chapters?.view ?? "outline") : null),
      };
    case "ui_seek":
      return { ...state, playhead: typeof request.at === "string" ? { at: request.at } : { id: request.id as string } };
    case "ui_select":
      return { ...state, selected: request.ids as string[], edit_point: null };
    case "ui_play":
      return {
        ...state,
        playing: true,
        range: (request.range as UiState["range"] | undefined) ?? null,
        loop: request.loop === true,
      };
    case "ui_pause":
      return { ...state, playing: false };
    case "ui_state":
      return state;
  }
}
