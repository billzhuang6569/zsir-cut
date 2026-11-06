// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mergeKeymap } from "../../app-host/src/keymap.js";
import { App } from "../src/App.js";
import { useChapterPanel } from "../src/ChapterPanel.js";
import { type ChaptersView, chapterMarkdown, chapterTime } from "../src/chapters.js";
import type { ProjectView } from "../src/connection.js";
import * as connection from "../src/connection.js";
import type { UiState } from "../src/state.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";

const markers: ProjectView["markers"] = [
  { id: "second", kind: "chapter", at: { t: "20s" }, text: "第二章", level: 1 },
  { id: "section", kind: "chapter", at: { t: "1001/100s" }, text: "细节", level: 2 },
  { id: "orphan", kind: "chapter", at: { t: "0s" }, text: "开场小节", level: 2 },
  { id: "note", kind: "review", at: { t: "5s" }, text: "检查" },
  { id: "first", kind: "chapter", at: { t: "5s" }, text: "第一章" },
];
const row = (
  id: string | null,
  title: string | null,
  start: string,
  end: string,
  duration: string,
  level: number,
  hue: number,
) => ({
  id,
  title,
  start: { t: start },
  end: { t: end },
  duration: { t: duration },
  level,
  hue,
  description: `描述：${title}`,
  user_edited: false,
});
const chapters: ChaptersView = {
  total: { t: "60s" },
  chapters: [
    { ...row(null, null, "0s", "5s", "5s", 1, 0), sections: [row("orphan", "开场小节", "0s", "5s", "5s", 2, 0)] },
    {
      ...row("first", "第一章", "5s", "20s", "15s", 1, 1),
      sections: [row("section", "细节", "1001/100s", "20s", "999/100s", 2, 1)],
    },
    {
      ...row("second", "第二章", "20s", "60s", "40s", 1, 2),
      sections: [
        row("s21", "第二章第一节", "20s", "30s", "10s", 2, 2),
        row("s22", "第二章第二节", "30s", "60s", "30s", 2, 2),
      ],
    },
  ],
};
const flat = chapters.chapters.flatMap((g) => [...(g.id ? [g] : []), ...g.sections]);
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

