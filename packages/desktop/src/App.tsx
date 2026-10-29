import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PANELS, type Panel, type UiState } from "../../app-host/src/ui.js";
import { connectHost, type ProjectView } from "./connection.js";
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
  const dragging = useRef(false);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const update = useCallback((next: UiState) => {
    current.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    if (!config) return;
    const host = connectHost(config, {
      ui: async (verb, request) => {
        while (dragging.current && verb !== "ui_state") await new Promise((resolve) => setTimeout(resolve, 16));
        const view = projectRef.current;
        const next = applyUi(current.current, verb, request);
        if (view && verb === "ui_seek") next.playhead = { at: seekTarget(view, view.cues, next.playhead) };
        if (verb === "ui_play" && next.range) next.playhead = { at: next.range.start };
        update(next);
        return next;
      },
      project: (path, view) => {
        update({ ...current.current, project: path });
        setProject(view);
        setError(null);
      },
      icon: () => {},
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
  return (
    <main className="zc-shell">
      <section aria-label="菜单栏" className="zc-menubar">
        <strong>庄Sir剪辑助手</strong>
        <span>{project?.name ?? "未打开工程"}</span>
        {project && <span className="zc-muted">r{project.revision.seq}</span>}
        <span className="zc-grow" />
        <button type="button" className="zc-btn" disabled>
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
          className="zc-pad"
        >
          <h2>{labels[state.panel]}</h2>
        </div>
      </section>
      <section aria-label="参数区" className="zc-parameters zc-pad" data-panel={state.panel}>
        <h2>{parameters[state.panel]}</h2>
        {state.panel === "subtitles" && (
          <div className="zc-tabs" role="tablist" aria-label="字幕参数">
            {["subtitles", "style"].map((sub) => (
              <button
                key={sub}
                type="button"
                role="tab"
                aria-selected={(state.sub ?? "subtitles") === sub}
                className="zc-tab"
                onClick={() => update({ ...current.current, sub })}
              >
                {sub === "style" ? "样式" : "字幕"}
              </button>
            ))}
          </div>
        )}
        {state.panel === "subtitles" && state.sub === "style" && <h3>样式</h3>}
      </section>
      <TimelinePreview
        project={project}
        state={state}
        update={update}
        config={config}
        error={error}
        errorDetail={errorDetail}
        dragging={dragging}
        call={(verb, request) => connection.current?.call(verb, request) ?? Promise.reject(new Error("宿主未连接"))}
      />
    </main>
  );
}
