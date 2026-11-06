// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { type AiNotice, useAiPanel } from "../src/AiPanel.js";
import { PermissionCard, StepRow } from "../src/ai-components.js";
import { connectHost, type PermissionRequest } from "../src/connection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function mount() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  return { node, root };
}
function button(node: HTMLElement, label: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.includes(label),
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function key(node: HTMLElement, value: string) {
  await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
}
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const permission: PermissionRequest = {
  type: "permission_request",
  id: "prm_test",
  verb: "export",
  title: "导出到「交接」",
  detail: "写入导出文件。",
  target: "/交接",
  command: {},
};
const draft = {
  session_id: "ses_draft",
  state: "in_review",
  base_revision: "rev_base",
  draft_revision: "rev_draft",
  intent: "缩短开头",
  decisions: [
    { id: "dec_test", seq: 1, question: "保留跳剪？", options: [{ id: "yes", label: "保留" }], state: "pending" },
  ],
  pending_count: 1,
  revision_count: 2,
  changes: [{ entity: "clip" }],
};
function host() {
  return vi.fn(async (verb: string, _request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "chat_agents") return [{ agent: "claude", available: true, version: "2.1.7 (Claude Code)" }];
    if (verb === "chat_list") return [];
    if (verb === "ai_state") return { sessions: [draft], batches: [] };
    if (verb === "chat_send") return { id: "chat_test" };
    if (verb === "diff") return { changes: [{ entity: "clip", before: {}, after: null }] };
    return {};
  });
}
function Panel({
  call,
  notices = [],
  initialPermissions = [],
  epoch = 0,
}: {
  call: ReturnType<typeof host>;
  notices?: AiNotice[];
  initialPermissions?: PermissionRequest[];
  epoch?: number;
}) {
  const [permissions, setPermissions] = useState(initialPermissions);
  const ai = useAiPanel({
    call,
    path: "/project",
    project: null,
    revision: 0,
    notices,
    connectionEpoch: epoch,
    permissions,
    permissionAnswered: (id) => setPermissions((old) => old.filter((item) => item.id !== id)),
  });
  return (
    <>
      <main>
        {ai.header}
        {ai.chat}
      </main>
      <aside>
        <h2>决定</h2>
        {ai.decisionStatus}
        {ai.parameters}
      </aside>
    </>
  );
}

// The board's fourteen cases use the same compact row and disclosure interaction.
it.each([
  ["思考", "thinking", true, false, false, "思考"],
  ["读取合并", "read_transcript", false, false, false, "读取字幕"],
  ["查找", "Grep", false, false, false, "查找"],
  ["看画面听声音", "view_image", false, false, false, "看了画面"],
  ["改动进草稿", "zcut_edit", false, false, false, "改了时间线"],
  ["长任务", "zcut_transcribe", true, false, false, "识别字幕"],
  ["同时做几件事", "parallel", true, false, false, "同时做几件事"],
  ["计划", "update_plan", false, false, false, "计划"],
  ["派出助手", "Task", true, false, false, "派出助手"],
  ["需要同意", "permission_request", true, false, false, "等待许可"],
  ["出错重试", "zcut_import_media", false, true, false, "失败 1 次"],
  ["停止不允许", "zcut_export", false, false, true, "已停下"],
  ["运行命令", "exec_command", false, false, false, "运行命令"],
  ["工作中", "wait", true, false, false, "等待"],
] as const)("工具画板：%s", async (_case, name, live, failed, stopped, label) => {
  const { node, root } = mount();
  await act(() =>
    root.render(
      <StepRow
        name={name}
        live={live}
        failed={failed}
        stopped={stopped}
        count={3}
        detail={{ session_id: "ses_hidden", text: "已完成检查", clip_id: "clp_hidden" }}
      />,
    ),
  );
  const row = node.querySelector<HTMLButtonElement>(".zc-step");
  expect(row?.textContent).toContain(label);
  expect(row?.textContent).toContain("×3");
  expect(row?.querySelectorAll("svg")).toHaveLength(2);
  expect(row?.getAttribute("aria-expanded")).toBe("false");
  await act(() => row?.click());
  expect(row?.getAttribute("aria-expanded")).toBe("true");
  expect(node.textContent).toContain("已完成检查");
  expect(node.textContent).not.toMatch(/ses_hidden|clp_hidden/);
});

