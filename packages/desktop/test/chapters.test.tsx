// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import { App } from "../src/App.js";
import { useChapterPanel } from "../src/ChapterPanel.js";
import { chapterGroups, chapterMarkdown, chapterTime } from "../src/chapters.js";
import type { ProjectView } from "../src/connection.js";
import * as connection from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";

const markers: ProjectView["markers"] = [
  { id: "second", kind: "chapter", at: { t: "20s" }, text: "第二章", level: 1 },
  { id: "section", kind: "chapter", at: { t: "1001/100s" }, text: "细节", level: 2 },
  { id: "orphan", kind: "chapter", at: { t: "0s" }, text: "开场小节", level: 2 },
  { id: "note", kind: "review", at: { t: "5s" }, text: "检查" },
  { id: "first", kind: "chapter", at: { t: "5s" }, text: "第一章" },
];
const project: ProjectView = {
  id: "tl_main",
  name: "工程",
  revision: { id: "rev_1", seq: 1 },
  edit_rate: "25",
  start_timecode: "01:00:00:00",
  drop_frame: false,
  duration: { t: "60s" },
  tracks: [],
  media: [],
  cues: [],
  styles: [],
  markers,
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("groups by rational time, retains leading orphan sections and defaults to level one", () => {
  expect(chapterGroups(markers, 2).map((g) => g.map((m) => m.id))).toEqual([
    ["orphan"],
    ["first", "section"],
    ["second"],
  ]);
  expect(chapterGroups(markers, 1).map((g) => g.map((m) => m.id))).toEqual([["first"], ["second"]]);
  expect(markers[0]?.id).toBe("second");
  expect(chapterGroups([], 2)).toEqual([]);
});
it("copies exact Markdown with relative timestamps, hour rollover and level filtering", () => {
  expect(chapterMarkdown(markers, 2)).toBe("  - 0:00 开场小节\n0:05 第一章\n  - 0:10 细节\n0:20 第二章");
  expect(chapterMarkdown(markers, 1)).toBe("0:05 第一章\n0:20 第二章");
  expect(chapterTime("3599999/1000s")).toBe("59:59");
  expect(chapterTime("3600s")).toBe("1:00:00");
  expect(chapterTime("3661001/1000s")).toBe("1:01:01");
});
async function mount(view = project, timeline = false) {
  const call = vi.fn(async (_verb: string, _request: Record<string, unknown>): Promise<unknown> => ({}));
  let state: UiState = {
    ...initialState(),
    project: "/工程.zcut.json",
    panel: "chapters",
    playhead: { at: "12s" },
    preview: "media",
    playing: true,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [ui, update] = useState(state);
    state = ui;
    const panel = useChapterPanel({ project: view, state: ui, update, call, canGenerate: false, generate: vi.fn() });
    return (
      <>
        {panel.controls}
        {panel.outline}
        {timeline && (
          <TimelinePreview
            config={undefined}
            project={view}
            state={ui}
            update={update}
            call={call}
            error={null}
            dragging={{ current: false }}
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
  const click = async (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === text || b.textContent === text,
    );
    if (!button) throw new Error(text);
    await act(async () => button.click());
  };
  const render = async () => {
    await act(async () => root.render(<Harness />));
  };
  return { container, call, click, render, state: () => state };
}
it("renders sequence timecodes, highlights the current section, seeks and exposes settings through ui_state", async () => {
  const ui = await mount();
  expect(ui.container.querySelector('[aria-current="location"]')?.textContent).toBe("细节");
  expect(ui.container.querySelector("time")?.textContent).toBe("01:00:00:00");
  expect(ui.container.querySelector('[aria-label="未归组的小节"]')?.textContent).toContain("开场小节");
  await ui.click("第二章");
  expect(ui.state()).toMatchObject({ playhead: { at: "20s" }, preview: "timeline", playing: false });
  const select = ui.container.querySelector<HTMLSelectElement>("select");
  await act(async () => {
    if (select) {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  expect(ui.container.querySelectorAll(".zc-chapter-title")).toHaveLength(2);
  await act(async () => ui.container.querySelector<HTMLInputElement>('[role="switch"]')?.click());
  expect(ui.container.querySelector("time")).toBeNull();
  expect(applyUi(ui.state(), "ui_state", {}).chapters).toEqual({ levels: 1, timecodes: false });
  expect(applyUi(ui.state(), "ui_show_panel", { panel: "chapters", sub: "outline" })).toMatchObject({
    panel: "chapters",
    sub: "outline",
  });
  expect([...ui.container.querySelectorAll("button:disabled")].map((n) => n.textContent)).toContain("让 AI 重新分章");
});
it("sends rename, level, deletion and frame-aligned insertion ops with human labels", async () => {
  const ui = await mount();
  const title = [...ui.container.querySelectorAll(".zc-chapter-title")].find((n) => n.textContent === "第一章");
  await act(async () => title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const input = ui.container.querySelector<HTMLInputElement>('[aria-label="章节名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "新标题");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "update_marker", marker_id: "first", text: "新标题" }],
      label: "重命名章节「第一章」",
    }),
  );
  const menu = ui.container.querySelectorAll(".zc-chapter-menu")[0];
  await act(async () => menu?.querySelector<HTMLButtonElement>("button")?.click());
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "update_marker", marker_id: "orphan", level: 1 }],
      label: "把章节「开场小节」改为一级标题",
    }),
  );
  await act(async () => menu?.querySelector<HTMLButtonElement>("button:last-child")?.click());
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({ ops: [{ op: "remove_marker", marker_id: "orphan" }], label: "删除章节「开场小节」" }),
  );
  await ui.click("在播放头加一节");
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      project: "/工程.zcut.json",
      timeline_id: "tl_main",
      base_revision: "rev_1",
      author: { kind: "human", name: "桌面用户" },
      idempotency_key: expect.any(String),
      label: "在播放头加一节",
      ops: [{ op: "add_marker", at: "12s", duration: "0s", kind: "chapter", level: 2, text: "新章节" }],
    }),
  );
  ui.call.mockRejectedValueOnce(new Error("med_secret"));
  await ui.click("在播放头加一节");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe("章节修改失败，请检查工程后重试");
});
it("copies the filtered outline and briefly reports success; clipboard failures remain visible", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const ui = await mount();
  await ui.click("复制 Markdown");
  expect(writeText).toHaveBeenCalledWith(chapterMarkdown(markers, 2));
  expect(ui.container.textContent).toContain("已复制");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  expect(ui.container.textContent).toContain("复制 Markdown");
  writeText.mockRejectedValueOnce(new Error("denied"));
  await ui.click("复制 Markdown");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("复制失败");
});
it("reorders after project refresh and sends chapter marker drag through edit", async () => {
  const view = { ...project, markers: structuredClone(markers) };
  const ui = await mount(view, true);
  const marker = ui.container.querySelector<HTMLButtonElement>('.zc-marker[aria-label="第二章"]');
  // jsdom has no PointerEvent implementation.
  await act(async () => marker?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 960 })));
  await act(async () => marker?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 48 })));
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      label: "移动章节「第二章」",
      ops: [{ op: "update_marker", marker_id: "second", at: "1s" }],
    }),
  );
  const moved = view.markers.find((m) => m.id === "second");
  if (moved) moved.at.t = "1s";
  await ui.render();
  expect([...ui.container.querySelectorAll(".zc-chapter-title")].map((n) => n.textContent)).toEqual([
    "开场小节",
    "第二章",
    "第一章",
    "细节",
  ]);
});
it.each([true, false])(
  "handles chapter generation through the existing chat (Agent available: %s)",
  async (available) => {
    let handlers: Parameters<typeof connection.connectHost>[1] | undefined;
    const call = vi.fn(async (verb: string): Promise<unknown> => {
      if (verb === "chat_agents") return [{ agent: "codex", available, version: "test" }];
      if (verb === "ai_state") return { sessions: [], batches: [] };
      if (verb === "chat_list") return [];
      return { id: "chat_1" };
    });
    vi.spyOn(connection, "connectHost").mockImplementation((_config, value) => {
      handlers = value;
      return Object.assign(() => {}, { call });
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanups.push(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    await act(async () => root.render(<App config={{ port: 1, token: "test" }} />));
    await act(async () => handlers?.project("/工程.zcut.json", project));
    await act(async () => container.querySelector<HTMLButtonElement>('[id$="-tab-chapters"]')?.click());
    const generate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (n) => n.textContent === "让 AI 重新分章",
    );
    expect(generate?.disabled).toBe(!available);
    if (!available) {
      expect(call.mock.calls.some(([verb]) => verb === "chat_send")).toBe(false);
      return;
    }
    await act(async () => generate?.click());
    expect(container.querySelector('[id$="-tab-ai"]')?.getAttribute("aria-selected")).toBe("true");
    expect(call).toHaveBeenCalledWith("chat_send", {
      agent: "codex",
      text: "按现在的剪辑和字幕重新分章，一级标题不超过 5 个",
    });
  },
);

it("aligns new sections to NTSC frames without floating point time", async () => {
  const ui = await mount({ ...project, edit_rate: "30000/1001" });
  await ui.click("在播放头加一节");
  expect(ui.call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({ ops: [expect.objectContaining({ at: "359359/30000s" })] }),
  );
});
