// @vitest-environment jsdom

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mergeKeymap } from "../../app-host/src/keymap.js";
import type { UiState } from "../../app-host/src/ui.js";
import { transcriptIds } from "../../core/src/project/id.ts";
import { renderSubtitle as exportRenderer } from "../../exporters/src/subtitle-render.ts";
import { useAiPanel } from "../src/AiPanel.js";
import type { ProjectView } from "../src/connection.js";
import { renderSubtitle, SubtitleCanvas } from "../src/SubtitleCanvas.js";
import { useSubtitlePanel } from "../src/SubtitlePanel.js";
import { applyUi, initialState } from "../src/state.js";
import { renderPreset, subtitlePresets } from "../src/subtitle-presets.js";
import {
  alignment,
  caretOffset,
  cueEdit,
  defaultStyle,
  formatSubtitleTime,
  placeCaret,
  subtitleStyleOps,
  textEdit,
  textEdits,
} from "../src/subtitles.js";
import type { TranscriptView } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";
import { TimelinePreview } from "./timeline-preview.js";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));

const cue = {
  cue_id: "cue_1",
  track_id: "trk_s",
  transcript_id: "tra_1",
  start: "1001/1000s",
  end: "3s",
  text: "你好世界",
  style_id: "sty_1",
  piece: 0,
  tokens: [
    { id: "tok_1", text: "你好" },
    { id: "tok_2", text: "世界" },
  ],
};
const project: ProjectView = {
  id: "tl_main",
  name: "示例工程",
  revision: { id: "rev_1", seq: 7 },
  edit_rate: "25",
  drop_frame: false,
  start_timecode: "01:00:00:00",
  duration: { t: "10s" },
  tracks: [{ id: "trk_s", name: "字幕 A", kind: "subtitle", enabled: true, clips: [] }],
  markers: [],
  media: [{ id: "med_1", name: "素材一", kind: "audio", audio: { channels: 1, sample_rate: "48000" } }],
  cues: [
    cue,
    { cue_id: "cue_free", track_id: "trk_s", start: "3s", end: "5s", text: "自由字幕", piece: 0, style_id: "sty_1" },
  ],
  transcripts: [
    {
      id: cue.transcript_id,
      media_id: "med_1",
      ext: { zsir: { id_tag: "stored" } },
      tokens: cue.tokens.map((token) => ({ ...token, align: { start: "0s", end: "3s" } })),
      cues: [{ id: cue.cue_id, first_token: "tok_1", last_token: "tok_2" }],
    },
  ],
  styles: [{ ...defaultStyle, id: "sty_1", name: "正文", version: 3 }],
  subtitleTracks: [{ id: "trk_s", name: "字幕 A", default_style_id: "sty_1" }],
  recognition: { language: "zh", terms: ["专有名词"] },
  recognized: true,
  recognitionRevision: 4,
  format: { width: 320, height: 180 },
  subtitleWarnings: [{ code: "W_SUB_SHORT", ids: ["cue_1"] }],
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas().context);
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(
  view = project,
  sub = "subtitles",
  responder: (verb: string, request: Record<string, unknown>) => unknown = () => ({}),
  withPreview = false,
  withAi = false,
) {
  let state: UiState = { ...initialState(), project: "/示例.zcut.json", panel: "subtitles", sub };
  let setView: (view: ProjectView) => void = () => {};
  let setUi: (state: UiState) => void = () => {};
  const call = vi.fn(async (verb: string, request: Record<string, unknown>) => responder(verb, request));
  const aiCall = vi.fn(async (verb: string) => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true, version: "1" }];
    if (verb === "chat_list") return [];
    return { sessions: [], batches: [] };
  });
  const panelCall = (verb: string, request: Record<string, unknown>) =>
    verb === "asr_status" ? Promise.resolve({ supported: true }) : call(verb, request);
  const promptAi = vi.fn();
  const editCue = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const timelineCall = (verb: string, request: Record<string, unknown>) =>
    verb === "prefs_get"
      ? Promise.resolve({ prefs: { ui: { snap: true, magnetic: true, track_height: "m" } }, ...mergeKeymap("fcp", {}) })
      : call(verb, request);
  function Harness() {
    const [ui, update] = useState(state);
    const [current, updateView] = useState(view);
    setView = updateView;
    setUi = update;
    state = ui;
    const ai = useAiPanel({
      call: aiCall,
      path: withAi ? ui.project : null,
      project: current,
      notices: [],
      revision: 0,
    });
    const panel = useSubtitlePanel({
      project: current,
      state: ui,
      update,
      call: panelCall,
      promptAi: (text) => {
        promptAi(text);
        update((previous) => applyUi(previous, "ui_show_panel", { panel: "ai" }));
        ai.appendInput(text);
      },
    });
    return (
      <>
        {panel.controls}
        {panel.parameters}
        {withAi && <div hidden={ui.panel !== "ai"}>{ai.chat}</div>}
        {withPreview && (
          <TimelinePreview
            project={view}
            state={ui}
            update={update}
            call={timelineCall}
            config={undefined}
            error={null}
            dragging={{ current: false }}
            subtitlePreview={panel.stylePreview}
            onSubtitleStyle={panel.previewStyle}
            onEditSubtitle={(cue) => {
              editCue(cue);
              panel.editCue(cue);
            }}
          />
        )}
      </>
    );
  }
  await act(async () => root.render(<Harness />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const find = <T extends HTMLElement>(label: string) => {
    const element = container.querySelector<T>(`[aria-label="${label}"]`);
    if (!element) throw new Error(label);
    return element;
  };
  const click = async (label: string) => {
    const elements = [...container.querySelectorAll<HTMLElement>("button, [role=textbox]")];
    const button =
      elements.find((element) => element.getAttribute("aria-label") === label) ??
      elements.find((element) => element.textContent === label);
    if (!button) throw new Error(label);
    await act(async () => {
      button.focus();
      button.click();
    });
  };
  const input = async (label: string, value: string) => {
    const element = find<HTMLInputElement | HTMLTextAreaElement>(label);
    await act(async () => {
      if (element.getAttribute("contenteditable") === "true") {
        element.textContent = value;
        placeCaret(element, value.length);
      } else {
        const prototype =
          element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return element;
  };
  const blur = async (label: string) => {
    await act(async () => {
      const element = find(label);
      element.focus();
      element.blur();
    });
  };
  const key = async (element: HTMLElement, key: string, extra = {}) =>
    act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
    });
  const settle = async () => {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1000);
      else await new Promise((resolve) => setTimeout(resolve, 1010));
    });
  };
  const focus = async (label: string, offset: number) => act(async () => placeCaret(find(label), offset));
  return {
    container,
    call,
    editCue,
    promptAi,
    aiCall,
    settle,
    find,
    click,
    input,
    blur,
    key,
    focus,
    state: () => state,
    view: async (next: ProjectView) => act(async () => setView(next)),
    update: async (patch: Partial<UiState>) => act(async () => setUi({ ...state, ...patch })),
  };
}
it.each([
  ["41s", "00:41"],
  ["3725s", "1:02:05"],
  ["599/10s", "00:59"],
  ["3600s", "1:00:00"],
  ["35999/10s", "59:59"],
  ["0s", "00:00"],
])("formats subtitle start %s as %s", (start, expected) => {
  expect(formatSubtitleTime(start)).toBe(expected);
});

it("keeps long subtitle text in flow beside seconds-only time and overlays actions on hover, selection or editing", async () => {
  const style = document.createElement("style");
  style.textContent =
    readFileSync("packages/desktop/src/shell.css", "utf8") + readFileSync("packages/desktop/src/subtitles.css", "utf8");
  document.head.append(style);
  cleanups.push(async () => style.remove());
  const text = `${"这是一条会自动换行的长字幕".repeat(10)}\n${"LongUnbrokenText".repeat(20)}`;
  const h = await mount({
    ...project,
    cues: [
      { ...cue, start: "599/10s", end: "61s", text, tokens: [{ id: "tok_1", text }] },
      { ...cue, cue_id: "cue_next", start: "61s", end: "63s", text: "自由字幕" },
    ],
  });
  const row = h.container.querySelector<HTMLElement>(".zc-sub-row") as HTMLElement;
  const editor = row.querySelector<HTMLElement>(".zc-sub-text") as HTMLElement;
  const actions = row.querySelector<HTMLElement>(".zc-sub-actions") as HTMLElement;
  expect([...row.children].map((child) => child.className)).toEqual([
    "time zc-sub-time",
    "zc-sub-text",
    "actions zc-sub-actions",
  ]);
  expect(row.querySelector("time")?.textContent).toBe("00:59");
  expect(editor.textContent).toBe(text);
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(editor.getAttribute("aria-multiline")).toBe("true");
  expect(row.parentElement?.className).toBe("zc-list zc-sub-list");
  expect(getComputedStyle(row.parentElement as HTMLElement).flexDirection).toBe("column");
  // jsdom has no layout engine: assert the sizing rules that prevent flex rows from shrinking below their text.
  expect(getComputedStyle(row).flexShrink).toBe("0");
  expect(getComputedStyle(row).height).toBe("auto");
  expect(getComputedStyle(row).gridTemplateColumns).toBe("40px minmax(0, 1fr)");
  expect(getComputedStyle(row).position).toBe("relative");
  expect(getComputedStyle(editor).whiteSpace).toBe("pre-wrap");
  expect(getComputedStyle(editor).overflowWrap).toBe("anywhere");
  expect(getComputedStyle(editor).minWidth).toBe("0");
  expect(getComputedStyle(actions).position).toBe("absolute");
  expect(getComputedStyle(actions).right).toBe("6px");
  expect(getComputedStyle(editor).fontWeight).toBe("400");
  expect(getComputedStyle(row).alignItems).toBe("baseline");
  expect(getComputedStyle(h.find("选择字幕 1")).padding).toBe("0px");
  expect(getComputedStyle(actions).visibility).toBe("hidden");
  expect(actions.querySelectorAll("button")).toHaveLength(2);
  expect(getComputedStyle(h.find("选择字幕 1")).fontWeight).toBe("400");
  const hover = [...(style.sheet?.cssRules ?? [])].find(
    (rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".zc-sub-row:hover .zc-sub-actions"),
  ) as CSSStyleRule;
  expect(hover.style.visibility).toBe("visible");
  await h.click("选择字幕 1");
  expect(row.classList.contains("is-selected")).toBe(true);
  expect(getComputedStyle(actions).visibility).toBe("visible");
  await act(async () => placeCaret(editor, 0));
  expect(row.classList.contains("is-editing")).toBe(true);
  expect(getComputedStyle(actions).visibility).toBe("visible");
  await h.input("编辑字幕", `${text}\n编辑时新增的一行`);
  expect(editor.textContent).toBe(`${text}\n编辑时新增的一行`);
  expect(editor.parentElement).toBe(row);
  expect(getComputedStyle(row).flexShrink).toBe("0");
  expect(row.nextElementSibling?.querySelector(".zc-sub-text")?.textContent).toBe("自由字幕");
  await h.key(editor, "Escape");
  expect(row.classList.contains("is-editing")).toBe(false);
  expect(h.call).not.toHaveBeenCalled();
});

