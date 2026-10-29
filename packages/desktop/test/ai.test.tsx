// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { type AiNotice, useAiPanel } from "../src/AiPanel.js";
import type { ProjectView } from "../src/connection.js";

function core(verb: string, request: Record<string, unknown>) {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {dispatch} from './packages/core/src/index.ts'; let raw='';for await(const chunk of process.stdin) raw+=chunk; const input=JSON.parse(raw); console.log(JSON.stringify(await dispatch(input.verb,input.request)));`,
    ],
    { input: JSON.stringify({ verb, request }), encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(run.stderr);
  const envelope = JSON.parse(run.stdout);
  if (!envelope.ok) throw new Error(JSON.stringify(envelope));
  return envelope.result;
}
function Harness({
  call,
  path,
  notices = [],
  revision = 0,
  project = null,
  connectionEpoch = 0,
}: {
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  path: string;
  notices?: AiNotice[];
  revision?: number;
  project?: ProjectView | null;
  connectionEpoch?: number;
}) {
  const ai = useAiPanel({ call, path, project, notices, revision, connectionEpoch });
  return (
    <>
      <div>{ai.chat}</div>
      <aside>{ai.parameters}</aside>
    </>
  );
}
function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.includes(label) || node.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function change(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AI panel", () => {
  it("answers three real kernel decisions one at a time and automatically sends the complete summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut37-decisions-"));
    const project = join(directory, "project.zcut.json");
    const raw = JSON.parse(await readFile("examples/interview.zcut.json", "utf8"));
    await writeFile(project, JSON.stringify(raw));
    const base = { project, base_revision: raw.revision.id, author: { kind: "agent", name: "fake-agent" } };
    const begun = core("session_begin", { ...base, idempotency_key: "begin", approval: "manual", intent: "测试决定" });
    core("session_ask", {
      ...base,
      session_id: begun.session_id,
      idempotency_key: "ask",
      decisions: [0, 1, 2].map((index) => ({
        question: `问题 ${index + 1}`,
        options: [{ id: `opt_${index}`, label: `回答 ${index + 1}`, recommended: true }],
        allow_other: true,
      })),
    });
    const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
      if (verb === "chat_agents") return [{ agent: "claude", available: true, version: "fake" }];
      if (verb === "chat_send") return { id: "chat_test" };
      if (verb === "chat_list") return [];
      if (verb === "ai_state")
        return {
          sessions: [
            {
              ...core("inspect", { project, view: "session", session_id: begun.session_id }),
              revision_count: 0,
              changes: [],
            },
          ],
          batches: [],
        };
      return core(verb, request);
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness call={call} path={project} />));
      for (let index = 0; index < 3; index++) {
        expect(container.querySelectorAll(".zc-q")).toHaveLength(1);
        expect(container.querySelector(".zc-q-question")?.textContent).toBe(`问题 ${index + 1}`);
        expect(container.querySelector(".zc-ring")?.getAttribute("aria-label")).toBe(`${index} / 3 已定`);
        if (index === 2) {
          await act(async () => button(container, "跳过").click());
        } else {
          if (index === 1) {
            const input = container.querySelector<HTMLInputElement>('input[aria-label="其他想法"]');
            if (!input) throw new Error("Missing other input");
            await act(() => input.focus());
            await change(input, "保留 **原文** | <回答>");
          } else await act(() => button(container, `回答 ${index + 1}`).click());
          await act(async () => button(container, "下一件").click());
        }
      }
      expect(call.mock.calls.filter(([verb]) => verb === "session_answer")).toHaveLength(3);
      expect(call).toHaveBeenCalledWith("chat_send", {
        agent: "claude",
        text: "- 问题 1 → 回答 1\n- 问题 2 → 保留 **原文** | <回答>\n- 问题 3 → 跳过",
      });
      const sent = call.mock.calls.find(([verb]) => verb === "chat_send")?.[1].text as string;
      await act(async () =>
        root.render(
          <Harness call={call} path={project} notices={[{ chat: "chat_test", event: { type: "user", text: sent } }]} />,
        ),
      );
      expect(container.querySelector(".zc-chat-user p")?.textContent).toBe(sent);
      const style = document.createElement("style");
      style.textContent = await readFile("packages/desktop/src/ai.css", "utf8");
      document.head.append(style);
      try {
        expect(getComputedStyle(container.querySelector(".zc-chat-user") as HTMLElement).whiteSpace).toBe("pre-wrap");
      } finally {
        style.remove();
      }
      expect(core("inspect", { project, view: "session", session_id: begun.session_id }).pending_count).toBe(0);
      const stored = JSON.parse(await readFile(project, "utf8"));
      expect(stored.revision.id).toBe(raw.revision.id);
    } finally {
      await act(() => root.unmount());
      container.remove();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders partial Markdown, collapsible tool rows, references, stop, history, draft approval warning and batches", async () => {
    const requestLog: { verb: string; request: Record<string, unknown> }[] = [];
    const session = {
      session_id: "ses_test",
      state: "in_review",
      draft_revision: "rev_draft",
      decisions: [],
      pending_count: 2,
      revision_count: 1,
      changes: [{ entity: "clip" }, { entity: "cue" }],
    };
    const call = vi.fn(async (verb: string, request: Record<string, unknown>) => {
      requestLog.push({ verb, request });
      if (verb === "chat_agents")
        return [
          { agent: "claude", available: true, version: "fake" },
          { agent: "codex", available: true, version: "fake" },
        ];
      if (verb === "ai_state") return { sessions: [session], batches: [{ state: "open", count: 4, applied: [1] }] };
      if (verb === "chat_send") return { id: "chat_test" };
      if (verb === "chat_list")
        return requestLog.filter((entry) => entry.verb === "chat_list").length === 1
          ? []
          : [{ id: "chat_saved", agent: "codex", title: "过去的对话", updated_at: new Date().toISOString() }];
      if (verb === "chat_history")
        return { events: [{ type: "user", text: "历史问题" }, { type: "text", text: "历史回复" }, { type: "end" }] };
      return {};
    });
    const view = { revision: { id: "rev_main", seq: 1 }, media: [{ id: "med_test", name: "镜头 A" }] } as ProjectView;
    const notices: AiNotice[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
      root.render(<Harness call={call} path="/project.zcut.json" project={view} notices={[...notices]} />);
    try {
      await act(async () => render());
      expect(container.textContent).toContain("AI 正在做第 2 / 4 步");
      expect(
        [...container.querySelectorAll(".zc-draft-counts > span")].map((node) => node.getAttribute("aria-label")),
      ).toEqual(["1 修订", "1 片段", "1 字幕改动"]);
      expect(button(container, "批准").querySelector("svg")).not.toBeNull();
      await act(() => button(container, "批准").click());
      expect(container.textContent).toContain("还有 2 件决定未答");
      expect(requestLog.some((entry) => entry.verb === "session_approve")).toBe(false);
      await act(async () => button(container, "仍然批准").click());
      expect(requestLog.find((entry) => entry.verb === "session_approve")?.request).toMatchObject({
        base_revision: "rev_main",
        author: { kind: "human" },
      });
      const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="发给 AI"]');
      if (!input) throw new Error("input missing");
      await change(input, "@");
      await act(() => button(container, "镜头 A").click());
      expect(input.value).toBe("@[镜头 A](med_test) ");
      await act(() =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })),
      );
      expect(requestLog.some((entry) => entry.verb === "chat_send")).toBe(false);
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(requestLog.find((entry) => entry.verb === "chat_send")?.request.text).toBe("@[镜头 A](med_test) ");
      for (const event of [
        { type: "user", text: "@[镜头 A](med_test)" },
        { type: "text", text: "# 标题\n- **重点**\n```js\n<unsafe>\n```" },
        { type: "tool_start", id: "tool", name: "zcut_inspect", input: { view: "brief" } },
      ] as const)
        notices.push({ chat: "chat_test", event });
      await act(async () => render());
      expect(container.querySelector(".zc-chat-ref")?.textContent).toBe("@[镜头 A]");
      expect(container.querySelector(".zc-markdown strong")?.textContent).toBe("重点");
      expect(container.querySelector(".zc-markdown pre")?.textContent).toBe("<unsafe>");
      expect(container.querySelector("unsafe")).toBeNull();
      expect(container.querySelector(".zc-step.is-live")).not.toBeNull();
      await act(() => button(container, "查看工程").click());
      expect(container.querySelector(".zc-step-detail")?.textContent).toContain("brief");
      await act(async () => button(container, "停止").click());
      expect(call).toHaveBeenCalledWith("chat_stop", {});
      notices.push(
        { chat: "chat_test", event: { type: "tool_end", id: "tool" } },
        { chat: "chat_test", event: { type: "end" } },
      );
      await act(async () => render());
      expect(container.querySelector(".zc-step.is-live")).toBeNull();
      await act(async () => button(container, "历史对话").click());
      await act(async () => button(container, "过去的对话").click());
      expect(container.textContent).toContain("历史回复");
      await act(() => button(container, "新对话").click());
      expect(container.textContent).not.toContain("历史回复");
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });
});

it("saves other answers once with Cmd-Enter and supports skipping", async () => {
  const { DecisionCard } = await import("../src/ai-components.js");
  const answer = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <DecisionCard
          decision={{
            id: "dec_test",
            seq: 1,
            question: "怎么剪？",
            options: [{ id: "opt_a", label: "换机位" }],
            state: "pending",
          }}
          done={0}
          total={1}
          last
          busy={false}
          answer={answer}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('input[aria-label="其他想法"]');
    if (!input) throw new Error("Missing other input");
    await act(() => input.focus());
    await change(input, "保留停顿");
    await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(answer).toHaveBeenCalledExactlyOnceWith({ text: "保留停顿" });
    await act(() => button(container, "跳过").click());
    expect(answer).toHaveBeenLastCalledWith({ skip: true });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it("shows only installation guidance when no local Agent is available", async () => {
  const call = vi.fn(async (verb: string) =>
    verb === "chat_agents"
      ? [
          { agent: "claude", available: false, version: null },
          { agent: "codex", available: false, version: null },
        ]
      : { sessions: [], batches: [] },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness call={call} path="/project.zcut.json" />));
    expect(container.querySelector(".zc-ai-chat")?.textContent).toBe("未检测到本机 Agent。安装说明");
    expect(container.querySelector(".zc-ai-chat a")?.getAttribute("href")).toBe(
      "https://code.claude.com/docs/en/setup",
    );
    expect(container.querySelector(".zc-ai-chat textarea")).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});

it("separates tool-delimited text and merges consecutive failed attempts with full diagnostics", async () => {
  const call = vi.fn(async (verb: string) =>
    verb === "chat_agents" ? [{ agent: "claude", available: true, version: "测试" }] : { sessions: [], batches: [] },
  );
  const events: AiNotice["event"][] = [{ type: "text", text: "第一段" }];
  for (let i = 0; i < 3; i++)
    events.push(
      { type: "tool_start", id: String(i), name: "mcp__zsir-cut__zcut_session_begin", input: { attempt: i } },
      {
        type: "tool_end",
        id: String(i),
        input: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "E_VALIDATION" } }) }],
      },
    );
  events.push(
    { type: "text", text: "第二" },
    { type: "text", text: "段" },
    {
      type: "tool_start",
      id: "success",
      name: "zcut_session_begin",
      input: { author: { kind: "agent", name: "Claude" } },
    },
    { type: "tool_end", id: "success", input: { ok: true } },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Harness
          call={call}
          path="/project.zcut.json"
          notices={events.map((event) => ({ chat: "chat_test", event }))}
        />,
      ),
    );
    expect([...container.querySelectorAll(".zc-markdown")].map((node) => node.textContent)).toEqual([
      "第一段",
      "第二段",
    ]);
    expect(container.querySelectorAll(".zc-step")).toHaveLength(2);
    expect(container.querySelectorAll(".zc-step.is-failed")).toHaveLength(1);
    expect(container.querySelector(".zc-step.is-failed")?.textContent).toContain("开始会话 ×3（失败 3 次）");
    await act(() => button(container, "×3").click());
    const detail = JSON.parse(container.querySelector(".zc-step-detail")?.textContent ?? "null");
    expect(detail).toHaveLength(3);
    expect(detail.map((item: { arguments: unknown }) => item.arguments)).toEqual([
      { attempt: 0 },
      { attempt: 1 },
      { attempt: 2 },
    ]);
    expect(JSON.stringify(detail)).toContain("E_VALIDATION");
    expect(JSON.stringify(detail)).toContain("mcp__zsir-cut__zcut_session_begin");
  } finally {
    await act(() => root.unmount());
  }
});

it("renders streamed GFM tables with inline formatting, escaped pipes and safe HTML", async () => {
  const { Markdown } = await import("../src/ai-components.js");
  const container = document.createElement("div");
  const root = createRoot(container);
  const header = "| 名称 | 结果 |";
  try {
    await act(() => root.render(<Markdown text={header} />));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe(header);
    await act(() =>
      root.render(
        <Markdown
          text={`${header}\n| :--- | ---: |\n| **重点** | \`代码\` |\n| A\\|B | <img src=x onerror=alert(1)> |\n\n后文`}
        />,
      ),
    );
    expect([...container.querySelectorAll("th")].map((node) => node.textContent)).toEqual(["名称", "结果"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("td strong")?.textContent).toBe("重点");
    expect(container.querySelector("td code")?.textContent).toBe("代码");
    expect(container.querySelectorAll("td")[2]?.textContent).toBe("A|B");
    expect(container.querySelector("img")).toBeNull();
    expect([...container.querySelectorAll("p")].at(-1)?.textContent).toBe("后文");
    const style = document.createElement("style");
    style.textContent = await readFile("packages/desktop/src/ai.css", "utf8");
    document.head.append(style);
    document.body.append(container);
    try {
      expect(getComputedStyle(container.querySelector(".zc-markdown-table") as HTMLElement).overflowX).toBe("auto");
      expect(getComputedStyle(container.querySelector(".zc-markdown-table") as HTMLElement).maxWidth).toBe("100%");
    } finally {
      style.remove();
    }
    await act(() => root.render(<Markdown text={"名称 | 结果\n--- | :---:\n短行\n名称 | 结果\n不是分隔行 | ---"} />));
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("tbody tr")).toBeNull();
    expect(container.textContent).toContain("不是分隔行 | ---");
    await act(() => root.render(<Markdown text={"```\n| A | B |\n| --- | --- |\n```"} />));
    expect(container.querySelector("table")).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it("groups consecutive successful and mixed tool calls while preserving order and live state", async () => {
  const call = vi.fn(async (verb: string) =>
    verb === "chat_agents" ? [{ agent: "claude", available: true, version: "测试" }] : { sessions: [], batches: [] },
  );
  const events: AiNotice["event"][] = [];
  for (let i = 0; i < 5; i++)
    events.push(
      { type: "tool_start", id: `ok${i}`, name: i % 2 ? "mcp__zsir-cut__zcut_inspect" : "zcut_inspect", input: { i } },
      { type: "tool_end", id: `ok${i}`, input: { ok: true, i } },
    );
  events.push({ type: "text", text: "间隔" });
  for (let i = 0; i < 4; i++) {
    events.push({ type: "tool_start", id: `mixed${i}`, name: "zcut_inspect", input: { i } });
    if (i < 3) events.push({ type: "tool_end", id: `mixed${i}`, input: { ok: i === 0, i } });
  }
  events.push({ type: "tool_start", id: "other", name: "zcut_validate", input: {} });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <Harness call={call} path="/project.zcut.json" notices={events.map((event) => ({ chat: "chat_test", event }))} />,
    );
  try {
    await act(async () => render());
    expect(container.querySelectorAll(".zc-step")).toHaveLength(3);
    expect(container.querySelectorAll(".zc-step")[0]?.textContent).toContain("查看工程 ×5");
    expect(container.querySelectorAll(".zc-step")[0]?.querySelector(".zc-icon")).not.toBeNull();
    expect(container.querySelector(".zc-step.is-failed.is-live")?.textContent).toContain("查看工程 ×4（失败 2 次）");
    await act(() => button(container, "×5").click());
    const success = JSON.parse(container.querySelector(".zc-step-detail")?.textContent ?? "null");
    expect(success.map((item: { arguments: unknown; result: unknown }) => [item.arguments, item.result])).toEqual(
      Array.from({ length: 5 }, (_, i) => [{ i }, { ok: true, i }]),
    );
    expect(success.map((item: { tool: string }) => item.tool)).toEqual(
      Array.from({ length: 5 }, (_, i) => (i % 2 ? "mcp__zsir-cut__zcut_inspect" : "zcut_inspect")),
    );
    await act(() => button(container, "×4").click());
    const mixed = JSON.parse(container.querySelectorAll(".zc-step-detail")[1]?.textContent ?? "null");
    expect(mixed.map((item: { arguments: unknown }) => item.arguments)).toEqual([
      { i: 0 },
      { i: 1 },
      { i: 2 },
      { i: 3 },
    ]);
    events.push({ type: "tool_end", id: "mixed3", input: { ok: true, i: 3 } });
    await act(async () => render());
    expect(container.querySelector(".zc-step.is-failed.is-live")).toBeNull();
    expect(container.querySelector(".zc-step.is-failed")?.textContent).toContain("失败 2 次");
  } finally {
    await act(() => root.unmount());
  }
});

