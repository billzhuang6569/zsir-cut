import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Layout } from "../../app-host/src/preferences.js";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { PANELS, type Panel } from "../../app-host/src/ui.js";
import { type AiNotice, useAiPanel } from "./AiPanel.js";
import { useChapterPanel } from "./ChapterPanel.js";
import { Icon, IconButton } from "./components.js";
import {
  connectHost,
  type PermissionRequest,
  type ProjectView,
  type Subscribe,
  useTimelinePreferences,
} from "./connection.js";
import { ExportPanel } from "./ExportPanel.js";
import { useHistoryPanel } from "./HistoryPanel.js";
import { LayoutDivider } from "./LayoutDivider.js";
import { useMediaPanel } from "./MediaPanel.js";
import { sourceProject } from "./media.js";
import { ProjectEntry } from "./ProjectEntry.js";
import { ReviewView } from "./ReviewView.js";
import { SettingsPage } from "./SettingsPage.js";
import { useSubtitlePanel } from "./SubtitlePanel.js";
import { recordedKey } from "./settings-keymap.js";
import { applyUi, initialState, type UiState } from "./state.js";
import { TimelinePreview } from "./TimelinePreview.js";
import { seekTarget } from "./timeline.js";
import { useVoicePanel } from "./VoicePanel.js";
import "./panels.css";