it("submits only changed recognition fields on blur and preserves terms", async () => {
  const h = await mount();
  expect(h.container.textContent).toContain("已识别 · 第 4 版 · 2 条字幕");
  await h.input("参考文本", "参考稿");
  expect(h.call).not.toHaveBeenCalled();
  await h.blur("参考文本");
  expect(h.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      label: "修改字幕识别设置",
      author: { kind: "human", name: "桌面用户" },
      base_revision: "rev_1",
      ops: [{ op: "set_recognition", reference_text: "参考稿" }],
    }),
  );
  expect(h.container.querySelector('input[aria-label="添加专有名词"]')).toBeNull();
  await h.click("添加专有名词");
  await h.input("添加专有名词", "新词");
  await h.key(h.find("添加专有名词"), "Enter");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "set_recognition", terms: ["专有名词", "新词"] }]);
  await h.click("删除专有名词「专有名词」");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "set_recognition", terms: [] }]);
  await h.blur("语言");
  expect(h.call).toHaveBeenCalledTimes(3);
});
it("filters without writing and exposes search through ui_state", async () => {
  const h = await mount();
  await h.input("搜索字幕", "自由");
  expect(h.container.querySelectorAll(".zc-sub-row")).toHaveLength(1);
  expect(h.state().subtitleBrowser?.search).toBe("自由");
  expect(h.call).not.toHaveBeenCalled();
});
it("replaces text, reports locked skips and highlights affected rows", async () => {
  const h = await mount(project, "subtitles", () => ({
    warnings: [{ code: "W_REPLACE_SKIPPED_LOCKED", cue_ids: ["cue_1"] }],
  }));
  await h.click("查找替换");
  await h.input("查找", "你好");
  await h.input("替换为", "您好");
  await h.click("全部替换");
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "全部替换字幕文字",
    ops: [{ op: "replace_text", find: "你好", replace: "您好", match_case: false }],
  });
  expect(h.container.textContent).toContain("跳过 1 条锁定字幕");
  expect(h.container.querySelectorAll(".is-skipped")).toHaveLength(1);
});
it("seeks on a single click, edits in place on blur, and Esc discards", async () => {
  const h = await mount();
  await h.click("你好世界");
  expect(h.state()).toMatchObject({
    selected: ["cue_1"],
    playhead: { at: "1001/1000s" },
    preview: "timeline",
    playing: false,
    subtitle_selection: { cue_ids: ["cue_1"], editing: "cue_1" },
  });
  expect(h.container.querySelector(".zc-sub-row textarea")).toBeNull();
  await h.input("编辑字幕", "你好朋友");
  expect(h.call).not.toHaveBeenCalled();
  await h.blur("编辑字幕");
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "修改字幕",
    ops: [
      {
        op: "edit_text",
        transcript_id: "tra_1",
        from_token: "tok_2",
        to_token: "tok_2",
        text: "朋友",
      },
    ],
  });
  await h.click("你好世界");
  await h.input("编辑字幕", "放弃");
  await h.key(h.find("编辑字幕"), "Escape");
  expect(h.container.querySelector('[aria-label="编辑字幕"]')).toBeNull();
  expect(h.container.querySelector(".zc-sub-text")?.textContent).toBe("你好世界");
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.container.querySelector(".zc-sub-time")?.getAttribute("title")).toBe("字幕显示时间过短");
  expect(h.container.querySelectorAll("time")).toHaveLength(2);
});
it("adds a frame-aligned free cue and deletes source and free cues through their own operations", async () => {
  const h = await mount();
  await h.click("在后面加一条");
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "在字幕后加一条",
    ops: [
      {
        op: "add_free_cue",
        track_id: "trk_s",
        timeline_start: "3s",
        duration: "2s",
        text: "新字幕",
        style_id: "sty_1",
      },
    ],
  });
  await h.click("删除字幕");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "hide_tokens", transcript_id: "tra_1", tokens: ["tok_1", "tok_2"] },
  ]);
  const buttons = h.container.querySelectorAll<HTMLButtonElement>('[aria-label="删除字幕"]');
  await act(async () => buttons[1]?.click());
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "remove_free_cue", track_id: "trk_s", id: "cue_free" }]);
});
it("preserves free cue identity, exact timing and style when editing", async () => {
  const h = await mount();
  const row = h.container.querySelectorAll<HTMLButtonElement>(".zc-sub-text")[1];
  if (!row) throw new Error();
  await act(async () => row.focus());
  await h.input("编辑字幕", "新文字");
  await h.blur("编辑字幕");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "remove_free_cue", track_id: "trk_s", id: "cue_free" },
    {
      op: "add_free_cue",
      track_id: "trk_s",
      id: "cue_free",
      timeline_start: "3s",
      duration: "2s",
      text: "新文字",
      style_id: "sty_1",
    },
  ]);
});
it.each([0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => [row, column])))(
  "maps alignment %i,%i to existing fields",
  async (row, column) => {
    const h = await mount(project, "style");
    const label = `${["上", "中", "下"][row]}${["左", "中", "右"][column]}`;
    await h.click(label);
    await h.settle();
    const mapped = alignment(row, column, 0.8);
    expect(mapped).toEqual({ anchor: ["top", "middle", "bottom"][row], offset_x: ((column - 1) * (1 - 0.8)) / 2 });
    expect(h.find<HTMLButtonElement>(label).disabled).toBe(column !== 1);
    if (column !== 1 || (row === 2 && column === 1)) expect(h.call).not.toHaveBeenCalled();
    else
      expect(h.call.mock.lastCall?.[1]).toMatchObject({
        label: "修改字幕样式",
        ops: [{ op: "update_style", style_id: "sty_1", position: { margin_v: 0.08, max_width: 0.8, ...mapped } }],
      });
  },
);
it("previews slider movement, writes once after the release merge window, and keeps metadata out of the update", async () => {
  const h = await mount(project, "style");
  const slider = await h.input("字号", "12");
  expect(h.call).not.toHaveBeenCalled();
  await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await h.blur("字号");
  await h.settle();
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", font_size: 12 / 180 }]);
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops[0]).not.toHaveProperty("version");
  expect(ops[0]).not.toHaveProperty("id");
});
it("recognizes multiple media sequentially using each committed revision", async () => {
  const view = {
    ...project,
    media: [...project.media, { ...project.media[0], id: "med_2", kind: "audio" }],
  } as ProjectView;
  const h = await mount(view, "subtitles", (verb) =>
    verb === "transcribe"
      ? { job_id: "job_1" }
      : verb === "job_status"
        ? { state: "succeeded", progress: 1 }
        : { project: { revision: { id: "rev_2" } } },
  );
  await h.click("重新识别");
  const calls = h.call.mock.calls.filter(([verb]) => verb === "transcribe");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toMatchObject({
    media_id: "med_1",
    base_revision: "rev_1",
    label: "识别「素材一」的字幕",
    author: { kind: "human", name: "桌面用户" },
  });
  expect(calls[1]?.[1].base_revision).toBe("rev_2");
});
it("keeps write errors visible and permits retry", async () => {
  const h = await mount(project, "subtitles", () => {
    throw new Error("failed");
  });
  await h.click("删除字幕");
  expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("字幕修改失败");
  await h.click("删除字幕");
  expect(h.call).toHaveBeenCalledTimes(2);
});
it("keeps edits at insertion boundaries ordered and preserves unchanged token fragments", () => {
  expect(textEdit(cue, "你好新世界")).toMatchObject({ from_token: "tok_2", to_token: "tok_2", text: "新世界" });
  expect(textEdit(cue, "你好世人")).toMatchObject({ from_token: "tok_2", to_token: "tok_2", text: "世人" });
  expect(textEdit(cue, "你好世界！")).toMatchObject({ from_token: "tok_2", to_token: "tok_2", text: "世界！" });
  expect(textEdit(cue, "")).toMatchObject({ from_token: "tok_1", to_token: "tok_2", text: "" });
  expect(textEdit(cue, cue.text)).toBeNull();
});
it("uses exactly the export renderer and identical drawing calls for style and timeline previews", async () => {
  expect(renderSubtitle).toBe(exportRenderer);
  const expected = recordingCanvas();
  exportRenderer(expected.context, cue.text, project.styles[0] ?? defaultStyle, 320, 180);
  const actual = recordingCanvas();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(actual.context);
  const container = document.createElement("div"),
    root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<SubtitleCanvas cues={[cue]} styles={project.styles} format={project.format} />));
  expect(actual.calls.filter(([name]) => name !== "clearRect")).toEqual(expected.calls);
  actual.calls.length = 0;
  await act(async () =>
    root.render(
      <TimelinePreview
        project={project}
        state={{ ...initialState(), playhead: { at: cue.start } }}
        update={() => {}}
        call={async () => ({})}
        config={undefined}
        error={null}
        dragging={{ current: false }}
      />,
    ),
  );
  expect(actual.calls.filter(([name]) => name !== "clearRect")).toEqual(expected.calls);
});

it("commits the filler switch only on blur", async () => {
  const h = await mount();
  expect(h.find<HTMLInputElement>("去除水词").checked).toBe(true);
  await act(async () => h.find<HTMLInputElement>("去除水词").click());
  expect(h.call).not.toHaveBeenCalled();
  await h.blur("去除水词");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "set_recognition", remove_fillers: false }]);
});
it("edits an existing occurrence override without changing the source transcript", async () => {
  const h = await mount({ ...project, cues: [{ ...cue, text_override: true, occurrence_id: "occ_1" }] });
  const row = h.container.querySelector<HTMLButtonElement>(".zc-sub-text");
  if (!row) throw new Error();
  await act(async () => row.focus());
  await h.input("编辑字幕", "覆盖文字");
  await h.blur("编辑字幕");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "set_override", track_id: "trk_s", occurrence_id: "occ_1", cue_id: "cue_1", text: "覆盖文字" },
  ]);
});
it("disables repeated recognition while polling progress, then recovers after completion", async () => {
  vi.useFakeTimers();
  try {
    let polls = 0;
    const h = await mount(project, "subtitles", (verb) =>
      verb === "transcribe"
        ? { job_id: "job_1" }
        : { state: ++polls === 1 ? "running" : "succeeded", progress: polls === 1 ? 0.5 : 1 },
    );
    const button = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "重新识别",
    );
    if (!button) throw new Error();
    await act(async () => {
      button.focus();
      button.click();
    });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("50%");
    await act(async () => {
      button.focus();
      button.click();
    });
    expect(h.call.mock.calls.filter(([verb]) => verb === "transcribe")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("重新识别");
  } finally {
    vi.useRealTimers();
  }
});

it("preserves stripped punctuation and edits the correct repeated token on each line", () => {
  const source = {
    ...cue,
    text: "hello world",
    tokens: [
      { id: "a", text: "hello" },
      { id: "b", text: "world." },
    ],
  };
  expect(textEdit(source, "hello worm")).toMatchObject({ from_token: "b", to_token: "b", text: "worm." });
  const repeated = {
    ...cue,
    text: "你好\n你好。",
    tokens: [
      { id: "a", text: "你好。" },
      { id: "b", text: "你好。" },
    ],
  };
  expect(textEdit(repeated, "您好\n你好。")).toMatchObject({ from_token: "a", to_token: "a", text: "您好。" });
  expect(textEdit({ ...cue, text: "不匹配的覆盖稿" }, "新文字")).toBeNull();
});

it("shows the success strip without an unknown revision and saves readable language choices as codes", async () => {
  const { recognitionRevision: _revision, ...view } = project;
  const h = await mount(view);
  const status = h.container.querySelector(".zc-sub-status");
  expect(status?.textContent).toBe("已识别 · 2 条字幕");
  expect(status?.classList.contains("is-recognized")).toBe(true);
  expect(status?.querySelector(".zc-dot")).not.toBeNull();
  const language = h.find<HTMLSelectElement>("语言");
  expect(language.selectedOptions[0]?.textContent).toBe("中文（普通话）");
  await act(async () => {
    language.value = "en";
    language.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "set_recognition", language: "en" }]);
  expect(h.find<HTMLTextAreaElement>("参考文本").placeholder).toBe("粘贴采访提纲、文稿或人名表，AI 会从里面找专有名词");
});
it("opens filler chips separately from the switch and supports adding and removing words", async () => {
  const h = await mount();
  expect(h.find("去除水词").getAttribute("role")).toBe("switch");
  expect(h.find("去除水词").closest("label")?.title).toContain("时间不动");
  expect(h.container.querySelector('[aria-label="水词"]')).toBeNull();
  await h.click("编辑水词表");
  expect(h.container.querySelectorAll('[aria-label="水词"] .zc-chip')).toHaveLength(8);
  await h.click("添加水词");
  await h.input("添加水词", "那个");
  await h.key(h.find("添加水词"), "Enter");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "set_recognition", filler_words: ["嗯", "啊", "呃", "额", "哦", "唉", "哎", "诶", "那个"] },
  ]);
  await h.click("删除水词「嗯」");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "set_recognition", filler_words: ["啊", "呃", "额", "哦", "唉", "哎", "诶"] },
  ]);
  expect(h.container.querySelector("details")).toBeNull();
});
it("shows the selected track style and applies edits to every style when scope is all", async () => {
  const h = await mount(
    {
      ...project,
      subtitleTracks: [
        ...(project.subtitleTracks ?? []),
        { id: "trk_en", name: "English", default_style_id: "sty_en" },
      ],
      styles: [...project.styles, { ...defaultStyle, id: "sty_en", font_size: 0.07 }],
      cues: [
        { ...cue, style_id: "sty_en" },
        { ...cue, cue_id: "en", track_id: "trk_en", text: "English sample", start: "6s", end: "8s", style_id: "sty_1" },
      ],
    },
    "style",
  );
  expect(h.find<HTMLInputElement>("字号").value).toBe("8");
  expect(h.container.querySelector(".zc-sub-sample")).toBeNull();
  await h.click("English");
  expect(h.find<HTMLInputElement>("字号").value).toBe("13");
  expect(h.find<HTMLButtonElement>("字幕样式轨道").textContent).toContain("English");
  expect(h.call).not.toHaveBeenCalled();
  await h.input("文字颜色", "#FFD84A");
  await h.blur("文字颜色");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    expect.objectContaining({ op: "update_style", style_id: "sty_1", color: "#FFD84A" }),
    expect.objectContaining({ op: "update_style", style_id: "sty_en", color: "#FFD84A" }),
  ]);
});
it("shows presets and displays the animation groups with shared renderer thumbnails", async () => {
  const h = await mount(project, "style");
  expect(h.container.querySelector('.zc-sub-controls [aria-label="字幕样式轨道"]')).not.toBeNull();
  expect(h.container.querySelectorAll(".zc-sub-preset-cell")).toHaveLength(subtitlePresets.length);
  expect(
    [...h.container.querySelectorAll(".zc-sub-style > details > summary")].map((item) => item.textContent?.trim()),
  ).toEqual(["文字", "描边", "阴影", "发光", "底板", "位置"]);
  expect(h.container.querySelector<HTMLDetailsElement>(".zc-sub-style > details")?.open).toBe(true);
  await h.click("动画");
  expect([...h.container.querySelectorAll(".zc-sub-animation h4")].map((item) => item.textContent)).toEqual([
    "入场",
    "出场",
    "逐字",
  ]);
  expect(h.container.querySelectorAll(".zc-sub-animation-cell canvas")).toHaveLength(13);
  expect(h.call).not.toHaveBeenCalled();
});

