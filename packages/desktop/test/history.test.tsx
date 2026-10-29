// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "../src/connection.js";
import { type HistoryEntry, useHistoryPanel } from "../src/HistoryPanel.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const project: ProjectView = {
  id: "tl_main",
  name: "工程",
  revision: { id: "rev_30", seq: 30 },
  edit_rate: "25",
  start_timecode: "00:00:00:00",
  drop_frame: false,
  duration: { t: "60s" },
  tracks: [],
  media: [],
  cues: [],
  styles: [],
  markers: [],
};
const entry = (seq: number, batch: HistoryEntry["batch"] = null): HistoryEntry => ({
  revision: `rev_${seq}`,
  seq,
  at: new Date().toISOString(),
  kind: "write",
  label: `修改 ${seq}`,
  author: { kind: batch ? "agent" : "human", name: "作者" },
  batch,
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(
  options: { batch?: boolean; queued?: boolean; longBatch?: boolean; open?: boolean; failPreview?: boolean } = {},
) {
  let currentProject = options.queued ? { ...project, historyBatches: ["bat_queued"] } : project;
  let state: UiState = {
    ...initialState(),
    project: "/工程.json",
    panel: "subtitles",
    sub: "style",
    history: { open: true, revision: null, label: null },
  };
  let batchOpen = options.open === true;
  const entries = options.batch
    ? [entry(30, { id: "bat_a", seq: 2, count: 3 }), entry(29, { id: "bat_a", seq: 1, count: 3 }), entry(28)]
    : Array.from({ length: 30 }, (_, i) =>
        entry(30 - i, options.longBatch ? { id: "bat_long", seq: 30 - i, count: 30 } : null),
      );
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "inspect" && request.view === "history") {
      const before = request.before ? entries.findIndex((e) => e.revision === request.before) + 1 : 0;
      return { entries: entries.slice(before, before + Number(request.limit)) };
    }
    if (verb === "batch_status")
      return { state: batchOpen ? "open" : "complete", applied: options.queued ? [] : [1, 2], count: 3 };
    if (options.failPreview && request.at_revision) throw new Error("快照不可用");
    if (verb === "inspect") return { ...project, duration: { t: "10s" } };
    if (verb === "preview_data") return { media: [], cues: [], styles: [] };
    if (verb === "restore") {
      entries.unshift({
        ...entry(31),
        kind: "restore",
        label: request.label as string,
        target: request.target as string,
      });
      currentProject = { ...project, revision: { id: "rev_31", seq: 31 } };
    }
    return {};
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let rerender = () => {};
  function Harness() {
    const [ui, update] = useState(state);
    const [, tick] = useState(0);
    rerender = () => tick((n) => n + 1);
    state = ui;
    const history = useHistoryPanel({ project: currentProject, state: ui, update, call });
    return (
      <>
        {state.history?.open && <section aria-label="参数区">{history.panel}</section>}
        <TimelinePreview
          project={history.view}
          state={ui}
          update={update}
          call={call}
          readOnly={history.viewing}
          onHistory={history.toggle}
          historyBanner={history.banner}
          config={undefined}
          error={null}
          dragging={{ current: false }}
        />
      </>
    );
  }
  await act(async () => root.render(<Harness />));
  cleanups.push(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  const click = async (label: string) => {
    const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (n) => n.textContent?.trim() === label || n.getAttribute("aria-label") === label,
    );
    if (!node) throw new Error(`找不到按钮：${label}`);
    await act(async () => node.click());
    return node;
  };
  return {
    container,
    call,
    click,
    state: () => state,
    appendPage: async () => {
      entries.unshift(...Array.from({ length: 30 }, (_, i) => entry(60 - i)));
      currentProject = { ...project, revision: { id: "rev_60", seq: 60 } };
      await act(async () => rerender());
    },
    complete: async () => {
      batchOpen = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    },
    rerender: async () => {
      await act(async () => rerender());
    },
  };
}
it("keeps the paired panel and sub when history opens through a UI verb", () => {
  const state = applyUi({ ...initialState(), panel: "subtitles", sub: "style" }, "ui_show_panel", { panel: "history" });
  expect(state).toMatchObject({ panel: "subtitles", sub: "style", history: { open: true, revision: null } });
});
it("paginates on scroll, previews at_revision read-only and restores with a human label", async () => {
  const ui = await mount();
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(20);
  expect(ui.container.querySelector(".zc-history-step")?.textContent).toContain("现在");
  await ui.click("修改 29刚刚");
  expect(ui.call).toHaveBeenCalledWith("inspect", { project: "/工程.json", view: "timeline", at_revision: "rev_29" });
  expect(ui.call).toHaveBeenCalledWith("preview_data", { project: "/工程.json", at_revision: "rev_29" });
  for (const name of ["切割 B", "加标记 M", "撤销", "重做"])
    expect(ui.container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)?.disabled).toBe(true);
  const writesBefore = ui.call.mock.calls.filter(([verb]) => ["edit", "undo", "redo"].includes(verb)).length;
  await act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
  });
  expect(ui.call.mock.calls.filter(([verb]) => ["edit", "undo", "redo"].includes(verb))).toHaveLength(writesBefore);
  const list = ui.container.querySelector(".zc-history-list");
  await act(async () => list?.dispatchEvent(new Event("scroll")));
  expect(ui.call).toHaveBeenCalledWith("inspect", {
    project: "/工程.json",
    view: "history",
    limit: 20,
    before: "rev_11",
  });
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(30);
  await ui.click("回到这一步");
  expect(ui.call).toHaveBeenCalledWith(
    "restore",
    expect.objectContaining({
      project: "/工程.json",
      target: "rev_29",
      base_revision: "rev_30",
      label: "回到：修改 29",
      author: { kind: "human", name: "桌面用户" },
      idempotency_key: expect.any(String),
    }),
  );
  expect(ui.state().history?.revision).toBeNull();
  await ui.rerender();
  expect(ui.container.querySelector(".zc-history-step")?.textContent).toContain("回到了 修改 29");
  expect(ui.container.querySelector(".zc-history-banner")).toBeNull();
});
it("collapses batches, shows progress, blocks restore until completion and preserves the original panel", async () => {
  vi.useFakeTimers();
  const ui = await mount({ batch: true, open: true });
  expect(ui.container.textContent).toContain("AI 正在做第 3 / 3 步");
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(1);
  await ui.click("修改 293 步");
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(3);
  await ui.click("修改 29刚刚");
  expect(ui.container.querySelector<HTMLButtonElement>(".zc-history-banner button")?.disabled).toBe(true);
  expect(ui.container.textContent).toContain("AI 批次尚未完成");
  await ui.complete();
  expect(ui.container.textContent).not.toContain("AI 正在做第");
  expect(ui.container.querySelector<HTMLButtonElement>(".zc-history-banner button")?.disabled).toBe(false);
  await ui.click("返回现在");
  expect(ui.state()).toMatchObject({ panel: "subtitles", sub: "style", history: { open: true, revision: null } });
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(ui.container.querySelector('[aria-label="参数区"]')).toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", metaKey: true }));
  });
  expect(ui.container.querySelector('[aria-label="参数区"]')).not.toBeNull();
  await ui.click("历史 ⌘ Y");
  expect(ui.state().history?.open).toBe(false);
});
it("keeps failed historical previews read-only and offers return to present", async () => {
  const ui = await mount({ failPreview: true });
  await ui.click("修改 29刚刚");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("历史预览读取失败");
  expect(ui.container.querySelector<HTMLButtonElement>(".zc-history-banner button")?.disabled).toBe(true);
  await ui.click("返回现在");
  expect(ui.state().history?.revision).toBeNull();
});

