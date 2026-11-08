import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { SubtitleAnimationCell } from "./SubtitleAnimationCell.js";
import { presetGroups, presetPatch, subtitlePresets } from "./subtitle-presets.js";
import {
  alignment,
  canMerge,
  caretLine,
  caretOffset,
  cueEdit,
  cueKey,
  cueLocked,
  defaultStyle,
  editorText,
  formatSubtitleTime,
  placeCaret,
  type SubtitleOp,
  subtitleStyleOps,
  tokenSpans,
} from "./subtitles.js";
import {
  type CueView,
  ceil,
  compare,
  contains,
  frameTime,
  mul,
  numberOf,
  parseRational,
  printRational,
  type Recognition,
  rational,
  type StyleView,
  seekTarget,
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
    <label className="zc-field zc-sub-setting">
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
      {label === "专有名词" && !values.length && !adding && (
        <span className="zc-hint">添加人名、品牌或行业术语，帮助识别更准确</span>
      )}
      {values.map((value) => (
        <span className="zc-chip is-sm" key={value}>
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
  preview,
}: {
  label: string;
  value: string;
  save: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  color?: boolean;
  preview?: (value: string) => void;
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
    <label className={`zc-field zc-sub-setting${color ? " zc-sub-color" : ""}`} htmlFor={id}>
      <span>{label}</span>
      {color && (
        <input
          type="color"
          className="zc-sub-swatch"
          aria-label={`${label}取色`}
          title={`${label}自定义取色`}
          value={value.slice(0, 7)}
          onChange={(e) => preview?.(e.target.value + value.slice(7))}
          onPointerUp={(e) => save(e.currentTarget.value + value.slice(7))}
          onKeyUp={(e) => save(e.currentTarget.value + value.slice(7))}
          onBlur={(e) => save(e.currentTarget.value + value.slice(7))}
        />
      )}
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
  slider = true,
  unit = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  save: (value: number) => void;
  preview: (value: number) => void;
  slider?: boolean;
  unit?: string;
}) {
  const commit = (input: HTMLInputElement) => {
    if (input.checkValidity() && input.value !== "") save(Number(input.value));
  };
  return (
    <label className={`zc-field zc-sub-setting zc-sub-number${slider ? "" : " zc-sub-size"}`}>
      <span>
        {label}
        {unit && `（${unit}）`}
      </span>
      {slider && (
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
      )}
      <input
        aria-label={slider ? `${label}数值` : label}
        className="zc-input"
        type="number"
        title={unit ? `${label}（${unit}）` : label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          if (e.target.value !== "") preview(Number(e.target.value));
        }}
        onPointerUp={slider ? undefined : (e) => commit(e.currentTarget)}
        onKeyUp={slider ? undefined : (e) => commit(e.currentTarget)}
        onBlur={(e) => commit(e.currentTarget)}
      />
    </label>
  );
}
function SubtitleRow({
  cue,
  active,
  busy,
  match,
  register,
  begin,
  end,
  commit,
  navigate,
  merge,
  undo,
  context,
}: {
  cue: CueView;
  active: boolean;
  busy: boolean;
  match?: { start: number; end: number } | undefined;
  register: (node: HTMLDivElement | null) => void;
  begin: () => void;
  end: () => void;
  commit: (text: string, splitAt?: number) => Promise<boolean>;
  navigate: (direction: number, offset: number) => void;
  merge: (direction: number, text: string) => Promise<boolean>;
  undo: (redo: boolean) => void;
  context: (event: React.MouseEvent, offset: number, token?: string) => void;
}) {
  const node = useRef<HTMLDivElement | null>(null);
  const draft = useRef(cue.text);
  const committed = useRef(cue.text);
  const rendered = useRef(cue.text);
  const history = useRef([{ text: cue.text, offset: 0 }]);
  const historyAt = useRef(0);
  const skipBlur = useRef(false);
  const readonly = !!cueLocked(cue);
  const escapeHtml = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  let spans: ReturnType<typeof tokenSpans> = [];
  try {
    spans = tokenSpans(cue);
  } catch {
    /* Overrides have no source-token mapping. */
  }
  const boundaries = [
    ...new Set([
      0,
      cue.text.length,
      ...spans.flatMap((span) => [span.start, span.end]),
      ...(match ? [match.start, match.end] : []),
    ]),
  ].sort((a, b) => a - b);
  const html = boundaries
    .slice(0, -1)
    .map((start, index) => {
      const stop = boundaries[index + 1] ?? cue.text.length;
      const span = spans.find((span) => span.start <= start && span.end >= stop && span.token.text);
      const changed =
        span?.token.state === "edited" && span.token.heard !== undefined && span.token.heard !== span.token.text;
      const text = escapeHtml(cue.text.slice(start, stop));
      const marked = match && start >= match.start && stop <= match.end ? `<mark>${text}</mark>` : text;
      return span
        ? `<span data-token="${escapeHtml(span.token.id)}"${changed ? ` class="zc-sub-edited" title="原来：${escapeHtml(span.token.heard ?? "")}"` : ""}>${marked}</span>`
        : marked;
    })
    .join("");
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const changed = rendered.current !== cue.text;
    const focused = document.activeElement === element;
    // A committed cue replaces browser-owned content even while this row has focus.
    if (changed || !focused || draft.current === cue.text) {
      const offset = focused ? caretOffset(element) : 0;
      element.innerHTML = html;
      if (focused) placeCaret(element, offset);
    }
    if (changed) {
      rendered.current = cue.text;
      committed.current = cue.text;
      draft.current = cue.text;
      history.current = [{ text: cue.text, offset: 0 }];
      historyAt.current = 0;
    }
  }, [html, cue.text]);
  const record = () => {
    if (!node.current) return;
    draft.current = editorText(node.current);
    history.current = history.current.slice(0, historyAt.current + 1);
    history.current.push({ text: draft.current, offset: caretOffset(node.current) });
    historyAt.current++;
  };
  const leave = async (text: string, splitAt?: number) => {
    skipBlur.current = true;
    const ok = await commit(text, splitAt);
    if (ok) {
      committed.current = rendered.current === cue.text ? text : rendered.current;
      history.current = [{ text: committed.current, offset: node.current ? caretOffset(node.current) : 0 }];
      historyAt.current = 0;
    }
    skipBlur.current = false;
    return ok;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: Inline rich text editing requires contentEditable.
    <div
      className="zc-sub-text"
      role="textbox"
      aria-label={active ? "编辑字幕" : cue.text}
      aria-multiline="true"
      aria-readonly={readonly}
      contentEditable={!readonly && !busy}
      suppressContentEditableWarning
      tabIndex={0}
      ref={(element) => {
        node.current = element;
        register(element);
      }}
      onFocus={() => {
        skipBlur.current = false;
        if (!readonly) begin();
      }}
      onClick={() => {
        if (!active) begin();
      }}
      onInput={record}
      onPaste={(event) => {
        if (readonly) return;
        event.preventDefault();
        const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
        if (!range || !node.current?.contains(range.commonAncestorContainer)) return;
        range.deleteContents();
        const text = document.createTextNode(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
        range.insertNode(text);
        range.setStartAfter(text);
        range.collapse(true);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        record();
      }}
      onBlur={() => {
        if (skipBlur.current || readonly) return;
        if (draft.current !== committed.current) void leave(draft.current);
        else end();
      }}
      onContextMenu={(event) =>
        context(
          event,
          node.current ? caretOffset(node.current) : 0,
          (event.target as HTMLElement).closest<HTMLElement>("[data-token]")?.dataset.token,
        )
      }
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || readonly || !node.current) return;
        const element = node.current;
        const text = editorText(element),
          offset = caretOffset(element);
        const selected = !window.getSelection()?.isCollapsed;
        const line = event.key === "ArrowUp" || event.key === "ArrowDown" ? caretLine(element, text, offset) : null;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.stopPropagation();
          if (text !== committed.current) {
            const next = historyAt.current + (event.shiftKey ? 1 : -1);
            const snapshot = history.current[next];
            if (snapshot) {
              historyAt.current = next;
              draft.current = snapshot.text;
              element.textContent = snapshot.text;
              placeCaret(element, snapshot.offset);
            }
          } else undo(event.shiftKey);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          skipBlur.current = true;
          element.innerHTML = html;
          draft.current = cue.text;
          history.current = [{ text: cue.text, offset: 0 }];
          historyAt.current = 0;
          element.blur();
          end();
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
            if (!range) return;
            range.deleteContents();
            const line = document.createTextNode("\n");
            range.insertNode(line);
            range.setStartAfter(line);
            range.collapse(true);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            record();
          } else if (offset === text.length) {
            void leave(text).then((ok) => {
              if (ok) navigate(1, 0);
            });
          } else if (offset > 0 && cue.transcript_id && !cue.text_override) void leave(text, offset);
        } else if (
          ((event.key === "Backspace" && offset === 0) || (event.key === "Delete" && offset === text.length)) &&
          !selected
        ) {
          event.preventDefault();
          event.stopPropagation();
          skipBlur.current = true;
          void merge(event.key === "Backspace" ? -1 : 1, text).then(() => {
            skipBlur.current = false;
          });
        } else if ((event.key === "ArrowUp" && line?.first) || (event.key === "ArrowDown" && line?.last)) {
          event.preventDefault();
          event.stopPropagation();
          void leave(text).then((ok) => {
            if (ok) navigate(event.key === "ArrowUp" ? -1 : 1, line?.column ?? 0);
          });
        }
      }}
    />
  );
}

