// @vitest-environment jsdom

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import { App } from "../src/App.js";
import type { ProjectView } from "../src/connection.js";
import { connectHost } from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { tokenCss } from "../src/tokens.js";

describe("desktop shell", () => {
  it("renders six regions and switches the paired subtitle parameter panel", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => root.render(<App />));
      expect(container.querySelector('[id$="-tab-ai"]')?.textContent).toBe("AI");
      expect(container.querySelector('[role="tabpanel"] h2')?.textContent).toBe("AI");
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
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs';
    import {dispatch, parseProject, projectSubtitles, printRational} from './packages/core/src/index.ts';
    const path = './examples/interview.zcut.json';
    const parsed = parseProject(readFileSync(path, 'utf8'));
    const envelope = await dispatch('inspect', {project:path,view:'timeline'});
    const cues = projectSubtitles(parsed.project, parsed.project.timelines[0].id).cues.map(cue => ({...cue,start:printRational(cue.start,true),end:printRational(cue.end,true)}));
    console.log(JSON.stringify({timeline:envelope.result,cues}));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  const data = JSON.parse(run.stdout);
  const cues = data.cues;
  let scheduled: FrameRequestCallback | undefined;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      scheduled = callback;
      return 1;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn(() => {
      scheduled = undefined;
    }),
  );
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [0.1, 0.5] }));
  const fixture = JSON.parse(
    readFileSync(new NodeURL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
  );
  const writes: Record<string, unknown>[] = [];
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
                  : data.timeline,
            },
          }),
        );
      } else if (message.type === "preview_data") {
        queueMicrotask(() =>
          this.receive({
            id: message.id,
            envelope: { ok: true, result: { media: fixture.media, cues, styles: fixture.subtitle_styles } },
          }),
        );
      } else {
        writes.push(message);
        queueMicrotask(() => this.receive({ id: message.id, envelope: { ok: true, result: {} } }));
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
    expect([...container.querySelectorAll(".zc-track .zc-track-name")].map((node) => node.textContent)).toEqual(
      fixture.timelines[0].tracks.map((track: { name: string }) => track.name),
    );
    await act(async () => {
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
    expect(container.querySelectorAll(".zc-clip-video")).toHaveLength(
      fixture.timelines[0].tracks
        .filter((t: { kind: string }) => t.kind === "video")
        .reduce((n: number, t: { clips: unknown[] }) => n + t.clips.length, 0),
    );
    expect(container.querySelectorAll(".zc-clip-audio")).toHaveLength(
      fixture.timelines[0].tracks
        .filter((t: { kind: string }) => t.kind === "audio")
        .reduce((n: number, t: { clips: unknown[] }) => n + t.clips.length, 0),
    );
    expect(container.querySelectorAll(".zc-clip-subtitle")).toHaveLength(cues.length);
    expect(container.querySelector<HTMLElement>(".zc-caption")?.style.fontFamily).toContain(
      '"Hiragino Sans GB", "Heiti SC", "Heiti TC", "Songti SC", sans-serif',
    );
    expect(container.querySelector<HTMLElement>(".zc-caption")?.style.getPropertyValue("--cue-size")).toBe(
      String(fixture.subtitle_styles[0].font_size),
    );
    expect(container.querySelector('[aria-label="Final Cut Pro"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="切割 B"]')?.click();
    });
    expect(writes.at(-1)).toMatchObject({
      verb: "edit",
      request: {
        author: { kind: "human" },
        label: expect.any(String),
        ops: expect.arrayContaining([expect.objectContaining({ op: "split", at: "59059/30000s" })]),
      },
    });
    expect(replies.at(-1)).toMatchObject({
      id: "state",
      result: { project: "/interview.zcut.json", panel: "subtitles", sub: "style", playhead: { at: "2s" } },
    });
    for (const [label, verb, op] of [
      ["加标记 M", "edit", "add_marker"],
      ["撤销", "undo", null],
      ["重做", "redo", null],
    ] as const) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
      });
      expect(writes.at(-1)).toMatchObject({ verb, request: { label: expect.any(String), author: { kind: "human" } } });
      if (op) expect(writes.at(-1)).toMatchObject({ request: { ops: [expect.objectContaining({ op })] } });
    }
    await act(async () => {
      socket?.receive({
        type: "ui_request",
        id: "play",
        verb: "ui_play",
        request: { range: { start: "0s", duration: "1s" }, loop: true },
      });
    });
    expect(container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:00;00");
    await act(() => scheduled?.(400));
    expect(container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:00;11");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    await act(() => scheduled?.(1200));
    expect(container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:00;00");
    await act(async () => {
      socket?.receive({ type: "ui_request", id: "pause", verb: "ui_pause", request: {} });
    });
    expect(scheduled).toBeUndefined();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:00;01");
    const ruler = container.querySelector<HTMLElement>('[aria-label="时间标尺"]');
    if (!ruler) throw new Error("Missing ruler");
    await act(() => ruler.dispatchEvent(new MouseEvent("pointerdown", { clientX: 48, bubbles: true })));
    await act(async () => {
      socket?.receive({ type: "ui_request", id: "deferred", verb: "ui_seek", request: { at: "3s" } });
    });
    expect(replies.some((reply) => reply.id === "deferred")).toBe(false);
    await act(async () => {
      ruler.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(replies.at(-1)).toMatchObject({ id: "deferred", result: { playhead: { at: "3s" } } });
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("stacks overlapping cues in distinct rows with the earliest at the bottom", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const project: ProjectView = {
    id: "timeline",
    name: "测试",
    revision: { id: "r1", seq: 1 },
    edit_rate: "25",
    start_timecode: "00:00:00:00",
    drop_frame: false,
    duration: { t: "10s" },
    markers: [],
    media: [],
    styles: [],
    tracks: [{ id: "sub", name: "字幕", kind: "subtitle", enabled: true, clips: [] }],
    cues: [
      { cue_id: "later", track_id: "sub", start: "1s", end: "4s", text: "后来的一句", style_id: "s", piece: 0 },
      {
        cue_id: "first",
        track_id: "sub",
        start: "0s",
        end: "3s",
        text: "先出现的标题\n第二行",
        style_id: "s",
        piece: 0,
      },
    ],
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <TimelinePreview
          project={project}
          state={{ ...initialState(), playhead: { at: "2s" } }}
          update={() => {}}
          config={undefined}
          call={async () => ({})}
          error={null}
          dragging={{ current: false }}
        />,
      ),
    );
    const captions = [...container.querySelectorAll<HTMLElement>(".zc-caption")];
    expect(captions.map((caption) => caption.textContent)).toEqual(["先出现的标题\n第二行", "后来的一句"]);
    expect(captions.map((caption) => caption.style.gridRow)).toEqual(["2", "1"]);
    const css = readFileSync(new NodeURL("../src/timeline.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.zc-caption\s*\{[^}]*grid-column: 1/s);
    expect(css).toMatch(/\.zc-caption-stack\s*\{[^}]*display: grid/s);
    expect(css).toMatch(/\.zc-ruler-row\s*\{[^}]*position: sticky;[^}]*top: 0/s);
    const shell = readFileSync(new NodeURL("../src/shell.css", import.meta.url), "utf8");
    expect(shell).toMatch(/\.zc-timeline\s*\{[^}]*min-height: 0;[^}]*overflow: auto/s);
    expect(container.querySelector(".zc-track .zc-track-name")?.parentElement).toBe(
      container.querySelector(".zc-track-lane")?.parentElement,
    );
  } finally {
    await act(() => root.unmount());
  }
});

it("shows Chinese open errors and preserves the kernel code in the tooltip", async () => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose = null;
    constructor() {
      socket = this;
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: request.id,
              envelope: { ok: false, error: { code: "E_VALIDATION", message: "Project file is invalid" } },
            }),
          }),
        ),
      );
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const error = vi.fn();
  const disconnect = connectHost(
    { port: 1, token: "test" },
    {
      ui: () => initialState(),
      project: vi.fn(),
      icon: vi.fn(),
      error,
    },
  );
  try {
    socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "bootstrap", project: "bad" }) }));
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("工程文件打不开：工程文件无效", "E_VALIDATION Project file is invalid"),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <TimelinePreview
            project={null}
            state={initialState()}
            update={() => {}}
            config={undefined}
            call={async () => ({})}
            error={error.mock.calls[0]?.[0]}
            errorDetail={error.mock.calls[0]?.[1]}
            dragging={{ current: false }}
          />,
        ),
      );
      expect(container.querySelector('[role="alert"]')?.getAttribute("title")).toContain("E_VALIDATION");
      expect(container.querySelector('[role="alert"]')?.textContent).not.toContain("Project file is invalid");
    } finally {
      await act(() => root.unmount());
    }
  } finally {
    disconnect();
    vi.unstubAllGlobals();
  }
});