it("switches named session tabs, shows option notes and hides empty draft counts", async () => {
  let multiple = true;
  const sessions = [
    {
      session_id: "ses_first",
      label: "精简节奏",
      intent: "不用这个 intent",
      state: "in_review",
      draft_revision: "rev_a",
      pending_count: 2,
      revision_count: 3,
      changes: [{ entity: "cue" }],
      decisions: [
        {
          id: "dec_a",
          seq: 1,
          question: "第一件？",
          state: "pending",
          options: [
            { id: "a", label: "短版", note: "适合短视频平台", recommended: true },
            { id: "b", label: "长版" },
          ],
        },
      ],
    },
    {
      session_id: "ses_second",
      intent: "这是没有标签的很长很长的会话意图需要截短显示",
      state: "open",
      draft_revision: "rev_b",
      pending_count: 1,
      revision_count: 0,
      changes: [],
      decisions: [
        { id: "dec_b", seq: 1, question: "第二件？", state: "pending", options: [{ id: "a", label: "保留" }] },
      ],
    },
  ];
  const call = vi.fn(async (verb: string) => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true }];
    if (verb === "chat_list") return [];
    return { sessions: multiple ? sessions : sessions.slice(0, 1), batches: [] };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness call={call} path="/project" />));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((node) => node.textContent)).toEqual(["精简节奏2", `${sessions[1]?.intent?.slice(0, 20)}…1`]);
    expect(container.querySelector('select[aria-label="编辑会话"]')).toBeNull();
    expect(container.textContent).not.toMatch(/ses_first|ses_second/);
    await act(() => tabs[0]?.click());
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".zc-q-question")?.textContent).toBe("第一件？");
    expect(container.querySelectorAll(".zc-q-note")).toHaveLength(1);
    expect(container.querySelector(".zc-q-note")?.textContent).toBe("适合短视频平台");
    expect(container.querySelector('[aria-label="AI 推荐"] svg')).not.toBeNull();
    expect(
      [...container.querySelectorAll(".zc-draft-counts > span")].map((node) => [
        node.textContent,
        node.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["3", "3 修订"],
      ["1", "1 字幕改动"],
    ]);
    expect(container.querySelectorAll(".zc-draft-counts svg")).toHaveLength(2);
    expect(button(container, "批准").classList.contains("zc-btn-approve")).toBe(true);
    await act(() => tabs[1]?.click());
    expect(container.querySelector(".zc-q-question")?.textContent).toBe("第二件？");
    multiple = false;
    await act(async () => root.render(<Harness call={call} path="/project" revision={1} />));
    expect(container.querySelector('[aria-label="编辑会话"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});

it("restores complete recent history, scrolls down, highlights rows and reloads after reconnect", async () => {
  const now = Date.now();
  const title = "历史对话的很长标题".repeat(12);
  const chats = [
    { id: "chat_recent", agent: "codex", title, updated_at: new Date(now - 180000).toISOString() },
    { id: "chat_older", agent: "claude", title: "之前的对话", updated_at: new Date(now - 7200000).toISOString() },
  ];
  const call = vi.fn(async (verb: string, request: Record<string, unknown>) => {
    if (verb === "chat_agents")
      return [
        { agent: "claude", available: true },
        { agent: "codex", available: true },
      ];
    if (verb === "chat_list") return chats;
    if (verb === "chat_history")
      return {
        events: [
          { type: "user", text: `${request.id} 问题` },
          { type: "text", text: "之前的完整回复" },
          { type: "tool_start", id: "tool", name: "zcut_inspect", input: { view: "brief" } },
          { type: "tool_end", id: "tool", input: { ok: true } },
          { type: "text", text: "后续回复" },
          { type: "end" },
        ],
      };
    return { sessions: [], batches: [] };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const style = document.createElement("style");
  style.textContent = await readFile("packages/desktop/src/ai.css", "utf8");
  document.head.append(style);
  let reopened: ReturnType<typeof createRoot> | undefined;
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  try {
    await act(async () => root.render(<Harness call={call} path="/project" />));
    expect(call).toHaveBeenCalledWith("chat_history", { id: "chat_recent" });
    expect(container.textContent).toContain("chat_recent 问题");
    expect(container.textContent).toContain("之前的完整回复");
    expect(container.textContent).toContain("后续回复");
    expect(container.querySelectorAll(".zc-step")).toHaveLength(1);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Agent"]')?.value).toBe("codex");
    expect(container.querySelector<HTMLElement>(".zc-chat-messages")?.scrollTop).toBe(900);
    const messagesStyle = getComputedStyle(container.querySelector(".zc-chat-messages") as HTMLElement);
    expect(messagesStyle.overflow).toBe("auto");
    expect(messagesStyle.minHeight).toBe("0");
    expect(messagesStyle.flexGrow).toBe("1");
    expect(getComputedStyle(container.querySelector(".zc-chat-input") as HTMLElement).flexShrink).toBe("0");

    await act(async () => button(container, "历史对话").click());
    const history = container.querySelector('section[aria-label="历史对话"]');
    expect(history?.querySelector("ul, li")).toBeNull();
    expect(history?.querySelectorAll(".zc-chat-history-row > svg")).toHaveLength(2);
    expect(history?.querySelector('[aria-current="true"] .zc-chat-history-title')?.textContent).toBe(title);
    expect(history?.querySelector("time")?.textContent).toBe("3 分钟前");
    const titleStyle = getComputedStyle(history?.querySelector(".zc-chat-history-title") as HTMLElement);
    expect(titleStyle.whiteSpace).toBe("nowrap");
    expect(titleStyle.textOverflow).toBe("ellipsis");
    expect(titleStyle.overflow).toBe("hidden");
    await act(async () => button(container, "之前的对话").click());
    expect(container.textContent).toContain("chat_older 问题");
    await act(async () => root.render(<Harness call={call} path="/project" connectionEpoch={1} />));
    expect(container.textContent).toContain("chat_recent 问题");
    expect(call.mock.calls.filter(([verb]) => verb === "chat_list")).toHaveLength(3);
    await act(() => root.unmount());
    reopened = createRoot(container);
    await act(async () => reopened?.render(<Harness call={call} path="/project" />));
    expect(container.textContent).toContain("之前的完整回复");
  } finally {
    height.mockRestore();
    style.remove();
    await act(() => (reopened ?? root).unmount());
    container.remove();
  }
});

it("merges live notices with restored history without duplicating streamed events", async () => {
  const first = { type: "text", text: "已有内容" } as const;
  const live = { type: "text", text: "新的内容" } as const;
  let resolveHistory: ((value: unknown) => void) | undefined;
  const call = vi.fn(async (verb: string) => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true }];
    if (verb === "chat_list") return [{ id: "chat_saved", agent: "claude", title: "上次" }];
    if (verb === "chat_history")
      return new Promise((resolve) => {
        resolveHistory = resolve;
      });
    return { sessions: [], batches: [] };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness call={call} path="/project" />));
    await act(async () =>
      root.render(
        <Harness
          call={call}
          path="/project"
          notices={[
            { chat: "chat_saved", event: first },
            { chat: "chat_saved", event: live },
          ]}
        />,
      ),
    );
    await act(async () => resolveHistory?.({ events: [{ type: "user", text: "之前的问题" }, first] }));
    expect(container.querySelector(".zc-chat-user")?.textContent).toBe("之前的问题");
    expect(container.querySelector(".zc-markdown")?.textContent).toBe("已有内容新的内容");
  } finally {
    await act(() => root.unmount());
  }
});

it("does not replace a new conversation with a delayed history response", async () => {
  let resolveHistory: ((value: unknown) => void) | undefined;
  const call = vi.fn(async (verb: string) => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true }];
    if (verb === "chat_list") return [{ id: "chat_saved", agent: "claude", title: "上次" }];
    if (verb === "chat_history")
      return new Promise((resolve) => {
        resolveHistory = resolve;
      });
    return { sessions: [], batches: [] };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness call={call} path="/project" />));
    await act(() => button(container, "新对话").click());
    await act(async () => resolveHistory?.({ events: [{ type: "text", text: "旧回复" }] }));
    expect(container.textContent).not.toContain("旧回复");
    expect(container.querySelector('[role="log"]')?.getAttribute("data-chat")).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
