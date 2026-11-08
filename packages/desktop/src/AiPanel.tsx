import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKind, ChatEvent } from "../../app-host/src/agent-events.js";
import {
  Button,
  type Decision,
  DecisionCard,
  isReadTool,
  Markdown,
  PermissionCard,
  StepRow,
  toolVerb,
} from "./ai-components.js";
import { Icon, IconButton } from "./components.js";
import type { PermissionRequest, ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { openReview } from "./ReviewView.js";
import "./ai.css";

function toolResultFailed(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      return toolResultFailed(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(toolResultFailed);
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.ok === false ||
    result.isError === true ||
    result.is_error === true ||
    result.status === "failed" ||
    result.status === "rejected" ||
    [result.structuredContent, result.content, result.text].some(toolResultFailed)
  );
}

function toolErrorCode(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return toolErrorCode(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(toolErrorCode).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  const error = result.error as { code?: string } | undefined;
  return error?.code ?? [result.structuredContent, result.content, result.text].map(toolErrorCode).find(Boolean);
}

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
export interface AiNotice {
  chat: string;
  event: ChatEvent;
}
interface Session {
  session_id: string;
  state: string;
  label?: string;
  intent?: string;
  base_revision: string;
  draft_revision: string;
  decisions: Decision[];
  pending_count: number;
  revision_count: number;
  changes: { entity: string }[];
}
interface ChatSummary {
  id: string;
  agent: AgentKind;
  title: string;
  updated_at: string;
}
function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
interface AiState {
  sessions: Session[];
  batches: { state: string; count: number; applied: number[] }[];
}
export function useAiPanel({
  call,
  path,
  project,
  notices,
  revision,
  connectionEpoch = 0,
  permissions = [],
  permissionAnswered,
}: {
  call: Call;
  path: string | null;
  project: ProjectView | null;
  notices: AiNotice[];
  revision: number;
  connectionEpoch?: number;
  permissions?: PermissionRequest[];
  permissionAnswered?: (id: string) => void;
}) {
  const [agents, setAgents] = useState<{ agent: AgentKind; available: boolean; version: string | null }[]>([]);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [chatId, setChatId] = useState<string>();
  const currentChat = useRef<string>();
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [generating, setGenerating] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = useRef(false);
  useEffect(() => {
    if (!focusInput.current || !agents.length || !inputRef.current) return;
    focusInput.current = false;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(input.length, input.length);
  }, [input, agents.length]);
  const [suggestion, setSuggestion] = useState("");
  const permissionCards = useRef<HTMLDivElement>(null);
  const draftCards = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ChatSummary[] | null>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const chatSelection = useRef(0);
  const restoring = useRef<{ selection: number; notices: AiNotice[] }>();
  const [ai, setAi] = useState<AiState>({ sessions: [], batches: [] });
  const [sessionId, setSessionId] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState<string>();
  const [approvalConflicts, setApprovalConflicts] = useState<Record<string, string>>({});
  const [reviewConflicts, setReviewConflicts] = useState<Set<string>>(() => new Set());
  const answers = useRef<string[]>([]);
  const consumed = useRef(0);
  const refresh = useCallback(async () => {
    const state = (await call("ai_state", {})) as AiState;
    if (Array.isArray(state.sessions)) setAi(state);
  }, [call]);
  useEffect(() => {
    if (!path) return;
    let disposed = false;
    void call("chat_agents", {})
      .then((value) => {
        if (disposed) return;
        const detected = value as typeof agents;
        if (!Array.isArray(detected)) return;
        setAgents(detected);
        const first = detected.find((item) => item.available);
        if (first && !currentChat.current) setAgent(first.agent);
      })
      .catch((e: Error) => setError(e.message));
    void refresh().catch((e: Error) => setError(e.message));
    return () => {
      disposed = true;
    };
  }, [path, call, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect restores the panel selection in the new host.
  useEffect(() => {
    if (path && agents.length) void call("chat_select", { agent }).catch((e: Error) => setError(e.message));
  }, [agent, agents.length, path, call, connectionEpoch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new host connection must restore persisted history.
  useEffect(() => {
    setGenerating(false);
    setInput("");
    setSuggestion("");
    setError("");
    setHistory(null);
    setAi({ sessions: [], batches: [] });
    setSessionId("");
    setApprovalConflicts({});
    setReviewConflicts(new Set());
    setEvents([]);
    currentChat.current = undefined;
    setChatId(undefined);
    consumed.current = 0;
    if (!path) return;
    let disposed = false;
    const selection = ++chatSelection.current;
    const recovery = { selection, notices: [] as AiNotice[] };
    restoring.current = recovery;
    currentChat.current = undefined;
    setChatId(undefined);
    setEvents([]);
    void (async () => {
      const chats = (await call("chat_list", {})) as ChatSummary[];
      const latest = Array.isArray(chats) ? chats[0] : undefined;
      if (!latest || disposed || selection !== chatSelection.current) return;
      const saved = (await call("chat_history", { id: latest.id })) as { events: ChatEvent[] };
      if (disposed || selection !== chatSelection.current) return;
      if (currentChat.current && currentChat.current !== latest.id) return;
      const incoming = recovery.notices.filter((notice) => notice.chat === latest.id).map((notice) => notice.event);
      let overlap = Math.min(saved.events.length, incoming.length);
      while (overlap && JSON.stringify(saved.events.slice(-overlap)) !== JSON.stringify(incoming.slice(0, overlap)))
        overlap--;
      currentChat.current = latest.id;
      setChatId(latest.id);
      setAgent(latest.agent);
      const restored = [...saved.events, ...incoming.slice(overlap)];
      setEvents(restored);
      const last = restored.findLast((event) => event.type === "user" || event.type === "suggestion");
      setSuggestion(last?.type === "suggestion" ? (last.text?.trim() ?? "") : "");
    })()
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (restoring.current === recovery) restoring.current = undefined;
      });
    return () => {
      disposed = true;
    };
  }, [path, call, connectionEpoch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll after restored or streamed messages render.
  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events, agents]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Host notifications invalidate the session view.
  useEffect(() => {
    if (!path) return;
    void refresh().catch((e: Error) => setError(e.message));
  }, [path, revision, refresh]);
  const runningBatch = ai.batches.find((batch) => batch?.state === "open");
  useEffect(() => {
    if (!path || (!generating && !runningBatch)) return;
    const timer = setInterval(() => {
      void refresh().catch((e: Error) => setError(e.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [path, generating, runningBatch, refresh]);
  useEffect(() => {
    for (const notice of notices.slice(consumed.current)) {
      if (!currentChat.current || currentChat.current === notice.chat) {
        if (restoring.current?.selection === chatSelection.current) restoring.current.notices.push(notice);
        else chatSelection.current++;
        currentChat.current = notice.chat;
        setChatId(notice.chat);
        setEvents((old) => [...old, notice.event]);
        if (notice.event.type === "suggestion") setSuggestion(notice.event.text?.trim() ?? "");
        if (notice.event.type === "user") setSuggestion("");
        if (notice.event.type === "end") {
          setGenerating(false);
          void refresh().catch((e: Error) => setError(e.message));
        }
      }
    }
    consumed.current = notices.length;
  }, [notices, refresh]);
  useEffect(() => {
    setReviewConflicts((old) => {
      const next = new Set(old);
      const tools = new Map<string, ChatEvent>();
      for (const event of events) {
        if (!event.id) continue;
        if (event.type === "tool_start") tools.set(event.id, { ...tools.get(event.id), ...event });
        if (event.type !== "tool_end") continue;
        const tool = tools.get(event.id);
        const id = (tool?.input as { session_id?: string } | undefined)?.session_id;
        const verb = toolVerb(tool?.name ?? "");
        if (!id) continue;
        if (["session_review", "session_approve"].includes(verb)) {
          if (toolErrorCode(event.input) === "E_CONFLICT") next.add(id);
          else next.delete(id);
        } else if (verb === "edit" && !event.failed && !toolResultFailed(event.input)) next.delete(id);
      }
      return next;
    });
  }, [events]);
  const send = async (text: string) => {
    if (generating || !text.trim()) return;
    if (!agents.some((item) => item.agent === agent && item.available)) {
      setInput(text);
      setError("未检测到所选 Agent，决定回答已保存。");
      return;
    }
    chatSelection.current++;
    setError("");
    setGenerating(true);
    setSuggestion("");
    setInput("");
    try {
      const result = (await call("chat_send", {
        agent,
        text,
        ...(currentChat.current ? { chat_id: currentChat.current } : {}),
      })) as { id: string };
      currentChat.current = result.id;
      setChatId(result.id);
    } catch (e) {
      setError(String(e));
      setGenerating(false);
      setInput(text);
    }
  };
  const write = (verb: string, session: Session, extra: Record<string, unknown>) =>
    call(verb, {
      project: path,
      session_id: session.session_id,
      base_revision: ["session_approve", "session_reject"].includes(verb)
        ? project?.revision.id
        : session.draft_revision,
      idempotency_key: crypto.randomUUID(),
      author: DESKTOP_AUTHOR,
      ...extra,
    });
  // The host lists UUIDv7 session IDs from oldest to newest.
  const draftSessions = ai.sessions.filter((item) => ["open", "in_review"].includes(item.state)).reverse();
  const session = draftSessions.find((item) => item.session_id === sessionId) ?? draftSessions[0];
  const decisions = [...(session?.decisions ?? [])].sort((a, b) => a.seq - b.seq);
  const pending = decisions.filter((item) => item.state === "pending");
  const decision = pending[0];
  const draftSession = session ?? ai.sessions.at(-1);
  const answer = async (value: { option_id: string } | { text: string } | { skip: true }) => {
    if (!session || !decision || saving || generating) return;
    setSaving(true);
    setError("");
    try {
      await write("session_answer", session, { decision_id: decision.id, ...value });
      const label =
        "skip" in value
          ? "跳过"
          : "text" in value
            ? value.text
            : (decision.options.find((item) => item.id === value.option_id)?.label ?? "");
      answers.current.push(`- ${decision.question} → ${label}`);
      await refresh();
      if (pending.length === 1) {
        const text = answers.current.join("\n");
        answers.current = [];
        await send(text);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const approve = async (item: Session, pendingCount = item.pending_count) => {
    if (approvalReason(item)) return false;
    if (pendingCount && confirmApprove !== item.session_id) {
      setConfirmApprove(item.session_id);
      return false;
    }
    setSaving(true);
    setError("");
    try {
      await write("session_approve", item, { label: "批准 AI 草稿" });
      setConfirmApprove(undefined);
      await refresh().catch((e: Error) => setError(e.message));
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "E_CONFLICT")
        setApprovalConflicts((old) => ({ ...old, [item.session_id]: item.draft_revision }));
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const showReview = (item: Session) => {
    if (item.changes?.length) openReview(item.session_id);
  };
  const reject = async (id: string) => {
    const item = ai.sessions.find((item) => item.session_id === id);
    if (!item || saving) return false;
    setSaving(true);
    setError("");
    try {
      await write("session_reject", item, { label: "拒绝 AI 草稿" });
      setConfirmApprove(undefined);
      await refresh().catch((e: Error) => setError(e.message));
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    tools: {
      id: string;
      name: string;
      input: unknown;
      result?: unknown;
      live: boolean;
      failed: boolean;
      stopped?: boolean;
      failureCount?: number;
      attempts?: unknown[];
    }[];
  }[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === "user")
      messages.push({ id: `message-${index}`, role: "user", text: event.text ?? "", tools: [] });
    else if (["text", "tool_start", "tool_end", "error"].includes(event.type)) {
      if (messages.at(-1)?.role !== "assistant")
        messages.push({ id: `message-${index}`, role: "assistant", text: "", tools: [] });
      if (event.type === "text" && messages.at(-1)?.tools.length)
        messages.push({ id: `message-${index}`, role: "assistant", text: "", tools: [] });
      const message = messages.at(-1);
      if (!message) continue;
      if (event.type === "text") message.text += event.text ?? "";
      if (event.type === "error") message.text += `\n${event.text ?? "Agent 出错"}`;
      if (event.type === "tool_start") {
        const existing = messages.flatMap((entry) => entry.tools).find((tool) => tool.id === event.id);
        if (existing) {
          if (event.name) existing.name = event.name;
          if (event.input !== undefined) existing.input = event.input;
        } else
          message.tools.push({
            id: event.id ?? String(message.tools.length),
            name: event.name ?? "工具调用",
            input: event.input,
            live: true,
            failed: false,
          });
      }
      if (event.type === "tool_end") {
        const tool = messages.flatMap((entry) => entry.tools).find((tool) => tool.id === event.id);
        if (tool) {
          tool.live = false;
          tool.result = event.input;
          tool.stopped = JSON.stringify(event.input)?.includes("E_PERMISSION_DENIED") ?? false;
          tool.failed = !tool.stopped && (event.failed === true || toolResultFailed(event.input));
        }
      }
    } else if (event.type === "end")
      for (const message of messages)
        for (const tool of message.tools) {
          if (tool.live && event.text === "已停止") tool.stopped = true;
          tool.live = false;
        }
  }
  for (const message of messages) {
    for (let i = 0; i < message.tools.length; i++) {
      const tool = message.tools[i];
      const next = message.tools[i + 1];
      if (
        tool &&
        next &&
        ((isReadTool(tool.name) && isReadTool(next.name)) ||
          (tool.failed && toolVerb(tool.name) === toolVerb(next.name)))
      ) {
        tool.attempts = [
          ...(tool.attempts ?? [{ tool: tool.name, arguments: tool.input, result: tool.result }]),
          { tool: next.name, arguments: next.input, result: next.result },
        ];
        tool.failureCount = (tool.failureCount ?? Number(tool.failed)) + Number(next.failed);
        tool.failed = tool.failureCount > 0;
        tool.live ||= next.live;
        tool.stopped ||= next.stopped ?? false;
        message.tools.splice(i + 1, 1);
        i--;
      }
    }
  }
  const available = agents.filter((item) => item.available);
  const approvalReason = (item: Session) => {
    if (reviewConflicts.has(item.session_id) || approvalConflicts[item.session_id] === item.draft_revision)
      return "工程在这之后又改过";
    if (item.state !== "in_review") return "AI 还没交审";
    if (!item.changes?.length) return "这一版没有改动";
    if (generating) return "AI 正在处理，请稍候";
    if (saving) return "正在保存，请稍候";
    return "";
  };
  const header = (
    <div className="zc-panel-head zc-ai-head">
      <h2>AI</h2>
      <div className="zc-agent-selector">
        <Icon name="bot" />
        <select
          aria-label="Agent"
          disabled={generating}
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value as AgentKind);
            chatSelection.current++;
            currentChat.current = undefined;
            setChatId(undefined);
            setEvents([]);
            setSuggestion("");
          }}
        >
          {available.map((item) => (
            <option key={item.agent} value={item.agent}>
              {item.agent === "claude" ? "Claude Code" : "Codex"}{" "}
              {item.version?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? item.version}
            </option>
          ))}
        </select>
        <Icon name="down" size={12} />
      </div>
      <IconButton
        icon="plus"
        label="新对话"
        disabled={generating}
        onClick={() => {
          chatSelection.current++;
          currentChat.current = undefined;
          setChatId(undefined);
          setEvents([]);
          setHistory(null);
          setSuggestion("");
        }}
      />
      <IconButton
        icon="list"
        label="历史对话"
        disabled={generating}
        onClick={() => {
          void call("chat_list", {})
            .then((value) => setHistory(value as typeof history))
            .catch((e: Error) => setError(e.message));
        }}
      />
    </div>
  );
  const chat = (
    <div className="zc-ai-chat">
      {!available.length ? (
        <p>
          未检测到本机 Agent。
          <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
            安装说明
          </a>
        </p>
      ) : (
        <>
          {history && (
            <section className="zc-chat-history" aria-label="历史对话">
              {history.map((item) => (
                <button
                  type="button"
                  className="zc-chat-history-row"
                  aria-current={chatId === item.id ? "true" : undefined}
                  key={item.id}
                  onClick={() => {
                    const selection = ++chatSelection.current;
                    void call("chat_history", { id: item.id })
                      .then((value) => {
                        if (selection !== chatSelection.current) return;
                        const saved = value as { events: ChatEvent[] };
                        currentChat.current = item.id;
                        setChatId(item.id);
                        setAgent(item.agent);
                        setEvents(saved.events);
                        setSuggestion("");
                        setHistory(null);
                      })
                      .catch((e: Error) => setError(e.message));
                  }}
                >
                  <Icon name="ask" />
                  <span className="zc-chat-history-title" title={item.title}>
                    {item.title}
                  </span>
                  <time dateTime={item.updated_at}>{relativeTime(item.updated_at)}</time>
                </button>
              ))}
            </section>
          )}
          <div
            ref={messageList}
            className="zc-chat-messages"
            role="log"
            aria-label="对话"
            aria-live="polite"
            data-chat={chatId}
          >
            {messages.map((message) => (
              <div className={`zc-chat-${message.role}`} key={message.id}>
                {message.role === "user" ? (
                  <p>
                    {message.text.split(/(@\[[^\]]+\])/g).map((part, j) =>
                      part.startsWith("@[") ? (
                        <span key={`${j}-${part}`} className="zc-chat-ref">
                          {part}
                        </span>
                      ) : (
                        part
                      ),
                    )}
                  </p>
                ) : (
                  <>
                    <Markdown text={message.text} />
                    {message.tools.map((tool) => {
                      const id =
                        tool.input && typeof tool.input === "object"
                          ? (tool.input as Record<string, unknown>).session_id
                          : undefined;
                      const reviewSession = id ? ai.sessions.find((item) => item.session_id === id) : draftSession;
                      return (
                        <StepRow
                          key={tool.id}
                          live={tool.live}
                          name={tool.name}
                          failed={tool.failed}
                          stopped={tool.stopped ?? false}
                          {...(reviewSession?.changes?.length && ["open", "in_review"].includes(reviewSession.state)
                            ? { onReview: () => void showReview(reviewSession) }
                            : {})}
                          failureCount={tool.failureCount ?? Number(tool.failed)}
                          count={tool.attempts?.length ?? 1}
                          detail={tool.attempts ?? { tool: tool.name, arguments: tool.input, result: tool.result }}
                        />
                      );
                    })}
                    <IconButton
                      icon="copy"
                      label="复制回复"
                      onClick={() => {
                        if (!navigator.clipboard) setError("当前环境不支持复制");
                        else void navigator.clipboard.writeText(message.text).catch(() => setError("复制失败"));
                      }}
                    />
                  </>
                )}
              </div>
            ))}
            {ai.sessions.some((item) => item.state === "in_review" && item.changes?.length) && (
              <Button
                className="zc-chat-pointer"
                icon="ask"
                onClick={() => {
                  const item = ai.sessions.find((item) => item.state === "in_review" && item.changes?.length);
                  if (item) showReview(item);
                }}
              >
                方案等你审 <Icon name="chevron" />
              </Button>
            )}
            {permissions.length > 0 && (
              <Button
                className="zc-chat-pointer"
                icon="ask"
                onClick={() => {
                  permissionCards.current?.scrollIntoView?.({ block: "nearest" });
                  permissionCards.current?.querySelector<HTMLDivElement>('[role="alertdialog"]')?.focus();
                }}
              >
                等你许可 <Icon name="chevron" />
              </Button>
            )}
          </div>
          {generating && permissions.length === 0 && (
            <output className="zc-agent-status">
              <Icon name="clock" />
              <span className="zc-grow">正在处理…</span>
              <kbd>Esc</kbd> 停止
            </output>
          )}
          <div className="zc-chat-input">
            <textarea
              ref={inputRef}
              aria-label="发给 AI"
              rows={3}
              value={input}
              placeholder={suggestion ? "" : "描述你想怎么剪，@ 引用素材"}
              onChange={(e) => {
                setInput(e.target.value);
                setSuggestion("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && generating) {
                  e.preventDefault();
                  void call("chat_stop", {}).catch((error: Error) => setError(error.message));
                }
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Tab" && !e.shiftKey && suggestion && !input) {
                  e.preventDefault();
                  setInput(suggestion);
                  setSuggestion("");
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input || suggestion);
                }
              }}
            />
            {suggestion && !input && (
              <div className="zc-ghost" aria-hidden="true">
                <span>{suggestion}</span>
                <kbd>Tab</kbd>
              </div>
            )}
            {/@[^\s]*$/.test(input) && (
              <fieldset className="zc-chat-refs">
                <legend>引用素材</legend>
                {project?.media.map((media) => (
                  <Button
                    key={media.id}
                    onClick={() => setInput(input.replace(/@[^\s]*$/, `@[${media.name}](${media.id}) `))}
                  >
                    {media.name}
                  </Button>
                ))}
              </fieldset>
            )}
            <div className="zc-chat-actions">
              <span className="zc-grow" />
              <IconButton
                icon={generating ? "stop" : "send"}
                label={generating ? "停止" : "发送"}
                disabled={!generating && !input.trim() && !suggestion}
                onClick={() => {
                  if (generating) void call("chat_stop", {}).catch((e: Error) => setError(e.message));
                  else void send(input || suggestion);
                }}
              />
            </div>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  const parameters = (
    <>
      <div ref={permissionCards} className="zc-permission-list">
        {permissions.map((request) => (
          <PermissionCard
            key={request.id}
            request={request}
            answer={async (answer, message) => {
              await call("permission_answer", { id: request.id, answer, ...(message ? { message } : {}) });
              permissionAnswered?.(request.id);
            }}
          />
        ))}
      </div>
      <div ref={draftCards} className="zc-draft-list">
        {draftSessions.map((item) => {
          const changes = item.changes ?? [];
          const reason = approvalReason(item);
          const title = item.intent || item.label || "剪辑方案";
          return (
            <section
              className={`zc-draft${session?.session_id === item.session_id ? " is-selected" : ""}`}
              aria-label="AI 草稿"
              key={item.session_id}
            >
              <button
                type="button"
                className="zc-draft-select"
                aria-label={`选择方案：${title}`}
                aria-pressed={session?.session_id === item.session_id}
                disabled={saving}
                onClick={() => {
                  setSessionId(item.session_id);
                  setConfirmApprove(undefined);
                  answers.current = [];
                }}
              />
              <strong>方案 · {title}</strong>
              <div className="zc-draft-counts">
                {[
                  { icon: "list", label: "步", count: item.revision_count },
                  {
                    icon: "clip",
                    label: "片段",
                    count: changes.filter((change) => change.entity === "clip").length,
                  },
                  {
                    icon: "subtitle",
                    label: "字幕改动",
                    count: changes.filter((change) =>
                      ["cue", "transcript", "run", "token", "override", "free_cue", "style"].includes(change.entity),
                    ).length,
                  },
                ]
                  .filter((entry) => entry.count > 0)
                  .map((entry) => (
                    <span role="img" key={entry.label} aria-label={`${entry.count} ${entry.label}`} title={entry.label}>
                      <Icon name={entry.icon} />
                      {entry.count} {entry.label}
                    </span>
                  ))}
              </div>
              {confirmApprove === item.session_id && (
                <p role="alert">还有 {item.pending_count} 件决定未答，仍要批准吗？</p>
              )}
              {reason && <p className="zc-draft-reason">{reason}</p>}
              <Button
                variant="approve"
                icon="check"
                disabled={Boolean(reason)}
                onClick={() => {
                  void approve(item);
                }}
              >
                {confirmApprove === item.session_id ? "仍然批准" : "全部批准"}
              </Button>
              {reason === "工程在这之后又改过" && (
                <Button
                  disabled={saving || generating || !available.some((item) => item.agent === agent)}
                  onClick={() =>
                    void send(
                      `请基于主工程的最新版本重做「${title}」（原编辑会话 ${item.session_id}），新建 manual 编辑会话，完成后用 session_review 重新交审。`,
                    )
                  }
                >
                  让 AI 按新版本重做
                </Button>
              )}
              {reason === "这一版没有改动" && (
                <Button disabled={saving || generating} onClick={() => void reject(item.session_id)}>
                  丢掉这一版
                </Button>
              )}
              {changes.length > 0 && (
                <Button icon="image" onClick={() => void showReview(item)}>
                  看对比
                </Button>
              )}
            </section>
          );
        })}
      </div>
      {runningBatch && (
        <output>
          AI 正在做第 {Math.min(runningBatch.count, runningBatch.applied.length + 1)} / {runningBatch.count} 步
        </output>
      )}
      {decision ? (
        <DecisionCard
          key={`${session?.session_id}-${decision.id}`}
          decision={decision}
          done={decisions.length - pending.length}
          total={decisions.length}
          last={pending.length === 1}
          busy={saving || generating}
          answer={(value) => {
            void answer(value);
          }}
        />
      ) : (
        <p className="zc-muted">暂无待定事项</p>
      )}
    </>
  );
  return {
    chat,
    header,
    decisionStatus: (
      <span className="zc-chip is-sm is-attention">
        {permissions.length ? "Agent 在等你" : `${pending.length} 件待定`}
      </span>
    ),
    draftStatus: draftSession ? (
      <span className="zc-chip is-sm is-attention">
        <span className="zc-dot is-attention" />
        AI 草稿 · {draftSession.pending_count} 件待定
      </span>
    ) : null,
    generating,
    reviewActions: {
      approve: async (id: string, pendingCount: number) => {
        const item = ai.sessions.find((item) => item.session_id === id);
        return item ? approve(item, pendingCount) : false;
      },
      reject,
      confirming: confirmApprove,
      busy: saving || generating,
      error,
    },
    parameters,
    send,
    setInput,
    appendInput: (text: string) => {
      focusInput.current = true;
      setSuggestion("");
      setInput((previous) => (previous ? `${previous}\n\n${text}` : text));
    },
    canSend: Boolean(path) && !generating && available.some((item) => item.agent === agent),
  };
}