it("shows the selected cue at the playhead in the central preview", async () => {
  const h = await mount(
    {
      ...project,
      cues: [cue, { ...cue, cue_id: "later", text: "当前字幕", start: "5s", end: "7s" }],
    },
    "subtitles",
    () => ({}),
    true,
  );
  await h.click("当前字幕");
  await h.click("样式");
  expect(h.container.querySelector(".zc-sub-sample")).toBeNull();
  expect(h.container.querySelector(".zc-subtitle-canvas")?.getAttribute("aria-label")).toBe("当前字幕");
  expect(h.call).not.toHaveBeenCalled();
});
it("supports common fonts, custom fonts and font weight through the existing style operation", async () => {
  const h = await mount(project, "style");
  const select = async (label: string, value: string) =>
    act(async () => {
      const element = h.find<HTMLSelectElement>(label);
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  expect(h.find<HTMLSelectElement>("字体族").textContent).toContain("思源黑体");
  await select("字体族", "Source Han Sans SC");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "update_style", style_id: "sty_1", font_family: "Source Han Sans SC" },
  ]);
  await select("字体族", "other");
  expect(h.call).toHaveBeenCalledTimes(1);
  await h.input("其他字体", "Custom Font");
  await h.blur("其他字体");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "update_style", style_id: "sty_1", font_family: "Custom Font" },
  ]);
  await select("字重", "700");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", font_weight: 700 }]);
});

it("uses compact token-based style groups with accessible icon controls", async () => {
  const css = readFileSync("packages/desktop/src/subtitles.css", "utf8");
  expect(css).toContain(".zc-sub-style details");
  const h = await mount(project, "style");
  for (const label of ["斜体", "下划线", "添加描边"]) expect(h.find(label).title).toBe(label);
  expect(h.find<HTMLInputElement>("启用阴影").getAttribute("aria-checked")).toBe("false");
});

it("shows subtitle pass progress, failure reason, and retry", async () => {
  const running = await mount({
    ...project,
    subtitlePass: { running: true, warnings: [], progress: [{ transcript_id: "tra_1", done: 1, total: 8 }] },
  });
  expect(running.container.textContent).toContain("AI 整理字幕 · 分行 1/8");
  expect(running.container.textContent).toContain("大约还要 2 分钟");
  expect(running.container.querySelectorAll(".zc-sub-row")).toHaveLength(0);
  expect(running.container.textContent).not.toContain("已识别 · 第 4 版");
  const done = await mount({
    ...project,
    subtitlePass: {
      running: false,
      warnings: [{ code: "W_SUB_PASS_FALLBACK", reason: "第 2 块：Agent 超时（120 秒）" }],
    },
  });
  expect(done.container.textContent).toContain("字幕整理失败");
  expect(done.find("字幕整理失败").title).toBe("第 2 块：Agent 超时（120 秒）");
  expect(done.container.querySelectorAll(".zc-sub-row")).toHaveLength(0);
  await done.click("重新整理");
  expect(done.call).toHaveBeenCalledWith("chat_subtitle_retry", {});
});

it.each([
  ["整理中", { running: true, warnings: [], progress: [{ transcript_id: "tra_1", done: 1, total: 2 }] }, false],
  ["完成", { running: false, warnings: [], progress: [] }, true],
  [
    "校对中",
    {
      running: true,
      phase: "proofread" as const,
      warnings: [],
      progress: [{ transcript_id: "tra_1", done: 2, total: 6, phase: "proofread" as const }],
    },
    true,
  ],
  [
    "校对失败",
    { running: false, warnings: [{ code: "W_SUB_PROOFREAD_FAILED", reason: "校对失败", transcript_id: "tra_1" }] },
    true,
  ],
  [
    "失败",
    {
      running: false,
      warnings: [{ code: "W_SUB_PASS_FALLBACK", reason: "Agent 超时", transcript_id: "tra_1" }],
      progress: [],
    },
    false,
  ],
])("shows timeline and preview correctly: %s", async (_name, subtitlePass, shown) => {
  const other = { ...cue, cue_id: "cue_other", transcript_id: "tra_other", text: "其他母稿" };
  const view = { ...project, cues: [cue, other], subtitlePass };
  const actual = recordingCanvas();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(actual.context);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <TimelinePreview
        project={view}
        state={{ ...initialState(), playhead: { at: cue.start } }}
        update={() => {}}
        call={async () => ({})}
        config={undefined}
        error={null}
        dragging={{ current: false }}
      />,
    ),
  );
  const clips = [...container.querySelectorAll(".zc-clip-subtitle")];
  expect(clips).toHaveLength(2);
  expect(clips[0]?.textContent).toBe(cue.text);
  expect(clips[1]?.textContent).toBe(other.text);
  expect(container.querySelector(".zc-subtitle-canvas")?.getAttribute("aria-label")).toBe(
    shown ? `${cue.text}\n${other.text}` : other.text,
  );
  const drawn = actual.calls.filter(([name]) => name === "fillText").map((call) => call[1]);
  expect(drawn).toContain(other.text);
  expect(drawn.includes(cue.text)).toBe(shown);
  const panel = await mount(view);
  expect(panel.container.querySelectorAll(".zc-sub-row")).toHaveLength(shown ? 2 : 0);
  if (_name === "失败") expect(panel.find("字幕整理失败").title).toBe("Agent 超时");
});

it("does not show unmarked transcript cues before pass state arrives", async () => {
  const view = { ...project, unprocessedTranscripts: ["tra_1"] };
  const panel = await mount(view);
  expect(panel.container.querySelectorAll(".zc-sub-row")).toHaveLength(0);
  expect(panel.container.textContent).not.toContain("已识别 · 第 4 版");
});

