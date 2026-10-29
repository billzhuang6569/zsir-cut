import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Button } from "./ai-components.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { SubtitleCanvas } from "./SubtitleCanvas.js";
import { mediaUrl } from "./TimelinePreview.js";
import {
  contains,
  frameAt,
  frameTime,
  type OverlayView,
  printRational,
  seekTarget,
  sourceAt,
  timecode,
} from "./timeline.js";
import "./export.css";

const destinations = [
  {
    key: "fcp",
    name: "Final Cut Pro",
    profile: "fcp-11-fcpxml-1.13",
    files: ["fcpxml"],
    note: "含字幕；在剪辑软件里手动导入",
  },
  {
    key: "resolve",
    name: "DaVinci Resolve",
    profile: "resolve-18.5-otio",
    files: ["otio", "srt"],
    note: "字幕需要单独导入",
  },
  {
    key: "premiere",
    name: "Premiere Pro",
    profile: "premiere-25-xmeml-5",
    files: ["xml", "srt"],
    note: "字幕需要单独导入",
  },
] as const;
type Destination = (typeof destinations)[number];
type Loss = { severity: string; consequence: string };
type Report = { items: Loss[] };
type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
type Result = { path: string; done: boolean; progress: number; error?: string; files?: string[] };
const logos = {
  resolve: new URL("../../../design/assets/apps/davinciresolve.svg", import.meta.url).href,
  premiere: new URL("../../../design/assets/apps/adobepremierepro.svg", import.meta.url).href,
};
function FileIcon({ ext, children }: { ext: string; children?: ReactNode }) {
  return (
    <span className="zc-file">
      <svg width="38" height="46" viewBox="0 0 38 46" aria-hidden="true">
        <path d="M3 1h22l10 10v32a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" className="zc-file-page" />
        <path d="M25 1v8a2 2 0 0 0 2 2h8" className="zc-file-fold" />
        <rect x="1" y="26" width="30" height="12" rx="2" style={{ fill: `var(--file-${ext}, var(--text-3))` }} />
        <text x="16" y="35" textAnchor="middle" className="zc-file-ext" style={{ fontSize: ext.length > 4 ? 6.5 : 8 }}>
          {ext.toUpperCase()}
        </text>
      </svg>
      {children}
    </span>
  );
}
export function ExportPanel({
  project,
  state,
  update,
  call,
  config,
  fcpIcon,
}: {
  project: ProjectView;
  state: UiState;
  update: (state: UiState) => void;
  call: Call;
  config: { port: number; token: string } | undefined;
  fcpIcon: string | null;
}) {
  const settings = state.export ?? { open: false, sub: null, srt: true, wav: false, active: null };
  const latest = useRef({ project, state, update });
  latest.current = { project, state, update };
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [confirm, setConfirm] = useState<Destination | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<OverlayView | "new" | null>(null);
  const [name, setName] = useState("");
  const [tail, setTail] = useState("10s");
  const [track, setTrack] = useState("");
  const [output, setOutput] = useState("");
  const [at, setAt] = useState("0s");
  const busy = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDivElement>(null);
  const change = useCallback((value: Partial<NonNullable<UiState["export"]>>) => {
    const { state: current, update } = latest.current;
    update({
      ...current,
      export: { open: false, sub: null, srt: true, wav: false, active: null, ...current.export, ...value },
    });
  }, []);
  const request = useCallback(
    () => ({
      project: latest.current.state.project,
      timeline_id: latest.current.project.id,
      base_revision: latest.current.project.revision.id,
      idempotency_key: crypto.randomUUID(),
      author: { kind: "human", name: "桌面用户" },
    }),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!settings.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const foreground = dialog.current?.querySelector<HTMLElement>(".zc-export-confirm");
    (foreground?.querySelector<HTMLElement>("input,button") ?? dialog.current)?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (editing) setEditing(null);
        else if (confirm) setConfirm(null);
        else change({ open: false });
      }
      if (event.key === "Tab") {
        const nodes = [
          ...((
            dialog.current?.querySelector<HTMLElement>(".zc-export-confirm") ?? dialog.current
          )?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ) ?? []),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      previous?.focus();
    };
  }, [settings.open, editing, confirm, change]);
  useEffect(() => {
    if (!settings.open) return;
    let cancelled = false;
    setAt(seekTarget(latest.current.project, latest.current.project.cues, latest.current.state.playhead));
    void call("export_preferences", {})
      .then((value) => {
        if (!cancelled) setPaths(value as Record<string, string>);
      })
      .catch(() => {
        if (!cancelled) setError("无法读取导出位置偏好");
      });
    return () => {
      cancelled = true;
    };
  }, [settings.open, call]);
  useEffect(() => {
    if (!settings.open) return;
    let cancelled = false;
    setReports({});
    setChecks({});
    const base = { ...request(), base_revision: project.revision.id };
    for (const destination of destinations) {
      // The kernel gates even dry-run reports on accept_losses; only the preview bypasses that gate.
      void call("export", { ...base, profile: destination.profile, dry_run: true, accept_losses: true })
        .then((value) => {
          if (!cancelled) setReports((old) => ({ ...old, [destination.key]: value as Report }));
        })
        .catch(() => {
          if (!cancelled) setChecks((old) => ({ ...old, [destination.key]: "损失检查失败，请关闭面板后重试" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [settings.open, project.revision.id, call, request]);
  useEffect(() => {
    if (settings.open && settings.sub) {
      const node = [...(dialog.current?.querySelectorAll<HTMLElement>("[data-destination]") ?? [])].find(
        (node) => node.dataset.destination === settings.sub,
      );
      node?.scrollIntoView?.({ block: "nearest" });
    }
  }, [settings.open, settings.sub]);
  const remember = async (key: string, path: string) => {
    const next = { ...paths, [key]: path };
    await call("export_preferences", { value: next });
    setPaths(next);
    return path;
  };
  const choose = async (key: string) => {
    if (!isTauri()) return paths[key] || null;
    const path = await open({
      directory: true,
      multiple: false,
      title: "选择导出文件夹",
      ...(paths[key] ? { defaultPath: paths[key] } : {}),
    });
    return typeof path === "string" ? remember(key, path) : null;
  };
  const run = async (key: string, profiles: string[], accepted = false, overlay?: OverlayView) => {
    if (busy.current) return;
    busy.current = true;
    change({ active: key, sub: overlay ? "overlays" : key });
    setError("");
    let path = overlay?.output_path ?? paths[key] ?? "";
    try {
      if (!overlay && !path) path = (await choose(key)) ?? "";
      if (!path) {
        setError("请选择或输入导出文件夹");
        return;
      }
      if (!overlay) await remember(key, path);
      setResults((old) => ({ ...old, [key]: { path, progress: 0, done: false } }));
      const files: string[] = [];
      for (const [index, profile] of profiles.entries()) {
        const result = (await call("export", {
          ...request(),
          label: overlay ? `覆盖导出字幕叠层「${overlay.name}」` : "导出文件",
          profile,
          ...(overlay ? { overlay_id: overlay.id } : { output: path }),
          ...(accepted ? { accept_losses: true } : {}),
        })) as { job_id: string };
        for (;;) {
          if (!mounted.current) return;
          const job = (await call("job_status", { project: latest.current.state.project, job_id: result.job_id }).catch(
            () => null,
          )) as {
            state: string;
            progress: number;
            envelope: {
              ok: boolean;
              error: { message: string; code?: string } | null;
              result: { package?: string; files?: { path?: string; name?: string }[] };
            } | null;
          } | null;
          if (!job) {
            setResults((old) => ({
              ...old,
              [key]: {
                path,
                done: false,
                progress: old[key]?.progress ?? 0,
                error: "暂时无法读取进度，恢复连接后继续；请勿重复导出",
              },
            }));
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          setResults((old) => ({
            ...old,
            [key]: { path, done: false, progress: (index + job.progress) / profiles.length },
          }));
          if (job.state === "failed" || (job.state === "succeeded" && !job.envelope?.ok))
            throw new Error(
              job.envelope?.error?.code === "E_CONFLICT"
                ? "工程已改变，请刷新后重新导出"
                : job.envelope?.error?.code === "E_IO"
                  ? "无法读写文件，请检查素材是否在线及保存位置是否可写"
                  : job.envelope?.error?.code === "E_VALIDATION"
                    ? "导出校验失败，请检查工程或输出文件是否已存在"
                    : "导出失败，请检查素材、输出位置与工程状态后重试",
            );
          if (job.state === "succeeded") {
            if (job.envelope?.result.package) files.push(job.envelope.result.package);
            else
              files.push(
                ...(job.envelope?.result.files?.map(
                  (file) => file.path ?? `${path.replace(/\/$/, "")}/${file.name}`,
                ) ?? [path]),
              );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      setResults((old) => ({ ...old, [key]: { path, done: true, progress: 1, files } }));
    } catch (cause) {
      setResults((old) => ({
        ...old,
        [key]: { path, done: false, progress: 0, error: cause instanceof Error ? cause.message : "导出失败" },
      }));
    } finally {
      busy.current = false;
      if (mounted.current) change({ active: null });
    }
  };
  const edit = async (label: string, ops: Record<string, unknown>[]) => {
    if (busy.current) return;
    busy.current = true;
    change({ active: "overlay-edit" });
    setError("");
    try {
      await call("edit", { ...request(), label, ops });
      setEditing(null);
    } catch {
      setError("字幕叠层修改失败，请检查名称、尾长和保存位置后重试");
    } finally {
      busy.current = false;
      change({ active: null });
    }
  };
  const begin = (overlay?: OverlayView) => {
    change({ sub: "overlays" });
    setEditing(overlay ?? "new");
    setName(overlay?.name ?? "字幕叠层");
    setTail(overlay?.tail ?? "10s");
    setTrack(overlay?.subtitle_track_id ?? project.subtitleTracks?.[0]?.id ?? "");
    setOutput(overlay?.output_path ?? "");
  };
  const location = (key: string) => (
    <div className="zc-export-location">
      {isTauri() ? (
        <Button
          disabled={Boolean(settings.active)}
          onClick={() => void choose(key).catch(() => setError("无法选择保存位置"))}
        >
          更改保存位置
        </Button>
      ) : (
        <input
          className="zc-input"
          aria-label={`${key === "direct" ? "直接导出" : destinations.find((d) => d.key === key)?.name}保存位置`}
          placeholder="导出文件夹的绝对路径"
          value={paths[key] ?? ""}
          disabled={Boolean(settings.active)}
          onChange={(event) => setPaths({ ...paths, [key]: event.target.value })}
        />
      )}
      {isTauri() && paths[key] && <span className="zc-export-path">{paths[key]}</span>}
    </div>
  );
  const status = (key: string) => {
    const result = results[key];
    if (!result) return null;
    return (
      <div className="zc-export-status" aria-live="polite">
        {result.error ? (
          <p role="alert">{result.error}</p>
        ) : result.done ? (
          <>
            <span className="zc-dest-ok">
              <Icon name="check" />
              导出完成
            </span>
            <span className="zc-export-path">{result.files?.join("、") ?? result.path}</span>
            {isTauri() && (
              <Button
                onClick={() =>
                  void revealItemInDir(result.files?.[0] ?? result.path).catch(() => setError("无法在访达中显示"))
                }
              >
                在访达中显示
              </Button>
            )}
          </>
        ) : (
          <>
            <span>正在导出 {Math.round(result.progress * 100)}%</span>
            <progress aria-label="导出进度" max={1} value={result.progress} />
          </>
        )}
      </div>
    );
  };
  const frameCount = frameAt(project.duration.t, project.edit_rate);
  const clip = project.tracks
    .filter((t) => t.kind === "video" && t.enabled)
    .flatMap((t) => t.clips)
    .find((c) => c.enabled && contains(c.timeline_in.t, c.timeline_out.t, at));
  const src =
    clip && config ? mediaUrl(config, "thumb", clip.media_id, printRational(sourceAt(clip, at), true)) : undefined;
  if (!settings.open) return null;
  return (
    <div className="zc-export-backdrop">
      <div
        className="zc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导出"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>导出</h2>
          <IconButton icon="close" label="关闭导出" onClick={() => change({ open: false })} />
        </header>
        {error && <p role="alert">{error}</p>}
        <fieldset className="zc-export-graph" disabled={Boolean(editing || confirm)} aria-label="导出去处与预览">
          <div className="zc-export-preview">
            <h3>成片预览</h3>
            <div
              className="zc-picture"
              style={{ aspectRatio: `${project.format?.width ?? 1920} / ${project.format?.height ?? 1080}` }}
              role="slider"
              tabIndex={0}
              aria-label="快速浏览成片"
              aria-valuemin={0}
              aria-valuemax={Number(frameCount)}
              aria-valuenow={Number(frameAt(at, project.edit_rate))}
              onMouseMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const fraction = BigInt(
                  Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * 10000),
                );
                setAt(frameTime(((frameCount > 0n ? frameCount - 1n : 0n) * fraction) / 10000n, project.edit_rate));
              }}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  const next = frameAt(at, project.edit_rate) + (event.key === "ArrowLeft" ? -1n : 1n);
                  setAt(
                    frameTime(next >= frameCount ? (frameCount > 0n ? frameCount - 1n : 0n) : next, project.edit_rate),
                  );
                }
              }}
            >
              {src ? <img src={src} alt="成片画面" /> : <span className="zc-muted">暂无画面</span>}
              <SubtitleCanvas
                cues={project.cues.filter((cue) => contains(cue.start, cue.end, at))}
                styles={project.styles}
                format={project.format}
              />
            </div>
            <span>{timecode(at, project)}</span>
            <p>
              时长 {timecode(project.duration.t, { ...project, start_timecode: "00:00:00:00" })} ·{" "}
              {project.format?.width ?? 1920} × {project.format?.height ?? 1080} · {project.edit_rate} 帧/秒
            </p>
          </div>
          <div className="zc-export-destinations">
            {destinations.map((destination) => {
              const losses =
                reports[destination.key]?.items.filter((item) =>
                  ["warn", "warning", "error"].includes(item.severity),
                ) ?? [];
              const logo = destination.key === "fcp" ? fcpIcon : logos[destination.key];
              return (
                <section className="zc-export-node" key={destination.key} data-destination={destination.key}>
                  <button
                    type="button"
                    className="zc-dest"
                    title={destination.note}
                    aria-label={`导出到 ${destination.name}`}
                    disabled={Boolean(settings.active) || !reports[destination.key]}
                    onClick={() =>
                      losses.some((item) => item.severity === "error")
                        ? setConfirm(destination)
                        : void run(destination.key, [destination.profile])
                    }
                  >
                    {logo ? (
                      <img className="zc-app-logo" src={logo} alt="" width={40} height={40} />
                    ) : (
                      <span className="zc-app-tile">剪辑</span>
                    )}
                    <span className="zc-dest-name">
                      <strong>{destination.name}</strong>
                      {losses.length > 0 && (
                        <span
                          className="zc-warn"
                          role="img"
                          aria-label="导出有损失"
                          title={losses.map((loss) => loss.consequence).join("\n")}
                        >
                          !
                        </span>
                      )}
                    </span>
                    <span className="zc-dest-files">
                      {destination.files.map((ext) => (
                        <FileIcon key={ext} ext={ext} />
                      ))}
                    </span>
                    <Icon name="chevron" />
                  </button>
                  <small>
                    {checks[destination.key] ?? (!reports[destination.key] ? "正在检查交接损失…" : destination.note)}
                  </small>
                  {location(destination.key)}
                  {status(destination.key)}
                </section>
              );
            })}
            <section className="zc-export-node" data-destination="direct">
              <button
                type="button"
                className="zc-dest"
                aria-label="直接导出"
                disabled={Boolean(settings.active)}
                onClick={() =>
                  void run("direct", [
                    ...(settings.srt ? ["direct-srt"] : []),
                    ...(settings.wav ? ["direct-audio-wav"] : []),
                  ])
                }
              >
                <span className="zc-app-tile">
                  <Icon name="export" />
                </span>
                <strong>直接导出</strong>
                <span className="zc-dest-files">
                  {settings.srt && <FileIcon ext="srt" />}
                  {settings.wav && <FileIcon ext="wav" />}
                </span>
                <Icon name="chevron" />
              </button>
              <div className="zc-files">
                {(["srt", "wav"] as const).map((ext) => (
                  <button
                    type="button"
                    key={ext}
                    className={`zc-file-toggle ${settings[ext] ? "is-on" : ""}`}
                    aria-label={`导出 ${ext.toUpperCase()}`}
                    aria-pressed={settings[ext]}
                    disabled={Boolean(settings.active) || (settings[ext] && !settings[ext === "srt" ? "wav" : "srt"])}
                    onClick={() => change({ [ext]: !settings[ext], sub: "direct" })}
                  >
                    <FileIcon ext={ext} />
                    {settings[ext] && (
                      <span className="zc-file-check">
                        <Icon name="check" size={10} />
                      </span>
                    )}
                  </button>
                ))}
                <span className="zc-export-later">
                  <FileIcon ext="mp4">二期</FileIcon>
                </span>
              </div>
              {location("direct")}
              {status("direct")}
            </section>
            <section className="zc-export-node" data-destination="overlays">
              <h3>
                <Icon name="subtitle" /> 字幕叠层
              </h3>
              <p>剪辑线定稿后再出；改字幕后点这里覆盖同一个文件</p>
              {(project.subtitleOverlays ?? [])
                .filter((overlay) => overlay.timeline_id === project.id)
                .map((overlay) => (
                  <div className="zc-overlay-row" key={overlay.id}>
                    <Button
                      disabled={Boolean(settings.active)}
                      onClick={() => void run(overlay.id, ["subtitle-overlay"], false, overlay)}
                      title={overlay.output_path}
                    >
                      <FileIcon ext="mov" />
                      <span>
                        {overlay.name}
                        <small>
                          {project.subtitleTracks?.find((t) => t.id === overlay.subtitle_track_id)?.name ?? "字幕轨"} ·{" "}
                          {overlay.last_export
                            ? new Date(overlay.last_export.created_at).toLocaleString("zh-CN")
                            : "尚未导出"}
                        </small>
                      </span>
                    </Button>
                    <IconButton
                      icon="list"
                      label={`编辑叠层「${overlay.name}」`}
                      disabled={Boolean(settings.active)}
                      onClick={() => begin(overlay)}
                    />
                    <IconButton
                      icon="trash"
                      label={`删除叠层「${overlay.name}」`}
                      disabled={Boolean(settings.active)}
                      onClick={() =>
                        void edit(`删除字幕叠层「${overlay.name}」`, [{ op: "remove_overlay", overlay_id: overlay.id }])
                      }
                    />
                    {status(overlay.id)}
                  </div>
                ))}
              <Button
                icon="plus"
                disabled={Boolean(settings.active) || !project.subtitleTracks?.length}
                onClick={() => begin()}
              >
                新建叠层
              </Button>
            </section>
          </div>
        </fieldset>
        {confirm && (
          <div className="zc-export-confirm" role="alertdialog" aria-label="确认交接损失">
            <h3>有内容无法完整带入 {confirm.name}</h3>
            <ul>
              {reports[confirm.key]?.items
                .filter((loss) => loss.severity === "error")
                .map((loss, i) => (
                  <li key={`${i}-${loss.consequence}`}>{loss.consequence}</li>
                ))}
            </ul>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button
              onClick={() => {
                const destination = confirm;
                setConfirm(null);
                void run(destination.key, [destination.profile], true);
              }}
            >
              接受损失并导出
            </Button>
          </div>
        )}
        {editing && (
          <form
            className="zc-export-confirm"
            aria-label="字幕叠层设置"
            onSubmit={(event) => {
              event.preventDefault();
              const label = editing === "new" ? `新建字幕叠层「${name}」` : `修改字幕叠层「${name}」`;
              void edit(label, [
                editing === "new"
                  ? {
                      op: "add_overlay",
                      name,
                      timeline_id: project.id,
                      subtitle_track_id: track,
                      output_path: output,
                      tail,
                    }
                  : { op: "update_overlay", overlay_id: editing.id, name, tail },
              ]);
            }}
          >
            <h3>{editing === "new" ? "新建叠层" : "编辑叠层"}</h3>
            <label>
              名称
              <input
                className="zc-input"
                aria-label="叠层名称"
                value={name}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              尾长（秒，例如 10s 或 1/2s；0 到 600 秒）
              <input
                className="zc-input"
                aria-label="叠层尾长"
                value={tail}
                required
                onChange={(event) => setTail(event.target.value)}
              />
            </label>
            {editing === "new" && (
              <>
                <label>
                  字幕轨
                  <select
                    className="zc-input"
                    aria-label="叠层字幕轨"
                    value={track}
                    onChange={(event) => setTrack(event.target.value)}
                  >
                    {project.subtitleTracks?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                {isTauri() ? (
                  <Button
                    onClick={() =>
                      void save({
                        title: "保存字幕叠层",
                        defaultPath: "字幕叠层.mov",
                        filters: [{ name: "透明字幕视频", extensions: ["mov"] }],
                      })
                        .then((path) => {
                          if (path) setOutput(path);
                        })
                        .catch(() => setError("无法选择保存位置"))
                    }
                  >
                    选择保存位置
                  </Button>
                ) : (
                  <input
                    className="zc-input"
                    aria-label="叠层保存位置"
                    placeholder="绝对路径，以 .mov 结尾"
                    value={output}
                    onChange={(event) => setOutput(event.target.value)}
                  />
                )}
                <span className="zc-export-path">{output}</span>
              </>
            )}
            <Button disabled={Boolean(settings.active)} onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button type="submit" disabled={Boolean(settings.active) || !name.trim() || !track || !output}>
              保存叠层
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
