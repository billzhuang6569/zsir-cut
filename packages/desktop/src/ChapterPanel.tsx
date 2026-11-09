import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type Chapter, type ChaptersView, chapterMarkdown, chapterTime } from "./chapters.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import type { UiState } from "./state.js";
import { compare, frameAt, frameTime, numberOf, parseRational, pointerTime, seekTarget } from "./timeline.js";
import "./chapters.css";

const EMPTY_FOLDED: string[] = [];

export function useChapterPanel({
  project,
  state,
  update,
  call,
  canGenerate,
  generate,
}: {
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  canGenerate: boolean;
  generate: () => void;
}) {
  const settings = {
    ...state.chapters,
    levels: state.chapters?.levels ?? 2,
    timecodes: state.chapters?.timecodes ?? true,
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [hiddenDescriptions, setHiddenDescriptions] = useState<string[]>([]);
  const outlineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      const keyboard = event instanceof KeyboardEvent;
      if (keyboard && event.key !== "Escape") return;
      const menu = outlineRef.current?.querySelector<HTMLDetailsElement>(".zc-chapter-menu[open]");
      if (!menu || (!keyboard && event.target instanceof Node && menu.contains(event.target))) return;
      menu.open = false;
      if (keyboard) menu.querySelector("summary")?.focus();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const [data, setData] = useState<ChaptersView>({ chapters: [], total: { t: "0s" } });
  const latest = useRef(state);
  latest.current = state;
  const view = settings.view ?? "outline";
  const folded = settings.folded ?? EMPTY_FOLDED;
  const zoom = settings.zoom ?? 1;
  const [ready, setReady] = useState(false);
  const readyProject = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readyProject.current = null;
    setReady(false);
    if (!state.project) return;
    void call("prefs_get", {})
      .then((result) => {
        const prefs = (
          result as {
            prefs?: {
              ui: { snap: boolean; chapters: { view: "outline" | "timeline"; zoom: number; folded: string[] } };
            };
          }
        ).prefs;
        if (!cancelled && prefs)
          update({
            ...latest.current,
            snap: prefs.ui.snap,
            sub: latest.current.panel === "chapters" ? prefs.ui.chapters.view : latest.current.sub,
            chapters: { levels: 2, timecodes: true, ...latest.current.chapters, ...prefs.ui.chapters },
          });
        if (!cancelled) {
          readyProject.current = state.project;
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError("章节偏好读取失败，请重新打开工程");
      });
    return () => {
      cancelled = true;
    };
  }, [call, update, state.project]);
  useEffect(() => {
    if (!ready || readyProject.current !== state.project) return;
    void call("prefs_set", { patch: { ui: { chapters: { view, zoom, folded } } } }).catch(() =>
      setError("章节偏好保存失败，请重试"),
    );
  }, [call, ready, view, zoom, folded, state.project]);
  useEffect(() => {
    let cancelled = false;
    setData({ chapters: [], total: { t: "0s" } });
    if (project)
      void call("inspect", {
        project: state.project,
        timeline_id: project.id,
        view: "chapters",
        ...(state.history?.revision ? { at_revision: state.history.revision } : {}),
      })
        .then((result) => {
          if (!cancelled && (result as ChaptersView).chapters) setData(result as ChaptersView);
        })
        .catch(() => {
          if (!cancelled) setError("章节读取失败，请重试");
        });
    return () => {
      cancelled = true;
    };
  }, [call, project, state.project, state.history?.revision]);
  const groups = data.chapters;
  const markers = groups.flatMap((g) => [...(g.id ? [g] : []), ...(settings.levels === 2 ? g.sections : [])]);
  const at = project ? seekTarget(project, project.cues, state.playhead) : "0s";
  const contains = (m: Chapter) =>
    compare(parseRational(m.start.t, true), parseRational(at, true)) <= 0 &&
    compare(parseRational(at, true), parseRational(m.end.t, true)) < 0;
  const seek = (start: string) => {
    void call("ui_seek", { at: start }).catch(() => setError("跳转失败，请重试"));
  };
  const change = (patch: Partial<typeof settings>) =>
    update({ ...state, sub: patch.view ?? state.sub, chapters: { ...settings, ...patch } });
  const fold = (id: string) =>
    change({ folded: folded.includes(id) ? folded.filter((item) => item !== id) : [...folded, id] });
  const write = async (op: Record<string, unknown>, label: string) => {
    if (!project || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await call("edit", {
        project: state.project,
        timeline_id: project.id,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label,
        ops: [op],
      });
      setEditing(null);
    } catch {
      setError("章节修改失败，请检查工程后重试");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const controls = (
    <div className="zc-chapter-controls">
      <section>
        <h3>视图</h3>
        <fieldset className="zc-seg is-block zc-chapter-views" aria-label="章节视图">
          {(["outline", "timeline"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={view === value ? "is-active" : ""}
              aria-pressed={view === value}
              onClick={() => change({ view: value })}
            >
              <Icon name="chapters" />
              {value === "outline" ? "大纲" : "时间轴"}
            </button>
          ))}
        </fieldset>
      </section>
      <section>
        <h3>显示</h3>
        <label className="zc-chapter-setting">
          标题层级
          <select
            className="zc-select"
            aria-label="标题层级"
            value={settings.levels}
            onChange={(e) => update({ ...state, chapters: { ...settings, levels: e.target.value === "1" ? 1 : 2 } })}
          >
            <option value="1">只看一级</option>
            <option value="2">一级加二级</option>
          </select>
        </label>
        <label className="zc-chapter-setting">
          显示时间码
          <input
            type="checkbox"
            className={`zc-switch${settings.timecodes ? " is-on" : ""}`}
            role="switch"
            aria-checked={settings.timecodes}
            aria-label="显示时间码"
            checked={settings.timecodes}
            onChange={(e) => update({ ...state, chapters: { ...settings, timecodes: e.target.checked } })}
          />
        </label>
      </section>
      <section className="zc-chapter-generation">
        <h3>生成</h3>
        <div className="zc-chapter-actions">
          <button
            type="button"
            className="zc-btn zc-btn-secondary"
            disabled={!project || !canGenerate}
            title={!project ? "请先打开工程" : !canGenerate ? "暂无可用的 Agent，或 Agent 正在生成中" : undefined}
            onClick={generate}
          >
            <Icon name="spark" />让 AI 重新分章
          </button>
          <button
            type="button"
            className="zc-btn zc-btn-text"
            disabled={!markers.length}
            title={!markers.length ? "暂无可复制的章节" : undefined}
            onClick={() => {
              setError("");
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(chapterMarkdown(markers)))
                .then(() => setCopied(true))
                .catch(() => setError("复制失败，请检查剪贴板权限后重试"));
            }}
          >
            <Icon name={copied ? "check" : "md"} />
            {copied ? "已复制" : "复制为 Markdown"}
          </button>
        </div>
      </section>
    </div>
  );
  const all = groups.flatMap((g) => [...(g.id ? [g] : []), ...g.sections]);
  const outline = (
    <div className="zc-chapter-outline" ref={outlineRef}>
      <header className="zc-chapter-header">
        <h2>{view === "outline" ? "章节大纲" : "章节时间轴"}</h2>
        <span className="zc-meta">
          {groups.filter((g) => g.id).length} 章 · {chapterTime(data.total.t).padStart(5, "0")}
        </span>
        <IconButton
          icon="plus"
          label="在播放头加一节"
          disabled={!project || busy}
          onClick={() =>
            void write(
              {
                op: "add_marker",
                at: project ? frameTime(frameAt(at, project.edit_rate), project.edit_rate) : "0s",
                duration: "0s",
                kind: "chapter",
                text: "新章节",
                level: 2,
              },
              "在播放头加一节",
            )
          }
        />
      </header>
      {error && <p role="alert">{error}</p>}
      {!markers.length && <p className="zc-muted">暂无章节</p>}
      {view === "outline" ? (
        <>
          <div className="zc-chapter-folds">
            <button
              type="button"
              onClick={() => {
                change({ folded: [] });
                setHiddenDescriptions([]);
              }}
            >
              全部展开
            </button>
            ｜
            <button
              type="button"
              onClick={() => {
                change({ folded: groups.flatMap((g) => (g.id ? [g.id] : [])) });
                setHiddenDescriptions(all.flatMap((m) => (m.id ? [m.id] : [])));
              }}
            >
              全部折叠
            </button>
          </div>
          {groups.map((group) => (
            <section
              className={`zc-chapter-group${contains(group) ? " is-current" : ""}`}
              aria-label={group.title ?? "未归组的小节"}
              key={group.id ?? "orphans"}
            >
              {[
                ...(group.id ? [group] : []),
                ...(settings.levels === 2 && !folded.includes(group.id ?? "") ? group.sections : []),
              ].map((m) => (
                <div className={`zc-chapter-row${m.level === 2 ? " is-section" : ""}`} key={m.id}>
                  {settings.timecodes && project && (
                    <time>
                      {m.start.tc ?? chapterTime(m.start.t)} – {m.end.tc ?? chapterTime(m.end.t)} ·{" "}
                      {chapterTime(m.duration.t)}
                    </time>
                  )}
                  {m.level === 2 ? (
                    <button
                      type="button"
                      className="zc-chapter-fold"
                      aria-label={`描述：${m.title}`}
                      aria-expanded={!hiddenDescriptions.includes(m.id ?? "")}
                      onClick={() =>
                        setHiddenDescriptions((ids) =>
                          ids.includes(m.id ?? "") ? ids.filter((id) => id !== m.id) : [...ids, m.id ?? ""],
                        )
                      }
                    >
                      <Icon name={hiddenDescriptions.includes(m.id ?? "") ? "right" : "down"} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="zc-chapter-fold zc-chapter-mark"
                      aria-label={`折叠：${group.title}`}
                      aria-expanded={!folded.includes(group.id ?? "")}
                      onClick={() => fold(group.id ?? "")}
                    >
                      <span aria-hidden="true" />
                    </button>
                  )}
                  {editing === m.id ? (
                    <input
                      className="zc-input"
                      aria-label="章节名称"
                      value={draft}
                      disabled={busy}
                      ref={(input) => input?.focus()}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => {
                        if (draft !== m.title)
                          void write({ op: "update_marker", marker_id: m.id, text: draft }, `重命名章节「${m.title}」`);
                        else setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="zc-chapter-title"
                      aria-current={contains(m) ? "location" : undefined}
                      onClick={() => seek(m.start.t)}
                      onDoubleClick={() => {
                        setEditing(m.id);
                        setDraft(m.title ?? "");
                      }}
                    >
                      {m.title}
                    </button>
                  )}
                  <details
                    className="zc-chapter-menu"
                    onToggle={(event) => {
                      if (!event.currentTarget.open) return;
                      for (const menu of outlineRef.current?.querySelectorAll<HTMLDetailsElement>(
                        ".zc-chapter-menu[open]",
                      ) ?? []) {
                        if (menu !== event.currentTarget) menu.open = false;
                      }
                    }}
                  >
                    <summary aria-label={`章节菜单：${m.title}`}>
                      <Icon name="down" />
                    </summary>
                    <div>
                      {([1, 2] as const).map((level) => (
                        <button
                          type="button"
                          key={level}
                          disabled={busy || (m.level ?? 1) === level}
                          onClick={() =>
                            void write(
                              { op: "update_marker", marker_id: m.id, level },
                              `把章节「${m.title}」改为${level === 1 ? "一级" : "二级"}标题`,
                            )
                          }
                        >
                          {level === 1 ? "一级标题" : "二级标题"}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void write({ op: "remove_marker", marker_id: m.id }, `删除章节「${m.title}」`)}
                      >
                        <Icon name="trash" />
                        删除
                      </button>
                    </div>
                  </details>
                  {m.description && !hiddenDescriptions.includes(m.id ?? "") && (
                    <p className="zc-chapter-description">{m.description}</p>
                  )}
                </div>
              ))}
            </section>
          ))}
        </>
      ) : (
        <ChapterRail
          groups={groups}
          total={data.total.t}
          at={at}
          levels={settings.levels}
          zoom={zoom}
          timecodes={settings.timecodes}
          snap={state.snap ?? true}
          seek={seek}
          change={change}
        />
      )}
    </div>
  );
  return { controls, outline };
}

function ChapterRail({
  groups,
  total,
  at,
  levels,
  zoom,
  snap,
  timecodes,
  seek,
  change,
}: {
  groups: ChaptersView["chapters"];
  total: string;
  at: string;
  levels: 1 | 2;
  zoom: number;
  snap: boolean;
  timecodes: boolean;
  seek: (at: string) => void;
  change: (patch: { levels?: 1 | 2; zoom?: number }) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    if (!viewport.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const seconds = (t: string) => numberOf(parseRational(t, true));
  const scale = Math.max(1, Math.round(((height - 24) * zoom * 1000) / Math.max(seconds(total), 1)));
  const y = (t: string) => (seconds(t) * scale) / 1000;
  let lastLabel = -44;
  const labels = groups
    .flatMap((g) => [...(g.id ? [g] : []), ...(levels === 2 ? g.sections : [])])
    .map((m) => {
      const top = Math.max(y(m.start.t), lastLabel + 44);
      lastLabel = top;
      return { m, top };
    });
  return (
    <div className="zc-chapter-timeline">
      <header className="zc-chapter-rail-header">
        <fieldset className="zc-seg" aria-label="时间轴层级">
          {([1, 2] as const).map((level) => (
            <button
              type="button"
              key={level}
              className={levels === level ? "is-active" : ""}
              aria-pressed={levels === level}
              onClick={() => change({ levels: level })}
            >
              {level === 1 ? "一级" : "二级"}
            </button>
          ))}
        </fieldset>
        <input
          aria-label="章节时间轴缩放"
          type="range"
          min="0.5"
          max="4"
          step="0.1"
          value={zoom}
          onChange={(e) => change({ zoom: Number(e.target.value) })}
        />
      </header>
      <div className="zc-chapter-rail-scroll" ref={viewport}>
        <div className="zc-chapter-rail" style={{ height: Math.max(y(total), lastLabel + 44) + 12 }}>
          <div
            className="zc-chapter-scrub"
            role="slider"
            tabIndex={0}
            aria-label="章节播放头"
            aria-valuemin={0}
            aria-valuemax={seconds(total)}
            aria-valuenow={seconds(at)}
            onKeyDown={(e) => {
              if (["Home", "End", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
              if (e.key === "ArrowUp" || e.key === "ArrowDown")
                seek(
                  pointerTime(
                    Math.max(0, Math.min(y(total), y(at) + (e.key === "ArrowUp" ? -scale / 1000 : scale / 1000))) *
                      1000,
                    scale,
                    "1000",
                  ),
                );
              if (e.key === "Home") seek("0s");
              if (e.key === "End") seek(total);
            }}
            onClick={(e) => {
              const pixels = Math.max(0, Math.min(y(total), e.clientY - e.currentTarget.getBoundingClientRect().top));
              const nearest = groups
                .flatMap((group) => [group, ...group.sections])
                .reduce<Chapter | null>(
                  (best, m) =>
                    !best || Math.abs(y(m.start.t) - pixels) < Math.abs(y(best.start.t) - pixels) ? m : best,
                  null,
                );
              seek(
                snap && !e.metaKey && nearest && Math.abs(y(nearest.start.t) - pixels) <= 8
                  ? nearest.start.t
                  : pointerTime(pixels * 1000, scale, "1000"),
              );
            }}
          />
          {groups.map((group) => (
            <div key={group.id ?? "orphans"} className={`zc-chapter-colour hue-${group.hue % 5}`}>
              <button
                type="button"
                className={`zc-chap-block${levels === 2 && group.sections.length ? " is-parent" : ""}`}
                style={{ top: y(group.start.t), height: Math.max(4, y(group.duration.t)) }}
                aria-label={group.title ?? "未归组的小节"}
                onClick={() => seek(group.start.t)}
              >
                <span>{chapterTime(group.duration.t)}</span>
              </button>
              {group.sections.map((m, index) => (
                <button
                  type="button"
                  key={m.id}
                  className={`zc-chap-block is-section shade-${index % 3}`}
                  style={
                    {
                      top: y(m.start.t),
                      height: Math.max(4, y(m.duration.t)),
                      opacity: levels === 2 ? 1 : 0,
                      pointerEvents: levels === 2 ? "auto" : "none",
                    } as CSSProperties
                  }
                  tabIndex={levels === 2 ? 0 : -1}
                  aria-hidden={levels !== 2}
                  aria-label={m.title ?? "小节"}
                  onClick={() => seek(m.start.t)}
                >
                  {y(m.duration.t) >= 20 && <span>{chapterTime(m.duration.t)}</span>}
                </button>
              ))}
            </div>
          ))}
          <svg className="zc-chapter-leaders" width="94" height="100%" aria-hidden="true">
            {labels.map(({ m, top }) => (
              <path key={m.id} d={`M60 ${y(m.start.t) + 2} H70 L84 ${top + 10} H94`} />
            ))}
          </svg>
          {labels.map(({ m, top }) => (
            <button
              key={m.id}
              type="button"
              className={`zc-chap-label hue-${m.hue % 5}${m.level === 1 ? " is-chapter" : ""}`}
              style={{ top }}
              onClick={() => seek(m.start.t)}
            >
              <strong>{m.title}</strong>
              {timecodes && (
                <small>
                  {m.start.tc ?? chapterTime(m.start.t)} – {m.end.tc ?? chapterTime(m.end.t)} ·{" "}
                  {chapterTime(m.duration.t)}
                </small>
              )}
            </button>
          ))}
          <div className="zc-chap-playhead" style={{ top: y(at) }} />
        </div>
      </div>
    </div>
  );
}
