// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import { renderSubtitle as exportRenderer } from "../../exporters/src/subtitle-render.ts";
import type { ProjectView } from "../src/connection.js";
import { renderSubtitle, SubtitleCanvas } from "../src/SubtitleCanvas.js";
import { useSubtitlePanel } from "../src/SubtitlePanel.js";
import { initialState } from "../src/state.js";
import { alignment, defaultStyle, textEdit } from "../src/subtitles.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { recordingCanvas } from "./canvas.js";

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
});
async function mount(
  view = project,
  sub = "subtitles",
  responder: (verb: string, request: Record<string, unknown>) => unknown = () => ({}),
) {
  let state: UiState = { ...initialState(), project: "/示例.zcut.json", panel: "subtitles", sub };
  const call = vi.fn(async (verb: string, request: Record<string, unknown>) => responder(verb, request));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [ui, update] = useState(state);
    state = ui;
    const panel = useSubtitlePanel({ project: view, state: ui, update, call });
    return (
      <>
        {panel.controls}
        {panel.parameters}
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
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent === label,
    );
    if (!button) throw new Error(label);
    await act(async () => button.click());
  };
  const input = async (label: string, value: string) => {
    const element = find<HTMLInputElement | HTMLTextAreaElement>(label);
    await act(async () => {
      const prototype =
        element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
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
  return { container, call, find, click, input, blur, key, state: () => state };
}
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
it("seeks exactly, navigates rows, edits a minimal token range and cancels", async () => {
  const h = await mount();
  await h.click("你好世界");
  expect(h.state()).toMatchObject({
    selected: ["cue_1"],
    playhead: { at: "1001/1000s" },
    preview: "timeline",
    playing: false,
  });
  const row = h.container.querySelector<HTMLButtonElement>(".zc-sub-text");
  if (!row) throw new Error();
  await h.key(row, "ArrowDown");
  expect(h.state().selected).toEqual(["cue_free"]);
  await h.key(row, "Enter");
  await h.input("编辑字幕", "你好朋友");
  await h.key(h.find("编辑字幕"), "Enter", { metaKey: true });
  expect(h.call.mock.lastCall?.[1]).toMatchObject({
    label: "编辑字幕文字",
    ops: [{ op: "edit_text", transcript_id: "tra_1", from_token: "tok_2", to_token: "tok_2", text: "朋友" }],
  });
  const currentRow = h.container.querySelector<HTMLButtonElement>(".zc-sub-text");
  if (!currentRow) throw new Error();
  await h.key(currentRow, "Enter");
  await h.key(h.find("编辑字幕"), "Escape");
  expect(h.container.querySelector('[aria-label="编辑字幕"]')).toBeNull();
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.container.querySelector(".zc-sub-row > span")?.getAttribute("title")).toBe("字幕显示时间过短");
  expect(h.container.querySelectorAll("time")).toHaveLength(0);
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
  await h.key(row, "Enter");
  await h.input("编辑字幕", "新文字");
  await h.key(h.find("编辑字幕"), "Enter", { metaKey: true });
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
    const mapped = alignment(row, column, 0.8);
    expect(mapped).toEqual({ anchor: ["top", "middle", "bottom"][row], offset_x: ((column - 1) * (1 - 0.8)) / 2 });
    if (row === 2 && column === 1) expect(h.call).not.toHaveBeenCalled();
    else
      expect(h.call.mock.lastCall?.[1]).toMatchObject({
        label: "修改字幕样式",
        ops: [{ op: "update_style", style_id: "sty_1", position: { margin_v: 0.08, max_width: 0.8, ...mapped } }],
      });
  },
);
it("previews slider movement but commits once on release, and applies styles without IDs or version", async () => {
  const h = await mount(project, "style");
  const slider = await h.input("字号", "0.06");
  expect(h.call).not.toHaveBeenCalled();
  await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await h.blur("字号");
  expect(h.call).toHaveBeenCalledTimes(1);
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", font_size: 0.06 }]);
  await h.click("应用到所有字幕");
  const ops = h.call.mock.lastCall?.[1].ops as Record<string, unknown>[];
  expect(ops[0]).toMatchObject({ op: "update_style", style_id: "sty_1", font_size: 0.06 });
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
  await h.key(row, "Enter");
  await h.input("编辑字幕", "覆盖文字");
  await h.key(h.find("编辑字幕"), "Enter", { metaKey: true });
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
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("50%");
    await act(async () => button.click());
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
  expect(h.container.querySelectorAll('[aria-label="水词"] .zc-tag')).toHaveLength(8);
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
it("edits each track default independently of cue overrides and previews only its own cues", async () => {
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
  expect(h.find<HTMLInputElement>("字号").value).toBe("0.045");
  expect(h.container.querySelector(".zc-sub-sample canvas")?.getAttribute("aria-label")).toBe("你好世界");
  await h.click("English");
  expect(h.find<HTMLInputElement>("字号").value).toBe("0.07");
  expect(h.container.querySelector(".zc-sub-sample canvas")?.getAttribute("aria-label")).toBe("English sample");
  expect(h.call).not.toHaveBeenCalled();
  await h.click("黄字");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    expect.objectContaining({ op: "update_style", style_id: "sty_en", color: "#FFD84A" }),
  ]);
});
it("hides single-track selection and renders visual, selectable preset samples", async () => {
  const h = await mount(project, "style");
  expect(h.container.querySelector('[aria-label="字幕样式轨道"]')).toBeNull();
  const presets = h.container.querySelectorAll(".zc-sub-preset");
  expect([...presets].map((p) => p.textContent)).toEqual(["字幕", "字幕", "字幕"]);
  expect(presets[0]?.getAttribute("aria-pressed")).toBe("true");
  await h.click("黑底白字");
  expect(presets[1]?.getAttribute("aria-pressed")).toBe("true");
  expect(presets[0]?.getAttribute("aria-pressed")).toBe("false");
});

it("uses the selected track cue at the playhead and falls back to its first cue in a gap", async () => {
  const h = await mount({
    ...project,
    cues: [cue, { ...cue, cue_id: "later", text: "当前字幕", start: "5s", end: "7s" }],
  });
  await h.click("当前字幕");
  await h.click("样式");
  expect(h.container.querySelector(".zc-sub-sample canvas")?.getAttribute("aria-label")).toBe("当前字幕");
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
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "update_style", style_id: "sty_1", font_family: "Source Han Sans SC" },
  ]);
  await select("字体族", "other");
  expect(h.call).toHaveBeenCalledTimes(1);
  await h.input("其他字体", "Custom Font");
  await h.blur("其他字体");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([
    { op: "update_style", style_id: "sty_1", font_family: "Custom Font" },
  ]);
  await select("字重", "700");
  expect(h.call.mock.lastCall?.[1].ops).toEqual([{ op: "update_style", style_id: "sty_1", font_weight: 700 }]);
});

