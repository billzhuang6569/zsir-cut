// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { type AiNotice, useAiPanel } from "../src/AiPanel.js";
import type { PermissionRequest, ProjectView } from "../src/connection.js";
import { initialState } from "../src/state.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const node = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  node.remove();
});
const path = "/project.zcut.json";
const project: ProjectView = {
  id: "tl_a",
  name: "采访",
  start_timecode: "00:00:00:00",
  drop_frame: false,
  styles: [],
  revision: { id: "rev_now", seq: 4 },
  edit_rate: "25",
  duration: { t: "30s" },
  media: [{ id: "med_a", kind: "video", name: "记者机位", duration: "30s" }],
  markers: [{ id: "mrk_a", kind: "comment", text: "开始采访", at: { t: "10s" } }],
  transcripts: [
    {
      id: "transcript_a",
      media_id: "med_a",
      cues: [],
      tokens: [{ id: "tok_a", text: "字幕已改字", heard: "这是原话", align: { start: "9s", end: "10s" } }],
    },
  ],
  cues: [
    { cue_id: "cue_a", start: "10s", end: "12s", text: "字幕已改字", track_id: "trk_sub", style_id: "sty_a", piece: 0 },
  ],
  tracks: [
    {
      id: "trk_a",
      name: "视频 A",
      kind: "video",
      enabled: true,
      clips: [
        {
          id: "clp_a",
          label: "采访开场",
          occurrence_id: "occ_a",
          speed: "1",
          media_id: "med_a",
          enabled: true,
          timeline_in: { t: "10s" },
          timeline_out: { t: "14s" },
          source_in: { t: "8s" },
          source_out: { t: "12s" },
        },
      ],
    },
  ],
};
const turn = { chat: "chat_test", event: { type: "turn", id: "turn_now" } } satisfies AiNotice;
const end = { chat: "chat_test", event: { type: "end" } } satisfies AiNotice;
const idle = [turn, end];
const uiState = {
  ...initialState(),
  selected: ["clp_a"],
  timelineMarks: { in: "10s", out: "14s" },
  playhead: { at: "11s" },
};
const permission: PermissionRequest = {
  type: "permission_request",
  id: "prm_a",
  verb: "export",
  title: "导出成片",
  detail: "写入文件。",
  target: null,
  command: {},
};
type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
function Panel({
  call,
  changes = [],
  revision = 0,
  permissions = [],
  notices = idle,
}: {
  call: Call;
  changes?: ProjectChanged[];
  revision?: number;
  permissions?: PermissionRequest[];
  notices?: AiNotice[];
}) {
  const ai = useAiPanel({
    call,
    path,
    project,
    notices,
    uiState,
    revision: 0,
    decisionRevision: revision,
    turnChanges: changes,
    permissions,
  });
  return (
    <>
      <header>{ai.decisionStatus}</header>
      <section aria-label="进度">{ai.progress}</section>
      <div
        data-clips={[...ai.timelineChanges.clips.keys()].join()}
        data-removals={[...ai.timelineChanges.removals.keys()].join()}
      />
      <main>{ai.chat}</main>
      <aside>{ai.parameters}</aside>
    </>
  );
}
function button(label: string, container: ParentNode = node) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function region(label: string) {
  const found = node.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing region: ${label}`);
  return found;
}
async function render(props: Parameters<typeof Panel>[0]) {
  await act(async () => root?.render(<Panel {...props} />));
}
function mount() {
  document.body.append(node);
  root = createRoot(node);
}
const click = async (target: HTMLButtonElement) => act(async () => target.click());
const change: ProjectChanged = {
  type: "project_changed",
  target: "main",
  session_id: null,
  revision: { id: "rev_live", seq: 3 },
  turn: "turn_now",
  verb: "edit",
  label: "剪短开头",
  reason: "先进入主题",
  author: { kind: "agent", name: "Claude" },
  batch: null,
  summary: {},
  truncated: false,
  changes: [{ key: "clp_a", entity: "clip", before: null, after: { track_id: "trk_a", start: "10s", end: "14s" } }],
};
const callHost = (extra: Call) =>
  vi.fn(async (verb: string, request: Record<string, unknown>) => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true, version: null }];
    if (verb === "chat_list") return [];
    if (verb === "chat_send") return { id: "chat_test" };
    return extra(verb, request);
  });

it("adds each live turn step, folds previous turns, jumps and selects, and reports undo conflict or success", async () => {
  mount();
  let conflict = true;
  const call = callHost(async (verb, request) => {
    if (verb === "inspect" && request.view === "history")
      return {
        entries: [{ revision: "rev_old", seq: 2, turn: { id: "turn_previous" }, label: "较早的剪辑", changes: [] }],
      };
    if (verb === "undo" && conflict)
      throw Object.assign(new Error("冲突"), {
        code: "E_UNDO_CONFLICT",
        details: { keys: ["clp_a"] },
      });
    return {};
  });
  await render({ call });
  const activity = region("本轮改动");
  expect(activity.textContent).toContain("本轮暂无改动");
  expect(activity.querySelector("details")?.open).toBe(false);
  expect(activity.querySelector("summary")?.textContent).toContain("较早的剪辑");
  await render({ call, changes: [change] });
  await render({ call, changes: [change, { ...change, label: "调整句尾", revision: { id: "rev_second", seq: 4 } }] });
  expect(activity.textContent).toContain("调整句尾");
  expect(activity.textContent).toContain("Claude");
  expect(activity.textContent).toContain("先进入主题");
  await click(button("剪短开头", activity));
  expect(call).toHaveBeenCalledWith("ui_seek", { at: "10s" });
  expect(call).toHaveBeenCalledWith("ui_select", { ids: ["clp_a"], keepParameters: true });
  await click(button("撤回这一轮", activity));
  expect(call).toHaveBeenCalledWith("undo", expect.objectContaining({ turn_id: "turn_now", base_revision: "rev_now" }));
  expect(activity.querySelector('[role="alert"]')?.textContent).toContain("这几处你后来改过采访开场");
  conflict = false;
  await click(button("撤回这一轮", activity));
  expect(activity.querySelector("output")?.textContent).toBe("已撤回");
});

it("refreshes decisions, auditions a source anchor, and answers each card while AI is generating", async () => {
  mount();
  const decisions = ["applied", "stale", "failed", "none"].map((id, seq) => ({
    id,
    seq,
    state: "pending",
    question: `问题 ${id}`,
    refs:
      id === "applied"
        ? [
            {
              kind: "source",
              occurrence_id: "occ_a",
              media_id: "med_a",
              source_start: { t: "9s", tc: "00:00:09:00" },
              duration: { t: "2s" },
            },
          ]
        : [],
    options: [
      { id: "alternative", label: "备选" },
      { id: "recommended", label: "保留", recommended: true, note: "保持原意" },
    ],
  }));
  let ready = false;
  const call = callHost(async (verb, request) => {
    if (verb === "ai_state") return { sessions: [], batches: [] };
    if (verb === "inspect") return request.view === "history" ? { entries: [] } : { decisions: ready ? decisions : [] };
    if (verb === "answer") {
      const decision = decisions.find(({ id }) => id === request.decision_id);
      const result = {
        decision: {
          ...decision,
          state: "answered",
          execution: {
            state: decision?.id,
            error: decision?.id === "failed" ? { message: "片段已锁定" } : null,
          },
        },
      };
      if (decision?.id === "failed") throw Object.assign(new Error("failed"), { result });
      return result;
    }
    return {};
  });
  await render({ call });
  expect(node.querySelector('section[aria-label="方案"]')).toBeNull();
  ready = true;
  await render({ call, revision: 1, permissions: [permission] });
  expect(node.querySelector("header")?.textContent).toBe("5 件待定");
  expect(region("许可").textContent).toContain("许可 · 1");
  expect(region("许可").textContent).toContain("导出成片");
  expect(region("待你决定").textContent).not.toContain("导出成片");
  expect(region("待你决定").compareDocumentPosition(region("许可")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const applied = region("问题 applied");
  expect(applied.querySelector(".zc-q-option")?.textContent).toBe("保留 · 推荐保持原意");
  expect(applied.textContent).toContain("这是原话");
  expect(applied.textContent).not.toContain("字幕已改字");
  await click(button("源素材 00:00:09:00", applied));
  expect(call).toHaveBeenCalledWith("ui_play", { range: { start: "11s", duration: "2s" } });
  const other = region("问题 none");
  await click(button("稍后", other));
  expect(other.querySelector("input")).toBeNull();
  expect(call.mock.calls.filter(([verb]) => verb === "answer")).toHaveLength(0);
  expect(node.querySelector("header")?.textContent).toBe("5 件待定");
  await click(button("继续回答", other));

  const composer = node.querySelector<HTMLTextAreaElement>("textarea");
  if (!composer) throw new Error("missing composer");
  const type = async (input: HTMLTextAreaElement | HTMLInputElement, value: string) => {
    await act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type(composer, "继续剪");
  await click(button("发送"));
  expect(button("停止")).toBeDefined();

  for (const [state, message] of [
    ["applied", "已按你的选择改好"],
    ["stale", "这一段已经改过，已转给 AI 按最新工程重做"],
    ["failed", "没能改好：片段已锁定"],
  ]) {
    const card = region(`问题 ${state}`);
    await click(button("保留 · 推荐保持原意", card));
    expect(card.querySelector("output")?.textContent).toBe(message);
  }
  const input = other.querySelector("input");
  if (!input) throw new Error("missing other input");
  await type(input, "留下这一句");
  await click(button("提交", other));
  expect(call).toHaveBeenCalledWith("answer", expect.objectContaining({ decision_id: "none", text: "留下这一句" }));
  expect(other.querySelector("output")?.textContent).toBe("已记录你的选择");
  expect(node.querySelector("main")?.textContent).toContain("已回答：问题 none → 留下这一句");
  expect(node.querySelector("main")?.textContent).toContain("已回答：问题 applied → 保留");
  expect(node.querySelector("main")?.textContent).not.toContain("已回答：问题 stale");
  expect(node.querySelector("header")?.textContent).toBe("1 件待定");
  expect(call.mock.calls.filter(([verb]) => verb === "chat_send")).toHaveLength(1);
});

it("shows the current Agent turn, clears highlights on acknowledge, next turn and undo, and reports batch progress", async () => {
  mount();
  const call = callHost(async () => ({}));
  const removed = {
    ...change,
    revision: { id: "rev_removed", seq: 4 },
    batch: { id: "bat_test", seq: 2, count: 5 },
    changes: [{ key: "clp_removed", entity: "clip" as const, before: change.changes[0]?.after ?? null, after: null }],
  };
  const human = {
    ...change,
    revision: { id: "rev_human", seq: 5 },
    author: { kind: "human" as const, name: "剪辑师" },
    changes: [{ ...change.changes[0], entity: "clip" as const, key: "clp_human" }],
  };
  const highlights = () => {
    const result = node.querySelector<HTMLElement>("[data-clips]")?.dataset;
    return [result?.clips, result?.removals];
  };
  const changes = [change, removed, human];
  await render({ call, changes: [human], notices: [turn] });
  expect(highlights()).toEqual(["", ""]);
  expect(region("进度").textContent).toBe("AI 正在剪… 第 1 步");
  await render({ call, changes, notices: [turn] });
  expect(highlights()).toEqual(["clp_a", "clp_removed"]);
  expect(region("进度").textContent).toBe("AI 正在剪… 第 2 / 5 步");
  await render({ call, changes, notices: idle });
  expect(region("进度").textContent).toBe("");
  await click(button("知道了"));
  expect(highlights()).toEqual(["", ""]);

  const next: AiNotice = { chat: "chat_test", event: { type: "turn", id: "turn_next" } };
  const another = { ...change, turn: "turn_next", revision: { id: "rev_next", seq: 6 } };
  await render({ call, changes, notices: [...idle, next] });
  expect(highlights()).toEqual(["", ""]);
  await render({ call, changes: [...changes, another], notices: [...idle, next] });
  expect(highlights()).toEqual(["clp_a", ""]);
  const undo = { ...human, verb: "undo" as const, turn: "turn_next", revision: { id: "rev_undo", seq: 7 } };
  await render({ call, changes: [...changes, another, undo], notices: [...idle, next, end] });
  expect(highlights()).toEqual(["", ""]);
  const third: AiNotice = { chat: "chat_test", event: { type: "turn", id: "turn_third" } };
  await render({ call, changes: [...changes, another], notices: [...idle, next, end, third] });
  expect(highlights()).toEqual(["", ""]);
});

it("searches and inserts references with the keyboard and sends names, timecodes and IDs in place", async () => {
  mount();
  const call = callHost(async () => ({}));
  await render({ call });
  const input = node.querySelector("textarea");
  if (!input) throw new Error("缺少对话输入框");
  const type = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (key: string) =>
    act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const options = () => [...node.querySelectorAll('[role="option"]')].map((item) => item.textContent);
  await type("剪短@");
  expect(options()).toEqual([
    "选中的片段",
    "入出点区间",
    "播放头处",
    "字幕条 · 字幕已改字",
    "标记 · 开始采访",
    "素材 · 记者机位",
  ]);
  await key("ArrowDown");
  expect(node.querySelector('[aria-selected="true"]')?.textContent).toBe("入出点区间");
  await key("ArrowUp");
  await key("Enter");
  expect(button("移除引用：选中的片段")).toBeDefined();
  expect(call.mock.calls.some(([verb]) => verb === "chat_send")).toBe(false);
  await type("剪短，核对@改字");
  expect(options()).toEqual(["字幕条 · 字幕已改字"]);
  await key("Tab");
  await type("剪短，核对，参考@记者");
  expect(options()).toEqual(["素材 · 记者机位"]);
  await key("Escape");
  expect(options()).toEqual([]);
  await type("剪短，核对，参考@机位");
  await key("Enter");
  await key("Enter");
  expect(call).toHaveBeenCalledWith(
    "chat_send",
    expect.objectContaining({
      text: "剪短 @片段 clp_a（视频 A，00:00:10:00–00:00:14:00） ，核对 @字幕条 cue_a（字幕已改字，00:00:10:00–00:00:12:00） ，参考 @素材 med_a（记者机位）",
    }),
  );
});
