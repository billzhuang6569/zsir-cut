import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PANELS, type Panel, type UiState } from "../../app-host/src/ui.js";
import { type AiNotice, useAiPanel } from "./AiPanel.js";
import { useChapterPanel } from "./ChapterPanel.js";
import { connectHost, type ProjectView } from "./connection.js";
import { ExportPanel } from "./ExportPanel.js";
import { useMediaPanel } from "./MediaPanel.js";
import { sourceProject } from "./media.js";
import { useSubtitlePanel } from "./SubtitlePanel.js";
import { applyUi, initialState } from "./state.js";
import { TimelinePreview } from "./TimelinePreview.js";
import { seekTarget } from "./timeline.js";

const labels: Record<Panel, string> = { ai: "AI", media: "素材", chapters: "章节", subtitles: "字幕" };
const parameters: Record<Panel, string> = { ai: "决定", media: "素材信息", chapters: "章节大纲", subtitles: "字幕" };
export function App({ config }: { config?: { port: number; token: string } }) {
  const uniqueId = useId();
  const [state, setState] = useState<UiState>(initialState);
  const current = useRef(state);
  const [project, setProject] = useState<ProjectView | null>(null);
  const connection = useRef<ReturnType<typeof connectHost> | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [notices, setNotices] = useState<AiNotice[]>([]);
  const [aiRevision, setAiRevision] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const call = useCallback(
    (verb: string, request: Record<string, unknown>) =>
      connection.current?.call(verb, request) ?? Promise.reject(new Error("宿主未连接")),
    [],
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
        if (firstProject) {
          firstProject = false;
          setConnectionEpoch((value) => value + 1);
        }
        update({ ...current.current, project: path });
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
  const source = useMemo(
    () => (project && media.selected && state.preview === "media" ? sourceProject(project, media.selected) : null),
    [project, media.selected, state.preview],
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
    <main className="zc-shell">
      <section aria-label="菜单栏" className="zc-menubar">
        <strong>庄Sir剪辑助手</strong>
        <span>{project?.name ?? "未打开工程"}</span>
        {project && <span className="zc-muted">r{project.revision.seq}</span>}
        <span className="zc-grow" />
        <button
          type="button"
          className="zc-btn"
          disabled={!project}
          onClick={() => update(applyUi(current.current, "ui_show_panel", { panel: "export" }))}
        >
          导出
        </button>
      </section>
      <section aria-label="功能区" className="zc-functions">
        <div className="zc-tabs" role="tablist" aria-label="功能">
          {PANELS.map((panel) => (
            <button
              key={panel}
              id={`${uniqueId}-tab-${panel}`}
              type="button"
              role="tab"
              aria-selected={state.panel === panel}
              aria-controls={`${uniqueId}-function-panel`}
              className="zc-tab"
              onClick={() => update(applyUi(current.current, "ui_show_panel", { panel }))}
            >
              {labels[panel]}
            </button>
          ))}
        </div>
        <div
          id={`${uniqueId}-function-panel`}
          role="tabpanel"
          aria-labelledby={`${uniqueId}-tab-${state.panel}`}
          className="zc-pad zc-function-panel"
        >
          <h2>{labels[state.panel]}</h2>
          {state.panel === "media" && media.library}
          {state.panel === "chapters" && chapters.controls}
          {state.panel === "subtitles" && subtitles.controls}
          <div className="zc-ai-body" hidden={state.panel !== "ai"}>
            {ai.chat}
          </div>
        </div>
      </section>
      <section aria-label="参数区" className="zc-parameters zc-pad" data-panel={state.panel}>
        <h2>{parameters[state.panel]}</h2>
        {state.panel === "ai" && ai.parameters}
        {state.panel === "media" && media.parameters}
        {state.panel === "chapters" && chapters.outline}
        {state.panel === "subtitles" && subtitles.parameters}
      </section>
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
        hideViewer={Boolean(source)}
        onMediaDrop={(id, at, track) => {
          const item = project?.media.find((m) => m.id === id);
          if (item) media.place(item, at, track);
        }}
        project={project}
        state={state}
        update={update}
        config={config}
        error={error}
        errorDetail={errorDetail}
        dragging={dragging}
        call={(verb, request) => connection.current?.call(verb, request) ?? Promise.reject(new Error("宿主未连接"))}
      />
      {project && (
        <ExportPanel project={project} state={state} update={update} call={call} config={config} fcpIcon={fcpIcon} />
      )}
    </main>
  );
}