async function selectOption(h: Awaited<ReturnType<typeof mount>>, label: string, value: string) {
  if (label === "应用到") {
    await h.click(value === "selected" ? `选中 ${h.state().selected.length} 条` : "全部");
    return;
  }
  await act(async () => {
    const element = h.find<HTMLSelectElement>(label);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("merges releases within one second and copies only selected cues in the same edit", async () => {
  vi.useFakeTimers();
  const h = await mount();
  await h.click(cue.text);
  await h.click("样式");
  await selectOption(h, "应用到", "selected");
  const first = await h.input("字号", "12");
  await act(async () => first.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(600));
  const second = await h.input("字号", "14");
  await act(async () => second.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(h.call).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.call).toHaveBeenCalledTimes(1);
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops).toHaveLength(2);
  expect(ops[0]).toMatchObject({ op: "add_style", font_size: 14 / 180 });
  expect(ops[0]).not.toHaveProperty("version");
  expect(ops[1]).toEqual({ op: "set_cue", cue_id: cue.cue_id, style_id: ops[0]?.id });
});
it("caps outlines at three layers and writes disabled effects as null", async () => {
  vi.useFakeTimers();
  const h = await mount(project, "style");
  await h.click("添加描边");
  await h.click("添加描边");
  expect(h.find<HTMLButtonElement>("添加描边").disabled).toBe(true);
  await h.settle();
  const ops = h.call.mock.lastCall?.[1].ops as { outlines: unknown[] }[];
  expect(ops[0]?.outlines).toHaveLength(3);
  const withShadow = {
    ...project,
    styles: [
      {
        ...project.styles[0],
        id: "sty_1",
        font_family: "Arial",
        font_size: 0.05,
        color: "#FFFFFF",
        shadow: { color: "#000000", distance: 0.1, blur: 0.2, angle: 90 },
      },
    ],
  };
  const shadow = await mount(withShadow, "style");
  await act(async () => shadow.find<HTMLInputElement>("启用阴影").click());
  await shadow.settle();
  expect(shadow.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", shadow: null }]);
});
it("previews color dragging and persists only the final released color", async () => {
  vi.useFakeTimers();
  const h = await mount(project, "style");
  const color = await h.input("文字颜色取色", "#00ff00");
  await h.input("文字颜色取色", "#ff0000");
  expect(h.call).not.toHaveBeenCalled();
  await act(async () => color.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await h.settle();
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", color: "#ff0000" }]);
});
async function previewHarness(view = project) {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  cleanups.push(async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 320,
    height: 180,
    right: 320,
    bottom: 180,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const h = await mount(view, "subtitles", () => ({}), true);
  await h.click(cue.text);
  const hit = () => h.find<HTMLButtonElement>(`预览字幕：${cue.text}`);
  const pointer = (target: HTMLElement, type: string, x: number, y: number) =>
    act(async () => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 1 });
      target.dispatchEvent(event);
    });
  return { ...h, hit, pointer };
}
it("selects preview cues, clamps drag inside the frame, snaps to centre, and requests list editing", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  cleanups.push(async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
  const h = await previewHarness();
  await h.pointer(h.hit(), "pointerdown", 160, 160);
  expect(h.hit().classList.contains("is-selected")).toBe(true);
  await h.pointer(h.hit(), "pointermove", 162, 130);
  expect(h.container.querySelector(".zc-subtitle-guide")).not.toBeNull();
  expect(h.call).not.toHaveBeenCalled();
  await h.pointer(h.hit(), "pointerup", 162, 130);
  await h.settle();
  const ops = h.call.mock.lastCall?.[1].ops as { position: { anchor: string; offset_x: number; margin_v: number } }[];
  expect(ops[0]?.position).toMatchObject({ anchor: "bottom", offset_x: 0 });
  expect(ops[0]?.position.margin_v).toBeCloseTo(0.08 + 30 / 180);
  await h.pointer(h.hit(), "pointerdown", 160, 130);
  await h.pointer(h.hit(), "pointermove", 10000, -10000);
  const hit = h.hit();
  expect(Number.parseFloat(hit.style.left)).toBeGreaterThanOrEqual(0);
  expect(Number.parseFloat(hit.style.top)).toBeGreaterThanOrEqual(0);
  expect(Number.parseFloat(hit.style.left) + Number.parseFloat(hit.style.width)).toBeLessThanOrEqual(100.00001);
  await h.pointer(hit, "pointerup", 10000, -10000);
  await h.settle();
  await h.input("搜索字幕", "不存在");
  await h.update({ sub: "style" });
  await act(async () => h.hit().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(h.editCue).toHaveBeenCalledWith(cue);
  expect(h.state().subtitle_selection).toEqual({ cue_ids: [cue.cue_id], editing: cue.cue_id });
  const editor = h.find("编辑字幕");
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(editor.textContent).toBe(cue.text);
  expect(document.activeElement).toBe(editor);
  expect(caretOffset(editor)).toBe(cue.text.length);
  expect(window.getSelection()?.isCollapsed).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  expect(scroll.mock.instances.at(-1)).toBe(editor.closest(".zc-sub-row"));
});
it.each([
  { dy: -40, anchor: "top" },
  { dy: 40, anchor: "bottom" },
  { dy: -10000, anchor: "top" },
  { dy: 10000, anchor: "bottom" },
  { dy: 0, anchor: "middle" },
])("drops a middle subtitle at dy=$dy with $anchor anchor and no position jump", async ({ dy, anchor }) => {
  const style = {
    ...defaultStyle,
    id: "sty_1",
    position: { anchor: "middle" as const, margin_v: 0.08, max_width: 0.8, offset_x: 0 },
  };
  const h = await previewHarness({ ...project, styles: [style] });
  const originalTop = (Number.parseFloat(h.hit().style.top) / 100) * 180;
  const boxHeight = (Number.parseFloat(h.hit().style.height) / 100) * 180;
  const expectedTop = Math.max(0, Math.min(180 - boxHeight, originalTop + dy));
  await h.pointer(h.hit(), "pointerdown", 160, 90);
  await h.pointer(h.hit(), "pointermove", 190, 90 + dy);
  expect((Number.parseFloat(h.hit().style.top) / 100) * 180).toBeCloseTo(expectedTop);
  expect(h.call).not.toHaveBeenCalled();
  await h.pointer(h.hit(), "pointerup", 190, 90 + dy);
  await h.settle();
  expect(h.call).toHaveBeenCalledTimes(1);
  const ops = h.call.mock.lastCall?.[1].ops as { position: typeof style.position }[];
  expect(ops[0]?.position).toMatchObject({ anchor, max_width: style.position.max_width, offset_x: 30 / 320 });
  expect(ops[0]?.position.margin_v).toBeCloseTo(
    anchor === "top"
      ? expectedTop / 180
      : anchor === "bottom"
        ? (180 - expectedTop - boxHeight) / 180
        : style.position.margin_v,
  );
});
it.each(["bottom", "middle"] as const)(
  "scales around the %s subtitle centre and cancels without writing",
  async (anchor) => {
    const h = await previewHarness({
      ...project,
      transcripts: [
        {
          id: cue.transcript_id,
          media_id: "med_1",
          ext: { zsir: { id_tag: "stored" } },
          tokens: cue.tokens.map((token) => ({ ...token, align: { start: "0s", end: "3s" } })),
          cues: [{ id: cue.cue_id, first_token: "tok_1", last_token: "tok_2" }],
        },
      ],
      styles: [{ ...defaultStyle, id: "sty_1", position: { ...defaultStyle.position, margin_v: 0.08, anchor } }],
    });
    const hit = h.hit();
    const centre = () => Number.parseFloat(h.hit().style.top) + Number.parseFloat(h.hit().style.height) / 2;
    const original = centre();
    const x = ((Number.parseFloat(hit.style.left) + Number.parseFloat(hit.style.width)) / 100) * 320;
    const y = ((Number.parseFloat(hit.style.top) + Number.parseFloat(hit.style.height)) / 100) * 180;
    const corner = hit.querySelector<HTMLElement>('[data-subtitle-corner="se"]');
    if (!corner) throw new Error("corner");
    await h.pointer(corner, "pointerdown", x, y);
    await h.pointer(hit, "pointermove", x + 5, y + 1);
    expect(centre()).toBeCloseTo(original);
    await h.pointer(hit, "pointerup", x + 5, y + 1);
    await h.settle();
    const ops = h.call.mock.lastCall?.[1].ops as { font_size: number; position: { anchor: string } }[];
    expect(ops[0]?.font_size).toBeGreaterThan(defaultStyle.font_size);
    if (anchor === "middle") expect(ops[0]).not.toHaveProperty("position");
    else expect(ops[0]?.position.anchor).toBe(anchor);
    h.call.mockClear();
    await h.pointer(h.hit(), "pointerdown", 160, 150);
    await h.pointer(h.hit(), "pointermove", 180, 140);
    await h.pointer(h.hit(), "pointercancel", 180, 140);
    await h.settle();
    expect(h.call).not.toHaveBeenCalled();
  },
);
it("shows proofread progress while keeping the cue list editable", async () => {
  const h = await mount({
    ...project,
    subtitlePass: {
      running: true,
      phase: "proofread",
      warnings: [],
      progress: [{ transcript_id: "tra_1", done: 2, total: 6 }],
    },
  });
  expect(h.container.textContent).toContain("AI 校对 · 2/6");
  expect(h.container.querySelectorAll(".zc-sub-row")).toHaveLength(2);
  await h.focus(cue.text, 1);
  expect(h.find("编辑字幕").getAttribute("contenteditable")).toBe("true");
  await h.input("编辑字幕", "您好世界");
  await h.blur("编辑字幕");
  expect(h.call).toHaveBeenCalledWith("edit", expect.objectContaining({ label: "修改字幕" }));
});

it("shows proofread failure and retry without hiding the breaking result", async () => {
  const h = await mount({
    ...project,
    subtitlePass: {
      running: false,
      warnings: [{ code: "W_SUB_PROOFREAD_FAILED", reason: "Codex 未登录", transcript_id: "tra_1" }],
    },
  });
  expect(h.container.textContent).toContain("字幕校对失败");
  expect(h.find("字幕校对警告").title).toBe("Codex 未登录");
  expect(h.container.querySelectorAll(".zc-sub-row")).toHaveLength(2);
  await h.click("重新校对");
  expect(h.call).toHaveBeenCalledWith("chat_subtitle_retry", {});
});

it("shows progress from a manually requested proofread pass in preview data", async () => {
  const h = await mount({
    ...project,
    subtitle_pass: {
      pass_id: "job_manual",
      kind: "proofread",
      state: "running",
      done: 2,
      total: 6,
      reason: null,
    },
  });
  expect(h.container.textContent).toContain("AI 校对 · 2/6");
  expect(h.container.querySelectorAll(".zc-sub-row")).toHaveLength(2);
});

const nextCue = {
  ...cue,
  cue_id: "cue_2",
  text: "再见朋友",
  start: "3s",
  end: "5s",
  tokens: [
    { id: "tok_3", text: "再见" },
    { id: "tok_4", text: "朋友" },
  ],
  next_cue_id: null,
};
const listProject = {
  ...project,
  cues: [{ ...cue, next_cue_id: "cue_2" }, nextCue],
  transcripts: (project.transcripts ?? []).map((transcript) => ({
    ...transcript,
    tokens: [...transcript.tokens, ...nextCue.tokens.map((token) => ({ ...token, align: { start: "3s", end: "5s" } }))],
    cues: [...transcript.cues, { id: nextCue.cue_id, first_token: "tok_3", last_token: "tok_4" }],
  })),
};

it.each([1, 2])("splits at character %i in one edit batch and refreshes both row DOM texts", async (offset) => {
  const h = await mount(listProject);
  await h.focus(cue.text, offset);
  expect(caretOffset(h.find("编辑字幕"))).toBe(offset);
  await h.key(h.find("编辑字幕"), "Enter");
  const request = h.call.mock.lastCall?.[1];
  expect(request?.label).toBe("拆分字幕");
  const ops = request?.ops as Record<string, unknown>[];
  expect(ops.map((op) => op.op)).toEqual(offset === 1 ? ["split_token", "split_cue"] : ["split_cue"]);
  if (offset === 1)
    expect(ops[0]).toEqual({ op: "split_token", transcript_id: cue.transcript_id, token_id: "tok_1", at: 1 });
  expect(ops.at(-1)).toMatchObject({
    op: "split_cue",
    cue_id: "cue_1",
    after_token: "tok_1",
  });
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(ops.at(-1)).not.toHaveProperty("new_id");
  const id = cueEdit(cue, cue.text, offset, listProject.transcripts).newCue as string;
  await h.view({
    ...listProject,
    revision: { id: "rev_2", seq: 8 },
    cues: [
      { ...cue, text: offset === 1 ? "你" : "你好", tokens: [{ id: "tok_1", text: offset === 1 ? "你" : "你好" }] },
      { ...nextCue, cue_id: id, text: "后半条", tokens: [{ id: "tok_r", text: "后半条" }] },
      nextCue,
    ],
  });
  expect([...h.container.querySelectorAll(".zc-sub-text")].map((row) => row.textContent)).toEqual([
    offset === 1 ? "你" : "你好",
    "后半条",
    nextCue.text,
  ]);
  expect(h.state().subtitle_selection?.editing).toBe(id);
  expect(caretOffset(h.find("编辑字幕"))).toBe(0);
});
it("includes pending char-diff edits and their preassigned IDs before split_token and split_cue", async () => {
  const h = await mount(listProject);
  await h.click(cue.text);
  await h.input("编辑字幕", "你好新世界");
  await h.focus("编辑字幕", 3);
  await h.key(h.find("编辑字幕"), "Enter");
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops.map((op) => op.op)).toEqual(["edit_text", "split_token", "split_cue"]);
  expect(ops[0]).toMatchObject({
    from_token: "tok_2",
    to_token: "tok_2",
    text: "新世界",
    new_ids: [expect.any(String)],
  });
  expect(ops[1]).toMatchObject({ token_id: (ops[0]?.new_ids as string[])[0], at: 1 });
  expect(ops[2]?.after_token).toBe(ops[1]?.token_id);
  expect(h.call).toHaveBeenCalledTimes(1);
});
it("Enter at start does nothing and at end goes to the next cue start", async () => {
  const h = await mount(listProject);
  await h.focus(cue.text, 0);
  await h.key(h.find("编辑字幕"), "Enter");
  expect(h.call).not.toHaveBeenCalled();
  await h.focus("编辑字幕", cue.text.length);
  await h.key(h.find("编辑字幕"), "Enter");
  expect(h.state().subtitle_selection?.editing).toBe("cue_2");
  expect(caretOffset(h.find("编辑字幕"))).toBe(0);
  expect(h.call).not.toHaveBeenCalled();
});
it.each([1, 2])("Shift+Enter at %i stores breaks without creating another cue", async (offset) => {
  const h = await mount(listProject);
  await h.focus(cue.text, offset);
  await h.key(h.find("编辑字幕"), "Enter", { shiftKey: true });
  expect(h.find("编辑字幕").textContent).toBe(`${cue.text.slice(0, offset)}\n${cue.text.slice(offset)}`);
  expect(h.call).not.toHaveBeenCalled();
  await h.blur("编辑字幕");
  const request = h.call.mock.lastCall?.[1];
  expect(request?.label).toBe("修改字幕");
  const ops = request?.ops as Record<string, unknown>[];
  expect(ops.map((op) => op.op)).toEqual(offset === 1 ? ["split_token", "set_cue"] : ["set_cue"]);
  expect(ops.at(-1)).toEqual({ op: "set_cue", cue_id: "cue_1", breaks: ["tok_1"] });
});
it.each([
  ["Backspace", 0, "cue_2"],
  ["Delete", 4, "cue_1"],
] as const)("%s merges adjacent cues at the seam", async (key, offset, id) => {
  const h = await mount(listProject);
  await h.focus(id === "cue_1" ? cue.text : nextCue.text, offset);
  await h.key(h.find("编辑字幕"), key);
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "合并字幕",
    ops: [{ op: "merge_cues", cue_ids: ["cue_1", "cue_2"] }],
  });
  expect(h.state().subtitle_selection?.editing).toBe("cue_1");
  await h.view({
    ...listProject,
    revision: { id: "rev_2", seq: 8 },
    cues: [{ ...cue, text: cue.text + nextCue.text, tokens: [...cue.tokens, ...nextCue.tokens] }],
  });
  expect([...h.container.querySelectorAll(".zc-sub-text")].map((row) => row.textContent)).toEqual([
    cue.text + nextCue.text,
  ]);
  expect(caretOffset(h.find("编辑字幕"))).toBe(4);
  await h.key(h.find("编辑字幕"), "Escape");
  expect(h.container.querySelector(".zc-sub-text")?.textContent).toBe(cue.text + nextCue.text);
});
it.each(["locked", "other-transcript", "non-adjacent"])("refuses merging %s with a readable status", async (kind) => {
  const next = {
    ...nextCue,
    ...(kind === "locked" ? { locked: true } : kind === "other-transcript" ? { transcript_id: "trs_other" } : {}),
  };
  const h = await mount({
    ...listProject,
    cues: [{ ...cue, next_cue_id: kind === "non-adjacent" ? "cue_missing" : "cue_2" }, next],
  });
  await h.focus(cue.text, 4);
  await h.key(h.find("编辑字幕"), "Delete");
  expect(h.call).not.toHaveBeenCalled();
  expect(h.container.textContent).toContain("这两条不能合并");
});
it("Up/Down keep code-point column, commit pending edits, and respect multiline boundaries", async () => {
  const h = await mount(listProject);
  await h.focus(cue.text, 1);
  await h.key(h.find("编辑字幕"), "ArrowDown");
  expect(h.state().subtitle_selection?.editing).toBe("cue_2");
  expect(caretOffset(h.find("编辑字幕"))).toBe(1);
  await h.input("编辑字幕", "再见同学");
  await h.focus("编辑字幕", 2);
  await h.key(h.find("编辑字幕"), "ArrowUp");
  expect(h.call.mock.lastCall?.[1].label).toBe("修改字幕");
  expect(h.state().subtitle_selection?.editing).toBe("cue_1");
  expect(caretOffset(h.find("编辑字幕"))).toBe(2);
  await h.key(h.find("编辑字幕"), "Enter", { shiftKey: true });
  await h.focus("编辑字幕", 0);
  await h.key(h.find("编辑字幕"), "ArrowDown");
  expect(h.state().subtitle_selection?.editing).toBe("cue_1");
});
it("routes dirty text undo/redo locally and clean undo/redo to the project", async () => {
  const h = await mount(listProject);
  await h.click(cue.text);
  await h.input("编辑字幕", "你好朋友");
  await h.input("编辑字幕", "你好同学");
  await h.key(h.find("编辑字幕"), "z", { metaKey: true });
  expect(h.find("编辑字幕").textContent).toBe("你好朋友");
  await h.key(h.find("编辑字幕"), "z", { metaKey: true, shiftKey: true });
  expect(h.find("编辑字幕").textContent).toBe("你好同学");
  await h.key(h.find("编辑字幕"), "z", { metaKey: true });
  await h.key(h.find("编辑字幕"), "z", { metaKey: true });
  expect(h.find("编辑字幕").textContent).toBe(cue.text);
  expect(h.call).not.toHaveBeenCalled();
  await h.key(h.find("编辑字幕"), "z", { metaKey: true });
  expect(h.call.mock.lastCall?.[0]).toBe("undo");
  await h.key(h.find("编辑字幕"), "z", { metaKey: true, shiftKey: true });
  expect(h.call.mock.lastCall?.[0]).toBe("redo");
});
it("supports time-column selection, Cmd toggle, Shift range, Cmd+A and batch actions", async () => {
  const third = { ...nextCue, cue_id: "cue_3", start: "5s", end: "7s", text: "第三条" };
  const h = await mount({
    ...listProject,
    cues: [listProject.cues[0] as typeof cue, { ...nextCue, next_cue_id: "cue_3" }, third],
  });
  await h.click("选择字幕 1");
  expect(h.state().subtitle_selection).toEqual({ cue_ids: ["cue_1"], editing: null });
  await act(async () => h.find("选择字幕 2").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
  expect(h.state().selected).toEqual(["cue_1", "cue_2"]);
  expect(h.find("合并").title).toBe("合并");
  await h.click("样式");
  await h.click("正文");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "set_cue", cue_id: "cue_1", style_id: "sty_1" },
    { op: "set_cue", cue_id: "cue_2", style_id: "sty_1" },
  ]);
  await h.click("删除选中字幕");
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "删除字幕",
    ops: [
      { op: "hide_tokens", tokens: ["tok_1", "tok_2"] },
      { op: "hide_tokens", tokens: ["tok_3", "tok_4"] },
    ],
  });
  await h.click("选择字幕 1");
  await act(async () => h.find("选择字幕 3").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
  expect(h.state().selected).toEqual(["cue_1", "cue_2", "cue_3"]);
  await h.click("取消选择");
  await h.key(h.find("字幕列表"), "a", { metaKey: true });
  expect(h.state().selected).toHaveLength(3);
  expect(h.state().subtitle_selection?.editing).toBeNull();
});
it.each(["locked", "approved"])("shows a lock and read-only text for %s cues", async (kind) => {
  const locked =
    kind === "locked"
      ? { ...cue, locked: true }
      : { ...cue, tokens: cue.tokens.map((token) => ({ ...token, state: "approved" })) };
  const h = await mount({ ...project, cues: [locked] });
  expect(h.find("已锁定")).toBeTruthy();
  expect(h.find(cue.text).getAttribute("aria-readonly")).toBe("true");
  await h.focus(cue.text, 1);
  await h.key(h.find(cue.text), "Enter");
  expect(h.call).not.toHaveBeenCalled();
  expect(h.state().subtitle_selection?.editing).toBeNull();
});
it.each(["tidy", "proofread"] as const)(
  "keeps AI %s progress, row dimming and failure retry without starting from an entry",
  async (kind) => {
    const h = await mount(listProject);
    const running = { pass_id: "pass_1", kind, state: "running" as const, done: 1, total: 2, reason: "" };
    await h.view({ ...listProject, subtitle_pass: running, subtitlePass: { running: true, warnings: [] } });
    expect(h.container.querySelectorAll(".is-running")).toHaveLength(2);
    expect(h.container.textContent).toContain(`${kind === "tidy" ? "AI 重新分行" : "AI 校对"} · 1/2`);
    expect(h.call).not.toHaveBeenCalled();
    await h.view({ ...listProject, subtitle_pass: { ...running, state: "failed", reason: "Agent 超时" } });
    expect(h.container.textContent).toContain("Agent 超时");
    expect(h.container.querySelectorAll(".is-running")).toHaveLength(0);
    await h.click("重试 AI 操作");
    expect(h.call.mock.calls).toEqual([["chat_subtitle_retry", {}]]);
  },
);