it("copies exact Markdown with relative timestamps, hour rollover and level filtering", () => {
  expect(chapterMarkdown(flat)).toBe(
    "  - 0:00 开场小节\n0:05 第一章\n  - 0:10 细节\n0:20 第二章\n  - 0:20 第二章第一节\n  - 0:30 第二章第二节",
  );
  expect(chapterMarkdown(flat.filter((m) => m.level === 1))).toBe("0:05 第一章\n0:20 第二章");
  expect(chapterTime("3599999/1000s")).toBe("59:59");
  expect(chapterTime("3600s")).toBe("1:00:00");
  expect(chapterTime("3661001/1000s")).toBe("1:01:01");
});
async function mount(
  view = project,
  timeline = false,
  saved = { view: "outline" as "outline" | "timeline", zoom: 1, folded: [] as string[] },
  snap = true,
) {
  let data = structuredClone(chapters);
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "inspect") return data;
    if (verb === "prefs_get") return { prefs: { ui: { chapters: saved, snap } }, ...mergeKeymap("fcp", {}) };
    if (verb === "prefs_set") {
      const patch = (request.patch as { ui: { chapters?: unknown; snap?: boolean } }).ui;
      Object.assign(saved, patch.chapters);
      if (patch.snap !== undefined) snap = patch.snap;
      return {};
    }
    if (verb === "ui_seek") {
      updateState({ ...state, playhead: { at: request.at as string }, preview: "timeline", playing: false });
    }
    return {};
  });
  let updateState: (state: UiState) => void = () => {};
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
    const dragging = useRef(false);
    const [ui, update] = useState(state);
    state = ui;
    updateState = update;
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
            dragging={dragging}
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
  return {
    container,
    call,
    click,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    state: () => state,
    setSnap: async (snap: boolean) => {
      await act(async () => updateState({ ...state, snap }));
    },
    saved,
    refresh: async (next: ChaptersView) => {
      data = next;
      view = { ...view };
      await render();
    },
  };
}
it("renders sequence timecodes, highlights the current section, seeks and exposes settings through ui_state", async () => {
  const ui = await mount();
  expect(ui.container.querySelector('[aria-current="location"]')?.textContent).toBe("第一章");
  expect(ui.container.querySelector("time")?.textContent).toBe("0:00 – 0:05 · 0:05");
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
  expect(applyUi(ui.state(), "ui_state", {}).chapters).toMatchObject({ levels: 1, timecodes: false, view: "outline" });
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
  await ui.click("复制为 Markdown");
  expect(writeText).toHaveBeenCalledWith(chapterMarkdown(flat));
  expect(ui.container.textContent).toContain("已复制");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  expect(ui.container.textContent).toContain("复制为 Markdown");
  writeText.mockRejectedValueOnce(new Error("denied"));
  await ui.click("复制为 Markdown");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("复制失败");
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
    expect(generate?.classList.contains("zc-btn-secondary")).toBe(true);
    if (!available) {
      expect(generate?.title).toContain("暂无可用的 Agent");
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

it("renders the host ranges and titles in both views and refreshes both after a rename", async () => {
  const ui = await mount();
  expect(ui.call).toHaveBeenCalledWith("inspect", {
    project: "/工程.zcut.json",
    timeline_id: "tl_main",
    view: "chapters",
  });
  expect(ui.container.querySelectorAll(".zc-chapter-title")).toHaveLength(flat.length);
  expect(ui.container.querySelectorAll(".zc-chapter-group")).toHaveLength(chapters.chapters.length);
  const renamed = structuredClone(chapters);
  if (renamed.chapters[1]) renamed.chapters[1].title = "改过的标题";
  await ui.refresh(renamed);
  expect(ui.container.textContent).toContain("改过的标题");
  await ui.click("时间轴");
  expect(ui.state().chapters?.view).toBe("timeline");
  const labels = [...ui.container.querySelectorAll(".zc-chap-label")];
  expect(labels).toHaveLength(flat.length);
  expect(labels.map((node) => node.querySelector("strong")?.textContent)).toEqual(
    flat.map((m) => (m.id === "first" ? "改过的标题" : m.title)),
  );
  for (const [index, node] of labels.entries()) {
    const m = flat[index];
    if (!m) throw new Error("missing chapter");
    expect(node.textContent).toContain(
      `${chapterTime(m.start.t)} – ${chapterTime(m.end.t)} · ${chapterTime(m.duration.t)}`,
    );
  }
  const block = ui.container.querySelector<HTMLButtonElement>('.zc-chap-block[aria-label="第二章第二节"]');
  await act(async () => block?.click());
  expect(ui.call).toHaveBeenLastCalledWith("ui_seek", { at: "30s" });
  await ui.click("第二章第二节");
  expect(ui.call).toHaveBeenLastCalledWith("ui_seek", { at: "30s" });
  expect(applyUi(ui.state(), "ui_show_panel", { panel: "chapters", sub: "outline" }).chapters?.view).toBe("outline");
});

it("persists folds and restores them together with view and zoom after remount", async () => {
  const saved = { view: "outline" as "outline" | "timeline", zoom: 2, folded: [] as string[] };
  const ui = await mount(project, false, saved);
  await ui.click("折叠：第一章");
  await ui.click("折叠：第二章");
  expect(saved.folded).toEqual(["first", "second"]);
  await ui.unmount();
  const restored = await mount(project, false, saved);
  expect(restored.container.querySelectorAll('.zc-chapter-fold[aria-expanded="false"]')).toHaveLength(2);
  expect(restored.container.querySelectorAll(".is-section")).toHaveLength(1);
  await restored.click("全部展开");
  expect(saved.folded).toEqual([]);
  await restored.click("时间轴");
  await restored.unmount();
  const reopened = await mount(project, false, saved);
  expect(reopened.container.querySelector<HTMLInputElement>('[aria-label="章节时间轴缩放"]')?.value).toBe("2");
  expect(reopened.state().chapters?.view).toBe("timeline");
});

it.each([
  [true, false, "30s"],
  [false, false, "301/10s"],
  [true, true, "301/10s"],
])("scrubs with shared snapping=%s and Cmd=%s", async (snap, metaKey, target) => {
  const ui = await mount(project, false, { view: "timeline", zoom: 1, folded: [] }, snap);
  // Click 0.1 seconds beyond section 2 using its rendered pixel position.
  await act(async () =>
    ui.container.querySelector('[aria-label="章节播放头"]')?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientY:
          Number.parseFloat(
            ui.container.querySelector<HTMLElement>('.zc-chap-block[aria-label="第二章第二节"]')?.style.top ?? "0",
          ) *
          (30.1 / 30),
        metaKey,
      }),
    ),
  );
  expect(ui.call).toHaveBeenLastCalledWith("ui_seek", { at: target });
});

