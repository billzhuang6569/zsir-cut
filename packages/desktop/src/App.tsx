import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PANELS, type Panel, type UiState } from "../../app-host/src/ui.js";
import { type AiNotice, useAiPanel } from "./AiPanel.js";
import { useChapterPanel } from "./ChapterPanel.js";
import { Icon, IconButton } from "./components.js";
import { connectHost, type ProjectView } from "./connection.js";
import { ExportPanel } from "./ExportPanel.js";
import { useHistoryPanel } from "./HistoryPanel.js";
import { useMediaPanel } from "./MediaPanel.js";
import { sourceProject } from "./media.js";
import { ProjectEntry } from "./ProjectEntry.js";
import { useSubtitlePanel } from "./SubtitlePanel.js";
import { applyUi, initialState } from "./state.js";
import { TimelinePreview } from "./TimelinePreview.js";
import { seekTarget } from "./timeline.js";
import { SettingsPage, useVoicePanel } from "./VoicePanel.js";

const labels: Record<Panel, string> = { ai: "AI", media: "素材", chapters: "章节", subtitles: "字幕", voice: "语音" };
const parameters: Record<Panel, string> = {
  ai: "决定",
  media: "素材信息",
  chapters: "章节大纲",
  subtitles: "字幕",
  voice: "语音",
};
export function App({ config }: { config?: { port: number; token: string } }) {
  const uniqueId = useId();
  const [revisionControls, setRevisionControls] = useState<HTMLSpanElement | null>(null);
  const [previewPercent, setPreviewPercent] = useState(60);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<UiState>(initialState);
  const current = useRef(state);
  const [project, setProject] = useState<ProjectView | null>(null);
  const connection = useRef<ReturnType<typeof connectHost> | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [notices, setNotices] = useState<AiNotice[]>([]);
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
        !["inspect", "batch_status", "preview_data", "job_status"].includes(verb)
      )
        return Promise.reject(new Error("正在看历史，请先返回现在"));
      return rawCall(verb, request);
    },
    [rawCall],
  );
  const ai = useAiPanel({ call, path: state.project, project, notices, revision: aiRevision, connectionEpoch });
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
          firstProject = false;
          setConnectionEpoch((value) => value + 1);
        }
        update({ ...(path === current.current.project ? current.current : initialState()), project: path });
        setProject(view);
        setError(null);
      },
      chat: (notice) => setNotices((old) => [...old, notice]),
      aiChanged: () => setAiRevision((value) => value + 1),
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
  const history = useHistoryPanel({ project, state, update, call: rawCall });
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
      project && media.selected && state.preview === "media" && !state.history?.revision
        ? sourceProject(project, media.selected)
        : null,
    [project, media.selected, state.preview, state.history?.revision],
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
    <main className="zc zc-shell">
      <section aria-label="菜单栏" className="zc-menubar">
        <strong>庄Sir剪辑助手</strong>
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
        {project && <span className="zc-muted">r{project.revision.seq}</span>}
        <span className="zc-grow" />
        <span className="zc-revision-controls" ref={setRevisionControls}>
          {!project && (
            <>
              <IconButton icon="undo" label="撤销" disabled />
              <IconButton icon="redo" label="重做" disabled />
            </>
          )}
        </span>
        {!project && <IconButton icon="settings" label="设置" onClick={() => setSettingsOpen(true)} />}
        <IconButton
          icon="history"
          label="历史 ⌥⌘H"
          disabled={!project}
          pressed={state.history?.open === true}
          onClick={history.toggle}
        />
        <button
          type="button"
          className="zc-btn zc-btn-primary"
          disabled={!project || history.viewing}
          onClick={() => update(applyUi(current.current, "ui_show_panel", { panel: "export" }))}
        >
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
          <section aria-label="功能区" className="zc-functions">
            <div
              id={`${uniqueId}-function-panel`}
              role="tabpanel"
              aria-labelledby={`${uniqueId}-tab-${state.panel}`}
              className="zc-pad zc-function-panel"
              ref={(node) => {
                node?.toggleAttribute("inert", history.viewing);
              }}
            >
              <h2>{labels[state.panel]}</h2>
              <div hidden={state.panel !== "voice"}>{voice}</div>
              {state.panel === "media" && media.library}
              {state.panel === "chapters" && chapters.controls}
              {state.panel === "subtitles" && subtitles.controls}
              <div className="zc-ai-body" hidden={state.panel !== "ai"}>
                {ai.chat}
              </div>
            </div>
          </section>
          <section
            aria-label="参数区"
            className="zc-parameters zc-pad"
            data-panel={state.history?.open ? "history" : state.panel}
          >
            {state.history?.open ? (
              history.panel
            ) : (
              <>
                <h2>{parameters[state.panel]}</h2>
                {state.panel === "ai" && ai.parameters}
                {state.panel === "media" && media.parameters}
                {state.panel === "chapters" && chapters.outline}
                {state.panel === "subtitles" && subtitles.parameters}
                {state.panel === "voice" && (
                  <p className="zc-muted">在左侧克隆音色或生成配音，生成后可在「素材」中查看。</p>
                )}
              </>
            )}
          </section>
          <section
            className="zc-editor"
            aria-label="剪辑区"
            style={{
              gridTemplateRows: `minmax(160px, ${previewPercent}fr) 8px var(--toolbar-h) minmax(120px, ${100 - previewPercent}fr)`,
            }}
          >
            {source && state.media && (
              <TimelinePreview
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
            <TimelinePreview
              revisionControlsTarget={revisionControls}
              hideViewer={Boolean(source)}
              onMediaDrop={(id, at, track) => {
                const item = project?.media.find((m) => m.id === id);
                if (item && !history.viewing) media.place(item, at, track);
              }}
              project={history.view}
              historyBanner={history.banner}
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
            <hr
              className="zc-editor-divider"
              aria-label="预览与时间线分界"
              aria-orientation="horizontal"
              tabIndex={0}
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={previewPercent}
              onKeyDown={(event) => {
                if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                setPreviewPercent((value) => Math.max(25, Math.min(75, value + (event.key === "ArrowUp" ? -5 : 5))));
              }}
              onPointerDown={(event) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (bounds?.height)
                  setPreviewPercent(Math.max(25, Math.min(75, ((event.clientY - bounds.top) / bounds.height) * 100)));
              }}
              onPointerUp={(event) => {
                dragging.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => {
                dragging.current = false;
              }}
            />
          </section>
        </>
      )}
      {settingsOpen && <SettingsPage call={rawCall} close={() => setSettingsOpen(false)} />}
      {project && (
        <ExportPanel project={project} state={state} update={update} call={call} config={config} fcpIcon={fcpIcon} />
      )}
    </main>
  );
}