it("loads the beginning of a batch across pages before naming its collapsed group", async () => {
  const ui = await mount({ longBatch: true });
  expect(ui.call).toHaveBeenCalledWith("inspect", {
    project: "/工程.json",
    view: "history",
    limit: 20,
    before: "rev_11",
  });
  expect(ui.container.querySelector(".zc-history-list [aria-expanded]")?.textContent).toBe("修改 130 步");
  await ui.click("修改 130 步");
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(30);
});

it("catches up without gaps when more than a page is written between refreshes", async () => {
  const ui = await mount();
  await ui.appendPage();
  expect(ui.call).toHaveBeenCalledWith("inspect", {
    project: "/工程.json",
    view: "history",
    limit: 20,
    before: "rev_41",
  });
  expect(ui.container.querySelectorAll(".zc-history-step")).toHaveLength(50);
  expect(ui.container.querySelector(".zc-history-step")?.textContent).toContain("修改 60");
});

it("shows a queued batch even before it has written a history entry", async () => {
  const ui = await mount({ queued: true, open: true });
  expect(ui.call).toHaveBeenCalledWith("batch_status", { project: "/工程.json", batch_id: "bat_queued" });
  expect(ui.container.textContent).toContain("AI 正在做第 1 / 3 步");
  await ui.click("修改 29刚刚");
  expect(ui.container.querySelector<HTMLButtonElement>(".zc-history-banner button")?.disabled).toBe(true);
});