it.each([
  ["更多字幕操作", "更多字幕操作"],
  ["样式", "字幕样式"],
])("dismisses %s on outside pointerdown while keeping inside presses open", async (trigger, label) => {
  const h = await mount(listProject);
  await h.update({ selected: [cue.cue_id, nextCue.cue_id] });
  const menu = () => h.container.querySelector(`[role="menu"][aria-label="${label}"]`);
  await h.click(trigger);
  await act(async () => menu()?.firstElementChild?.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu()).toBeNull();
  expect(h.find(trigger).getAttribute("aria-expanded")).toBe("false");
  expect(h.call).not.toHaveBeenCalled();
  expect(h.promptAi).not.toHaveBeenCalled();
});

it.each([
  ["更多字幕操作", "更多字幕操作"],
  ["样式", "字幕样式"],
])("dismisses %s on Escape and returns focus to its trigger", async (trigger, label) => {
  const h = await mount(listProject);
  await h.update({ selected: [cue.cue_id, nextCue.cue_id] });
  const menu = () => h.container.querySelector(`[role="menu"][aria-label="${label}"]`);
  await h.click(trigger);
  const item = menu()?.querySelector("button");
  expect(item).toBeTruthy();
  item?.focus();
  await h.key(item as HTMLButtonElement, "ArrowDown");
  expect(menu()).not.toBeNull();
  await h.key(item as HTMLButtonElement, "Escape");
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(h.find(trigger));
});

it.each([
  ["更多字幕操作", "更多字幕操作"],
  ["样式", "字幕样式"],
])("toggles %s through pointerdown then click on its icon", async (trigger, label) => {
  const h = await mount(listProject);
  await h.update({ selected: [cue.cue_id, nextCue.cue_id] });
  for (const open of [true, false, true, false]) {
    const icon = h.find(trigger).querySelector("path");
    expect(icon).not.toBeNull();
    await act(async () => icon?.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await act(async () => icon?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(!!h.container.querySelector(`[role="menu"][aria-label="${label}"]`)).toBe(open);
  }
});

it.each([
  ["更多字幕操作", "更多字幕操作", "全部重新分行"],
  ["更多字幕操作", "更多字幕操作", "全部校对"],
  ["样式", "字幕样式", "正文"],
])("closes %s after choosing %s / %s", async (trigger, label, action) => {
  const h = await mount(listProject);
  await h.update({ selected: [cue.cue_id, nextCue.cue_id] });
  await h.click(trigger);
  const menu = h.container.querySelector(`[role="menu"][aria-label="${label}"]`);
  const button = [...(menu?.querySelectorAll("button") ?? [])].find((item) => item.textContent === action);
  expect(button).toBeTruthy();
  await act(async () => button?.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await h.click(action);
  expect(h.container.querySelector(`[role="menu"][aria-label="${label}"]`)).toBeNull();
  if (trigger === "样式")
    expect(h.call.mock.lastCall?.[1].ops).toEqual([
      { op: "set_cue", cue_id: cue.cue_id, style_id: "sty_1" },
      { op: "set_cue", cue_id: nextCue.cue_id, style_id: "sty_1" },
    ]);
  else expect(h.promptAi).toHaveBeenCalledOnce();
});

it.each(["toolbar", "selection", "context", "all"] as const)(
  "fills both exact prompts from the %s entry, switches to AI, appends and focuses without requests",
  async (entry) => {
    const third = { ...nextCue, cue_id: "cue_3", start: "3660s", end: "3725s", text: "第三条" };
    const h = await mount({ ...listProject, cues: [third, cue, nextCue] }, "subtitles", () => ({}), false, true);
    if (entry !== "toolbar") await h.update({ selected: ["cue_3", "cue_1", "cue_2"] });
    await h.input("发给 AI", "原来的要求");
    for (const kind of ["tidy", "proofread"] as const) {
      const label = kind === "tidy" ? "AI 重新分行" : "AI 校对";
      await h.update({ panel: "subtitles" });
      h.call.mockClear();
      h.aiCall.mockClear();
      if (entry === "context") {
        await act(async () => h.find(cue.text).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
        const button = [...h.find("字幕菜单").querySelectorAll("button")].find((node) => node.textContent === label);
        await act(async () => button?.click());
      } else if (entry === "all") {
        await h.click("更多字幕操作");
        await h.click(kind === "tidy" ? "全部重新分行" : "全部校对");
      } else {
        const toolbar = h.container.querySelector(entry === "selection" ? ".zc-sub-toolbar" : ".zc-sub-search-row");
        const button = toolbar?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        expect(button).toBeTruthy();
        await act(async () => button?.click());
      }
      const range = entry === "toolbar" || entry === "all" ? "全部字幕" : "选中的 3 条字幕（00:01–1:02:05）";
      const prompt = kind === "tidy" ? `把${range}按意思重新分行。` : `校对${range}，只改错字和专有名词，不改意思。`;
      expect(h.promptAi).toHaveBeenLastCalledWith(prompt);
      expect(h.state().panel).toBe("ai");
      expect(h.state().subtitle_selection?.cue_ids).toEqual(
        entry === "toolbar" || entry === "all" ? [] : ["cue_1", "cue_2", "cue_3"],
      );
      const input = h.find<HTMLTextAreaElement>("发给 AI");
      expect(input.value).toBe(`原来的要求\n\n${prompt}`);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(input.value.length);
      expect(input.selectionEnd).toBe(input.value.length);
      expect(h.call).not.toHaveBeenCalled();
      expect(h.aiCall).not.toHaveBeenCalled();
      expect(h.container.querySelector(".zc-sub-ai")).toBeNull();
      await h.input("发给 AI", "原来的要求");
    }
  },
);
it("uses the context row as the Agent selection when it was not selected", async () => {
  const h = await mount(listProject);
  await h.update({ selected: ["cue_2"] });
  await act(async () => h.find(cue.text).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  const button = [...h.find("字幕菜单").querySelectorAll("button")].find((node) => node.textContent === "AI 校对");
  await act(async () => button?.click());
  expect(h.promptAi).toHaveBeenCalledWith("校对选中的 1 条字幕（00:01–00:03），只改错字和专有名词，不改意思。");
  expect(h.state().subtitle_selection?.cue_ids).toEqual(["cue_1"]);
  expect(h.call).not.toHaveBeenCalled();
});

it("underlines edited words, exposes original text and restores through edit_text in the context menu", async () => {
  const h = await mount({
    ...listProject,
    cues: [
      {
        ...cue,
        tokens: [
          { id: "tok_1", text: "你好", state: "edited", heard: "您好" },
          cue.tokens[1] as { id: string; text: string },
        ],
      },
      nextCue,
    ],
  });
  const token = h.container.querySelector<HTMLElement>(".zc-sub-edited");
  expect(token?.title).toBe("原来：您好");
  await act(async () =>
    token?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })),
  );
  expect(h.find("字幕菜单").textContent).toContain("复制文字");
  await h.click("还原");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "edit_text", transcript_id: "tra_1", from_token: "tok_1", to_token: "tok_1", text: "您好" },
  ]);
});
it("counts all matches and replaces one at a time, moving the highlight and scrolling across rows", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  cleanups.push(async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
  const first = {
    ...cue,
    text: "你好你好",
    tokens: [
      { id: "tok_1", text: "你好" },
      { id: "tok_2", text: "你好" },
    ],
  };
  const second = { ...nextCue, text: "你好", tokens: [{ id: "tok_3", text: "你好" }] };
  const h = await mount({ ...listProject, cues: [first, second] });
  await h.input("搜索字幕", "不存在");
  await h.click("查找替换");
  expect(h.container.querySelector(".zc-sub-replace output")).toBeNull();
  expect(h.find<HTMLInputElement>("查找").placeholder).toBe("旧词");
  expect(h.find<HTMLInputElement>("替换为").placeholder).toBe("新词");
  for (const label of ["替换下一处", "全部替换"]) {
    const button = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBeTruthy();
  }
  await h.input("查找", "你好");
  await h.input("替换为", "您好");
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("3 处");
  expect(h.container.querySelectorAll("mark")).toHaveLength(1);
  await h.click("替换下一处");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([expect.objectContaining({ from_token: "tok_1", text: "您好" })]);
  const updated = {
    ...first,
    text: "您好你好",
    tokens: [
      { id: "tok_1", text: "您好" },
      { id: "tok_2", text: "你好" },
    ],
  };
  await h.view({ ...listProject, cues: [updated, second] });
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("2 处");
  expect(h.container.querySelector("mark")?.parentElement?.getAttribute("data-token")).toBe("tok_2");
  await h.click("替换下一处");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([expect.objectContaining({ from_token: "tok_2", text: "您好" })]);
  scroll.mockClear();
  await h.view({
    ...listProject,
    cues: [{ ...updated, text: "您好您好", tokens: updated.tokens.map((t) => ({ ...t, text: "您好" })) }, second],
  });
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("1 处");
  const row = h.container.querySelector("mark")?.closest(".zc-sub-row");
  expect(row?.textContent).toContain("你好");
  expect(scroll).toHaveBeenCalled();
  expect(scroll.mock.instances.at(-1)).toBe(row);
  expect(h.container.querySelector('[aria-label="上一个"], [aria-label="下一个"]')).toBeNull();
  await h.input("查找", "没有这个词");
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("没有找到");
  expect(
    [...h.container.querySelectorAll<HTMLButtonElement>(".zc-sub-replace-actions button")].every((b) => b.disabled),
  ).toBe(true);
  await h.input("查找", "");
  expect(h.container.querySelector(".zc-sub-replace output")).toBeNull();
  expect(
    [...h.container.querySelectorAll<HTMLButtonElement>(".zc-sub-replace-actions button")].every((b) => b.disabled),
  ).toBe(true);
});

