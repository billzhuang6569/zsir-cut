// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import { App } from "../src/App.js";
import { applyUi, initialState } from "../src/state.js";
import { tokenCss } from "../src/tokens.js";

describe("desktop shell", () => {
  it("renders six regions and switches the paired subtitle parameter panel", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => root.render(<App />));
      for (const name of ["菜单栏", "功能区", "预览", "参数区", "工具栏", "时间线"]) {
        expect(container.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
      }
      const subtitles = container.querySelector<HTMLButtonElement>('[id$="-tab-subtitles"]');
      if (!subtitles) throw new Error("Missing subtitle tab");
      await act(() => subtitles.click());
      expect(container.querySelector('[aria-label="参数区"]')?.getAttribute("data-panel")).toBe("subtitles");
      expect(container.querySelector('[aria-label="参数区"] h2')?.textContent).toBe("字幕");
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });

  it("generates every design color and size without renaming", () => {
    const tokens = JSON.parse(readFileSync(new NodeURL("../../../design/tokens.json", import.meta.url), "utf8"));
    const css = tokenCss();
    for (const token of tokens.color.tokens) expect(css).toContain(`--${token.name}: ${token.value.dark};`);
    for (const token of tokens.size.tokens) expect(css).toContain(`--${token.name}: ${token.value};`);
  });

  it("records all six UI verbs without changing the project", () => {
    let state: UiState = { ...initialState(), project: "/example.zcut.json" };
    state = applyUi(state, "ui_show_panel", { panel: "subtitles", sub: "style" });
    state = applyUi(state, "ui_seek", { at: "1001/100s" });
    state = applyUi(state, "ui_select", { ids: ["clp_1"] });
    state = applyUi(state, "ui_play", { range: { start: "0s", duration: "2s" }, loop: true });
    expect(applyUi(state, "ui_state", {})).toMatchObject({
      project: "/example.zcut.json",
      panel: "subtitles",
      sub: "style",
      playhead: { at: "1001/100s" },
      selected: ["clp_1"],
      playing: true,
      loop: true,
    });
    state = applyUi(state, "ui_pause", {});
    state = applyUi(state, "ui_select", { ids: [] });
    state = applyUi(state, "ui_seek", { id: "cue_1" });
    state = applyUi(state, "ui_show_panel", { panel: "media" });
    expect(state).toMatchObject({ playing: false, selected: [], playhead: { id: "cue_1" }, panel: "media", sub: null });
  });
});

it("opens the project through inspect and receives UI commands", async () => {
  const { vi } = await import("vitest");
  const fixture = JSON.parse(
    readFileSync(new NodeURL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
  );
  const replies: { id: string; result: unknown }[] = [];
  let socket: FakeSocket | undefined;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    receive(message: unknown) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.type === "ui_ready") {
        this.receive({ type: "bootstrap", project: "/interview.zcut.json", fcpIcon: null });
      } else if (message.type === "ui_result") replies.push(message);
      else if (message.verb === "inspect") {
        expect(message.request.project).toBe("/interview.zcut.json");
        queueMicrotask(() =>
          this.receive({
            id: message.id,
            envelope: {
              ok: true,
              error: null,
              result:
                message.request.view === "brief"
                  ? { project: { name: fixture.name, revision: fixture.revision } }
                  : { tracks: fixture.timelines[0].tracks },
            },
          }),
        );
      }
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App config={{ port: 1234, token: "test token" }} />));
    expect(socket?.url).toBe("ws://127.0.0.1:1234/?token=test%20token");
    expect(container.querySelector('[aria-label="菜单栏"]')?.textContent).toContain(fixture.name);
    expect(container.querySelector('[aria-label="菜单栏"]')?.textContent).toContain(`r${fixture.revision.seq}`);
    expect([...container.querySelectorAll(".zc-track-name")].map((node) => node.textContent)).toEqual(
      fixture.timelines[0].tracks.map((track: { name: string }) => track.name),
    );
    await act(() => {
      socket?.receive({
        type: "ui_request",
        id: "panel",
        verb: "ui_show_panel",
        request: { panel: "subtitles", sub: "style" },
      });
      socket?.receive({ type: "ui_request", id: "seek", verb: "ui_seek", request: { at: "2s" } });
      socket?.receive({ type: "ui_request", id: "state", verb: "ui_state", request: {} });
    });
    expect(container.querySelector('[aria-label="参数区"] h3')?.textContent).toBe("样式");
    expect(replies.at(-1)).toMatchObject({
      id: "state",
      result: { project: "/interview.zcut.json", panel: "subtitles", sub: "style", playhead: { at: "2s" } },
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
