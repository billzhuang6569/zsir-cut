import { useCallback, useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Button, DecisionProgress } from "./ai-components.js";
import { Icon } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
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
}: {
  project: ProjectView | null;
  state: UiState;
  update: (next: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
}) {
  const latest = useRef({ project, state, update });
  latest.current = { project, state, update };
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
    update({ ...state, history, playing: false, preview: "timeline", selected: [] });
  }, []);
  const close = useCallback(() => change({ open: false, revision: null, label: null }), [change]);
  const present = useCallback(() => change({ open: true, revision: null, label: null }), [change]);
  const toggle = useCallback(() => {
    if (latest.current.state.history?.open) close();
    else present();
  }, [close, present]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (latest.current.state.export?.open) return;
      if (event.key === "Escape" && latest.current.state.history?.open) {
        event.preventDefault();
        close();
      }
      if (
        event.metaKey &&
        event.key.toLowerCase() === "y" &&
        !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]"))
      ) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [close, toggle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset pagination when the project changes.
  useEffect(() => {
    loaded.current = false;
    setEntries([]);
    setBatches({});
    setExpanded([]);
    setMore(false);
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
  }, [open, state.project, project?.revision.id, call]);

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
      onClick={() => change({ open: true, revision: entry.revision, label: stepLabel(entry) })}
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
    banner: revision && (
      <div className="zc-history-banner" aria-live="polite">
        <span className="zc-grow">正在看：{state.history?.label}</span>
        <Button
          icon="undo"
          disabled={busy || batchOpen || snapshot?.revision !== revision}
          title={batchOpen ? "AI 批次尚未完成，暂时不能恢复" : undefined}
          onClick={() => void restore()}
        >
          回到这一步
        </Button>
        <Button icon="history" disabled={busy} onClick={present}>
          返回现在
        </Button>
        {batchOpen && <small>AI 批次尚未完成，暂时不能恢复</small>}
      </div>
    ),
    panel: (
      <>
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
          {list}
          {!entries.length && <p className="zc-muted">还没有历史步骤</p>}
          {more && (
            <Button disabled={loading} onClick={() => void loadMore()}>
              {loading ? "正在加载…" : "加载更早的步骤"}
            </Button>
          )}
        </div>
      </>
    ),
  };
}