it("counts locked matches, skips them for single replacement, and toggles case sensitivity with Aa", async () => {
  const h = await mount({
    ...project,
    cues: [{ ...cue, locked: true, text: "Word word" }, { ...project.cues[1], text: "Word word" } as typeof cue],
  });
  await h.click("查找替换");
  await h.input("查找", "Word");
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("4 处");
  expect(h.find("区分大小写").getAttribute("aria-pressed")).toBe("false");
  expect(h.find("区分大小写").title).toBe("区分大小写");
  await h.click("区分大小写");
  expect(h.find("区分大小写").getAttribute("aria-pressed")).toBe("true");
  expect(h.container.querySelector(".zc-sub-replace output")?.textContent).toBe("2 处");
  await h.click("替换下一处");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "remove_free_cue", track_id: "trk_s", id: "cue_free" },
    expect.objectContaining({ op: "add_free_cue", track_id: "trk_s", id: "cue_free", text: " word" }),
  ]);
});

it("moves beyond replacement text that still contains the search term and retains the current match on failure", async () => {
  const first = { ...project.cues[1], text: "词词" } as typeof cue;
  let fails = true;
  const h = await mount({ ...project, cues: [first] }, "subtitles", () => {
    if (fails) throw new Error("失败");
    return {};
  });
  await h.click("查找替换");
  await h.input("查找", "词");
  await h.input("替换为", "新词");
  await h.click("替换下一处");
  expect(h.container.querySelector("mark")?.previousSibling).toBeNull();
  fails = false;
  await h.click("替换下一处");
  await h.view({ ...project, cues: [{ ...first, text: "新词词" }] });
  expect(h.container.querySelector("mark")?.previousSibling?.textContent).toBe("新词");
});
it("follows playback except within three seconds of user scrolling", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  cleanups.push(async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
  let now = 10000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = await mount(listProject);
  await h.update({ playing: true, playhead: { at: "2s" } });
  expect(h.container.querySelector(".is-current")?.textContent).toContain(cue.text);
  expect(scroll).toHaveBeenCalledTimes(1);
  await act(async () => h.find("字幕列表").dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
  now += 2000;
  await h.update({ playhead: { at: "3s" } });
  expect(scroll).toHaveBeenCalledTimes(1);
  now += 1001;
  await h.update({ playhead: { at: "4s" } });
  expect(scroll).toHaveBeenCalledTimes(2);
});
it("plans separate whole-token edits and preserves hidden-token boundaries", () => {
  const words = {
    ...cue,
    text: "甲乙丙",
    tokens: [
      { id: "a", text: "甲" },
      { id: "b", text: "乙" },
      { id: "c", text: "丙" },
    ],
  };
  expect(textEdits(words, "一乙三")).toMatchObject([
    { from_token: "a", to_token: "a", text: "一" },
    { from_token: "c", to_token: "c", text: "三" },
  ]);
  const hidden = {
    ...cue,
    tokens: [
      cue.tokens[0] as { id: string; text: string },
      { id: "hidden", text: "" },
      cue.tokens[1] as { id: string; text: string },
    ],
  };
  expect(cueEdit(hidden, cue.text, 2, listProject.transcripts).ops).toMatchObject([
    { op: "split_cue", after_token: "tok_1" },
  ]);
  expect(() => cueEdit(hidden, "新的字幕")).toThrow("隐藏字词");
});
it.each([false, true])(
  "a component split inside a token followed by one project undo restores content bytes (pending edit: %s)",
  async (pending) => {
    const directory = await mkdtemp(join(tmpdir(), "subtitle-component-"));
    const path = join(directory, "project.zcut.json");
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    await copyFile("fixtures/projects/std-25.zcut.json", path);
    const load = async () =>
      JSON.parse(await readFile(path, "utf8")) as {
        revision: { id: string; seq: number };
        transcripts: TranscriptView[];
      };
    const before = await load();
    const item = before.transcripts.find((item) => item.id === "trs_A_zh");
    const source = item?.cues.find((cue) => cue.id === "cue_zh_03");
    if (!item || !source) throw new Error("fixture cue");
    const tokens = item.tokens.slice(
      item.tokens.findIndex((token) => token.id === source.first_token),
      item.tokens.findIndex((token) => token.id === source.last_token) + 1,
    );
    const view = {
      ...project,
      id: "tl_std",
      revision: { id: before.revision.id, seq: before.revision.seq },
      transcripts: before.transcripts,
      cues: [
        {
          ...cue,
          cue_id: source.id,
          transcript_id: item.id,
          text: tokens.map((token) => token.text).join(""),
          tokens: tokens.map(({ id, text }) => ({ id, text })),
        },
      ],
    };
    const h = await mount(view, "subtitles", async (verb, request) => {
      const run = spawnSync(process.execPath, ["packages/cli/src/index.ts", verb, path], {
        encoding: "utf8",
        input: JSON.stringify({ ...request, project: path }),
      });
      const result = JSON.parse(run.stdout);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.result;
    });
    await h.focus(view.cues[0]?.text ?? "", 2);
    if (pending) {
      await h.input("编辑字幕", (view.cues[0]?.text ?? "").replace("Agent", "AgXent"));
      await h.focus("编辑字幕", 2);
    }
    await h.key(h.find("编辑字幕"), "Enter");
    const after = await load();
    expect(after.revision.seq).toBe(before.revision.seq + 1);
    await h.view({ ...view, revision: { id: after.revision.id, seq: after.revision.seq } });
    await h.key(h.container.querySelector(".zc-sub-text") as HTMLElement, "z", { metaKey: true });
    const restored = await load();
    expect(JSON.stringify({ ...restored, revision: before.revision })).toBe(JSON.stringify(before));
    expect(h.call.mock.calls.map(([verb]) => verb)).toEqual(["edit", "undo"]);
  },
);

it("maps edits of generated English spaces to the complete neighboring tokens", () => {
  const english = {
    ...cue,
    text: "hello world",
    tokens: [
      { id: "a", text: "hello" },
      { id: "b", text: "world" },
    ],
  };
  expect(textEdits(english, "helloworld")).toMatchObject([{ from_token: "a", to_token: "b", text: "helloworld" }]);
  expect(textEdits(english, "hello! world")).toMatchObject([{ from_token: "a", to_token: "a", text: "hello!" }]);
  expect(
    cueEdit({ ...cue, breaks: ["offscreen"] }, "你好\n世界", undefined, listProject.transcripts).ops.at(-1),
  ).toEqual({
    op: "set_cue",
    cue_id: cue.cue_id,
    breaks: ["offscreen", "tok_1"],
  });
});

it("keeps arrows within wrapped visual lines and preserves the visual character column across cues", async () => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Range) {
      const top = this.startContainer.parentElement?.dataset.token === "tok_2" ? 25 : 5;
      return [{ top, bottom: top + 15, height: 15 }];
    },
  });
  cleanups.push(async () => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });
  const h = await mount(listProject);
  const first = h.find(cue.text);
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 42, height: 42 } as DOMRect);
  await h.focus(cue.text, 1);
  await h.key(h.find("编辑字幕"), "ArrowDown");
  expect(h.state().subtitle_selection?.editing).toBe("cue_1");
  await h.focus("编辑字幕", 3);
  await h.key(h.find("编辑字幕"), "ArrowUp");
  expect(h.state().subtitle_selection?.editing).toBe("cue_1");
  await h.key(h.find("编辑字幕"), "ArrowDown");
  expect(h.state().subtitle_selection?.editing).toBe("cue_2");
  expect(caretOffset(h.find("编辑字幕"))).toBe(1);
});

it("copies all selected cue text through the row context menu", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  cleanups.push(async () => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  const h = await mount(listProject);
  await h.key(h.find("字幕列表"), "a", { metaKey: true });
  await act(async () => h.find(cue.text).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await h.click("复制文字");
  expect(writeText).toHaveBeenCalledWith(`${cue.text}\n${nextCue.text}`);
  expect(h.call).not.toHaveBeenCalled();
});

it("keeps pending inline edits in the same batch when merging from the context menu", async () => {
  const h = await mount(listProject);
  await h.click(cue.text);
  await h.input("编辑字幕", "你好朋友");
  await act(async () => h.find("编辑字幕").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  const merge = [...h.find("字幕菜单").querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "与下一条合并",
  );
  await act(async () => merge?.click());
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "合并字幕",
    ops: [
      { op: "edit_text", from_token: "tok_2", to_token: "tok_2", text: "朋友" },
      { op: "merge_cues", cue_ids: ["cue_1", "cue_2"] },
    ],
  });
});