it("keeps preset samples distinct with the application CSS cascade, including disabled controls", async () => {
  const sheet = document.createElement("style");
  sheet.textContent = ["subtitles.css", "ai.css", "shell.css"]
    .map((name) => readFileSync(`packages/desktop/src/${name}`, "utf8"))
    .join("\n");
  document.head.append(sheet);
  cleanups.push(async () => sheet.remove());
  const h = await mount(project, "style");
  const buttons = [...h.container.querySelectorAll<HTMLButtonElement>(".zc-sub-preset")];
  const samples = buttons.map((button) => button.querySelector("span") as HTMLElement);
  const appearances = samples.map((sample) => {
    const css = getComputedStyle(sample);
    return [css.color, css.backgroundColor];
  });
  expect(appearances.map(([color]) => color)).toEqual([
    "rgb(255, 255, 255)",
    "rgb(255, 255, 255)",
    "rgb(255, 216, 74)",
  ]);
  expect(new Set(appearances.map((appearance) => JSON.stringify(appearance))).size).toBe(3);
  expect(getComputedStyle(samples[1] as HTMLElement).backgroundColor).toBe("rgba(0, 0, 0, 0.8)");
  expect(getComputedStyle(samples[1] as HTMLElement).borderRadius).toBe("4px");
  for (const index of [0, 2]) {
    expect(getComputedStyle(samples[index] as HTMLElement).textShadow).toContain("#000");
    expect(getComputedStyle(samples[index] as HTMLElement).fontWeight).toBe("700");
  }
  for (const [index, button] of buttons.entries()) {
    expect(button.title).toBe(["描边白字", "黑底白字", "黄字"][index]);
    expect(getComputedStyle(button).backgroundColor).toBe("rgb(51, 51, 51)");
  }
  const selected = buttons[0] as HTMLButtonElement;
  expect(getComputedStyle(selected).borderTopWidth).toBe("1px");
  expect(getComputedStyle(selected).borderTopColor).toBe("rgb(221, 221, 221)");
  await h.click("黑底白字");
  expect(getComputedStyle(buttons[1] as HTMLElement).borderTopColor).toBe("rgb(221, 221, 221)");
  expect(getComputedStyle(selected).borderTopColor).toBe("rgba(0, 0, 0, 0)");
  await act(async () => {
    for (const button of buttons) button.disabled = true;
  });
  expect(samples.map((sample) => getComputedStyle(sample).color)).toEqual(appearances.map(([color]) => color));
  for (const button of buttons) expect(getComputedStyle(button).opacity).toBe("1");
});

it("shows subtitle pass progress, failure reason, and retry", async () => {
  const running = await mount({
    ...project,
    subtitlePass: { running: true, warnings: [], progress: [{ transcript_id: "tra_1", done: 1, total: 8 }] },
  });
  expect(running.container.textContent).toContain("AI 整理字幕… 1 / 8");
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
  expect(clips[0]?.textContent).toBe(shown ? cue.text : "");
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