it.each(["once", "project", "deny"] as const)("许可按钮和数字键答复：%s", async (answer) => {
  const index = ["once", "project", "deny"].indexOf(answer);
  for (const keyboard of [false, true]) {
    const { node, root } = mount();
    const respond = vi.fn(async () => {});
    await act(() => root.render(<PermissionCard request={permission} answer={respond} />));
    const input = node.querySelector<HTMLInputElement>("input");
    const card = node.querySelector<HTMLDivElement>('[role="alertdialog"]');
    if (!input || !card) throw new Error("Missing permission card");
    await type(input, "换个文件夹");
    await key(input, String(index + 1));
    expect(respond).not.toHaveBeenCalled();
    if (keyboard) {
      await act(() => card.focus());
      await key(card, String(index + 1));
    } else await act(async () => button(node, ["允许这一次", "这个工程里都允许", "不允许"][index] as string).click());
    expect(respond).toHaveBeenCalledExactlyOnceWith(answer, "换个文件夹");
  }
});

it("keeps failed permission answers retryable and removes only the answered card in arrival order", async () => {
  const { node, root } = mount();
  const call = host();
  // Use a verb-specific rejection so bootstrap requests still succeed.
  const original = host();
  let fail = true;
  call.mockImplementation(async (verb, request) => {
    if (verb === "permission_answer" && fail) {
      fail = false;
      throw new Error("断线");
    }
    return original(verb, request);
  });
  await act(async () =>
    root.render(
      <Panel call={call} initialPermissions={[permission, { ...permission, id: "prm_second", title: "生成配音" }]} />,
    ),
  );
  expect(node.querySelectorAll('[role="alertdialog"]')).toHaveLength(2);
  expect(node.querySelector("aside")?.textContent?.indexOf(permission.title)).toBeLessThan(
    node.querySelector("aside")?.textContent?.indexOf("方案 ·") ?? 0,
  );
  await act(async () => button(node, "允许这一次").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("请重试");
  expect(node.querySelectorAll('[role="alertdialog"]')).toHaveLength(2);
  await act(async () => button(node, "允许这一次").click());
  expect(call).toHaveBeenCalledWith("permission_answer", { id: "prm_test", answer: "once" });
  expect(node.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain("生成配音");
  expect(node.querySelectorAll("main .zc-chat-pointer")).toHaveLength(2);
  await act(() => button(node, "等你许可").click());
  expect(document.activeElement).toBe(node.querySelector('[role="alertdialog"]'));
});

it("renders suggestions only inside the composer; Tab fills, Enter sends, typing and a new turn clear", async () => {
  const { node, root } = mount();
  const call = host();
  const notices: AiNotice[] = [];
  const render = async () => act(async () => root.render(<Panel call={call} notices={[...notices]} />));
  await render();
  expect(node.querySelector(".zc-ghost")).toBeNull();
  const input = node.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) throw new Error("Missing composer");
  const suggest = async () => {
    notices.push({ chat: "chat_test", event: { type: "suggestion", text: "继续精剪" } });
    await render();
  };
  await suggest();
  expect(node.querySelector(".zc-chat-input .zc-ghost")?.textContent).toBe("继续精剪Tab");
  expect(node.querySelector('[role="log"]')?.textContent).not.toContain("继续精剪");
  expect(input.value).toBe("");
  await key(input, "Tab");
  expect(input.value).toBe("继续精剪");
  expect(node.querySelector(".zc-ghost")).toBeNull();
  expect(call.mock.calls.filter(([verb]) => verb === "chat_send")).toHaveLength(0);
  await key(input, "Enter");
  expect(call).toHaveBeenCalledWith("chat_send", expect.objectContaining({ text: "继续精剪" }));
  notices.push({ chat: "chat_test", event: { type: "end" } });
  await render();
  await suggest();
  await type(input, "我的想法");
  expect(node.querySelector(".zc-ghost")).toBeNull();
  await type(input, "");
  expect(node.querySelector(".zc-ghost")).toBeNull();
  await suggest();
  await key(input, "Enter");
  expect(node.querySelector(".zc-ghost")).toBeNull();
  expect(call.mock.calls.filter(([verb]) => verb === "chat_send")).toHaveLength(2);
});

it("places the plan in 决定, leaves one chat pointer, and opens the diff from both links", async () => {
  const { node, root } = mount();
  const call = host();
  await act(async () =>
    root.render(
      <Panel
        call={call}
        notices={[{ chat: "chat_test", event: { type: "tool_start", id: "tool_internal", name: "zcut_edit" } }]}
      />,
    ),
  );
  expect(node.querySelectorAll("aside .zc-draft")).toHaveLength(1);
  expect(node.querySelector("main .zc-draft")).toBeNull();
  expect(
    (node.querySelector("aside .zc-draft")?.compareDocumentPosition(node.querySelector("aside .zc-q") as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(node.querySelectorAll(".zc-chat-pointer")).toHaveLength(1);
  expect(node.querySelector(".zc-chat-pointer")?.textContent).toBe("方案等你审 ");
  expect(node.textContent).not.toMatch(/在右边决定|ses_draft|rev_base|tool_internal/);
  expect(node.querySelector(".zc-ai-head")?.textContent).toContain("Claude Code 2.1.7");
  expect(node.querySelector(".zc-ai-head")?.textContent).not.toContain("(Claude Code)");
  expect(node.querySelectorAll(".zc-ai-head > button")).toHaveLength(2);
  await act(async () => button(node, "看对比").click());
  expect(call).toHaveBeenCalledWith("diff", {
    project: "/project",
    session_id: "ses_draft",
    from: "rev_base",
    to: "rev_draft",
  });
  expect(node.querySelector('[aria-label="方案对比"]')?.textContent).toContain("移除 · 片段");
  await act(() => button(node, "收起").click());
  await act(async () => button(node, "看方案").click());
  expect(node.querySelector('[aria-label="方案对比"]')).not.toBeNull();
  expect(button(node, "全部批准")).toBeDefined();
});

it("forwards replayed permission pushes after reconnect without requiring chat events", () => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen = null;
    onclose = null;
    onerror = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      socket = this;
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const permissionHandler = vi.fn();
  const handlers = { ui: vi.fn(), project: vi.fn(), icon: vi.fn(), error: vi.fn(), permission: permissionHandler };
  let disconnect = connectHost({ port: 1, token: "test" }, handlers);
  socket?.onmessage?.({ data: JSON.stringify(permission) });
  disconnect();
  disconnect = connectHost({ port: 1, token: "test" }, handlers);
  socket?.onmessage?.({ data: JSON.stringify(permission) });
  expect(permissionHandler).toHaveBeenNthCalledWith(2, permission);
  disconnect();
});

it.each(["once", "project", "deny"] as const)(
  "sends %s with the optional message and dismisses the permission",
  async (answer) => {
    const { node, root } = mount();
    const call = host();
    await act(async () => root.render(<Panel call={call} initialPermissions={[permission]} />));
    const input = node.querySelector<HTMLInputElement>(".zc-permission input");
    if (!input) throw new Error("Missing message input");
    await type(input, "请用另一个文件夹");
    await act(async () =>
      button(node, { once: "允许这一次", project: "这个工程里都允许", deny: "不允许" }[answer]).click(),
    );
    expect(call).toHaveBeenCalledWith("permission_answer", { id: permission.id, answer, message: "请用另一个文件夹" });
    expect(node.querySelector('[role="alertdialog"]')).toBeNull();
    expect(node.querySelector("main")?.textContent).not.toContain("等你许可");
  },
);

it("keeps read grouping, write steps, stopped calls and denied calls distinct", async () => {
  const { node, root } = mount();
  const call = host();
  const events: AiNotice["event"][] = [
    { type: "tool_start", id: "read1", name: "zcut_inspect" },
    { type: "tool_end", id: "read1", input: {} },
    { type: "tool_start", id: "read2", name: "zcut_read_transcript" },
    { type: "tool_end", id: "read2", input: {} },
    { type: "tool_start", id: "write1", name: "zcut_edit" },
    { type: "tool_end", id: "write1", input: {} },
    { type: "tool_start", id: "write2", name: "zcut_edit" },
    { type: "tool_end", id: "write2", input: {} },
    { type: "tool_start", id: "denied", name: "zcut_export" },
    { type: "tool_end", id: "denied", input: { ok: false, error: { code: "E_PERMISSION_DENIED" } } },
    { type: "tool_start", id: "stopped", name: "zcut_transcribe" },
    { type: "end", text: "已停止" },
  ];
  await act(async () =>
    root.render(<Panel call={call} notices={events.map((event) => ({ chat: "chat_test", event }))} />),
  );
  expect(node.querySelectorAll(".zc-step")).toHaveLength(5);
  expect(node.querySelector(".zc-step")?.textContent).toContain("×2");
  expect(node.querySelectorAll(".zc-step.is-stopped")).toHaveLength(2);
  expect(node.querySelector(".zc-step.is-failed")).toBeNull();
});