it("selects animations, supplies highlight in the same write and commits rational durations on release", async () => {
  vi.useFakeTimers();
  const h = await mount(project, "style");
  await h.click("动画");
  await h.click("入场：上升");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "update_style", style_id: "sty_1", animation: { in: { type: "rise", duration: "1/5s" } } },
  ]);
  const calls = h.call.mock.calls.length;
  await h.input("入场时长", "0.35");
  expect(h.call).toHaveBeenCalledTimes(calls);
  await act(async () => h.find("入场时长").dispatchEvent(new Event("pointerup", { bubbles: true })));
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    expect.objectContaining({ animation: { in: { type: "rise", duration: "7/20s" } } }),
  ]);
  await h.click("出场：下沉");
  await h.click("逐字：填色");
  await h.settle();
  expect(h.container.querySelector('[aria-label="逐字"] input[type="range"]')).toBeNull();
  expect(h.container.querySelectorAll('.zc-sub-animation input[type="range"]')).toHaveLength(2);
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    expect.objectContaining({
      highlight: { color: "#FFD84A" },
      animation: { in: { type: "rise", duration: "7/20s" }, out: { type: "sink", duration: "1/5s" }, word: "fill" },
    }),
  ]);
  await h.click("入场：无");
  await h.settle();
  expect(JSON.parse(JSON.stringify(h.call.mock.lastCall?.[1].ops))).toEqual([
    expect.objectContaining({ animation: { out: { type: "sink", duration: "1/5s" }, word: "fill" } }),
  ]);
});
it("uses the selected subtitle style copy rule for word animation", async () => {
  vi.useFakeTimers();
  const h = await mount();
  await h.click("你好世界");
  await h.click("样式");
  await selectOption(h, "应用到", "selected");
  await h.click("动画");
  await h.click("逐字：跳动");
  await h.settle();
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops).toHaveLength(2);
  expect(ops[0]).toMatchObject({ op: "add_style", highlight: { color: "#FFD84A" }, animation: { word: "jump" } });
  expect(ops[1]).toEqual({ op: "set_cue", cue_id: "cue_1", style_id: ops[0]?.id });
});
it("draws the paused playhead frame with projected word times and ignores override word effects", async () => {
  const recorded = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorded.context);
  const container = document.createElement("div");
  const root = createRoot(container);
  const style = { ...defaultStyle, id: "sty_1", highlight: { color: "#FF8800" }, animation: { word: "fill" as const } };
  const timed = {
    ...cue,
    words: [
      { text: "你好", start: "0s", end: "1s" },
      { text: "世界", start: "1s", end: "2s" },
    ],
  };
  await act(async () =>
    root.render(<SubtitleCanvas cues={[timed]} styles={[style]} at="1501/1000s" format={project.format} />),
  );
  expect(recorded.calls.some((call) => call[0] === "clip")).toBe(true);
  recorded.calls.length = 0;
  await act(async () =>
    root.render(
      <SubtitleCanvas
        cues={[{ ...timed, text_override: true }]}
        styles={[style]}
        at="1501/1000s"
        format={project.format}
      />,
    ),
  );
  expect(recorded.calls.some((call) => call[0] === "clip")).toBe(false);
  await act(async () => root.unmount());
});

it("redraws animated captions from the playback clock every frame and cancels on pause", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const recorded = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorded.context);
  const root = createRoot(document.createElement("div"));
  const playback = { current: cue.start as string | null };
  const styles = [{ ...defaultStyle, id: "sty_1", animation: { in: { type: "fade" as const, duration: "1s" } } }];
  await act(async () =>
    root.render(
      <SubtitleCanvas
        cues={[cue]}
        styles={styles}
        playing
        playback={playback}
        at={cue.start}
        format={project.format}
      />,
    ),
  );
  expect(recorded.calls).toContainEqual(["globalAlpha", 0]);
  const count = recorded.calls.filter((call) => call[0] === "clearRect").length;
  playback.current = "3/2s";
  await act(async () => {
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    for (const callback of scheduled) callback(16);
  });
  expect(recorded.calls.filter((call) => call[0] === "clearRect")).toHaveLength(count + 1);
  expect(recorded.calls.filter((call) => call[0] === "globalAlpha").at(-1)?.[1]).toBeGreaterThan(0);
  await act(async () => root.render(<SubtitleCanvas cues={[cue]} styles={styles} at="3/2s" format={project.format} />));
  expect(callbacks.size).toBe(0);
  await act(async () => root.unmount());
});
it("loops the shared renderer on thumbnail hover and stops after leaving without writing", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.spyOn(performance, "now").mockReturnValue(0);
  const recorded = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorded.context);
  const h = await mount(project, "style");
  await h.click("动画");
  const cell = h.find("入场：淡入");
  await act(async () => cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(callbacks.size).toBe(1);
  recorded.calls.length = 0;
  for (const time of [100, 2100]) {
    await act(async () => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback(time);
    });
  }
  expect(recorded.calls.filter((call) => call[0] === "globalAlpha").map((call) => call[1])).toEqual([0.875, 0.875]);
  await act(async () => cell.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(callbacks.size).toBe(0);
  expect(h.call).not.toHaveBeenCalled();
});
it("adds missing highlight per target style without overwriting existing highlight colors", () => {
  const colored = { ...project.styles[0], ...defaultStyle, id: "sty_1", highlight: { color: "#AA0000" } };
  const view = { ...project, styles: [colored, { ...defaultStyle, id: "sty_2" }] };
  expect(subtitleStyleOps(view, [], { animation: { word: "highlight" } }, false)).toEqual([
    { op: "update_style", style_id: "sty_1", animation: { word: "highlight" } },
    { op: "update_style", style_id: "sty_2", animation: { word: "highlight" }, highlight: { color: "#FFD84A" } },
  ]);
});
it.each([false, true])("readbacks split/merge DOM and core's next short IDs (pending text: %s)", async (pending) => {
  const directory = await mkdtemp(join(tmpdir(), "subtitle-list-"));
  const path = join(directory, "project.zcut.json");
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await copyFile("fixtures/regressions/subtitle-list-short-ids.zcut.json", path);
  const load = async () =>
    JSON.parse(await readFile(path, "utf8")) as {
      revision: ProjectView["revision"];
      transcripts: TranscriptView[];
    };
  const before = await load();
  const transcript = before.transcripts[0] as TranscriptView;
  const source = transcript.cues[0] as TranscriptView["cues"][number];
  const original = transcript.tokens[0]?.text ?? "";
  const view = (data: typeof before): ProjectView => ({
    ...project,
    revision: data.revision,
    transcripts: data.transcripts,
    cues: data.transcripts.flatMap((item) =>
      item.cues.slice(0, -1).map((entry) => {
        const tokens = item.tokens.slice(
          item.tokens.findIndex((token) => token.id === entry.first_token),
          item.tokens.findIndex((token) => token.id === entry.last_token) + 1,
        );
        return { ...cue, cue_id: entry.id, transcript_id: item.id, tokens, text: tokens.map((t) => t.text).join("") };
      }),
    ),
  });
  const tokenId = transcriptIds(before, transcript, "tok_");
  const replacementId = pending ? tokenId() : undefined;
  const splitId = tokenId();
  const cueId = transcriptIds(before, transcript, "cue_")();
  expect(splitId).toBe(pending ? "tok_stored_11" : "tok_stored_10");
  expect(cueId).toBe("cue_stored_10");
  const h = await mount(view(before), "subtitles", async (verb, request) => {
    const run = spawnSync(process.execPath, ["packages/cli/src/index.ts", verb, path], {
      encoding: "utf8",
      input: JSON.stringify({ ...request, project: path }),
    });
    const result = JSON.parse(run.stdout);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.result;
  });
  await h.focus(original, 4);
  if (pending) {
    await h.input("编辑字幕", "可能约有两万多个");
    await h.focus("编辑字幕", 5);
  }
  await h.key(h.find("编辑字幕"), "Enter");
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  if (pending) expect(ops[0]?.new_ids).toEqual([replacementId]);
  expect(ops.find((op) => op.op === "split_token")).not.toHaveProperty("new_id");
  expect(ops.at(-1)).not.toHaveProperty("new_id");
  const split = await load();
  expect(split.transcripts[0]?.tokens.map((token) => token.id)).toEqual([
    replacementId ?? "tok_stored_0",
    splitId,
    "tok_stored_z",
  ]);
  expect(split.transcripts[0]?.cues.map((entry) => entry.id)).toEqual([source.id, cueId, "cue_stored_z"]);
  await h.view(view(split));
  const left = pending ? "可能约有两" : "可能有两";
  const texts = () => [...h.container.querySelectorAll(".zc-sub-text")].map((row) => row.textContent);
  expect(texts()).toEqual([left, "万多个"]);
  expect(h.state().subtitle_selection?.editing).toBe(cueId);
  expect(caretOffset(h.find("编辑字幕"))).toBe(0);
  await h.key(h.find("编辑字幕"), "Backspace");
  await h.view(view(await load()));
  expect(texts()).toEqual([`${left}万多个`]);
  expect(caretOffset(h.find("编辑字幕"))).toBe(left.length);
  await h.key(h.find("编辑字幕"), "Escape");
  expect(texts()).toEqual([`${left}万多个`]);
});

it("preassigns only referenced IDs and shares core's stored-tag and collision rules without mutating the view", () => {
  const transcripts = structuredClone(listProject.transcripts);
  const transcript = transcripts[0] as TranscriptView;
  transcript.tokens.push({ id: "tok_stored_z", text: "未显示", align: { start: "10s", end: "11s" } });
  const before = JSON.stringify(transcripts);
  const expected = transcriptIds({ transcripts }, transcript, "tok_");
  const plan = cueEdit(cue, "你好新世界", 3, transcripts);
  expect(plan.ops[0]?.new_ids).toEqual([expected()]);
  expect(plan.ops[1]).not.toHaveProperty("new_id");
  expect(cueEdit(cue, "你好新世界", undefined, transcripts).ops[0]).not.toHaveProperty("new_ids");
  expect(JSON.stringify(transcripts)).toBe(before);

  transcript.id = "trs_123456abcdef";
  delete transcript.ext;
  transcripts.push({ ...transcript, id: "trs_654321abcdef", tokens: [], cues: [] });
  const collisionCue = { ...cue, transcript_id: transcript.id };
  const copies = structuredClone(transcripts);
  const coreCue = transcriptIds({ transcripts: copies }, copies[0] as TranscriptView, "cue_")();
  expect(cueEdit(collisionCue, cue.text, 1, transcripts).newCue).toBe(coreCue);
  expect(coreCue).toBe("cue_56abcdef_0");
  expect(transcript.ext).toBeUndefined();
});

