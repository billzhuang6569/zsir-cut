import { useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { chapterGroups, chapterMarkdown, chapterTime } from "./chapters.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { compare, frameAt, frameTime, parseRational, seekTarget, timecode } from "./timeline.js";
import "./chapters.css";

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
  const settings = state.chapters ?? { levels: 2, timecodes: true };
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const groups = chapterGroups(project?.markers ?? [], settings.levels);
  const markers = groups.flat();
  const at = project ? seekTarget(project, project.cues, state.playhead) : "0s";
  const active = markers.findLast((m) => compare(parseRational(m.at.t, true), parseRational(at, true)) <= 0);
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
        author: { kind: "human", name: "桌面用户" },
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
      <fieldset className="zc-chapter-views" aria-label="章节视图">
        <button
          type="button"
          className="zc-chapter-view"
          aria-pressed
          onClick={() => update({ ...state, sub: "outline" })}
        >
          <Icon name="list" />
          大纲
        </button>
        <button type="button" className="zc-chapter-view" disabled>
          <Icon name="grid" />
          思维导图<small>下个版本</small>
        </button>
        <button type="button" className="zc-chapter-view" disabled>
          <Icon name="clip" />
          时间地图<small>下个版本</small>
        </button>
      </fieldset>
      <section>
        <h3>显示</h3>
        <label className="zc-chapter-setting">
          标题层级
          <select
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
            className="zc-chapter-switch"
            role="switch"
            aria-checked={settings.timecodes}
            aria-label="显示时间码"
            checked={settings.timecodes}
            onChange={(e) => update({ ...state, chapters: { ...settings, timecodes: e.target.checked } })}
          />
        </label>
      </section>
      <section>
        <h3>生成</h3>
        <div className="zc-chapter-actions">
          <button
            type="button"
            className="zc-btn zc-btn-primary"
            disabled={!project || !canGenerate}
            title={!project ? "请先打开工程" : !canGenerate ? "暂无可用的 Agent，或 Agent 正在生成中" : undefined}
            onClick={generate}
          >
            <Icon name="spark" />让 AI 重新分章
          </button>
          <button
            type="button"
            className="zc-btn zc-btn-secondary"
            disabled={!markers.length}
            title={!markers.length ? "暂无可复制的章节" : undefined}
            onClick={() => {
              setError("");
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(chapterMarkdown(project?.markers ?? [], settings.levels)))
                .then(() => setCopied(true))
                .catch(() => setError("复制失败，请检查剪贴板权限后重试"));
            }}
          >
            <Icon name={copied ? "check" : "md"} />
            {copied ? "已复制" : "复制 Markdown"}
          </button>
        </div>
      </section>
    </div>
  );
  const all = chapterGroups(project?.markers ?? [], 2).flat();
  const outline = (
    <div className="zc-chapter-outline">
      <header className="zc-chapter-stats">
        <span role="img" aria-label={`${all.filter((m) => m.level !== 2).length} 章`}>
          <span aria-hidden="true">#</span>
          {all.filter((m) => m.level !== 2).length}
        </span>
        <span role="img" aria-label={`${all.filter((m) => m.level === 2).length} 节`}>
          <span aria-hidden="true">##</span>
          {all.filter((m) => m.level === 2).length}
        </span>
        <span role="img" aria-label={`总长 ${chapterTime(project?.duration.t ?? "0s")}`}>
          <Icon name="play" />
          {chapterTime(project?.duration.t ?? "0s")}
        </span>
        <span className="zc-grow" />
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
      {groups.map((group) => (
        <section
          className="zc-chapter-group"
          aria-label={group[0]?.level === 2 ? "未归组的小节" : group[0]?.text}
          key={group[0]?.id}
        >
          {group.map((m) => (
            <div className={`zc-chapter-row${m.level === 2 ? " is-section" : ""}`} key={m.id}>
              <span className="zc-chapter-hash" aria-hidden="true">
                {m.level === 2 ? "##" : "#"}
              </span>
              {editing === m.id ? (
                <input
                  className="zc-input"
                  aria-label="章节名称"
                  value={draft}
                  disabled={busy}
                  ref={(input) => input?.focus()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft !== m.text)
                      void write({ op: "update_marker", marker_id: m.id, text: draft }, `重命名章节「${m.text}」`);
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
                  aria-current={active?.id === m.id ? "location" : undefined}
                  onClick={() => update({ ...state, playhead: { at: m.at.t }, preview: "timeline", playing: false })}
                  onDoubleClick={() => {
                    setEditing(m.id);
                    setDraft(m.text);
                  }}
                >
                  {m.text}
                </button>
              )}
              {settings.timecodes && project && <time>{timecode(m.at.t, project)}</time>}
              <details className="zc-chapter-menu">
                <summary aria-label={`章节菜单：${m.text}`}>
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
                          `把章节「${m.text}」改为${level === 1 ? "一级" : "二级"}标题`,
                        )
                      }
                    >
                      {level === 1 ? "一级标题" : "二级标题"}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void write({ op: "remove_marker", marker_id: m.id }, `删除章节「${m.text}」`)}
                  >
                    <Icon name="trash" />
                    删除
                  </button>
                </div>
              </details>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
  return { controls, outline };
}