const labels: Record<Panel, string> = { ai: "AI", media: "素材", chapters: "章节", subtitles: "字幕", voice: "语音" };
const parameters: Record<Panel, string> = {
  ai: "决定",
  media: "素材信息",
  chapters: "章节大纲",
  subtitles: "字幕",
  voice: "配音",
};
export function App({ config }: { config?: { port: number; token: string } }) {
  const uniqueId = useId();
  const [revisionControls, setRevisionControls] = useState<HTMLSpanElement | null>(null);
  const [layoutDraft, setLayoutDraft] = useState<Partial<Layout>>({});
  const [viewerTarget, setViewerTarget] = useState<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewSession, setReviewSession] = useState<string | null>(null);
  const reviewSessionRef = useRef(reviewSession);
  reviewSessionRef.current = reviewSession;
  const [reviewTarget, setReviewTarget] = useState<HTMLElement | null>(null);
  const [projectChange, setProjectChange] = useState<ProjectChanged | null>(null);
  const [state, setState] = useState<UiState>(initialState);
  const current = useRef(state);
  const [project, setProject] = useState<ProjectView | null>(null);
  const connection = useRef<ReturnType<typeof connectHost> | null>(null);
  const subscribe: Subscribe = useCallback((listener) => connection.current?.subscribe(listener) ?? (() => {}), []);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [notices, setNotices] = useState<AiNotice[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [aiRevision, setAiRevision] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const rawCall = useCallback(
    (verb: string, request: Record<string, unknown>) =>
      connection.current?.call(verb, request) ?? Promise.reject(new Error("宿主未连接")),
    [],
  );
  const call = useCallback(
    (verb: string, request: Record<string, unknown>) => {
      if (
        current.current.history?.revision &&
        !["inspect", "batch_status", "preview_data", "job_status", "prefs_get", "prefs_set", "ui_seek"].includes(verb)
      )
        return Promise.reject(new Error("正在看历史，请先返回现在"));
      return rawCall(verb, request);
    },
    [rawCall],
  );
  const ai = useAiPanel({
    call,
    path: state.project,
    project,
    notices,
    revision: aiRevision,
    connectionEpoch,
    permissions,
    permissionAnswered: (id) => setPermissions((old) => old.filter((item) => item.id !== id)),
  });
  const [fcpIcon, setFcpIcon] = useState<string | null>(null);
  const dragging = useRef(false);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const update = useCallback((next: UiState) => {
    current.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    if (!config) return;
    let firstProject = true;
    const host = connectHost(config, {
      ui: async (verb, request) => {
        while (dragging.current && verb !== "ui_state") await new Promise((resolve) => setTimeout(resolve, 16));
        const view = projectRef.current;
        const next = applyUi(current.current, verb, request);
        if (view && verb === "ui_select") {
          const cueIds = [...new Set(next.selected.filter((id) => view.cues.some((cue) => cue.cue_id === id)))];
          next.subtitle_selection = {
            cue_ids: cueIds,
            editing:
              next.subtitle_selection?.editing && cueIds.includes(next.subtitle_selection.editing)
                ? next.subtitle_selection.editing
                : null,
          };
          const selected = view.media.find((m) => next.selected.includes(m.id));
          if (selected) {
            next.preview = "media";
            next.media = { id: selected.id, at: "0s", in: null, out: null };
            next.playing = false;
          }
        }
        if (view && verb === "ui_seek") {
          next.playhead = { at: seekTarget(view, view.cues, next.playhead) };
          next.preview = "timeline";
          next.playing = false;
        }
        if (verb === "ui_play" && next.range) next.playhead = { at: next.range.start };
        update(next);
        return next;
      },
      project: (path, view) => {
        if (firstProject || path !== current.current.project) {
          setNotices([]);
          setPermissions([]);
          setReviewSession(null);
          setProjectChange(null);
          firstProject = false;
          setConnectionEpoch((value) => value + 1);
        }
        update({ ...(path === current.current.project ? current.current : initialState()), project: path });
        setProject(view);
        setError(null);
      },
      chat: (notice) => {
        setNotices((old) => [...old, notice]);
        if (notice.event.type === "end" && notice.event.text === "已停止") setPermissions([]);
      },
      permission: (request) =>
        setPermissions((old) => (old.some((item) => item.id === request.id) ? old : [...old, request])),
      aiChanged: () => setAiRevision((value) => value + 1),
      projectChanged: (event) => {
        if (event.target === "session" && event.session_id === reviewSessionRef.current) setProjectChange(event);
      },
      icon: setFcpIcon,
      error: (message, detail) => {
        setError(message);
        setErrorDetail(detail);
      },
    });
    connection.current = host;
    return () => {
      host();
      connection.current = null;
    };
  }, [config, update]);
  const preferences = useTimelinePreferences(rawCall, setError, state, update);
  const layout = { ...preferences.layout, ...layoutDraft };
  const divider = (field: keyof Layout, label: string) => (
    <LayoutDivider
      field={field}
      label={label}
      value={layout[field] ?? null}
      dragging={dragging}
      change={(value) => setLayoutDraft((old) => ({ ...old, [field]: value }))}
      cancel={() =>
        setLayoutDraft((old) => {
          const next = { ...old };
          delete next[field];
          return next;
        })
      }
      commit={(value) => {
        setLayoutDraft((old) => ({ ...old, [field]: value }));
        void preferences.setUi({ layout: { [field]: value } }).then(() =>
          setLayoutDraft((old) => {
            if (old[field] !== value) return old;
            const next = { ...old };
            delete next[field];
            return next;
          }),
        );
      }}
    />
  );
  const history = useHistoryPanel({ project, state, update, call: rawCall, subscribe });
  const settingsKey = preferences.keymap.open_settings;
  const historyKey = preferences.keymap.toggle_history;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || document.querySelector("dialog[open]")) return;
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (historyKey && recordedKey(event) === historyKey && current.current.project) {
        event.preventDefault();
        event.stopPropagation();
        history.toggle();
      } else if (settingsKey && recordedKey(event) === settingsKey) {
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [settingsKey, historyKey, history.toggle]);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== "string" || !id || !current.current.project) return;
      update({
        ...current.current,
        history: { open: false, revision: null, label: null },
        playing: false,
        preview: "timeline",
        selected: [],
        edit_point: null,
      });
      setReviewSession(id);
    };
    window.addEventListener("desktop-open-review", open);
    return () => window.removeEventListener("desktop-open-review", open);
  }, [update]);
  const media = useMediaPanel({ project, state, update, call, config });
  const chapters = useChapterPanel({
    project,
    state,
    update,
    call,
    canGenerate: ai.canSend,
    generate: () => {
      const text = "按现在的剪辑和字幕重新分章，一级标题不超过 5 个";
      update(applyUi(current.current, "ui_show_panel", { panel: "ai" }));
      ai.setInput(text);
      void ai.send(text);
    },
  });
  const subtitles = useSubtitlePanel({ project, state, update, call, config });
  const voice = useVoicePanel({ call, state, update, project, config });
  const source = useMemo(
    () =>
      project && !reviewSession && media.selected && state.preview === "media" && !state.history?.revision
        ? sourceProject(project, media.selected)
        : null,
    [project, reviewSession, media.selected, state.preview, state.history?.revision],
  );
  const updateSource = useCallback(
    (next: UiState) => {
      const previous = current.current;
      if (previous.media)
        update({
          ...previous,
          playing: next.playing,
          media: { ...previous.media, at: "at" in next.playhead ? next.playhead.at : "0s" },
        });
    },
    [update],
  );
  return (
    <main
      className="zc zc-shell"
      style={
        {
          "--layout-left-request": layout.left_width == null ? "var(--panel-w)" : `${layout.left_width}px`,
          "--layout-right-request": layout.right_width == null ? "var(--inspector-w)" : `${layout.right_width}px`,
          "--layout-timeline": layout.timeline_height ?? 0.43,
        } as CSSProperties
      }
    >
      <section aria-label="菜单栏" className="zc-menubar">
        <svg className="zc-logo" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="7" fill="var(--cream)" />
          <path d="M5 8h9M5 12h14M8 16h7" stroke="var(--on-primary)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <strong>庄Sir剪辑助手</strong>
        <span className="zc-topbar-separator" />
        <ProjectEntry
          aiBusy={ai.generating}
          connectionEpoch={connectionEpoch}
          config={config}
          project={project}
          call={rawCall}
          error={error}
          changed={(media) => {
            if (media) update({ ...current.current, panel: "media" });
          }}
        />
        {ai.draftStatus}
        {history.banner}
        <span className="zc-grow" />
        {project && (
          <span className="zc-meta zc-save-status">
            <span className="zc-dot is-approved" />
            已保存 · r{project.revision.seq}
          </span>
        )}
        <span className="zc-revision-controls" ref={setRevisionControls}>
          {!project && (
            <>
              <IconButton icon="undo" label="撤销" disabled />
              <IconButton icon="redo" label="重做" disabled />
            </>
          )}
        </span>
        {!project && <IconButton icon="settings" label="设置" onClick={() => setSettingsOpen(true)} />}
        <IconButton icon="search" label="命令面板 ⌘K" />
        <div className="zc-history-anchor" ref={history.anchor}>
          <IconButton
            icon="history"
            label="历史 ⌥⌘H"
            aria-haspopup="dialog"
            aria-expanded={state.history?.open === true}
            disabled={!project}
            pressed={state.history?.open === true}
            onClick={history.toggle}
          />
          {history.panel}
        </div>
        <button
          type="button"
          className="zc-btn zc-btn-primary is-primary"
          disabled={!project || history.viewing || Boolean(reviewSession)}
          onClick={() => update(applyUi(current.current, "ui_show_panel", { panel: "export" }))}
        >
          <Icon name="export" />
          导出
        </button>
      </section>
      {project && (
        <>
          <nav className="zc-rail" aria-label="图标栏">
            <div role="tablist" aria-label="功能" aria-orientation="vertical">
              {PANELS.map((panel) => (
                <button
                  key={panel}
                  id={`${uniqueId}-tab-${panel}`}
                  type="button"
                  role="tab"
                  aria-selected={state.panel === panel}
                  aria-controls={`${uniqueId}-function-panel`}
                  className={`zc-rail-item${state.panel === panel ? " is-active" : ""}`}
                  title={labels[panel]}
                  onClick={() => update(applyUi(current.current, "ui_show_panel", { panel }))}
                >
                  <span className="tile">
                    <Icon name={panel} size={20} />
                  </span>
                  <span>{labels[panel]}</span>
                </button>
              ))}
            </div>
            <span className="zc-grow" />
            <button
              type="button"
              className="zc-rail-item"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="设置"
            >
              <span className="tile">
                <Icon name="settings" size={20} />
              </span>
              <span>设置</span>
            </button>
          </nav>
          <section aria-label="功能区" className="zc-functions zc-panel">
            {history.viewing && <div className="zc-pad zc-history-report">{history.report}</div>}
            <div
              hidden={history.viewing}
              id={`${uniqueId}-function-panel`}
              role="tabpanel"
              aria-labelledby={`${uniqueId}-tab-${state.panel}`}
              className="zc-pad zc-function-panel"
              ref={(node) => {
                node?.toggleAttribute("inert", history.viewing);
              }}
            >
              {state.panel === "ai" ? (
                ai.header
              ) : (
                <div className="zc-panel-head">
                  <h2>{labels[state.panel]}</h2>
                  {state.panel === "media" && media.header}
                </div>
              )}
              <div className="zc-voice-slot" hidden={state.panel !== "voice"}>
                {voice.controls}
              </div>
              {state.panel === "media" && media.library}
              {state.panel === "chapters" && chapters.controls}
              {state.panel === "subtitles" && subtitles.controls}
              <div className="zc-ai-body" hidden={state.panel !== "ai"}>
                {ai.chat}
              </div>
            </div>
          </section>
          {divider("left_width", "功能区与预览分界")}
          <section className="zc-editor" aria-label="剪辑区">
            <div className="zc-upper-row">
              <div className="zc-preview-slot" ref={setViewerTarget}>
                {source && state.media && (
                  <TimelinePreview
                    preferences={preferences}
                    onOpenSettings={() => setSettingsOpen(true)}
                    viewerOnly
                    project={source}
                    state={{ ...state, playhead: { at: state.media.at }, range: null, loop: false }}
                    update={updateSource}
                    config={config}
                    error={null}
                    dragging={dragging}
                    call={call}
                  />
                )}
              </div>
              {divider("right_width", "预览与参数区分界")}
              <section
                ref={setReviewTarget}
                aria-label="参数区"
                className="zc-parameters zc-panel zc-pad"
                data-panel={history.viewing ? "history" : state.panel}
              >
                {reviewSession ? null : history.viewing ? (
                  history.decisions
                ) : (
                  <>
                    {state.panel === "ai" ? (
                      <div className="zc-decision-heading">
                        <h2>决定</h2>
                        {ai.decisionStatus}
                      </div>
                    ) : (
                      state.panel !== "chapters" && state.panel !== "subtitles" && <h2>{parameters[state.panel]}</h2>
                    )}
                    {state.panel === "ai" && ai.parameters}
                    {state.panel === "media" && media.parameters}
                    {state.panel === "chapters" && chapters.outline}
                    {state.panel === "subtitles" && subtitles.parameters}
                    {state.panel === "voice" && voice.parameters}
                  </>
                )}
              </section>
            </div>
            {reviewSession ? (
              <ReviewView
                key={`${state.project}-${reviewSession}`}
                preferences={preferences}
                sessionId={reviewSession}
                revision={aiRevision}
                project={project}
                state={state}
                update={update}
                call={call}
                change={projectChange}
                actions={ai.reviewActions}
                parametersTarget={reviewTarget}
                viewerTarget={viewerTarget}
                config={config}
                dragging={dragging}
                close={() => setReviewSession(null)}
                committed={setProject}
              />
            ) : (
              <TimelinePreview
                preferences={preferences}
                onOpenSettings={() => setSettingsOpen(true)}
                viewerTarget={viewerTarget}
                revisionControlsTarget={revisionControls}
                hideViewer={Boolean(source)}
                onMediaDrop={(id, at, track) => {
                  const item = project?.media.find((m) => m.id === id);
                  if (item && !history.viewing) media.place(item, at, track);
                }}
                project={history.view}
                onEditSubtitle={subtitles.editCue}
                readOnly={history.viewing}
                state={state}
                update={update}
                subtitlePreview={subtitles.stylePreview}
                onSubtitleStyle={subtitles.previewStyle}
                config={config}
                error={error}
                errorDetail={errorDetail}
                dragging={dragging}
                call={call}
              />
            )}
            {divider("timeline_height", "预览与时间线分界")}
          </section>
        </>
      )}
      {settingsOpen && (
        <SettingsPage
          call={rawCall}
          subscribe={subscribe}
          onPrefs={preferences.acceptPrefs}
          projectPath={state.project}
          close={() => setSettingsOpen(false)}
          openRecognition={() => update(applyUi(current.current, "ui_show_panel", { panel: "subtitles" }))}
        />
      )}
      {project && (
        <ExportPanel project={project} state={state} update={update} call={call} config={config} fcpIcon={fcpIcon} />
      )}
    </main>
  );
}
