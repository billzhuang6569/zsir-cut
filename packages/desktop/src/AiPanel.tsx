import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKind, ChatEvent } from "../../app-host/src/agent-events.js";
import { Button, type Decision, DecisionCard, Markdown, StepRow } from "./ai-components.js";
import { IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import "./ai.css";

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
export interface AiNotice {
  chat: string;
  event: ChatEvent;
}
interface Session {
  session_id: string;
  state: string;
  draft_revision: string;
  decisions: Decision[];
  pending_count: number;
  revision_count: number;
  changes: { entity: string }[];
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
}: {
  call: Call;
  path: string | null;
  project: ProjectView | null;
  notices: AiNotice[];
  revision: number;
}) {
  const [agents, setAgents] = useState<{ agent: AgentKind; available: boolean; version: string | null }[]>([]);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [chatId, setChatId] = useState<string>();
  const currentChat = useRef<string>();
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [generating, setGenerating] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ id: string; agent: AgentKind; title: string }[] | null>(null);
  const [ai, setAi] = useState<AiState>({ sessions: [], batches: [] });
  const [sessionId, setSessionId] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState<string>();
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
        if (first) setAgent(first.agent);
      })
      .catch((e: Error) => setError(e.message));
    void refresh().catch((e: Error) => setError(e.message));
    return () => {
      disposed = true;
    };
  }, [path, call, refresh]);
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
        currentChat.current = notice.chat;
        setChatId(notice.chat);
        setEvents((old) => [...old, notice.event]);
        if (notice.event.type === "end") {
          setGenerating(false);
          void refresh().catch((e: Error) => setError(e.message));
        }
      }
    }
    consumed.current = notices.length;
  }, [notices, refresh]);
  const send = async (text: string) => {
    if (generating || !text.trim()) return;
    if (!agents.some((item) => item.agent === agent && item.available)) {
      setInput(text);
      setError("未检测到所选 Agent，决定回答已保存。");
      return;
    }
    setError("");
    setGenerating(true);
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
      base_revision: verb === "session_approve" ? project?.revision.id : session.draft_revision,
      idempotency_key: crypto.randomUUID(),
      author: { kind: "human", name: "剪辑师" },
      ...extra,
    });
  const session = ai.sessions.find((item) => item.session_id === sessionId) ?? ai.sessions.at(-1);
  const decisions = [...(session?.decisions ?? [])].sort((a, b) => a.seq - b.seq);
  const pending = decisions.filter((item) => item.state === "pending");
  const decision = pending[0];
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
      answers.current.push(`关于『${decision.question}』：${label}`);
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
  const approve = async (item: Session) => {
    if (saving) return;
    if (item.pending_count && confirmApprove !== item.session_id) {
      setConfirmApprove(item.session_id);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await write("session_approve", item, { label: "批准 AI 草稿" });
      setConfirmApprove(undefined);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    tools: { id: string; name: string; input: unknown; live: boolean }[];
  }[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === "user")
      messages.push({ id: `message-${index}`, role: "user", text: event.text ?? "", tools: [] });
    else if (["text", "tool_start", "tool_end", "error"].includes(event.type)) {
      if (messages.at(-1)?.role !== "assistant")
        messages.push({ id: `message-${index}`, role: "assistant", text: "", tools: [] });
      const message = messages.at(-1);
      if (!message) continue;
      if (event.type === "text") message.text += event.text ?? "";
      if (event.type === "error") message.text += `\n${event.text ?? "Agent 出错"}`;
      if (event.type === "tool_start") {
        const existing = message.tools.find((tool) => tool.id === event.id);
        if (existing) {
          if (event.name) existing.name = event.name;
          if (event.input !== undefined) existing.input = event.input;
        } else
          message.tools.push({
            id: event.id ?? String(message.tools.length),
            name: event.name ?? "工具调用",
            input: event.input,
            live: true,
          });
      }
      if (event.type === "tool_end") {
        const tool = message.tools.find((tool) => tool.id === event.id);
        if (tool) tool.live = false;
      }
    } else if (event.type === "end")
      for (const message of messages) for (const tool of message.tools) tool.live = false;
  }
  const available = agents.filter((item) => item.available);
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
          <div className="zc-chat-actions">
            <span className="zc-grow" />
            <IconButton
              icon="new-chat"
              label="新对话"
              disabled={generating}
              onClick={() => {
                currentChat.current = undefined;
                setChatId(undefined);
                setEvents([]);
                setHistory(null);
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
          {history && (
            <ul aria-label="历史对话">
              {history.map((item) => (
                <li key={item.id}>
                  <Button
                    onClick={() => {
                      void call("chat_history", { id: item.id })
                        .then((value) => {
                          const saved = value as { events: ChatEvent[] };
                          currentChat.current = item.id;
                          setChatId(item.id);
                          setAgent(item.agent);
                          setEvents(saved.events);
                          setHistory(null);
                        })
                        .catch((e: Error) => setError(e.message));
                    }}
                  >
                    {item.title}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="zc-chat-messages" role="log" aria-label="对话" aria-live="polite" data-chat={chatId}>
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
                    {message.tools.map((tool) => (
                      <StepRow key={tool.id} live={tool.live} detail={{ tool: tool.name, arguments: tool.input }}>
                        {tool.name}
                      </StepRow>
                    ))}
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
            {ai.sessions
              .filter((item) => item.state === "in_review")
              .map((item) => {
                const changes = item.changes ?? [];
                return (
                  <section className="zc-draft" aria-label="AI 草稿" key={item.session_id}>
                    <strong>草稿</strong>
                    <p>
                      {item.revision_count} 个修订 · {changes.filter((change) => change.entity === "clip").length}{" "}
                      处片段 ·{" "}
                      {
                        changes.filter((change) =>
                          ["cue", "transcript", "run", "token", "override", "free_cue", "style"].includes(
                            change.entity,
                          ),
                        ).length
                      }{" "}
                      处字幕改动
                    </p>
                    {confirmApprove === item.session_id && (
                      <p role="alert">还有 {item.pending_count} 件决定未答，仍要批准吗？</p>
                    )}
                    <Button
                      variant="approve"
                      disabled={saving || generating}
                      onClick={() => {
                        void approve(item);
                      }}
                    >
                      {confirmApprove === item.session_id ? "仍然批准" : "批准"}
                    </Button>
                  </section>
                );
              })}
          </div>
          <div className="zc-chat-input">
            <textarea
              aria-label="发给 AI"
              rows={3}
              value={input}
              placeholder="描述你想怎么剪，@ 引用素材"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
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
              <select
                aria-label="Agent"
                disabled={generating}
                value={agent}
                onChange={(e) => {
                  setAgent(e.target.value as AgentKind);
                  currentChat.current = undefined;
                  setChatId(undefined);
                  setEvents([]);
                }}
              >
                {available.map((item) => (
                  <option key={item.agent} value={item.agent}>
                    {item.agent === "claude" ? "Claude Code" : "Codex"} {item.version}
                  </option>
                ))}
              </select>
              <span className="zc-grow" />
              <IconButton
                icon={generating ? "stop" : "send"}
                label={generating ? "停止" : "发送"}
                disabled={!generating && !input.trim()}
                onClick={() => {
                  if (generating) void call("chat_stop", {}).catch((e: Error) => setError(e.message));
                  else void send(input);
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
      {runningBatch && (
        <output>
          AI 正在做第 {Math.min(runningBatch.count, runningBatch.applied.length + 1)} / {runningBatch.count} 步
        </output>
      )}
      {ai.sessions.length > 1 && (
        <select
          aria-label="编辑会话"
          value={session?.session_id}
          disabled={saving}
          onChange={(e) => {
            setSessionId(e.target.value);
            answers.current = [];
          }}
        >
          {ai.sessions.map((item) => (
            <option key={item.session_id} value={item.session_id}>
              {item.session_id}
            </option>
          ))}
        </select>
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
  return { chat, parameters };
}
