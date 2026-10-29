import type { UiState, UiVerb } from "../../app-host/src/ui.js";

export function initialState(): UiState {
  return {
    project: null,
    panel: "ai",
    sub: null,
    playhead: { at: "0s" },
    selected: [],
    playing: false,
    range: null,
    loop: false,
  };
}

export function applyUi(state: UiState, verb: UiVerb, request: Record<string, unknown>): UiState {
  switch (verb) {
    case "ui_show_panel":
      return { ...state, panel: request.panel as UiState["panel"], sub: (request.sub as string | undefined) ?? null };
    case "ui_seek":
      return { ...state, playhead: typeof request.at === "string" ? { at: request.at } : { id: request.id as string } };
    case "ui_select":
      return { ...state, selected: request.ids as string[] };
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
