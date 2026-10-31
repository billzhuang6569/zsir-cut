import { useEffect, useId, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { SubtitleCanvas } from "./SubtitleCanvas.js";
import { alignment, defaultStyle, textEdit } from "./subtitles.js";
import { mediaUrl } from "./TimelinePreview.js";
import {
  type CueView,
  ceil,
  compare,
  contains,
  frameTime,
  mul,
  parseRational,
  printRational,
  type Recognition,
  type StyleView,
  seekTarget,
  sourceAt,
  sub,
} from "./timeline.js";
import "./subtitles.css";

const languages = [
  ["zh", "中文（普通话）"],
  ["en", "English"],
  ["yue", "中文（粤语）"],
  ["ja", "日本語"],
  ["ko", "한국어"],
];
const fonts = [
  ["PingFang SC", "苹方"],
  ["Hiragino Sans GB", "冬青黑体"],
  ["Source Han Sans SC", "思源黑体"],
  ["Noto Sans CJK SC", "Noto Sans CJK"],
  ["Microsoft YaHei", "微软雅黑"],
];
function SelectSetting({
  label,
  value,
  options,
  save,
}: {
  label: string;
  value: string;
  options: string[][];
  save: (value: string) => void;
}) {
  return (
    <label className="zc-sub-setting">
      {label}
      <span className="zc-sub-select">
        <select className="zc-input" aria-label={label} value={value} onChange={(e) => save(e.target.value)}>
          {!options.some(([id]) => id === value) && <option value={value}>{value}</option>}
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <Icon name="down" />
      </span>
    </label>
  );
}
function Terms({ label, values, save }: { label: string; values: string[]; save: (values: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  return (
    <fieldset className="zc-sub-terms" aria-label={label}>
      {values.map((value) => (
        <span className="zc-tag" key={value}>
          {value}
          <button
            type="button"
            aria-label={`删除${label}「${value}」`}
            onClick={() => save(values.filter((v) => v !== value))}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="zc-input"
          aria-label={`添加${label}`}
          placeholder="输入后按回车"
          value={text}
          ref={(input) => input?.focus()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && text.trim()) {
              e.preventDefault();
              save([...new Set([...values, text.trim()])]);
              setText("");
              setAdding(false);
            }
            if (e.key === "Escape") {
              setText("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <IconButton icon="plus" label={`添加${label}`} onClick={() => setAdding(true)} />
      )}
    </fieldset>
  );
}
function TextSetting({
  label,
  value,
  save,
  multiline = false,
  placeholder,
  color = false,
}: {
  label: string;
  value: string;
  save: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  color?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    className: "zc-input",
    "aria-label": label,
    defaultValue: value,
    placeholder,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value !== value) save(e.target.value);
    },
  };
  return (
    <label className={`zc-sub-setting${color ? " zc-sub-color" : ""}`} htmlFor={id}>
      <span>{label}</span>
      {color && <span className="zc-sub-swatch" style={{ backgroundColor: value }} aria-hidden="true" />}
      {multiline ? (
        <textarea key={value} {...props} rows={4} />
      ) : (
        <input
          key={value}
          {...props}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}
function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  save,
  preview,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  save: (value: number) => void;
  preview: (value: number) => void;
}) {
  const commit = (input: HTMLInputElement) => {
    if (input.checkValidity() && input.value !== "") save(Number(input.value));
  };
  return (
    <label className="zc-sub-setting zc-sub-number">
      <span>{label}</span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => preview(Number(e.target.value))}
        onPointerUp={(e) => commit(e.currentTarget)}
        onKeyUp={(e) => commit(e.currentTarget)}
        onBlur={(e) => commit(e.currentTarget)}
      />
      <input
        aria-label={`${label}数值`}
        className="zc-input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          if (e.target.value !== "") preview(Number(e.target.value));
        }}
        onBlur={(e) => commit(e.currentTarget)}
      />
    </label>
  );
}
export function useSubtitlePanel({
  project,
  state,
  update,
  call,
  config,
}: {
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  config?: { port: number; token: string } | undefined;
}) {
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<number | null>(null);
  const locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fillersOpen, setFillersOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [styleTrackId, setStyleTrackId] = useState("");
  const [customFont, setCustomFont] = useState(false);
  const browser = state.subtitleBrowser ?? { search: "", find: "", replace: "", matchCase: false };
  const setBrowser = (patch: Partial<typeof browser>) =>
    update({ ...state, subtitleBrowser: { ...browser, ...patch } });
  const recognition = project?.recognition ?? {};
  const [removeFillers, setRemoveFillers] = useState(recognition.remove_fillers ?? true);
  useEffect(() => setRemoveFillers(recognition.remove_fillers ?? true), [recognition.remove_fillers]);
  const cues = project?.cues ?? [];
  const at = project ? seekTarget(project, cues, state.playhead) : "0s";
  const subtitleTracks = project?.subtitleTracks ?? project?.tracks.filter((track) => track.kind === "subtitle") ?? [];
  const styleTrack = subtitleTracks.find((track) => track.id === styleTrackId) ?? subtitleTracks[0];
  const trackCues = cues.filter((cue) => cue.track_id === styleTrack?.id);
  const sample = trackCues.find((cue) => contains(cue.start, cue.end, at)) ?? trackCues[0];
  const styleId = styleTrack && "default_style_id" in styleTrack ? styleTrack.default_style_id : trackCues[0]?.style_id;
  const style = project?.styles.find((item) => item.id === styleId);
  const [styleDraft, setStyleDraft] = useState<StyleView>(style ?? defaultStyle);
  useEffect(() => setStyleDraft(style ?? defaultStyle), [style]);
  const committedStyle = useRef(style);
  useEffect(() => {
    committedStyle.current = style;
  }, [style]);
  const write = async (ops: Record<string, unknown>[], label: string) => {
    if (!project || locked.current || !ops.length) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = (await call("edit", {
        project: state.project,
        timeline_id: project.id,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label,
        ops,
      })) as { warnings?: { code: string; cue_ids?: string[] }[] };
      if (ops.some((op) => op.op === "replace_text"))
        setSkipped(
          result?.warnings?.filter((w) => w.code === "W_REPLACE_SKIPPED_LOCKED").flatMap((w) => w.cue_ids ?? []) ?? [],
        );
      return true;
    } catch {
      setError("字幕修改失败，请检查工程后重试");
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const setRecognition = (patch: Partial<Recognition>) =>
    void write([{ op: "set_recognition", ...patch }], "修改字幕识别设置");
  const transcribe = async () => {
    if (!project || locked.current) return;
    locked.current = true;
    setBusy(true);
    setProgress(0);
    setError("");
    try {
      const media = project.media.filter((item) => item.audio);
      let baseRevision = project.revision.id;
      for (const [index, item] of media.entries()) {
        const result = (await call("transcribe", {
          project: state.project,
          media_id: item.id,
          base_revision: baseRevision,
          idempotency_key: crypto.randomUUID(),
          author: DESKTOP_AUTHOR,
          label: `识别「${item.name ?? "素材"}」的字幕`,
        })) as { job_id?: string };
        if (result?.job_id) {
          for (;;) {
            if (!alive.current) return;
            const job = (await call("job_status", { project: state.project, job_id: result.job_id })) as {
              state: string;
              progress: number;
              envelope?: { ok: boolean };
            };
            setProgress((index + job.progress) / media.length);
            if (job.state === "failed" || job.state === "cancelled" || job.envelope?.ok === false) throw new Error();
            if (job.state === "succeeded") break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (index < media.length - 1) {
          // Each successful recognition creates a revision; read it before the next media.
          const brief = (await call("inspect", { project: state.project, view: "brief" })) as {
            project: { revision: { id: string } };
          };
          baseRevision = brief.project.revision.id;
        }
      }
    } catch {
      setError("识别失败，请检查语音引擎和素材后重试");
    } finally {
      locked.current = false;
      setBusy(false);
      setProgress(null);
    }
  };
  const choose = (cue: CueView) =>
    update({ ...state, selected: [cue.cue_id], playhead: { at: cue.start }, preview: "timeline", playing: false });
  const begin = (cue: CueView) => {
    setEditing(`${cue.track_id}:${cue.cue_id}:${cue.piece}:${cue.start}`);
    setDraft(cue.text);
  };
  const saveText = async (cue: CueView) => {
    if (draft === cue.text) {
      setEditing(null);
      return;
    }
    const op = textEdit(cue, draft);
    if (cue.transcript_id && !cue.text_override && !op) {
      setError("字幕内容已变化，请刷新工程后重试");
      return;
    }
    const ops = cue.text_override
      ? [
          {
            op: "set_override",
            track_id: cue.track_id,
            occurrence_id: cue.occurrence_id,
            cue_id: cue.cue_id,
            text: draft,
          },
        ]
      : cue.transcript_id
        ? op
          ? [op]
          : []
        : [
            { op: "remove_free_cue", track_id: cue.track_id, id: cue.cue_id },
            {
              op: "add_free_cue",
              track_id: cue.track_id,
              id: cue.cue_id,
              timeline_start: cue.start,
              duration: printRational(sub(parseRational(cue.end, true), parseRational(cue.start, true)), true),
              text: draft,
              style_id: cue.style_id,
            },
          ];
    if (await write(ops, "编辑字幕文字")) setEditing(null);
  };
  const changeStyle = (patch: Partial<StyleView>, commit: boolean) => {
    const next = { ...styleDraft, ...patch };
    setStyleDraft(next);
    if (!commit || !style || locked.current) return;
    const changed = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(committedStyle.current?.[key as keyof StyleView]),
      ),
    );
    if (!Object.keys(changed).length) return;
    void write([{ op: "update_style", style_id: style.id, ...changed }], "修改字幕样式").then((ok) => {
      if (ok) committedStyle.current = next;
    });
  };
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    patch: (value: number) => Partial<StyleView>,
  ) => (
    <NumberSetting
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      preview={(n) => changeStyle(patch(n), false)}
      save={(n) => changeStyle(patch(n), true)}
    />
  );
  const position = styleDraft.position ?? defaultStyle.position;
  const box = styleDraft.box ?? { color: "#00000000", padding: 0, radius: 0 };
  const outline = styleDraft.outline ?? { color: "#000000", width: 0 };
  const clip = project?.tracks
    .find((track) => track.kind === "video" && track.enabled)
    ?.clips.find((clip) => clip.enabled && contains(clip.timeline_in.t, clip.timeline_out.t, at));
  const background =
    config && clip ? mediaUrl(config, "thumb", clip.media_id, printRational(sourceAt(clip, at), true)) : undefined;
  const passProgress = project?.subtitlePass?.progress ?? [];
  const failed = project?.subtitlePass?.warnings ?? [];
  const pending = !!project?.unprocessedTranscripts?.length;
  const done = passProgress.reduce((sum, item) => sum + item.done, 0);
  const total = passProgress.reduce((sum, item) => sum + item.total, 0);
  const controls = (
    <div className="zc-sub-controls">
      <p className={`zc-sub-status${project?.recognized ? " is-recognized" : ""}`}>
        <span className="zc-dot" aria-hidden="true" />
        {project?.subtitlePass?.running
          ? `AI 整理字幕… ${done} / ${total}`
          : failed.length
            ? "字幕整理失败"
            : pending
              ? "AI 整理字幕…"
              : project?.recognized
                ? `已识别${project.recognitionRevision !== undefined ? ` · 第 ${project.recognitionRevision} 版` : ""} · ${cues.length} 条字幕`
                : "还没有识别"}
        {!!project?.subtitlePass?.warnings.length && !project.subtitlePass.running && (
          <span
            className="zc-sub-attention"
            role="img"
            aria-label="字幕整理失败"
            title={project.subtitlePass.warnings.map((warning) => warning.reason).join("；")}
          >
            ⚠
          </span>
        )}
      </p>
      <fieldset disabled={!project || busy}>
        <SelectSetting
          label="语言"
          value={recognition.language ?? "zh"}
          options={languages}
          save={(language) => setRecognition({ language })}
        />
        <TextSetting
          label="参考文本"
          placeholder="粘贴采访提纲、文稿或人名表，AI 会从里面找专有名词"
          multiline
          value={recognition.reference_text ?? ""}
          save={(reference_text) => setRecognition({ reference_text })}
        />
        <h3>专有名词</h3>
        <Terms label="专有名词" values={recognition.terms ?? []} save={(terms) => setRecognition({ terms })} />
        <label className="zc-switch-row" title="嗯、啊、呃……整个字词是语气词时，字幕里不显示，时间不动">
          去除水词
          <input
            type="checkbox"
            aria-label="去除水词"
            role="switch"
            aria-checked={removeFillers}
            className="zc-switch"
            checked={removeFillers}
            onChange={(e) => setRemoveFillers(e.target.checked)}
            onBlur={() => {
              if (removeFillers !== (recognition.remove_fillers ?? true))
                setRecognition({ remove_fillers: removeFillers });
            }}
          />
        </label>
        <button
          type="button"
          className="zc-btn zc-btn-ghost"
          aria-expanded={fillersOpen}
          onClick={() => setFillersOpen(!fillersOpen)}
        >
          编辑水词表
        </button>
        {fillersOpen && (
          <Terms
            label="水词"
            values={recognition.filler_words ?? ["嗯", "啊", "呃", "额", "哦", "唉", "哎", "诶"]}
            save={(filler_words) => setRecognition({ filler_words })}
          />
        )}
      </fieldset>
      <button
        type="button"
        className="zc-btn zc-btn-primary zc-sub-recognize"
        disabled={!project?.media.some((m) => m.audio) || busy}
        onClick={() => void transcribe()}
      >
        <Icon name="refresh" />
        {progress === null ? "重新识别" : `识别中 ${Math.round(progress * 100)}%`}
      </button>
      {progress !== null && <progress aria-label="识别进度" max={1} value={progress} />}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  const visible = cues
    .filter((cue) => cue.text.toLocaleLowerCase().includes(browser.search.toLocaleLowerCase()))
    .sort((a, b) => compare(parseRational(a.start, true), parseRational(b.start, true)));
  const parameters = (
    <div className="zc-sub-parameters">
      <div className="zc-tabs" role="tablist" aria-label="字幕参数">
        {["subtitles", "style"].map((sub) => (
          <button
            type="button"
            role="tab"
            className="zc-tab"
            key={sub}
            aria-selected={(state.sub ?? "subtitles") === sub}
            onClick={() => update({ ...state, sub })}
          >
            {sub === "style" ? "样式" : "字幕"}
          </button>
        ))}
      </div>
      {project?.subtitlePass?.running ? (
        <p className="zc-muted">
          识别完成，AI 正在按意思断句，大约还要 {Math.max(1, Math.ceil((total - done) / 6))} 分钟
        </p>
      ) : failed.length ? (
        <p role="alert">
          {failed.map((warning) => warning.reason).join("；")}{" "}
          <IconButton icon="refresh" label="重新整理" onClick={() => void call("chat_subtitle_retry", {})} />
        </p>
      ) : pending ? (
        <p className="zc-muted">识别完成，AI 正在按意思断句</p>
      ) : state.sub !== "style" ? (
        <>
          <div className="zc-sub-search-row">
            <label className="zc-sub-search">
              <Icon name="search" />
              <input
                className="zc-input"
                aria-label="搜索字幕"
                placeholder="搜索字幕"
                value={browser.search}
                onChange={(e) => setBrowser({ search: e.target.value })}
              />
            </label>
            <IconButton
              icon="replace"
              label="查找替换"
              aria-expanded={replaceOpen}
              onClick={() => setReplaceOpen(!replaceOpen)}
            />
          </div>
          {replaceOpen && (
            <div className="zc-sub-replace">
              <input
                className="zc-input"
                aria-label="查找"
                value={browser.find}
                onChange={(e) => setBrowser({ find: e.target.value })}
              />
              <input
                className="zc-input"
                aria-label="替换为"
                value={browser.replace}
                onChange={(e) => setBrowser({ replace: e.target.value })}
              />
              <label className="zc-switch-row">
                <input
                  className="zc-switch"
                  role="switch"
                  aria-label="区分大小写"
                  aria-checked={browser.matchCase}
                  type="checkbox"
                  checked={browser.matchCase}
                  onChange={(e) => setBrowser({ matchCase: e.target.checked })}
                />
                区分大小写
              </label>
              <button
                className="zc-btn zc-btn-secondary"
                type="button"
                disabled={!project || busy || !browser.find}
                onClick={() =>
                  void write(
                    [
                      {
                        op: "replace_text",
                        find: browser.find,
                        replace: browser.replace,
                        match_case: browser.matchCase,
                      },
                    ],
                    "全部替换字幕文字",
                  )
                }
              >
                全部替换
              </button>
            </div>
          )}
          {!!skipped.length && <output className="zc-sub-attention">跳过 {skipped.length} 条锁定字幕</output>}
          {!visible.length && <p className="zc-muted">暂无字幕</p>}
          <div className="zc-sub-list">
            {visible.map((cue, index) => {
              const key = `${cue.track_id}:${cue.cue_id}:${cue.piece}:${cue.start}`;
              const warnings = project?.subtitleWarnings?.filter((w) => w.ids.includes(cue.cue_id)) ?? [];
              const reasons = warnings.map((w) =>
                w.code === "W_SUB_SHORT"
                  ? "字幕显示时间过短"
                  : w.code === "W_SUB_TOO_WIDE" || w.code === "W_SUB_OVERFLOW"
                    ? "字幕超出宽度或行数"
                    : "字幕投影需要检查",
              );
              return (
                <div
                  className={`zc-sub-row${state.selected.includes(cue.cue_id) ? " is-selected" : ""}${skipped.includes(cue.cue_id) ? " is-skipped" : ""}`}
                  key={key}
                >
                  <span className={warnings.length ? "zc-sub-attention" : "zc-muted"} title={reasons.join("；")}>
                    {index + 1}
                  </span>
                  {editing === key ? (
                    <textarea
                      aria-label="编辑字幕"
                      className="zc-input"
                      value={draft}
                      disabled={busy}
                      ref={(input) => input?.focus()}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(null);
                        }
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void saveText(cue);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="zc-sub-text"
                      onClick={() => choose(cue)}
                      onDoubleClick={() => begin(cue)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          begin(cue);
                        }
                        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                          e.preventDefault();
                          const next = visible[index + (e.key === "ArrowUp" ? -1 : 1)];
                          if (next) {
                            choose(next);
                            const row = e.currentTarget.closest(".zc-sub-row");
                            (e.key === "ArrowUp" ? row?.previousElementSibling : row?.nextElementSibling)
                              ?.querySelector<HTMLButtonElement>(".zc-sub-text")
                              ?.focus();
                          }
                        }
                      }}
                    >
                      {cue.text}
                    </button>
                  )}
                  <span className="zc-sub-actions">
                    <IconButton
                      icon="plus"
                      label="在后面加一条"
                      disabled={busy}
                      onClick={() => {
                        const start = project
                          ? frameTime(
                              ceil(mul(parseRational(cue.end, true), parseRational(project.edit_rate))),
                              project.edit_rate,
                            )
                          : cue.end;
                        void write(
                          [
                            {
                              op: "add_free_cue",
                              track_id: cue.track_id,
                              timeline_start: start,
                              duration: "2s",
                              text: "新字幕",
                              style_id: cue.style_id,
                            },
                          ],
                          "在字幕后加一条",
                        );
                      }}
                    />
                    <IconButton
                      icon="trash"
                      label="删除字幕"
                      disabled={busy}
                      onClick={() =>
                        void write(
                          [
                            cue.transcript_id
                              ? {
                                  op: "hide_tokens",
                                  transcript_id: cue.transcript_id,
                                  tokens: cue.tokens?.map((token) => token.id) ?? [],
                                }
                              : { op: "remove_free_cue", track_id: cue.track_id, id: cue.cue_id },
                          ],
                          "删除字幕",
                        )
                      }
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          {subtitleTracks.length > 1 && (
            <fieldset className="zc-seg zc-sub-tracks" aria-label="字幕样式轨道">
              {subtitleTracks.map((track) => (
                <button
                  type="button"
                  className="zc-btn zc-btn-ghost"
                  key={track.id}
                  aria-pressed={track.id === styleTrack?.id}
                  onClick={() => {
                    setStyleTrackId(track.id);
                    setCustomFont(false);
                  }}
                >
                  {track.name}
                </button>
              ))}
            </fieldset>
          )}
          <div
            className="zc-sub-sample"
            style={{
              aspectRatio: `${project?.format?.width ?? 1920} / ${project?.format?.height ?? 1080}`,
              backgroundImage: background ? `url("${background}")` : undefined,
            }}
          >
            <SubtitleCanvas
              cues={[
                {
                  text: sample?.text ?? "字幕样式预览",
                  style_id: styleDraft.id,
                },
              ]}
              styles={[styleDraft]}
              format={project?.format}
            />
          </div>
          <fieldset className="zc-sub-style" disabled={!style || busy}>
            <h3>预设</h3>
            <div className="zc-sub-presets">
              {["描边白字", "黑底白字", "黄字"].map((name, index) => (
                <button
                  type="button"
                  className={`zc-sub-preset zc-sub-preset-${index}`}
                  aria-label={name}
                  title={name}
                  aria-pressed={
                    styleDraft.color.toUpperCase() === (index === 2 ? "#FFD84A" : "#FFFFFF") &&
                    (index === 1
                      ? box.color === "#000000CC" && outline.width === 0
                      : box.color === "#00000000" && outline.width === 0.06)
                  }
                  key={name}
                  onClick={() =>
                    changeStyle(
                      {
                        color: index === 2 ? "#FFD84A" : "#FFFFFF",
                        outline: { color: "#000000", width: index === 1 ? 0 : 0.06 },
                        box: {
                          color: index === 1 ? "#000000CC" : "#00000000",
                          padding: index === 1 ? 0.3 : 0,
                          radius: 0.15,
                        },
                      },
                      true,
                    )
                  }
                >
                  <span>字幕</span>
                </button>
              ))}
            </div>
            <h3>字体</h3>
            <SelectSetting
              label="字体族"
              value={
                customFont || !fonts.some(([value]) => value === styleDraft.font_family)
                  ? "other"
                  : styleDraft.font_family
              }
              options={[...fonts, ["other", "其他…"]]}
              save={(font_family) => {
                setCustomFont(font_family === "other");
                if (font_family !== "other") changeStyle({ font_family }, true);
              }}
            />
            {(customFont || !fonts.some(([value]) => value === styleDraft.font_family)) && (
              <TextSetting
                label="其他字体"
                value={styleDraft.font_family}
                save={(font_family) => changeStyle({ font_family }, true)}
              />
            )}
            <SelectSetting
              label="字重"
              value={String(styleDraft.font_weight ?? 400)}
              options={Array.from({ length: 9 }, (_, i) => [String((i + 1) * 100), String((i + 1) * 100)])}
              save={(value) => changeStyle({ font_weight: Number(value) }, true)}
            />
            {number("字号", styleDraft.font_size, 0.01, 0.2, 0.001, (font_size) => ({ font_size }))}
            <h3>颜色</h3>
            <TextSetting
              color
              label="文字颜色"
              value={styleDraft.color}
              save={(color) => changeStyle({ color }, true)}
            />
            <h3>描边</h3>
            <TextSetting
              color
              label="描边颜色"
              value={outline.color}
              save={(color) => changeStyle({ outline: { ...outline, color } }, true)}
            />
            {number("描边宽度", outline.width, 0, 0.3, 0.01, (width) => ({ outline: { ...outline, width } }))}
            <h3>底板</h3>
            <TextSetting
              color
              label="底板颜色"
              value={box.color}
              save={(color) => changeStyle({ box: { ...box, color } }, true)}
            />
            {number("内边距", box.padding ?? 0, 0, 2, 0.05, (padding) => ({ box: { ...box, padding } }))}
            {number("圆角", box.radius ?? 0, 0, 2, 0.05, (radius) => ({ box: { ...box, radius } }))}
            <h3>位置</h3>
            <fieldset className="zc-sub-align" aria-label="字幕对齐">
              {[0, 1, 2].flatMap((row) =>
                [0, 1, 2].map((column) => {
                  const mapped = alignment(row, column, position?.max_width ?? 0.8);
                  const label = `${["上", "中", "下"][row]}${["左", "中", "右"][column]}`;
                  return (
                    <button
                      type="button"
                      key={label}
                      aria-label={label}
                      aria-pressed={position?.anchor === mapped.anchor && (position.offset_x ?? 0) === mapped.offset_x}
                      onClick={() =>
                        changeStyle(
                          { position: { ...position, margin_v: position?.margin_v ?? 0.08, ...mapped } },
                          true,
                        )
                      }
                    >
                      ·
                    </button>
                  );
                }),
              )}
            </fieldset>
            {number("上下边距", position?.margin_v ?? 0.08, 0, 0.5, 0.01, (margin_v) => ({
              position: { anchor: "bottom", ...position, margin_v },
            }))}
            {number("最大宽度", position?.max_width ?? 0.8, 0.1, 1, 0.01, (max_width) => {
              const old = position?.offset_x ?? 0;
              return {
                position: {
                  anchor: "bottom",
                  margin_v: 0.08,
                  ...position,
                  max_width,
                  offset_x: old === 0 ? 0 : (Math.sign(old) * (1 - max_width)) / 2,
                },
              };
            })}
            {number("行距", styleDraft.line_spacing ?? 1.2, 0.5, 3, 0.1, (line_spacing) => ({ line_spacing }))}
            {number("最多行数", styleDraft.max_lines ?? 2, 1, 3, 1, (max_lines) => ({ max_lines }))}
            <button
              className="zc-btn zc-btn-primary"
              type="button"
              disabled={!project?.styles.length}
              onClick={() => {
                const { font_family, font_size, color, font_weight, outline, box, position, max_lines, line_spacing } =
                  styleDraft;
                const fields = {
                  font_family,
                  font_size,
                  color,
                  font_weight: font_weight ?? null,
                  outline: outline ?? null,
                  box: box ?? null,
                  position: position ?? null,
                  max_lines: max_lines ?? null,
                  line_spacing: line_spacing ?? null,
                };
                void write(
                  (project?.styles ?? []).map((item) => ({ op: "update_style", style_id: item.id, ...fields })),
                  "应用样式到所有字幕",
                );
              }}
            >
              应用到所有字幕
            </button>
          </fieldset>
        </>
      )}
    </div>
  );
  return { controls, parameters };
}