it("keeps chapter grouping and end-time derivation out of the UI", () => {
  const helper = readFileSync("packages/desktop/src/chapters.ts", "utf8");
  const panel = readFileSync("packages/desktop/src/ChapterPanel.tsx", "utf8");
  expect(helper + panel).not.toMatch(/chapterGroups|project\??\.markers|\.sort\(|\bsub\(/);
  expect(panel).toContain('view: "chapters"');
  expect(panel).toContain("m.end.t");
  expect(panel).toContain("m.duration.t");
});

it("routes chapter seeks through the same UI verb handler as host requests", async () => {
  const send = vi.fn();
  class Socket {
    send = send;
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  const ui = vi.fn((verb, request) => applyUi(initialState(), verb, request));
  const host = connection.connectHost(
    { port: 1, token: "test" },
    { ui, project: vi.fn(), icon: vi.fn(), error: vi.fn() },
  );
  expect(await host.call("ui_seek", { at: "30s" })).toMatchObject({ playhead: { at: "30s" } });
  expect(ui).toHaveBeenCalledExactlyOnceWith("ui_seek", { at: "30s" });
  expect(send).not.toHaveBeenCalled();
  host();
});

it("shares toolbar, keyboard and chapter state snap changes immediately with chapter scrubbing", async () => {
  const ui = await mount(project, true);
  await ui.click("时间轴");
  const scrub = async (snap: boolean) => {
    expect(ui.state().snap).toBe(snap);
    expect(ui.container.querySelector('[aria-label="吸附"]')?.getAttribute("aria-pressed")).toBe(String(snap));
    const start = Number.parseFloat(
      ui.container.querySelector<HTMLElement>('.zc-chap-block[aria-label="第二章第二节"]')?.style.top ?? "0",
    );
    await act(async () =>
      ui.container
        .querySelector('[aria-label="章节播放头"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: start * (30.1 / 30) })),
    );
    expect(ui.call).toHaveBeenLastCalledWith("ui_seek", { at: snap ? "30s" : "301/10s" });
  };
  await ui.click("吸附");
  expect(ui.call).toHaveBeenCalledWith("prefs_set", { patch: { ui: { snap: false } } });
  await scrub(false);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })));
  expect(ui.call).toHaveBeenCalledWith("prefs_set", { patch: { ui: { snap: true } } });
  await scrub(true);
  await ui.setSnap(false);
  await scrub(false);
});

it("uses compact chapter controls, a single summary header and semantic outline markers", async () => {
  const ui = await mount();
  expect(ui.container.querySelector(".zc-chapter-controls h3")?.textContent).toBe("视图");
  expect(ui.container.querySelectorAll(".zc-chapter-views.zc-seg button .zc-icon")).toHaveLength(2);
  expect(ui.container.querySelector(".zc-chapter-views .is-active")?.textContent).toBe("大纲");
  expect(ui.container.querySelector("select.zc-select")).not.toBeNull();
  expect(ui.container.querySelector(".zc-switch.is-on")?.getAttribute("role")).toBe("switch");
  expect(ui.container.querySelector(".zc-chapter-generation .zc-btn-secondary")?.textContent).toBe("让 AI 重新分章");
  expect(ui.container.querySelector(".zc-chapter-generation .zc-btn-text")?.textContent).toBe("复制为 Markdown");
  const header = ui.container.querySelector(".zc-chapter-header");
  expect(header?.querySelector("h2")?.textContent).toBe("章节大纲");
  expect(header?.querySelector(".zc-meta")?.textContent).toBe("2 章 · 01:00");
  expect(header?.querySelector('[aria-label="在播放头加一节"]')).not.toBeNull();
  expect(ui.container.querySelector(".zc-chapter-stats, .zc-chapter-hash")).toBeNull();
  expect(ui.container.querySelectorAll(".zc-chapter-mark")).toHaveLength(2);
  expect(ui.container.querySelector(".zc-chapter-group.is-current")?.getAttribute("aria-label")).toBe("第一章");
  const row = ui.container.querySelector(".zc-chapter-row:not(.is-section)");
  expect(row?.firstElementChild?.tagName).toBe("TIME");
  expect(ui.container.querySelector(".is-section .zc-chapter-fold .zc-icon")).not.toBeNull();
  await ui.click("时间轴");
  expect(header?.querySelector("h2")?.textContent).toBe("章节时间轴");
  const railHeader = ui.container.querySelector(".zc-chapter-rail-header");
  expect(railHeader?.querySelector(".zc-seg .is-active")?.textContent).toBe("二级");
  expect(railHeader?.querySelector('[aria-label="章节时间轴缩放"]')).not.toBeNull();
  expect(ui.container.querySelector(".zc-chap-block.is-section.shade-1")).not.toBeNull();
});
