import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Button } from "./ai-components.js";
import { chapterTime } from "./chapters.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { SubtitleCanvas } from "./SubtitleCanvas.js";
import { mediaUrl } from "./TimelinePreview.js";
import {
  compare,
  contains,
  floor,
  frameAt,
  frameTime,
  type OverlayView,
  parseRational,
  printRational,
  seekTarget,
  sourceAt,
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
type Loss = {
  feature: string;
  severity: string;
  consequence: string;
  status: "approximated" | "baked" | "unsupported";
};
type Report = { items: Loss[]; summary?: { preserved_by_feature: Record<string, number> } };
const featureNames: Record<string, string> = {
  clip_cut: "剪辑点与顺序",
  timecode: "时间码",
  av_sync: "音画同步",
  clip_enabled: "片段开关",
  gain: "音量",
  transform: "画面变换",
  cross_dissolve: "叠化转场",
  speed_constant: "固定变速",
  speed_segmented: "分段变速",
  speed_smooth: "平滑变速",
  reverse: "倒放",
  marker: "标记",
  marker_level: "章节层级",
  marker_description: "章节描述",
  subtitle_text_timing: "字幕文字与时间",
  subtitle_style: "字幕样式",
  subtitle_override: "字幕单条样式",
  ext_data: "扩展信息",
  media: "素材引用",
};
function featureLabel(feature: string, count: number) {
  return feature === "subtitle_text_timing"
    ? `${count} 条字幕`
    : `${featureNames[feature] ?? "其他内容"} ${count} ${feature.startsWith("marker") ? "个" : "项"}`;
}
function groupLosses(items: Loss[]) {
  const groups = new Map<string, Loss & { count: number; consequences: Set<string> }>();
  for (const item of items) {
    const key = `${item.feature}-${item.status}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.consequences.add(item.consequence);
      if (item.severity === "error") group.severity = "error";
    } else {
      groups.set(key, { ...item, count: 1, consequences: new Set([item.consequence]) });
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
}
type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
type Result = { path: string; done: boolean; progress: number; error?: string; details?: string; files?: string[] };
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
      author: DESKTOP_AUTHOR,
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
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
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
    let details = "";
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
          if (job.state === "failed" || (job.state === "succeeded" && !job.envelope?.ok)) {
            details = job.envelope?.error?.message ?? "";
            throw new Error(
              details.startsWith("Exchange validation failed")
                ? "导出未通过剪辑点校验，文件未生成。请保留工程并反馈此问题。"
                : job.envelope?.error?.code === "E_CONFLICT"
                  ? "工程已改变，请刷新后重新导出"
                  : job.envelope?.error?.code === "E_IO"
                    ? "无法读写文件，请检查素材是否在线及保存位置是否可写"
                    : job.envelope?.error?.code === "E_VALIDATION"
                      ? "导出校验失败，请检查工程或输出文件是否已存在"
                      : "导出失败，请检查素材、输出位置与工程状态后重试",
            );
          }
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
        [key]: {
          path,
          done: false,
          progress: 0,
          error: details && cause instanceof Error ? cause.message : "导出失败，请检查素材、保存位置与工程状态后重试",
          details: details || (cause instanceof Error ? cause.message : String(cause)),
        },
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
  const status = (key: string) => {
    const result = results[key];
    if (!result) return null;
    return (
      <div className="zc-export-status" aria-live="polite">
        {result.error ? (
          <>
            <p role="alert">{result.error}</p>
            {result.details && (
              <details>
                <summary>错误详情</summary>
                <pre>{result.details}</pre>
              </details>
            )}
          </>
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
  const firstClip = project.tracks
    .filter((track) => track.kind === "video" && track.enabled)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled)
    .sort((a, b) => compare(parseRational(a.timeline_in.t, true), parseRational(b.timeline_in.t, true)))[0];
  const poster =
    firstClip && config
      ? mediaUrl(config, "thumb", firstClip.media_id, printRational(sourceAt(firstClip, firstClip.timeline_in.t), true))
      : undefined;
  const seconds = floor(parseRational(project.duration.t, true));
  const rate = parseRational(project.edit_rate);
  const hundredths = (rate.numerator * 100n + rate.denominator / 2n) / rate.denominator;
  const fps = `${hundredths / 100n}${
    hundredths % 100n
      ? `.${String(hundredths % 100n)
          .padStart(2, "0")
          .replace(/0$/, "")}`
      : ""
  }`;
  const selected = destinations.find((destination) => destination.key === settings.sub);
  const selectedKey =
    selected?.key ?? (settings.sub === "overlays" ? "overlays" : settings.sub === "direct" ? "direct" : "fcp");
  const destination = selected ?? destinations[0];
  const title = selectedKey === "direct" ? "只要文件" : selectedKey === "overlays" ? "字幕叠层" : destination.name;
  const report = reports[destination.key];
  const exportSelected = () => {
    if (selectedKey === "overlays") {
      begin();
      return;
    }
    if (selectedKey === "direct") {
      void run("direct", [...(settings.srt ? ["direct-srt"] : []), ...(settings.wav ? ["direct-audio-wav"] : [])]);
    } else if (report?.items.some((item) => item.severity === "error")) setConfirm(destination);
    else void run(destination.key, [destination.profile]);
  };
  if (!settings.open) return null;
  return (
    <div className="zc-scrim zc-export-backdrop">
      <div
        className="zc-dialog zc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导出"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="zc-export-header">
          <div>
            <h2>导出</h2>
            <p className="zc-hint">把这一版交给剪辑软件继续做，或者只存成文件。</p>
          </div>
          <IconButton icon="close" label="关闭导出" onClick={() => change({ open: false })} />
        </header>
        <fieldset className="zc-export-body" disabled={Boolean(editing || confirm)} aria-label="导出去处与预览">
          <div className="zc-export-left">
            <h3>
              <span className="zc-export-step">1</span>交给谁
            </h3>
            <div className="zc-export-destinations">
              {destinations.map((item) => {
                const losses = reports[item.key]?.items ?? [];
                const logo = item.key === "fcp" ? fcpIcon : logos[item.key];
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={`zc-dest${selectedKey === item.key ? " is-selected" : ""}`}
                    aria-label={`选择 ${item.name}`}
                    aria-pressed={selectedKey === item.key}
                    disabled={Boolean(settings.active)}
                    onClick={() => change({ sub: item.key })}
                  >
                    {logo ? (
                      <img className="zc-app-logo" src={logo} alt="" />
                    ) : (
                      <span className="zc-app-tile">
                        <Icon name="media" />
                      </span>
                    )}
                    <span className="zc-dest-name">
                      <strong>{item.name}</strong>
                      <small>{item.note}</small>
                    </span>
                    <span
                      className={`zc-dot ${checks[item.key] || losses.some((loss) => loss.severity === "error") ? "is-danger" : losses.length ? "is-attention" : reports[item.key] ? "is-approved" : ""}`}
                      role="img"
                      aria-label={losses.length ? "导出有损失" : reports[item.key] ? "检查完成" : "等待检查"}
                      title={
                        checks[item.key] ??
                        (losses.map((loss) => loss.consequence).join("\n") ||
                          (reports[item.key] ? "全部原样" : "正在检查交接损失…"))
                      }
                    />
                  </button>
                );
              })}
              {[
                ["overlays", "字幕叠层", "只有字幕的透明视频，放在最上层", "subtitle"],
                ["direct", "只要文件", "字幕 SRT、音频 WAV", "file"],
              ].map(([key, name, note, icon]) => (
                <button
                  type="button"
                  className={`zc-dest${selectedKey === key ? " is-selected" : ""}`}
                  key={key}
                  aria-pressed={selectedKey === key}
                  disabled={Boolean(settings.active)}
                  onClick={() => change({ sub: key ?? null })}
                >
                  <span className="zc-app-tile">
                    <Icon name={icon ?? "file"} />
                  </span>
                  <span className="zc-dest-name">
                    <strong>{name}</strong>
                    <small>{note}</small>
                  </span>
                </button>
              ))}
            </div>
            <section className="zc-card zc-export-summary" aria-label="成片信息">
              <div className="zc-export-summary-main">
                <div
                  className="zc-picture zc-export-thumbnail"
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
                      Math.round(
                        Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * 10000,
                      ),
                    );
                    setAt(frameTime(((frameCount > 0n ? frameCount - 1n : 0n) * fraction) / 10000n, project.edit_rate));
                  }}
                  onKeyDown={(event) => {
                    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                      event.preventDefault();
                      const next = frameAt(at, project.edit_rate) + (event.key === "ArrowLeft" ? -1n : 1n);
                      setAt(
                        frameTime(
                          next >= frameCount ? (frameCount > 0n ? frameCount - 1n : 0n) : next,
                          project.edit_rate,
                        ),
                      );
                    }
                  }}
                >
                  {(src ?? poster) ? <img src={src ?? poster} alt="成片缩略图" /> : <Icon name="media" />}
                  <span>{chapterTime(project.duration.t).padStart(5, "0")}</span>
                  <SubtitleCanvas
                    at={at}
                    cues={project.cues.filter((cue) => contains(cue.start, cue.end, at))}
                    styles={project.styles}
                    format={project.format}
                  />
                </div>
                <div className="zc-export-summary-title">
                  <strong>{project.name}</strong>
                  <span className="zc-export-saved">
                    <span className="zc-dot is-approved" />第 {project.revision.seq} 版 · 已保存
                  </span>
                </div>
              </div>
              <div className="zc-export-summary-chips">
                <span className="zc-chip is-sm">
                  <Icon name="clock" size={12} />
                  {seconds / 60n > 0n ? `${seconds / 60n} 分 ` : ""}
                  {String(seconds % 60n)} 秒
                </span>
                <span className="zc-chip is-sm">
                  <Icon name="media" size={12} />
                  {project.format?.height ?? 1080}p
                </span>
                <span className="zc-chip is-sm">
                  <Icon name="play" size={12} />
                  {fps} 帧/秒
                </span>
                <span className="zc-chip is-sm">
                  <Icon name="subtitle" size={12} />
                  {project.cues.length} 条字幕
                </span>
              </div>
            </section>
          </div>
          <div className="zc-export-right" data-destination={selectedKey}>
            <h3>
              <span className="zc-export-step">2</span>交给 {title} 会得到什么
            </h3>
            <div className="zc-card zc-export-file-card">
              <div className="zc-files">
                {(selectedKey === "overlays"
                  ? ["mov"]
                  : selectedKey === "direct"
                    ? [...(settings.srt ? ["srt"] : []), ...(settings.wav ? ["wav"] : [])]
                    : destination.files
                ).map((ext) => (
                  <FileIcon key={ext} ext={ext} />
                ))}
              </div>
              <div>
                <strong>
                  {project.name}
                  {selectedKey === "overlays"
                    ? ".mov"
                    : selectedKey === "direct"
                      ? " · 字幕与音频"
                      : `.${destination.files[0]}`}
                </strong>
                <p className="zc-hint">
                  {selectedKey === "overlays"
                    ? "带透明通道的字幕视频，样式与预览一致。"
                    : selectedKey === "direct"
                      ? "按需选择字幕 SRT 和音频 WAV。"
                      : "时间线文件，素材不复制，原地引用。"}
                </p>
              </div>
            </div>
            {selectedKey === "direct" ? (
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
            ) : selectedKey === "overlays" ? (
              <div className="zc-overlay-content">
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
                            {project.subtitleTracks?.find((t) => t.id === overlay.subtitle_track_id)?.name ?? "字幕轨"}{" "}
                            ·{" "}
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
                          void edit(`删除字幕叠层「${overlay.name}」`, [
                            { op: "remove_overlay", overlay_id: overlay.id },
                          ])
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
              </div>
            ) : (
              <section className="zc-export-losses" aria-label="带过去的情况">
                <h4 className="zc-overline">带过去的情况</h4>
                {!report ? (
                  <p className="zc-hint">{checks[destination.key] ?? "正在检查交接损失…"}</p>
                ) : report.items.length ? (
                  groupLosses(report.items).map((loss) => (
                    <div className="zc-row" key={`${loss.feature}-${loss.status}`}>
                      <span
                        className={`zc-dot ${loss.status === "unsupported" || loss.severity === "error" ? "is-danger" : "is-attention"}`}
                      />
                      <span className="text">
                        {featureLabel(loss.feature, loss.count)}
                        <small>{[...loss.consequences].join("；")}</small>
                      </span>
                      <span className="zc-meta">
                        {loss.status === "unsupported" ? "带不过去" : "近似"}
                        {loss.status === "baked" ? " · 已烘焙" : ""}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="zc-row">
                    <span className="zc-dot is-approved" />
                    <span>保留 · 检查完成，未发现交接损失</span>
                  </div>
                )}
                {Object.entries(report?.summary?.preserved_by_feature ?? {})
                  .filter(([, count]) => count > 0)
                  .map(([feature, count]) => (
                    <div className="zc-row" key={feature}>
                      <span className="zc-dot is-approved" />
                      <span className="text">{featureLabel(feature, count)}</span>
                      <span className="zc-meta">原样</span>
                    </div>
                  ))}
              </section>
            )}
            <section className="zc-export-import">
              <h4 className="zc-overline">导入方法</h4>
              <p>
                {selectedKey === "fcp"
                  ? "在 Final Cut Pro 里选「文件 › 导入 › XML…」，选择导出的 FCPXML 文件。"
                  : selectedKey === "resolve"
                    ? "在 DaVinci Resolve 中导入 OTIO 时间线，再单独导入 SRT 字幕。"
                    : selectedKey === "premiere"
                      ? "在 Premiere Pro 中导入 XML 时间线，再单独导入 SRT 字幕。"
                      : selectedKey === "overlays"
                        ? "把透明字幕视频放到剪辑软件时间线的最上层。"
                        : "SRT 可导入剪辑软件作为字幕；WAV 可作为音频素材使用。"}
              </p>
            </section>
          </div>
        </fieldset>
        <footer className="zc-export-footer">
          <div className="zc-export-feedback">
            {error && <p role="alert">{error}</p>}
            {selectedKey !== "overlays" && status(selectedKey)}
          </div>
          <h3>
            <span className="zc-export-step">3</span>存到
          </h3>
          {selectedKey === "overlays" ? (
            <span className="zc-hint zc-export-location">使用各叠层的保存位置；点叠层覆盖导出。</span>
          ) : (
            <div className="zc-export-location">
              <input
                className="zc-input"
                aria-label={`${selectedKey === "direct" ? "直接导出" : destination.name}保存位置`}
                placeholder="导出文件夹的绝对路径"
                value={paths[selectedKey] ?? ""}
                disabled={Boolean(settings.active)}
                onChange={(event) => setPaths({ ...paths, [selectedKey]: event.target.value })}
              />
              <Button
                icon="folder"
                className="is-secondary"
                disabled={Boolean(settings.active) || !isTauri()}
                onClick={() => void choose(selectedKey).catch(() => setError("无法选择保存位置"))}
              >
                选择
              </Button>
            </div>
          )}
          <Button variant="text" onClick={() => change({ open: false })}>
            取消
          </Button>
          <Button
            variant="primary"
            className="is-primary is-lg"
            icon="export"
            aria-label={
              selectedKey === "direct" ? "直接导出" : selectedKey === "overlays" ? "新建叠层" : `导出到 ${title}`
            }
            disabled={
              Boolean(settings.active || editing || confirm) ||
              (selectedKey === "overlays" ? !project.subtitleTracks?.length : selectedKey !== "direct" && !report)
            }
            onClick={exportSelected}
          >
            {selectedKey === "overlays" ? "新建叠层" : `导出到 ${title}`}
          </Button>
        </footer>
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
            <Button
              variant="secondary"
              icon="close"
              disabled={Boolean(settings.active)}
              onClick={() => setEditing(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              icon="check"
              type="submit"
              disabled={Boolean(settings.active) || !name.trim() || !track || !output}
            >
              保存叠层
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
