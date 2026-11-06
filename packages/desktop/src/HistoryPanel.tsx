import { useCallback, useEffect, useRef, useState } from "react";
import type { EntityChange } from "../../core/dist/project/entities.js";
import { Button, DecisionProgress } from "./ai-components.js";
import { Icon } from "./components.js";
import type { ProjectView, Subscribe } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { type HistoryDecision, HistoryDecisions, HistoryReport } from "./HistoryReport.js";
import type { UiState } from "./state.js";
import "./history.css";

export interface HistoryEntry {
  revision: string;
  seq: number;
  at: string;
  kind: string;
  label: string | null;
  author?: { kind: string; name: string };
  batch: { id: string; seq: number; count: number } | null;
  target?: string;
  reason?: string | null;
  session_id?: string | null;
  changes?: EntityChange[];
}
interface BatchStatus {
  state: string;
  count: number;
  applied: number[];
}
const stepLabel = (entry: HistoryEntry) => entry.label || "工程修改";
function relativeTime(at: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export function useHistoryPanel({
  project,
  state,
  update,
  call,
  subscribe,
}: {
  subscribe?: Subscribe;
  project: ProjectView | null;
  state: UiState;
  update: (next: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
}) {
  const latest = useRef({ project, state, update });
  latest.current = { project, state, update };
  const anchor = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<{ session_id: string; intent?: string; revision_count: number }[]>([]);
  const [decisions, setDecisions] = useState<{ revision: string; items: HistoryDecision[] } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [batches, setBatches] = useState<Record<string, BatchStatus>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{ revision: string; view: ProjectView } | null>(null);
  const pageBusy = useRef(false);
  const loaded = useRef(false);
  const generation = useRef(0);
  const open = state.history?.open === true;
  const revision = state.history?.revision;
  const change = useCallback((history: NonNullable<UiState["history"]>) => {
    const { state, update } = latest.current;
    update({
      ...state,
      history: { ...history, viewing: history.revision },
      playing: false,
      preview: "timeline",
      selected: [],
      edit_point: null,
    });
  }, []);
  const setOpen = useCallback((open: boolean) => {
    const { state, update } = latest.current;
    update({
      ...state,
      history: { revision: null, label: null, ...state.history, open, viewing: state.history?.revision ?? null },
    });
  }, []);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const present = useCallback(() => change({ open: true, revision: null, label: null }), [change]);
  const toggle = useCallback(() => {
    if (latest.current.state.history?.open) close();
    else setOpen(true);
  }, [close, setOpen]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (latest.current.state.export?.open) return;
      if (event.key === "Escape" && latest.current.state.history?.open) {
        event.preventDefault();
        close();
        anchor.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [close]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (latest.current.state.history?.open && event.target instanceof Node && !anchor.current?.contains(event.target))
        close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close]);
  useEffect(
    () =>
      subscribe?.((message) => {
        if (message.type === "project_changed" || message.type === "ai_changed")
          setRefreshVersion((value) => value + 1);
      }),
    [subscribe],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset pagination when the project changes.
  useEffect(() => {
    loaded.current = false;
    setEntries([]);
    setBatches({});
    setExpanded([]);
    setMore(false);
    setDrafts([]);
    setSnapshot(null);
    setDecisions(null);
    setError("");
    setReadError("");
  }, [state.project]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh immediately on project_changed as well as polling batches.
  useEffect(() => {
    const epoch = ++generation.current;
    if (!open || !state.project) return;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = (await call("inspect", { project: state.project, view: "history", limit: 20 })) as {
          entries: HistoryEntry[];
        };
        // Catch up if more than one page was written between refreshes.
        const previous = entriesRef.current[0];
        while (previous && result.entries.length && (result.entries.at(-1)?.seq ?? 0) > previous.seq) {
          const page = (await call("inspect", {
            project: state.project,
            view: "history",
            limit: 20,
            before: result.entries.at(-1)?.revision,
          })) as { entries: HistoryEntry[] };
          if (generation.current !== epoch) return;
          if (!page.entries.length) break;
          result.entries.push(...page.entries);
        }
        if (generation.current !== epoch) return;
        setEntries((old) =>
          [...new Map([...old, ...result.entries].map((entry) => [entry.revision, entry])).values()].sort(
            (a, b) => b.seq - a.seq,
          ),
        );
        if (!loaded.current) {
          setMore(result.entries.length === 20);
          loaded.current = true;
        }
        const ai = (await call("ai_state", {})) as {
          sessions?: { session_id: string; state: string; intent?: string; revision_count: number }[];
        };
        if (generation.current !== epoch) return;
        setDrafts(
          (ai.sessions ?? []).filter((item) => ["open", "in_review"].includes(item.state) && item.revision_count > 0),
        );
        const ids = [
          ...new Set([
            ...(latest.current.project?.historyBatches ?? []),
            ...result.entries.flatMap((entry) => (entry.batch ? [entry.batch.id] : [])),
          ]),
        ];
        const statuses = await Promise.all(
          ids.map(async (id) => [id, await call("batch_status", { project: state.project, batch_id: id })] as const),
        );
        if (generation.current === epoch) {
          setBatches(Object.fromEntries(statuses) as Record<string, BatchStatus>);
          setReadError("");
        }
      } catch {
        if (generation.current === epoch) setReadError("历史读取失败，请重试");
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      ++generation.current;
      clearInterval(timer);
    };
  }, [open, state.project, project?.revision.id, refreshVersion, call]);

  useEffect(() => {
    setSnapshot(null);
    if (!revision || !state.project) return;
    let cancelled = false;
    const request = { project: state.project, at_revision: revision };
    void Promise.all([call("inspect", { ...request, view: "timeline" }), call("preview_data", request)])
      .then(([timeline, preview]) => {
        const project = latest.current.project;
        if (!cancelled && project)
          setSnapshot({
            revision,
            view: { ...project, ...(timeline as ProjectView), ...(preview as ProjectView) },
          });
      })
      .catch(() => {
        if (!cancelled) setError("历史预览读取失败，请返回现在后重试");
      });
    return () => {
      cancelled = true;
    };
  }, [revision, state.project, call]);

  const selected = entries.find((entry) => entry.revision === revision);
  const sessionId = selected?.session_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Session decisions can change without a main revision.
  useEffect(() => {
    setDecisions(null);
    if (!revision || !sessionId || !state.project) return;
    let active = true;
    void call("inspect", { project: state.project, view: "session", session_id: sessionId })
      .then((result) => {
        if (active) setDecisions({ revision, items: (result as { decisions: HistoryDecision[] }).decisions });
      })
      .catch(() => {
        if (active) setError("决定读取失败，请重试");
      });
    return () => {
      active = false;
    };
  }, [revision, sessionId, state.project, call, refreshVersion]);
  const selectedDecisions = decisions && decisions.revision === revision ? decisions.items : [];

  const loadMore = useCallback(async () => {
    if (!more || pageBusy.current || !entries.length) return;
    pageBusy.current = true;
    setLoading(true);
    const epoch = generation.current;
    try {
      const result = (await call("inspect", {
        project: state.project,
        view: "history",
        limit: 20,
        before: entries.at(-1)?.revision,
      })) as { entries: HistoryEntry[] };
      if (epoch !== generation.current) return;
      setEntries((old) =>
        [...new Map([...old, ...result.entries].map((entry) => [entry.revision, entry])).values()].sort(
          (a, b) => b.seq - a.seq,
        ),
      );
      setMore(result.entries.length === 20);
    } catch {
      setError("更早的历史读取失败，请重试");
    } finally {
      pageBusy.current = false;
      setLoading(false);
    }
  }, [more, entries, call, state.project]);
  const batchOpen = Object.values(batches).some((batch) => batch.state === "open");
  const restore = async () => {
    const { project, state } = latest.current;
    if (!project || !state.history?.revision || busy || batchOpen) return;
    setBusy(true);
    setError("");
    try {
      await call("restore", {
        project: state.project,
        target: state.history.revision,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label: `回到：${state.history.label ?? "工程修改"}`.slice(0, 80),
      });
      present();
      setRefreshVersion((value) => value + 1);
    } catch (cause) {
      setError(
        String(cause instanceof Error ? cause.cause : cause).includes("E_BATCH_OPEN")
          ? "AI 批次尚未完成，暂时不能恢复"
          : "恢复失败，请检查工程状态后重试",
      );
    } finally {
      setBusy(false);
    }
  };
  const row = (entry: HistoryEntry) => (
    <button
      type="button"
      className="zc-step zc-history-step"
      key={entry.revision}
      aria-pressed={revision === entry.revision}
      title={entry.author?.name}
      onClick={() => {
        setError("");
        change({ open: true, revision: entry.revision, label: stepLabel(entry) });
      }}
    >
      <span role="img" aria-label={entry.kind === "restore" ? "恢复" : entry.author?.kind === "agent" ? "Agent" : "人"}>
        <Icon name={entry.kind === "restore" ? "undo" : entry.author?.kind === "agent" ? "spark" : "human"} />
      </span>
      <span className="zc-grow">
        {entry.kind === "restore" ? `回到了 ${stepLabel(entry).replace(/^回到[：:]\s*/, "")}` : stepLabel(entry)}
      </span>
      {entry.revision === project?.revision.id && <small>现在</small>}
      <time dateTime={entry.at} title={new Date(entry.at).toLocaleString("zh-CN")}>
        {relativeTime(entry.at)}
      </time>
    </button>
  );
  useEffect(() => {
    if (!open || !entries.length || pageBusy.current) return;
    const last = entries.at(-1);
    if (last?.batch && last.batch.seq > 1) void loadMore();
  }, [open, entries, loadMore]);
  const seen = new Set<string>();
  const list = entries.map((entry) => {
    if (!entry.batch) return row(entry);
    const batch = entry.batch;
    if (seen.has(batch.id)) return null;
    seen.add(batch.id);
    const steps = entries.filter((item) => item.batch?.id === batch.id);
    const first = steps.find((item) => item.batch?.seq === 1);
    const isExpanded = expanded.includes(batch.id);
    return (
      <div key={batch.id}>
        <button
          type="button"
          className="zc-step"
          aria-expanded={isExpanded}
          onClick={() => setExpanded((old) => (isExpanded ? old.filter((id) => id !== batch.id) : [...old, batch.id]))}
        >
          <Icon name={isExpanded ? "down" : "chevron"} />
          <span className="zc-grow">{first ? stepLabel(first) : "AI 批次"}</span>
          <small>{batch.count} 步</small>
        </button>
        {isExpanded && <div className="zc-history-group">{steps.map(row)}</div>}
      </div>
    );
  });
  return {
    toggle,
    viewing: Boolean(revision),
    view: revision ? (snapshot?.revision === revision ? snapshot.view : null) : project,
    anchor,
    report: <HistoryReport entry={selected} decisions={selectedDecisions} />,
    decisions: <HistoryDecisions decisions={selectedDecisions} />,
    banner: revision && (
      <span className="zc-history-banner" aria-live="polite">
        正在看：{state.history?.label}
      </span>
    ),
    panel: open && (
      <section className="zc-popover zc-history-popover" role="dialog" aria-label="历史">
        <span className="zc-popover-caret" />
        <div className="zc-history-heading">
          <h2>历史</h2>
          <Button icon="close" onClick={close}>
            关闭
          </Button>
        </div>
        {Object.entries(batches)
          .filter(([, batch]) => batch.state === "open")
          .map(([id, batch]) => (
            <output className="zc-history-progress" key={id}>
              <DecisionProgress done={batch.applied.length} total={batch.count} />
              AI 正在做第 {Math.min(batch.applied.length + 1, batch.count)} / {batch.count} 步
            </output>
          ))}
        {(error || readError) && <p role="alert">{error || readError}</p>}
        <div
          className="zc-history-list"
          onScroll={(event) => {
            const node = event.currentTarget;
            if (node.scrollHeight - node.scrollTop - node.clientHeight < 32) void loadMore();
          }}
        >
          {drafts.map((draft) => (
            <button
              type="button"
              className="zc-step zc-history-draft"
              key={draft.session_id}
              onClick={() => {
                change({ open: false, revision: null, label: null });
                window.dispatchEvent(new CustomEvent("desktop-open-review", { detail: draft.session_id }));
              }}
            >
              <Icon name="spark" />
              <span className="zc-grow">
                {draft.intent || "AI 草稿"}
                <small>{draft.revision_count} 步</small>
              </span>
              <span className="zc-chip is-sm is-attention">待审 ›</span>
            </button>
          ))}
          {list}
          {!entries.length && !drafts.length && <p className="zc-muted">还没有历史步骤</p>}
          {more && (
            <Button disabled={loading} onClick={() => void loadMore()}>
              {loading ? "正在加载…" : "加载更早的步骤"}
            </Button>
          )}
        </div>
        <footer className="zc-history-footer">
          <Button
            icon="undo"
            disabled={!revision || busy || batchOpen || snapshot?.revision !== revision}
            title={batchOpen ? "AI 批次尚未完成，暂时不能恢复" : undefined}
            onClick={() => void restore()}
          >
            回到这一步
          </Button>
          <Button disabled={busy} onClick={present}>
            回到最新
          </Button>
        </footer>
      </section>
    ),
  };
}