export function useSubtitlePanel({
  project,
  state,
  update,
  call,
  promptAi,
}: {
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  config?: { port: number; token: string } | undefined;
  promptAi: (text: string) => void;
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
  const [editing, setEditing] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollAt = useRef(-Infinity);
  const followScroll = useRef(false);
  const pendingFocus = useRef<{ id: string; offset: number } | null>(null);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ cue: CueView; offset: number; token?: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('[aria-label="字幕菜单"]')) setMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const [more, setMore] = useState(false);
  const [stylePicker, setStylePicker] = useState(false);
  const [aiRows, setAiRows] = useState<string[] | null>(null);
  const [matchPosition, setMatchPosition] = useState<{ key: string; offset: number } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fillersOpen, setFillersOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [styleTrackId, setStyleTrackId] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [styleTab, setStyleTab] = useState("style");
  const [previewPatch, setPreviewPatch] = useState<{ fields: Partial<StyleView>; ids: string[] } | null>(null);
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
  useEffect(() => {
    const ids = [...new Set(state.selected.filter((id) => cues.some((cue) => cue.cue_id === id)))];
    const active = editing ? (cues.find((cue) => cueKey(cue) === editing)?.cue_id ?? null) : null;
    const reported = state.subtitle_selection;
    if (!reported || reported.editing !== active || JSON.stringify(reported.cue_ids) !== JSON.stringify(ids))
      update({ ...state, subtitle_selection: { cue_ids: ids, editing: active } });
  }, [state, cues, editing, update]);
  const styleTrack = subtitleTracks.find((track) => track.id === styleTrackId) ?? subtitleTracks[0];
  const trackCues = cues.filter((cue) => cue.track_id === styleTrack?.id);
  const styleId = styleTrack && "default_style_id" in styleTrack ? styleTrack.default_style_id : trackCues[0]?.style_id;
  const selectedCue = cues.find((cue) => state.selected.includes(cue.cue_id));
  const style = project?.styles.find((item) => item.id === (selectedOnly ? selectedCue?.style_id : styleId));
  const [styleDraft, setStyleDraft] = useState<StyleView>(style ?? defaultStyle);
  useEffect(() => setStyleDraft({ ...(style ?? defaultStyle), ...pendingStyle.current?.fields }), [style]);
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
  const selection = (ids: string[], active: string | null = null, cue?: CueView) => {
    setEditing(active);
    update({
      ...stateRef.current,
      selected: ids,
      subtitle_selection: { cue_ids: ids, editing: active ? (cue?.cue_id ?? null) : null },
      ...(cue ? { playhead: { at: cue.start }, preview: "timeline" as const, playing: false } : {}),
    });
  };
  const focusRow = useCallback((id: string, offset: number) => {
    pendingFocus.current = { id, offset };
    const node = rowRefs.current.get(id);
    if (node) {
      placeCaret(node, offset);
      node.closest(".zc-sub-row")?.scrollIntoView?.({ block: "nearest" });
      pendingFocus.current = null;
    }
  }, []);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target) focusRow(target.id, target.offset);
  });
  const begin = (cue: CueView) => {
    setEditing(cueLocked(cue) ? null : cueKey(cue));
    pendingFocus.current = { id: cueKey(cue), offset: cue.text.length };
  };
  const rowOps = (cue: CueView, text: string): SubtitleOp[] => {
    if (text === cue.text) return [];
    if (cue.text_override)
      return [
        { op: "set_override", track_id: cue.track_id, occurrence_id: cue.occurrence_id, cue_id: cue.cue_id, text },
      ];
    if (cue.transcript_id) return cueEdit(cue, text, undefined, project?.transcripts).ops;
    return [
      { op: "remove_free_cue", track_id: cue.track_id, id: cue.cue_id },
      {
        op: "add_free_cue",
        track_id: cue.track_id,
        id: cue.cue_id,
        timeline_start: cue.start,
        duration: printRational(sub(parseRational(cue.end, true), parseRational(cue.start, true)), true),
        text,
        style_id: cue.style_id,
      },
    ];
  };
  const commitRow = async (cue: CueView, text: string, splitAt?: number) => {
    try {
      const plan =
        splitAt !== undefined && cue.transcript_id && !cue.text_override
          ? cueEdit(cue, text, splitAt, project?.transcripts)
          : { ops: rowOps(cue, text), newCue: undefined };
      const ok = !plan.ops.length || (await write(plan.ops, splitAt !== undefined ? "拆分字幕" : "修改字幕"));
      if (ok) {
        if (stateRef.current.subtitle_selection?.editing === cue.cue_id) selection(stateRef.current.selected);
        if (plan.newCue) focusRow(plan.newCue, 0);
      }
      return ok;
    } catch (error) {
      setError(error instanceof Error ? error.message : "字幕修改失败");
      return false;
    }
  };
  const projectUndo = async (redo: boolean) => {
    if (!project || locked.current) return;
    try {
      await call(redo ? "redo" : "undo", {
        project: state.project,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label: redo ? "重做" : "撤销",
      });
    } catch {
      setError("撤销或重做失败，请重试");
    }
  };
  const styleContext = useRef({ project, state, write, selectedOnly });
  styleContext.current = { project, state, write, selectedOnly };
  const pendingStyle = useRef<{
    control: string;
    label: string;
    fields: Partial<StyleView>;
    ids: string[];
    selectedOnly: boolean;
    project: ProjectView;
    state: UiState;
    write: typeof write;
  } | null>(null);
  const styleQueue = useRef(Promise.resolve());
  const styleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStyle = () => {
    if (styleTimer.current) clearTimeout(styleTimer.current);
    const pending = pendingStyle.current;
    pendingStyle.current = null;
    if (!pending) return;
    styleQueue.current = styleQueue.current.then(async () => {
      const context = styleContext.current;
      const view =
        context.state.project === pending.state.project ? (context.project ?? pending.project) : pending.project;
      const ops = subtitleStyleOps(view, pending.ids, pending.fields, pending.selectedOnly);
      if (ops.length && !(await pending.write(ops, pending.label))) setError("字幕样式未保存，请重试");
    });
  };
  const flushRef = useRef(flushStyle);
  flushRef.current = flushStyle;
  useEffect(() => () => flushRef.current(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A committed revision replaces the transient preview.
  useEffect(() => {
    setPreviewPatch(
      pendingStyle.current ? { fields: pendingStyle.current.fields, ids: pendingStyle.current.ids } : null,
    );
  }, [project?.revision.id]);
  const changeStyle = (
    patch: Partial<StyleView>,
    commit: boolean,
    control = Object.keys(patch).join(","),
    ids = state.selected,
    label = "修改字幕样式",
  ) => {
    const next = { ...styleDraft, ...patch };
    setStyleDraft(next);
    setPreviewPatch({ fields: { ...previewPatch?.fields, ...patch }, ids });
    if (!commit || !project) return;
    if (
      pendingStyle.current &&
      (pendingStyle.current.control !== control ||
        pendingStyle.current.selectedOnly !== selectedOnly ||
        pendingStyle.current.ids.join() !== ids.join())
    )
      flushStyle();
    const context = styleContext.current;
    pendingStyle.current = {
      control,
      label,
      fields: { ...pendingStyle.current?.fields, ...patch },
      ids,
      selectedOnly,
      project,
      state,
      write: (ops, label) =>
        (styleContext.current.state.project === context.state.project ? styleContext.current.write : context.write)(
          ops,
          label,
        ),
    };
    if (styleTimer.current) clearTimeout(styleTimer.current);
    // The protocol has immutable revisions, so the release window commits as one edit.
    styleTimer.current = setTimeout(flushStyle, 1000);
  };
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    patch: (value: number) => Partial<StyleView>,
    slider = true,
    unit = "",
  ) => (
    <NumberSetting
      label={label}
      slider={slider}
      value={value}
      min={min}
      max={max}
      step={step}
      unit={unit}
      preview={(n) => changeStyle(patch(n), false, label)}
      save={(n) => changeStyle(patch(n), true, label)}
    />
  );
  const height = project?.format?.height ?? 1080;
  const width = project?.format?.width ?? 1920;
  const fontPixels = styleDraft.font_size * height;
  const pixels = (
    label: string,
    value: number,
    min: number,
    max: number,
    scale: number,
    patch: (value: number) => Partial<StyleView>,
  ) =>
    number(
      label,
      Math.round(value * scale * 10) / 10,
      Math.round(min * scale * 10) / 10,
      Math.round(max * scale * 10) / 10,
      0.1,
      (value) => patch(value / scale),
      true,
      "px",
    );
  const position = styleDraft.position ?? defaultStyle.position;
  const box = styleDraft.box ?? { color: "#00000000", padding: 0, radius: 0 };
  const outlines = styleDraft.outlines ?? (styleDraft.outline ? [styleDraft.outline] : []);
  const color = (label: string, value: string, patch: (value: string) => Partial<StyleView>) => (
    <TextSetting
      color
      label={label}
      value={value}
      preview={(v) => changeStyle(patch(v), false, label)}
      save={(v) => changeStyle(patch(v), true, label)}
    />
  );
  const passProgress = project?.subtitlePass?.progress ?? [];
  const warnings = project?.subtitlePass?.warnings ?? [];
  const failed = warnings.filter((w) => w.code === "W_SUB_PASS_FALLBACK");
  const latestPass = project?.subtitle_pass ?? state.subtitle_pass;
  const manual = latestPass?.state === "running" ? latestPass : undefined;
  const running = !!manual || project?.subtitlePass?.running;
  const proofreading = manual ? manual.kind === "proofread" : project?.subtitlePass?.phase === "proofread";
  const breaking = project?.subtitlePass?.running && project.subtitlePass.phase !== "proofread";
  const pending = !!project?.unprocessedTranscripts?.length;
  const done = manual?.done ?? passProgress.reduce((sum, item) => sum + item.done, 0);
  const total = manual?.total ?? passProgress.reduce((sum, item) => sum + item.total, 0);
  const proofreadProgress = passProgress.filter((item) => item.phase === "proofread" || (!item.phase && proofreading));
  const proofreadDone =
    latestPass?.kind === "proofread" ? latestPass.done : proofreadProgress.reduce((sum, item) => sum + item.done, 0);
  const proofreadTotal =
    latestPass?.kind === "proofread" ? latestPass.total : proofreadProgress.reduce((sum, item) => sum + item.total, 0);
  const controls = (
    <div className="zc-panel-body zc-sub-controls">
      <p className={`zc-card zc-sub-status${project?.recognized ? " is-recognized" : ""}`}>
        <span className="zc-dot" aria-hidden="true" />
        {running
          ? proofreading
            ? `AI 校对 · ${done}/${total}`
            : `AI 整理字幕 · 分行 ${done}/${total}`
          : warnings.length
            ? failed.length
              ? "字幕整理失败"
              : warnings.some((w) => w.code === "W_SUB_PROOFREAD_FAILED")
                ? "字幕校对失败"
                : "部分校对已跳过"
            : pending
              ? "AI 整理字幕…"
              : project?.recognized
                ? `已识别${project.recognitionRevision !== undefined ? ` · 第 ${project.recognitionRevision} 版` : ""} · ${cues.length} 条字幕`
                : "还没有识别"}
        {!!warnings.length && !running && (
          <span
            className="zc-sub-attention"
            role="img"
            aria-label={failed.length ? "字幕整理失败" : "字幕校对警告"}
            title={warnings.map((warning) => warning.reason).join("；")}
          >
            ⚠
          </span>
        )}
      </p>
      <section className="zc-sub-progress" aria-label="字幕整理进度">
        {[
          { label: "概要", complete: !!project?.recognized && !pending, active: pending },
          {
            label: "分行",
            complete: !!project?.recognized && !pending && !breaking && !failed.length,
            active: breaking,
          },
          {
            label: `校对 ${proofreadDone}/${proofreadTotal}`,
            complete: !!project?.recognized && !running && !pending && !warnings.length,
            active: proofreading,
          },
        ].map((step) => (
          <span key={step.label} className={step.complete ? "is-complete" : step.active ? "is-active" : ""}>
            <span aria-hidden="true" />
            {step.label}
          </span>
        ))}
      </section>
      {state.sub === "style" ? (
        <>
          <p className="zc-hint">在画面上拖字幕改位置，拖角改大小；靠近中线会吸附。</p>
          <h3 className="zc-sub-track-heading">字幕轨</h3>
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
            <IconButton
              icon="plus"
              label="添加字幕轨"
              disabled={!project || !styleId || busy}
              onClick={() =>
                void write(
                  [
                    {
                      op: "add_subtitle_track",
                      language: recognition.language ?? "zh",
                      carrier_tracks:
                        project?.tracks.filter((track) => track.kind === "audio").map((track) => track.id) ?? [],
                      default_style_id: styleId,
                    },
                  ],
                  "添加字幕轨",
                )
              }
            />
          </fieldset>
          <section aria-label="叠层导出" className="zc-sub-overlays">
            <span className="zc-muted">叠层导出</span>
            {(project?.subtitleOverlays ?? [])
              .filter((overlay) => overlay.timeline_id === project?.id && overlay.subtitle_track_id === styleTrack?.id)
              .map((overlay) => (
                <div className="zc-sub-overlay-row" key={overlay.id}>
                  <span title={overlay.output_path}>{overlay.output_path.split(/[\\/]/).at(-1)}</span>
                  <span className="zc-meta">
                    {overlay.last_export
                      ? `${new Date(overlay.last_export.created_at).toLocaleDateString("zh-CN")} 导出`
                      : "尚未导出"}
                  </span>
                  {isTauri() && (
                    <IconButton
                      icon="folderOpen"
                      label="在访达中显示"
                      onClick={() =>
                        void revealItemInDir(overlay.output_path).catch(() => setError("无法在访达中显示"))
                      }
                    />
                  )}
                </div>
              ))}
          </section>
          <p className="zc-hint zc-sub-overlay-hint">
            叠层是一条只有字幕的透明视频，放在剪辑软件最上层；改了字幕再导出会覆盖同一个文件。
          </p>
          <button
            type="button"
            className="zc-btn is-secondary is-lg"
            disabled={!project}
            onClick={() =>
              update({
                ...state,
                export: {
                  srt: true,
                  wav: false,
                  active: null,
                  ...state.export,
                  open: true,
                  sub: "overlays",
                },
              })
            }
          >
            <Icon name="export" />
            导出字幕叠层
          </button>
        </>
      ) : (
        <>
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
        </>
      )}
      {progress !== null && <progress aria-label="识别进度" max={1} value={progress} />}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  const visible = cues
    .filter(
      (cue) =>
        (replaceOpen && browser.find) || cue.text.toLocaleLowerCase().includes(browser.search.toLocaleLowerCase()),
    )
    .sort((a, b) => compare(parseRational(a.start, true), parseRational(b.start, true)));
  const ordered = useMemo(
    () => [...cues].sort((a, b) => compare(parseRational(a.start, true), parseRational(b.start, true))),
    [cues],
  );
  const selected = ordered.filter(
    (cue, index) =>
      state.selected.includes(cue.cue_id) && ordered.findIndex((row) => row.cue_id === cue.cue_id) === index,
  );
  const contiguous = (rows: CueView[]) =>
    canMerge(rows) &&
    rows.every((cue, index) => !index || ordered.indexOf(cue) === ordered.indexOf(rows[index - 1] as CueView) + 1);
  const mergeRows = async (rows: CueView[], pending?: { cue: CueView; text: string }) => {
    if (!contiguous(rows)) {
      setError("这两条不能合并");
      return false;
    }
    try {
      const first = rows[0];
      if (!first) return false;
      const ops = rows.flatMap((cue) => {
        const node = rowRefs.current.get(cueKey(cue));
        return rowOps(cue, pending?.cue.cue_id === cue.cue_id ? pending.text : node ? editorText(node) : cue.text);
      });
      ops.push({ op: "merge_cues", cue_ids: rows.map((cue) => cue.cue_id) });
      if (!(await write(ops, "合并字幕"))) return false;
      selection([first.cue_id], cueKey(first), first);
      focusRow(first.cue_id, first.text.length);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "这两条不能合并");
      return false;
    }
  };
  const deleteRows = (rows: CueView[]) =>
    void write(
      rows.flatMap((cue): SubtitleOp[] => {
        if (cueLocked(cue)) return [];
        return cue.transcript_id
          ? [
              {
                op: "hide_tokens",
                transcript_id: cue.transcript_id,
                tokens: cue.tokens?.filter((token) => token.text).map((token) => token.id) ?? [],
              },
            ]
          : [{ op: "remove_free_cue", track_id: cue.track_id, id: cue.cue_id }];
      }),
      "删除字幕",
    );
  const selectRow = (cue: CueView, event: React.MouseEvent) => {
    const ids = stateRef.current.selected;
    if (event.shiftKey && anchor.current) {
      const a = visible.findIndex((row) => row.cue_id === anchor.current),
        b = visible.indexOf(cue);
      selection(visible.slice(Math.min(a < 0 ? b : a, b), Math.max(a, b) + 1).map((row) => row.cue_id));
    } else {
      anchor.current = cue.cue_id;
      selection(
        event.metaKey || event.ctrlKey
          ? ids.includes(cue.cue_id)
            ? ids.filter((id) => id !== cue.cue_id)
            : [...ids, cue.cue_id]
          : [cue.cue_id],
      );
    }
  };
  const openAi = (verb: "subtitle_tidy" | "subtitle_proofread", rows?: CueView[]) => {
    setMenu(null);
    setMore(false);
    selection(rows?.map((cue) => cue.cue_id) ?? []);
    setAiRows(rows ? rows.map((cue) => cue.cue_id) : cues.map((cue) => cue.cue_id));
    const first = rows?.[0],
      last = rows?.at(-1);
    const range =
      first && last
        ? `选中的 ${rows.length} 条字幕（${formatSubtitleTime(first.start)}–${formatSubtitleTime(last.end)}）`
        : "全部字幕";
    promptAi(verb === "subtitle_tidy" ? `把${range}按意思重新分行。` : `校对${range}，只改错字和专有名词，不改意思。`);
  };
  const manualPass = project?.subtitle_pass;
  useEffect(() => {
    if (manualPass && manualPass.state !== "running") setAiRows(null);
  }, [manualPass]);
  const matches = (replaceOpen ? ordered : []).flatMap((cue, row) => {
    if (!browser.find) return [];
    const fold = (text: string) =>
      browser.matchCase
        ? text
        : text.replace(/\p{Script=Latin}/gu, (char) => {
            const lower = char.toLowerCase();
            return lower.length === char.length ? lower : char;
          });
    const text = fold(cue.text),
      find = fold(browser.find);
    const found: { cue: CueView; row: number; start: number; end: number }[] = [];
    let start = text.indexOf(find);
    while (start >= 0) {
      found.push({ cue, row, start, end: start + find.length });
      start = text.indexOf(find, start + find.length);
    }
    return found;
  });
  const editableMatches = matches.filter(({ cue }) => !cueLocked(cue));
  const positionRow = matchPosition ? ordered.findIndex((cue) => cueKey(cue) === matchPosition.key) : -1;
  const currentMatch =
    editableMatches.find(
      ({ row, start }) => row > positionRow || (row === positionRow && start >= (matchPosition?.offset ?? 0)),
    ) ??
    editableMatches[0] ??
    matches[0];
  const reveal = useCallback((cue: CueView) => {
    followScroll.current = true;
    rowRefs.current.get(cueKey(cue))?.closest(".zc-sub-row")?.scrollIntoView?.({ block: "nearest" });
    setTimeout(() => {
      followScroll.current = false;
    }, 100);
  }, []);
  useEffect(() => {
    if (currentMatch) reveal(currentMatch.cue);
  }, [currentMatch, reveal]);
  useEffect(() => {
    if (!state.playing || Date.now() - scrollAt.current < 3000) return;
    const current = ordered.find((cue) => contains(cue.start, cue.end, at));
    if (current) reveal(current);
  }, [at, state.playing, ordered, reveal]);
  const contextRows =
    menu && selected.length > 1 && selected.some((cue) => cue.cue_id === menu.cue.cue_id)
      ? selected
      : menu
        ? [menu.cue]
        : [];
  const menuAction = (label: string, action: () => void, disabled = false) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setMenu(null);
        setMore(false);
        action();
      }}
    >
      {label}
    </button>
  );
  const parameters = (
    <div className="zc-panel-body zc-sub-parameters">
      <div className="zc-tabs" role="tablist" aria-label="字幕参数">
        {["subtitles", "style"].map((sub) => (
          <button
            type="button"
            role="tab"
            className={`zc-tab${(state.sub ?? "subtitles") === sub ? " is-active" : ""}`}
            key={sub}
            aria-selected={(state.sub ?? "subtitles") === sub}
            onClick={() => update({ ...state, sub })}
          >
            {sub === "style" ? "样式" : "字幕"}
          </button>
        ))}
      </div>
      {warnings.length > 0 && !failed.length && !running && (
        <p role="alert">
          {warnings.map((w) => w.reason).join("；")}{" "}
          {warnings.some((w) => w.code === "W_SUB_PROOFREAD_FAILED") && (
            <IconButton icon="refresh" label="重新校对" onClick={() => void call("chat_subtitle_retry", {})} />
          )}
        </p>
      )}
      <div className="zc-sub-heading">
        <span>字幕</span>
        <IconButton icon="down" label="更多字幕操作" aria-expanded={more} onClick={() => setMore(!more)} />
        {more && (
          <div role="menu" aria-label="更多字幕操作">
            {menuAction("全部重新分行", () => openAi("subtitle_tidy"))}
            {menuAction("全部校对", () => openAi("subtitle_proofread"))}
          </div>
        )}
      </div>
      {manualPass?.state === "running" && (
        <output>
          {manualPass.kind === "tidy" ? "AI 重新分行" : "AI 校对"} · {manualPass.done}/{manualPass.total}
        </output>
      )}
      {(error || manualPass?.state === "failed") && (
        <p role="alert">
          {error || manualPass?.reason}
          {manualPass?.state === "failed" && (
            <IconButton icon="refresh" label="重试 AI 操作" onClick={() => void call("chat_subtitle_retry", {})} />
          )}
        </p>
      )}
      {breaking && !manualPass ? (
        <p className="zc-muted">
          识别完成，AI 正在按意思断句，大约还要 {Math.max(1, Math.ceil((total - done) / 6))} 分钟
        </p>
      ) : failed.length && !manualPass ? (
        <p role="alert">
          {failed.map((warning) => warning.reason).join("；")}{" "}
          <IconButton icon="refresh" label="重新整理" onClick={() => void call("chat_subtitle_retry", {})} />
        </p>
      ) : pending && !manualPass ? (
        <p className="zc-muted">识别完成，AI 正在按意思断句</p>
      ) : state.sub !== "style" ? (
        <>
          <div className="zc-sub-search-row">
            <label className="zc-search zc-sub-search">
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
              icon="spark"
              label="AI 重新分行"
              disabled={running || busy || !project}
              onClick={() => openAi("subtitle_tidy", selected.length ? selected : undefined)}
            />
            <IconButton
              icon="edit"
              label="AI 校对"
              disabled={running || busy || !project}
              onClick={() => openAi("subtitle_proofread", selected.length ? selected : undefined)}
            />
            <IconButton
              icon="replace"
              label="查找替换"
              aria-expanded={replaceOpen}
              onClick={() => setReplaceOpen(!replaceOpen)}
            />
          </div>
          {replaceOpen && (
            <div className="zc-sub-replace">
              <div className="zc-sub-replace-fields">
                <div className="zc-sub-find">
                  <input
                    className="zc-input"
                    aria-label="查找"
                    placeholder="旧词"
                    value={browser.find}
                    onChange={(e) => {
                      setMatchPosition(null);
                      setBrowser({ find: e.target.value });
                    }}
                  />
                  <button
                    type="button"
                    className="zc-sub-match-case"
                    aria-label="区分大小写"
                    title="区分大小写"
                    aria-pressed={browser.matchCase}
                    onClick={() => {
                      setMatchPosition(null);
                      setBrowser({ matchCase: !browser.matchCase });
                    }}
                  >
                    Aa
                  </button>
                </div>
                <span aria-hidden="true">→</span>
                <input
                  className="zc-input"
                  aria-label="替换为"
                  placeholder="新词"
                  value={browser.replace}
                  onChange={(e) => setBrowser({ replace: e.target.value })}
                />
              </div>
              {browser.find && (
                <output className="zc-muted">{matches.length ? `${matches.length} 处` : "没有找到"}</output>
              )}
              <div className="zc-sub-replace-actions">
                <button
                  type="button"
                  className="zc-btn zc-btn-secondary"
                  disabled={busy || !currentMatch || !!cueLocked(currentMatch.cue)}
                  title="替换当前匹配并移到下一处，跳过锁定字幕"
                  onClick={async () => {
                    if (!currentMatch) return;
                    const { cue, start, end } = currentMatch;
                    if (await commitRow(cue, cue.text.slice(0, start) + browser.replace + cue.text.slice(end)))
                      setMatchPosition({ key: cueKey(cue), offset: start + browser.replace.length });
                  }}
                >
                  替换下一处
                </button>
                <button
                  className="zc-btn zc-btn-secondary"
                  type="button"
                  disabled={!project || busy || !matches.length}
                  title="替换全部匹配，跳过锁定字幕"
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
            </div>
          )}
          {!!skipped.length && <output className="zc-sub-attention">跳过 {skipped.length} 条锁定字幕</output>}
          {!visible.length && <p className="zc-muted">暂无字幕</p>}
          {selected.length > 1 && (
            <div className="zc-sub-toolbar" role="toolbar" aria-label="字幕批量操作">
              <span>已选 {selected.length} 条</span>
              <IconButton
                icon="replace"
                label="合并"
                disabled={busy || !contiguous(selected)}
                onClick={() => void mergeRows(selected)}
              />
              <IconButton
                icon="trash"
                label="删除选中字幕"
                disabled={busy || selected.some(cueLocked)}
                onClick={() => deleteRows(selected)}
              />
              <IconButton icon="subtitle" label="样式" onClick={() => setStylePicker(!stylePicker)} />
              <IconButton
                icon="spark"
                label="AI 重新分行"
                disabled={running || busy || !project}
                onClick={() => openAi("subtitle_tidy", selected.length ? selected : undefined)}
              />
              <IconButton
                icon="check"
                label="AI 校对"
                disabled={running || busy || !project}
                onClick={() => openAi("subtitle_proofread", selected.length ? selected : undefined)}
              />
              <IconButton icon="close" label="取消选择" onClick={() => selection([])} />
            </div>
          )}
          {stylePicker && (
            <div role="menu" aria-label="字幕样式">
              {project?.styles.map((style) =>
                menuAction(
                  style.name ?? style.id,
                  () => {
                    setStylePicker(false);
                    void write(
                      selected.flatMap((cue): SubtitleOp[] =>
                        cue.transcript_id
                          ? [{ op: "set_cue", cue_id: cue.cue_id, style_id: style.id }]
                          : [
                              { op: "remove_free_cue", track_id: cue.track_id, id: cue.cue_id },
                              {
                                op: "add_free_cue",
                                track_id: cue.track_id,
                                id: cue.cue_id,
                                timeline_start: cue.start,
                                duration: printRational(
                                  sub(parseRational(cue.end, true), parseRational(cue.start, true)),
                                  true,
                                ),
                                text: cue.text,
                                style_id: style.id,
                              },
                            ],
                      ),
                      "修改字幕样式",
                    );
                  },
                  busy || selected.some(cueLocked),
                ),
              )}
            </div>
          )}
          <fieldset
            className="zc-list zc-sub-list"
            aria-label="字幕列表"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard selection needs a focusable list outside editing.
            tabIndex={0}
            onScrollCapture={() => {
              if (!followScroll.current) scrollAt.current = Date.now();
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) scrollAt.current = Date.now();
            }}
            onWheel={() => {
              scrollAt.current = Date.now();
            }}
            onTouchMove={() => {
              scrollAt.current = Date.now();
            }}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "a" &&
                !(event.target as HTMLElement).isContentEditable &&
                (event.target as HTMLElement).getAttribute("contenteditable") !== "true"
              ) {
                event.preventDefault();
                selection([...new Set(visible.map((cue) => cue.cue_id))]);
              }
            }}
          >
            {visible.map((cue, index) => {
              const key = cueKey(cue);
              const warnings = project?.subtitleWarnings?.filter((warning) => warning.ids.includes(cue.cue_id)) ?? [];
              const reasons = warnings.map((warning) =>
                warning.code === "W_SUB_SHORT" ? "字幕显示时间过短" : "字幕超出宽度或行数",
              );
              const running = manualPass?.state === "running" && (aiRows === null || aiRows.includes(cue.cue_id));
              const nextTo = (direction: number) => ordered[ordered.indexOf(cue) + direction];
              return (
                <div
                  className={`zc-row zc-sub-row${state.selected.includes(cue.cue_id) ? " is-selected" : ""}${editing === key ? " is-editing" : ""}${contains(cue.start, cue.end, at) ? " is-current" : ""}${skipped.includes(cue.cue_id) ? " is-skipped" : ""}${running ? " is-running" : ""}`}
                  key={key}
                >
                  <button
                    type="button"
                    className="time zc-sub-time"
                    aria-label={`选择字幕 ${index + 1}`}
                    title={reasons.join("；")}
                    aria-pressed={state.selected.includes(cue.cue_id)}
                    onClick={(event) => selectRow(cue, event)}
                  >
                    <time>{formatSubtitleTime(cue.start)}</time>
                    {cueLocked(cue) && (
                      <span role="img" aria-label="已锁定">
                        <Icon name="lock" />
                      </span>
                    )}
                  </button>
                  <SubtitleRow
                    cue={cue}
                    active={editing === key}
                    busy={busy}
                    match={currentMatch?.cue === cue ? currentMatch : undefined}
                    register={(node) => {
                      if (node) {
                        rowRefs.current.set(key, node);
                        rowRefs.current.set(cue.cue_id, node);
                      } else {
                        rowRefs.current.delete(key);
                        rowRefs.current.delete(cue.cue_id);
                      }
                    }}
                    begin={() => {
                      anchor.current = cue.cue_id;
                      selection([cue.cue_id], cueLocked(cue) ? null : key, cue);
                    }}
                    end={() => {
                      if (editing === key) selection(stateRef.current.selected);
                    }}
                    commit={(text, splitAt) => commitRow(cue, text, splitAt)}
                    undo={(redo) => void projectUndo(redo)}
                    navigate={(direction, offset) => {
                      const next = visible[index + direction];
                      if (next) {
                        selection([next.cue_id], cueLocked(next) ? null : cueKey(next), next);
                        const line =
                          direction < 0 ? (next.text.split("\n").at(-1) ?? "") : (next.text.split("\n")[0] ?? "");
                        const start = direction < 0 ? next.text.length - line.length : 0;
                        focusRow(next.cue_id, start + Array.from(line).slice(0, offset).join("").length);
                      }
                    }}
                    merge={async (direction, text) => {
                      const next = nextTo(direction);
                      if (!next) return false;
                      return mergeRows(direction < 0 ? [next, cue] : [cue, next], { cue, text });
                    }}
                    context={(event, offset, token) => {
                      event.preventDefault();
                      if (!state.selected.includes(cue.cue_id)) selection([cue.cue_id]);
                      setMenu({ cue, offset, ...(token ? { token } : {}), x: event.clientX, y: event.clientY });
                    }}
                  />
                  <span className="actions zc-sub-actions">
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
                      disabled={busy || !!cueLocked(cue)}
                      onClick={() => deleteRows([cue])}
                    />
                  </span>
                </div>
              );
            })}
          </fieldset>
          {menu && (
            <div
              className="zc-sub-menu"
              role="menu"
              aria-label="字幕菜单"
              onMouseDown={(event) => event.preventDefault()}
              style={{ left: menu.x, top: menu.y }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setMenu(null);
              }}
            >
              {menu.token &&
                menu.cue.tokens?.some(
                  (token) =>
                    token.id === menu.token &&
                    token.state === "edited" &&
                    token.heard !== undefined &&
                    token.heard !== token.text,
                ) &&
                menuAction(
                  "还原",
                  () => {
                    const token = menu.cue.tokens?.find((token) => token.id === menu.token);
                    if (token)
                      void write(
                        [
                          {
                            op: "edit_text",
                            transcript_id: menu.cue.transcript_id,
                            from_token: token.id,
                            to_token: token.id,
                            text: token.heard,
                          },
                        ],
                        "修改字幕",
                      );
                  },
                  !!cueLocked(menu.cue),
                )}
              {menuAction(
                "在光标处拆分",
                () => {
                  const node = rowRefs.current.get(cueKey(menu.cue));
                  void commitRow(menu.cue, node ? editorText(node) : menu.cue.text, menu.offset);
                },
                !!cueLocked(menu.cue) || !menu.cue.transcript_id || contextRows.length > 1,
              )}
              {menuAction("与上一条合并", () => {
                const previous = ordered[ordered.indexOf(contextRows[0] as CueView) - 1];
                void mergeRows(previous ? [previous, ...contextRows] : contextRows);
              })}
              {menuAction("与下一条合并", () => {
                const next = ordered[ordered.indexOf(contextRows.at(-1) as CueView) + 1];
                void mergeRows(next ? [...contextRows, next] : contextRows);
              })}
              {menuAction("删除", () => deleteRows(contextRows), contextRows.some(cueLocked))}
              {menuAction("AI 重新分行", () => openAi("subtitle_tidy", contextRows))}
              {menuAction("AI 校对", () => openAi("subtitle_proofread", contextRows))}
              {menuAction("复制文字", () => {
                if (!navigator.clipboard) setError("当前环境不支持复制");
                else
                  void navigator.clipboard
                    .writeText(contextRows.map((cue) => cue.text).join("\n"))
                    .catch(() => setError("复制失败"));
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="zc-sub-apply">
            <span>应用到</span>
            <fieldset className="zc-seg" aria-label="应用到">
              {[false, true].map((only) => (
                <button
                  type="button"
                  key={String(only)}
                  aria-pressed={selectedOnly === only}
                  onClick={() => {
                    flushStyle();
                    setPreviewPatch(null);
                    setSelectedOnly(only);
                  }}
                >
                  {only ? `选中 ${selected.length} 条` : "全部"}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="zc-tabs" role="tablist" aria-label="字幕样式设置">
            {[
              ["style", "样式"],
              ["animation", "动画"],
            ].map(([id, name]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`zc-tab${styleTab === id ? " is-active" : ""}`}
                aria-selected={styleTab === id}
                onClick={() => setStyleTab(id ?? "style")}
              >
                {name}
              </button>
            ))}
          </div>
          {styleTab === "animation" ? (
            <fieldset className="zc-sub-animation" disabled={!style || busy || (selectedOnly && !selectedCue)}>
              {(["in", "out", "word"] as const).map((group) => {
                const name = { in: "入场", out: "出场", word: "逐字" }[group];
                const choices =
                  group === "in"
                    ? [
                        ["none", "无"],
                        ["fade", "淡入"],
                        ["rise", "上升"],
                        ["pop", "放大"],
                        ["typewriter", "打字机"],
                      ]
                    : group === "out"
                      ? [
                          ["none", "无"],
                          ["fade", "淡出"],
                          ["sink", "下沉"],
                          ["pop", "缩小"],
                        ]
                      : [
                          ["none", "无"],
                          ["highlight", "高亮"],
                          ["fill", "填色"],
                          ["jump", "跳动"],
                        ];
                const current = styleDraft.animation?.[group];
                const selected = typeof current === "string" ? current : (current?.type ?? "none");
                const duration = typeof current === "object" ? current.duration : "1/5s";
                const seconds = typeof duration === "string" ? parseRational(duration, true) : duration;
                return (
                  <section key={group} aria-label={name}>
                    <h4>{name}</h4>
                    <div className="zc-sub-animation-grid">
                      {choices.map(([type = "none", title]) => {
                        const choice =
                          group === "word"
                            ? type
                            : type === "none"
                              ? undefined
                              : { type, duration: printRational(seconds, true) };
                        const animation = { ...styleDraft.animation, [group]: choice } as NonNullable<
                          StyleView["animation"]
                        >;
                        const highlight = styleDraft.highlight ?? { color: "#FFD84A" };
                        return (
                          <SubtitleAnimationCell
                            key={type}
                            label={`${name}：${title}`}
                            selected={selected === type}
                            style={{
                              ...styleDraft,
                              highlight,
                              animation: { [group]: choice } as NonNullable<StyleView["animation"]>,
                            }}
                            choose={() =>
                              changeStyle(
                                {
                                  animation,
                                  ...(group === "word" && type !== "none" && !styleDraft.highlight
                                    ? { highlight }
                                    : {}),
                                },
                                true,
                                `animation.${group}`,
                              )
                            }
                          />
                        );
                      })}
                    </div>
                    {group !== "word" &&
                      selected !== "none" &&
                      number(`${name}时长`, numberOf(seconds), 0.05, 2, 0.05, (value) => ({
                        animation: {
                          ...styleDraft.animation,
                          [group]: {
                            type: selected,
                            duration: printRational(rational(BigInt(Math.round(value * 1000)), 1000n), true),
                          },
                        } as NonNullable<StyleView["animation"]>,
                      }))}
                  </section>
                );
              })}
            </fieldset>
          ) : (
            <fieldset className="zc-sub-style" disabled={!style || busy || (selectedOnly && !selectedCue)}>
              <div className="zc-sub-presets">
                {presetGroups.map((group) => {
                  const featured = group === "基础" || group === "综艺";
                  const Group = featured ? "section" : "details";
                  return (
                    <Group key={group} aria-label={`${group}预设`}>
                      {featured ? <h4>{group}</h4> : <summary>{group}</summary>}
                      <div className="zc-sub-preset-grid">
                        {subtitlePresets
                          .filter((preset) => preset.group === group)
                          .map((preset) => (
                            <SubtitleAnimationCell
                              key={preset.name}
                              preset
                              label={`套用样式：${preset.name}`}
                              style={preset.fields}
                              selected={false}
                              choose={() => {
                                flushStyle();
                                changeStyle(
                                  presetPatch(preset),
                                  true,
                                  "preset",
                                  state.selected,
                                  `套用样式：${preset.name}`,
                                );
                                flushStyle();
                              }}
                            />
                          ))}
                      </div>
                    </Group>
                  );
                })}
              </div>
              <details open>
                <summary>
                  <Icon name="chevron" />
                  文字
                </summary>
                <div className="zc-sub-font-row">
                  <SelectSetting
                    label="字体族"
                    value={customFont ? "other" : styleDraft.font_family}
                    options={[...fonts, ["other", "其他…"]]}
                    save={(font_family) => {
                      setCustomFont(font_family === "other");
                      if (font_family !== "other") changeStyle({ font_family }, true);
                    }}
                  />
                  {number(
                    "字号",
                    Math.round(fontPixels),
                    Math.ceil(0.01 * height),
                    Math.floor(0.2 * height),
                    1,
                    (font_size) => ({ font_size: font_size / height }),
                    false,
                    "px",
                  )}
                </div>
                {(customFont || !fonts.some(([value]) => value === styleDraft.font_family)) && (
                  <TextSetting
                    label="其他字体"
                    value={styleDraft.font_family}
                    save={(font_family) => changeStyle({ font_family }, true)}
                  />
                )}
                <div className="zc-sub-inline">
                  <IconButton
                    icon="bold"
                    label="粗体"
                    pressed={(styleDraft.font_weight ?? 400) >= 700}
                    onClick={() =>
                      changeStyle({ font_weight: (styleDraft.font_weight ?? 400) >= 700 ? 400 : 700 }, true)
                    }
                  />
                  <IconButton
                    icon="italic"
                    label="斜体"
                    pressed={!!styleDraft.italic}
                    onClick={() => changeStyle({ italic: !styleDraft.italic }, true)}
                  />
                  <IconButton
                    icon="underline"
                    label="下划线"
                    pressed={!!styleDraft.underline}
                    onClick={() => changeStyle({ underline: !styleDraft.underline }, true)}
                  />
                  <span className="zc-grow" />
                  {(["left", "center", "right"] as const).map((align, i) => (
                    <IconButton
                      key={align}
                      icon={`align-${align}`}
                      label={["左对齐", "居中", "右对齐"][i] ?? align}
                      pressed={(styleDraft.align ?? "center") === align}
                      onClick={() => changeStyle({ align }, true)}
                    />
                  ))}
                </div>
                <fieldset className="zc-sub-colors" aria-label="常用文字颜色">
                  {["#FFFFFF", "#000000", "#FFD84A", "#FF994A", "#FF6376", "#8BE36C", "#6BCBFF", "#C79BFF"].map(
                    (color) => (
                      <button
                        key={color}
                        type="button"
                        className="zc-sub-color-chip"
                        style={{ backgroundColor: color }}
                        title={`文字颜色 ${color}`}
                        aria-label={`文字颜色 ${color}`}
                        aria-pressed={styleDraft.color.toUpperCase() === color}
                        onClick={() => changeStyle({ color }, true)}
                      />
                    ),
                  )}
                  {color("文字颜色", styleDraft.color, (color) => ({ color }))}
                </fieldset>
                <details className="zc-sub-text-more">
                  <summary>更多文字设置</summary>
                  {pixels("字间距", styleDraft.letter_spacing ?? 0, -0.2, 1, fontPixels, (letter_spacing) => ({
                    letter_spacing,
                  }))}
                  {number(
                    "行距",
                    styleDraft.line_spacing ?? 1.2,
                    0.5,
                    3,
                    0.1,
                    (line_spacing) => ({ line_spacing }),
                    true,
                    "倍",
                  )}
                  <SelectSetting
                    label="字重"
                    value={String(styleDraft.font_weight ?? 400)}
                    options={Array.from({ length: 9 }, (_, i) => [String((i + 1) * 100), String((i + 1) * 100)])}
                    save={(value) => changeStyle({ font_weight: Number(value) }, true)}
                  />
                  {number("最多行数", styleDraft.max_lines ?? 2, 1, 3, 1, (max_lines) => ({ max_lines }))}
                </details>
              </details>
              <details>
                <summary>
                  <Icon name="chevron" />
                  描边
                </summary>
                {outlines.map((outline, index) => {
                  const patch = (fields: Partial<typeof outline>) => ({
                    outlines: outlines.map((edge, i) => (i === index ? { ...edge, ...fields } : edge)),
                  });
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Outline controls are numbered layer slots, with no row state.
                    <div key={index} className="zc-sub-outline">
                      {color(`描边 ${index + 1} 颜色`, outline.color, (color) => patch({ color }))}
                      {pixels(`描边 ${index + 1} 宽度`, outline.width, 0, 0.3, fontPixels, (width) => patch({ width }))}
                      <IconButton
                        icon="trash"
                        label={`删除描边 ${index + 1}`}
                        onClick={() => {
                          const next = outlines.filter((_, i) => i !== index);
                          if (next.length) changeStyle({ outlines: next }, true);
                          else changeStyle({ outlines: undefined, outline: { color: "#000000", width: 0 } }, true);
                        }}
                      />
                    </div>
                  );
                })}
                <IconButton
                  icon="plus"
                  label="添加描边"
                  disabled={outlines.length >= 3}
                  onClick={() => changeStyle({ outlines: [...outlines, { color: "#000000", width: 0.06 }] }, true)}
                />
              </details>
              {(
                [
                  ["shadow", "阴影"],
                  ["glow", "发光"],
                ] as const
              ).map(([key, label]) => {
                const effect = styleDraft[key];
                return (
                  <details key={key}>
                    <summary>
                      <Icon name="chevron" />
                      {label}
                      <input
                        type="checkbox"
                        role="switch"
                        className="zc-switch"
                        aria-label={`启用${label}`}
                        title={`启用${label}`}
                        aria-checked={!!effect}
                        checked={!!effect}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          if (e.target.checked) e.currentTarget.closest("details")?.setAttribute("open", "");
                          changeStyle(
                            {
                              [key]: e.target.checked
                                ? key === "shadow"
                                  ? { color: "#00000099", blur: 0.1, distance: 0.1, angle: 90 }
                                  : { color: "#FFFFFF", blur: 0.2 }
                                : undefined,
                            },
                            true,
                          );
                        }}
                      />
                    </summary>
                    {effect && (
                      <>
                        {color(`${label}颜色`, effect.color, (color) => ({ [key]: { ...effect, color } }))}
                        {pixels(`${label}模糊`, effect.blur, 0, 2, fontPixels, (blur) => ({
                          [key]: { ...effect, blur },
                        }))}
                        {key === "shadow" && styleDraft.shadow && (
                          <>
                            {pixels("阴影距离", styleDraft.shadow.distance, 0, 2, fontPixels, (distance) => ({
                              shadow: {
                                color: "#00000099",
                                blur: 0.1,
                                angle: 90,
                                ...styleDraft.shadow,
                                distance,
                              },
                            }))}
                            {number(
                              "阴影角度",
                              styleDraft.shadow.angle,
                              0,
                              359,
                              1,
                              (angle) => ({
                                shadow: {
                                  color: "#00000099",
                                  blur: 0.1,
                                  distance: 0.1,
                                  ...styleDraft.shadow,
                                  angle,
                                },
                              }),
                              true,
                              "°",
                            )}
                          </>
                        )}
                      </>
                    )}
                  </details>
                );
              })}
              <details>
                <summary>
                  <Icon name="chevron" />
                  底板
                  <input
                    type="checkbox"
                    role="switch"
                    className="zc-switch"
                    aria-label="启用底板"
                    title="启用底板"
                    aria-checked={!!styleDraft.box}
                    checked={!!styleDraft.box}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      if (e.target.checked) e.currentTarget.closest("details")?.setAttribute("open", "");
                      const box = e.target.checked ? { color: "#000000B3", padding: 0.25, radius: 0.1 } : undefined;
                      changeStyle(Object.fromEntries([["box", box]]), true);
                    }}
                  />
                </summary>
                {styleDraft.box && (
                  <>
                    {color("底板颜色", box.color, (color) => ({ box: { ...box, color } }))}
                    {pixels("内边距", box.padding ?? 0, 0, 2, fontPixels, (padding) => ({ box: { ...box, padding } }))}
                    {pixels("圆角", box.radius ?? 0, 0, 2, fontPixels, (radius) => ({ box: { ...box, radius } }))}
                  </>
                )}
              </details>
              <details>
                <summary>
                  <Icon name="chevron" />
                  位置
                </summary>
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
                          title={column === 1 ? label : `${label}（暂不支持）`}
                          disabled={column !== 1}
                          aria-pressed={
                            position?.anchor === mapped.anchor && (position.offset_x ?? 0) === mapped.offset_x
                          }
                          onClick={() =>
                            changeStyle(
                              { position: { ...position, margin_v: position?.margin_v ?? 0.08, ...mapped } },
                              true,
                            )
                          }
                        >
                          <Icon name="anchor" />
                        </button>
                      );
                    }),
                  )}
                </fieldset>
                {pixels("上下边距", position?.margin_v ?? 0.08, 0, 1, height, (margin_v) => ({
                  position: { anchor: "bottom", ...position, margin_v },
                }))}
                {pixels("水平位置", position?.offset_x ?? 0, -0.5, 0.5, width, (offset_x) => ({
                  position: { anchor: "bottom", margin_v: 0.08, ...position, offset_x },
                }))}
                {number(
                  "最大宽度",
                  (position?.max_width ?? 0.8) * 100,
                  10,
                  100,
                  1,
                  (max_width) => ({
                    position: { anchor: "bottom", margin_v: 0.08, ...position, max_width: max_width / 100 },
                  }),
                  true,
                  "%",
                )}
              </details>
            </fieldset>
          )}
        </>
      )}
    </div>
  );
  return {
    controls,
    parameters,
    editCue: begin,
    stylePreview: previewPatch
      ? { fields: previewPatch.fields, cue_ids: selectedOnly ? previewPatch.ids : undefined }
      : undefined,
    previewStyle: (cue: CueView, patch: Partial<StyleView>, commit: boolean) =>
      changeStyle(patch, commit, "预览字幕", [cue.cue_id]),
  };
}