it("shows the compact style layout with text expanded and the track in the left column", async () => {
  const h = await mount(project, "style");
  expect(h.container.querySelector(".zc-sub-sample")).toBeNull();
  expect(h.container.textContent).not.toContain("▼");
  expect(h.container.querySelector('.zc-sub-controls [aria-label="字幕样式轨道"]')).not.toBeNull();
  const open = [...h.container.querySelectorAll(".zc-sub-style > details[open] > summary")];
  expect(open.map((summary) => summary.textContent?.trim())).toEqual(["文字"]);
  expect(h.container.querySelectorAll(".zc-sub-style summary > .zc-icon")).toHaveLength(6);
  expect(h.container.querySelectorAll(".zc-sub-preset-grid")).toHaveLength(5);
  expect(h.container.querySelectorAll(".zc-sub-preset-cell")).toHaveLength(subtitlePresets.length);
  expect(
    h.find("应用到").compareDocumentPosition(h.container.querySelector(".zc-sub-presets") as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(h.find<HTMLInputElement>("字号").type).toBe("number");
  expect(h.container.querySelectorAll(".zc-sub-colors button")).toHaveLength(8);
  expect(h.container.querySelectorAll(".zc-sub-style summary .zc-switch")).toHaveLength(3);
  expect(h.container.querySelectorAll(".zc-sub-align button:disabled")).toHaveLength(6);
  expect(h.container.querySelector('[aria-label="底板颜色取色"]')).toBeNull();
  await act(async () => h.find<HTMLInputElement>("启用底板").click());
  expect(h.find("底板颜色取色")).toBeTruthy();
  await act(async () => h.find<HTMLInputElement>("启用底板").click());
  expect(h.container.querySelector('[aria-label="底板颜色取色"]')).toBeNull();
  await h.view({
    ...project,
    subtitleTracks: [...(project.subtitleTracks ?? []), { id: "trk_other", name: "字幕 B", default_style_id: "sty_1" }],
  });
  expect(h.find("字幕样式轨道").textContent).toContain("字幕 B");
});

it("applies a preset as one named edit, keeps identity and position, and clears omitted effects", async () => {
  const style = {
    ...project.styles[0],
    ...defaultStyle,
    id: "sty_1",
    name: "保留名字",
    version: 9,
    max_lines: 3,
    position: { anchor: "top" as const, offset_x: 0.17, margin_v: 0.12, max_width: 0.65 },
    italic: true,
    underline: true,
    letter_spacing: 0.1,
    align: "left" as const,
    outlines: [{ color: "#FF0000", width: 0.1 }],
    box: { color: "#FFFFFF", padding: 0.3 },
    shadow: { color: "#000000", blur: 0.1, distance: 0.1, angle: 90 },
    glow: { color: "#FF0000", blur: 0.1 },
    highlight: { color: "#00FF00" },
    animation: { word: "fill" as const },
  };
  const h = await mount({ ...project, styles: [style] }, "style");
  await h.click("套用样式：经典白字");
  expect(h.call).toHaveBeenCalledTimes(1);
  const request = h.call.mock.lastCall?.[1];
  expect(request?.label).toBe("套用样式：经典白字");
  const ops = request?.ops as Record<string, unknown>[];
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({
    op: "update_style",
    style_id: "sty_1",
    italic: null,
    underline: null,
    letter_spacing: null,
    align: null,
    outlines: null,
    shadow: null,
    glow: null,
    highlight: null,
    animation: null,
    box: null,
  });
  for (const key of ["id", "name", "version", "position", "max_lines"]) expect(ops[0]).not.toHaveProperty(key);
  expect(style.position).toEqual({ anchor: "top", offset_x: 0.17, margin_v: 0.12, max_width: 0.65 });
});

it("applies presets through the selected copy rule and to all styles when requested", async () => {
  const view = { ...project, styles: [...project.styles, { ...defaultStyle, id: "sty_2" }] };
  const h = await mount(view, "style");
  await h.update({ selected: ["cue_1"] });
  await selectOption(h, "应用到", "selected");
  await h.click("套用样式：白底黑字");
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops).toHaveLength(2);
  expect(ops[0]).toMatchObject({
    op: "add_style",
    color: "#181818",
    name: "正文",
    position: defaultStyle.position,
    max_lines: 2,
  });
  expect(ops[1]).toEqual({ op: "set_cue", cue_id: "cue_1", style_id: ops[0]?.id });
  expect(h.call.mock.lastCall?.[1].label).toBe("套用样式：白底黑字");
  await selectOption(h, "应用到", "all");
  await h.click("套用样式：醒目黄字");
  expect(h.call.mock.lastCall?.[1].ops).toEqual(
    ["sty_1", "sty_2"].map((style_id) => expect.objectContaining({ op: "update_style", style_id, color: "#FFD84A" })),
  );
});

it("renders presets identically to the contact sheet helper and loops animated hover without writes", async () => {
  const contexts: ReturnType<typeof recordingCanvas>[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    const record = recordingCanvas();
    contexts.push(record);
    return record.context;
  });
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.spyOn(performance, "now").mockReturnValue(0);
  const h = await mount(project, "style");
  const expected = recordingCanvas();
  renderPreset(expected.context, subtitlePresets[0]?.fields ?? defaultStyle, 180, 120);
  expect(contexts[0]?.calls.filter(([name]) => name !== "clearRect")).toEqual(expected.calls);
  const cell = h.find("套用样式：弹入强调");
  await act(async () => cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(callbacks.size).toBe(1);
  const record = contexts.at(-1);
  const frames: unknown[][][] = [];
  for (const time of [100, 2100]) {
    if (record) record.calls.length = 0;
    await act(async () => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback(time);
    });
    frames.push([...(record?.calls ?? [])]);
  }
  expect(frames[0]).toEqual(frames[1]);
  expect(frames[0]?.some(([name]) => name === "scale")).toBe(true);
  await act(async () => cell.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(callbacks.size).toBe(0);
  expect(h.call).not.toHaveBeenCalled();
});

it("reveals the selected subtitle track overlay in Finder only in the desktop app", async () => {
  const view: ProjectView = {
    ...project,
    subtitleOverlays: [
      {
        id: "ovl_sub",
        name: "字幕层",
        timeline_id: project.id,
        subtitle_track_id: "trk_s",
        output_path: "/tmp/叠层/字幕A.mov",
        tail: "10s",
        last_export: null,
      },
    ],
  };
  const browser = await mount(view, "style");
  expect(browser.container.querySelector('[aria-label="在访达中显示"]')).toBeNull();
  vi.mocked(isTauri).mockReturnValue(true);
  const desktop = await mount(view, "style");
  expect(desktop.container.textContent).toContain("字幕A.mov");
  await desktop.click("在访达中显示");
  expect(revealItemInDir).toHaveBeenCalledWith("/tmp/叠层/字幕A.mov");
});

it("uses design-system subtitle rows and keeps overlay controls in the left style column", async () => {
  const h = await mount(project);
  expect(h.container.querySelector(".zc-sub-controls.zc-panel-body .zc-card")).not.toBeNull();
  expect(h.container.querySelector(".zc-list .zc-row .time")).not.toBeNull();
  expect(h.container.querySelector(".zc-search input[aria-label='搜索字幕']")).not.toBeNull();
  await h.click("样式");
  expect(h.container.querySelector(".zc-sub-controls [aria-label='叠层导出']")).not.toBeNull();
  expect(h.container.querySelector(".zc-sub-parameters [aria-label='叠层导出']")).toBeNull();
  expect(h.container.querySelector(".zc-sub-parameters .zc-tab.is-active")?.textContent).toBe("样式");
  await h.click("导出字幕叠层");
  expect(h.state().export).toMatchObject({ open: true, sub: "overlays" });
});

it("fills an empty AI input without leading blank lines", async () => {
  const h = await mount(listProject, "subtitles", () => ({}), false, true);
  await h.click("AI 重新分行");
  expect(h.find<HTMLTextAreaElement>("发给 AI").value).toBe("把全部字幕按意思重新分行。");
  expect(h.call).not.toHaveBeenCalled();
});

it("shows real proofreading counts, an empty terms hint, and adds a subtitle track through edit", async () => {
  const h = await mount({
    ...project,
    tracks: [
      ...project.tracks,
      { id: "trk_a", name: "声音 A", kind: "audio", enabled: true, clips: [] },
      { id: "trk_v", name: "视频 A", kind: "video", enabled: true, clips: [] },
    ],
    recognition: { language: "zh", terms: [] },
    subtitlePass: {
      running: true,
      phase: "proofread",
      warnings: [],
      progress: [{ transcript_id: "tra_1", done: 4, total: 6, phase: "proofread" }],
    },
  });
  const stages = h.container.querySelector('[aria-label="字幕整理进度"]');
  expect(stages?.textContent).toBe("概要分行校对 4/6");
  expect(stages?.children[2]?.className).toBe("is-active");
  expect(h.find("专有名词").textContent).toContain("添加人名、品牌或行业术语");
  await h.click("样式");
  expect(h.container.querySelector(".zc-sub-controls h3")?.textContent).toBe("字幕轨");
  await h.click("添加字幕轨");
  expect(h.call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      base_revision: "rev_1",
      ops: [{ op: "add_subtitle_track", language: "zh", carrier_tracks: ["trk_a"], default_style_id: "sty_1" }],
    }),
  );
  expect(h.container.querySelectorAll(".zc-sub-apply button")).toHaveLength(2);
  expect(h.container.querySelector('.zc-sub-apply button[aria-pressed="true"]')?.textContent).toBe("全部");
});

it("renders the current subtitle at zero seconds while paused in the timeline viewer", async () => {
  const h = await mount(
    { ...project, cues: [{ ...cue, start: "0s", text: "以前要花两天的时" }] },
    "subtitles",
    () => ({}),
    true,
  );
  expect(h.state().playing).toBe(false);
  expect(h.container.querySelector(".zc-picture .zc-subtitle-canvas")?.getAttribute("aria-label")).toBe(
    "以前要花两天的时",
  );
});

it.each([1080, 2160, 180])("displays pixel font sizes at timeline height %s and writes fractions", async (height) => {
  vi.useFakeTimers();
  const h = await mount({ ...project, format: { width: 1920, height } }, "style");
  expect(h.find<HTMLInputElement>("字号").value).toBe(String(Math.round(0.045 * height)));
  expect(h.find("字号").title).toBe("字号（px）");
  await h.input("字号", String(height / 10));
  await h.blur("字号");
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", font_size: 0.1 }]);
});

it.each([
  ["描边 1 宽度", "3", "5", { outlines: [{ color: "#000000", width: 0.1 }] }],
  ["阴影模糊", "5", "10", { shadow: { color: "#00000099", blur: 0.2, distance: 0.2, angle: 90 } }],
  ["阴影距离", "10", "15", { shadow: { color: "#00000099", blur: 0.1, distance: 0.3, angle: 90 } }],
  ["发光模糊", "10", "15", { glow: { color: "#FFFFFF", blur: 0.3 } }],
  ["内边距", "10", "15", { box: { color: "#00000099", padding: 0.3, radius: 0.1 } }],
  ["圆角", "5", "10", { box: { color: "#00000099", padding: 0.2, radius: 0.2 } }],
  ["字间距", "5", "10", { letter_spacing: 0.2 }],
  ["上下边距", "80", "100", { position: { ...defaultStyle.position, margin_v: 0.1 } }],
  ["水平位置", "0", "100", { position: { ...defaultStyle.position, offset_x: 0.05 } }],
  ["最大宽度", "80", "70", { position: { ...defaultStyle.position, max_width: 0.7 } }],
] as const)("edits %s in readable units without changing the storage contract", async (label, shown, input, patch) => {
  vi.useFakeTimers();
  const h = await mount(
    {
      ...project,
      format: { width: 2000, height: 1000 },
      styles: [
        {
          ...defaultStyle,
          id: "sty_1",
          font_size: 0.05,
          outline: { color: "#000000", width: 0.06 },
          shadow: { color: "#00000099", blur: 0.1, distance: 0.2, angle: 90 },
          glow: { color: "#FFFFFF", blur: 0.2 },
          box: { color: "#00000099", padding: 0.2, radius: 0.1 },
          letter_spacing: 0.1,
        },
      ],
    },
    "style",
  );
  const control = `${label}数值`;
  expect(h.find<HTMLInputElement>(control).value).toBe(shown);
  expect(h.find(control).title).toBe(`${label}（${label === "最大宽度" ? "%" : "px"}）`);
  await h.input(control, input);
  await h.blur(control);
  await h.settle();
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", ...patch }]);
});

it("keeps preset captions below their samples, current fonts visible and track buttons in one row", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("packages/desktop/src/subtitles.css", "utf8");
  document.head.append(style);
  cleanups.push(async () => style.remove());
  const h = await mount(project, "style");
  const tracks = h.find("字幕样式轨道");
  expect(getComputedStyle(tracks).flexDirection).toBe("row");
  expect(getComputedStyle(tracks).flexWrap).toBe("nowrap");
  expect(h.find("添加字幕轨").parentElement).toBe(tracks);
  const cell = h.container.querySelector<HTMLElement>(".zc-sub-preset-cell");
  if (!cell) throw new Error("Missing preset cell");
  expect([...cell.children].map((child) => child.tagName)).toEqual(["CANVAS", "SPAN"]);
  expect(getComputedStyle(cell).display).toBe("grid");
  expect(getComputedStyle(cell.lastElementChild as HTMLElement).position).toBe("static");
  expect(h.find("应用到").querySelector("select, svg")).toBeNull();
  const font = h.find<HTMLSelectElement>("字体族");
  expect(font.value).toBe("PingFang SC");
  expect(font.selectedOptions[0]?.textContent).toBe("苹方");
  const selectRule = [...(style.sheet?.cssRules ?? [])].find(
    (rule) => rule instanceof CSSStyleRule && rule.selectorText === ".zc-sub-font-row .zc-sub-select",
  ) as CSSStyleRule;
  expect(selectRule.style.getPropertyValue("font-size")).toBe("var(--label-size)");
  await h.view({ ...project, styles: [{ ...defaultStyle, id: "sty_1", font_family: "Custom Font" }] });
  expect(font.value).toBe("Custom Font");
  expect(font.selectedOptions[0]?.textContent).toBe("Custom Font");
  expect(h.find<HTMLInputElement>("其他字体").value).toBe("Custom Font");
});
