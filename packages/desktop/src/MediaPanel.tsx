import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { mediaDuration, mediaRange, middle, placeMedia, sourceProject } from "./media.js";
import { mediaUrl, Wave } from "./TimelinePreview.js";
import { compare, floor, type MediaView, parseRational, seekTarget, timecode } from "./timeline.js";
import "./media.css";

type Config = { port: number; token: string };
function Field({
  label,
  value,
  placeholder = label,
  commit,
  clear = false,
  disabled = false,
  options,
}: {
  label: string;
  value: string;
  placeholder?: string;
  commit: (value: string) => void;
  clear?: boolean;
  disabled?: boolean;
  options?: string[] | undefined;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(value);
  const submitted = useRef(value);
  useEffect(() => {
    setDraft(value);
    submitted.current = value;
  }, [value]);
  const save = () => {
    if (draft !== submitted.current) {
      submitted.current = draft;
      commit(draft);
      if (clear) {
        setDraft("");
        submitted.current = "";
      }
    }
  };
  return (
    <label className="zc-media-field">
      <input
        className="zc-input"
        list={options ? listId : undefined}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {options && (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
    </label>
  );
}
function AddValue({
  label,
  disabled,
  commit,
  options,
}: {
  label: string;
  disabled: boolean;
  commit: (value: string) => void;
  options?: string[] | undefined;
}) {
  const [adding, setAdding] = useState(false);
  return adding ? (
    <Field
      label={label}
      options={options}
      value=""
      disabled={disabled}
      commit={(value) => {
        if (value.trim()) commit(value);
        setAdding(false);
      }}
    />
  ) : (
    <IconButton icon="plus" label={label} disabled={disabled} onClick={() => setAdding(true)} />
  );
}
function shortDuration(media: MediaView) {
  const seconds = floor(parseRational(mediaDuration(media), true));
  const minutes = seconds / 60n;
  const tail = `${minutes % 60n}:${String(seconds % 60n).padStart(2, "0")}`;
  return seconds >= 3600n
    ? `${seconds / 3600n}:${tail.padStart(5, "0")}`
    : `${minutes}:${String(seconds % 60n).padStart(2, "0")}`;
}
function AudioThumbnail({
  media,
  config,
  width,
  project,
}: {
  project: ProjectView;
  media: MediaView;
  config?: Config | undefined;
  width: number;
}) {
  const clip = sourceProject(project, media).tracks[0]?.clips[0];
  return (
    clip &&
    compare(parseRational(mediaDuration(media), true), rational(0n)) > 0 && (
      <Wave
        clip={clip}
        width={width}
        scale={div(rational(BigInt(width)), parseRational(mediaDuration(media), true))}
        config={config}
      />
    )
  );
}
export function useMediaPanel({
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
  config?: Config | undefined;
}) {
  const browser = state.mediaBrowser ?? { scope: "all", search: "", size: 150 };
  const { scope, search, size } = browser;
  const setSearch = (search: string) => update({ ...state, mediaBrowser: { ...browser, search } });
  const setScope = (scope: string) => update({ ...state, mediaBrowser: { ...browser, scope } });
  const [importing, setImporting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colors, setColors] = useState<string[]>([]);
  const area = useRef<HTMLDivElement>(null);
  const [folderEdits, setFolderEdits] = useState<{ project: ProjectView; values: Record<string, string[]> } | null>(
    null,
  );
  const media = useMemo(
    () =>
      (project?.media ?? []).map((item) => {
        const folders = folderEdits?.project === project ? folderEdits?.values[item.id] : undefined;
        return folders ? { ...item, organize: { ...item.organize, folders } } : item;
      }),
    [project, folderEdits],
  );
  const selectedMedia = media.filter((item) => state.selected.includes(item.id));
  const selected = media.find((item) => item.id === state.media?.id) ?? selectedMedia[0];
  const folderTargets = selectedMedia.length ? selectedMedia : selected ? [selected] : [];
  const joinedFolders = [...new Set(folderTargets.flatMap((item) => item.organize?.folders ?? []))];
  const write = async (verb: string, label: string, data: Record<string, unknown>) => {
    if (!project || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      let result = (await call(verb, {
        project: state.project,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label,
        ...data,
      })) as { job_id?: string };
      while (result?.job_id) {
        const jobId = result.job_id;
        const job = (await call("job_status", { project: state.project, job_id: jobId })) as {
          state: string;
          progress: number;
          message: string;
          envelope?: { ok: boolean };
        };
        setProgress(job.progress);
        if (job.state === "failed" || job.envelope?.ok === false) throw new Error("导入失败，请检查素材");
        if (job.state === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = { job_id: jobId };
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
      setProgress(null);
    }
  };
  const importPaths = (paths: string[]) => paths.length && void write("import_media", "导入素材", { paths });
  const choose = (media: MediaView, multiple: boolean) => {
    const ids = multiple
      ? state.selected.includes(media.id)
        ? state.selected.filter((id) => id !== media.id)
        : [...state.selected, media.id]
      : [media.id];
    update({
      ...state,
      selected: ids,
      preview: "media",
      playing: false,
      media: ids.includes(media.id)
        ? state.media?.id === media.id
          ? state.media
          : { id: media.id, at: "0s", in: null, out: null }
        : ids[0]
          ? { id: ids[0], at: "0s", in: null, out: null }
          : undefined,
    });
  };
  const place = (
    media = selected,
    at = project ? seekTarget(project, project.cues, state.playhead) : "0s",
    track?: string,
  ) => {
    if (!media || !project || (track && project.tracks.find((item) => item.id === track)?.kind === "subtitle")) return;
    const op = placeMedia(project, media, state, at, track);
    if (!("video_track" in op) && !("audio_track" in op)) {
      setError("没有可用的目标轨道");
      return;
    }
    void write("edit", `把 ${media.name ?? "素材"} 加到时间线`, { timeline_id: project.id, ops: [op] });
  };
  const organize = (field: string, value: unknown) =>
    selected &&
    void write(
      "edit",
      `修改 ${selected.name ?? "素材"} 的${({ note: "注释", link: "来源链接", tags: "标签", folders: "文件夹", rating: "评分" } as Record<string, string>)[field]}`,
      { ops: [{ op: "update_media", media_id: selected.id, [field]: value }] },
    );
  const changeFolders = async (folder: string, remove = false) => {
    if (!project || locked.current || !folder.trim()) return;
    const values = Object.fromEntries(
      folderTargets.map((item) => [
        item.id,
        remove
          ? (item.organize?.folders ?? []).filter((value) => value !== folder)
          : [...new Set([...(item.organize?.folders ?? []), folder.trim()])],
      ]),
    );
    const applied = await write(
      "edit",
      `修改 ${folderTargets.length > 1 ? `${folderTargets.length} 个素材` : (selected?.name ?? "素材")} 的文件夹`,
      {
        ops: Object.entries(values).map(([media_id, folders]) => ({ op: "update_media", media_id, folders })),
      },
    );
    if (applied)
      setFolderEdits({
        project,
        values: { ...(folderEdits?.project === project ? folderEdits.values : {}), ...values },
      });
  };
  useEffect(() => {
    setColors([]);
    if (!selected || !config || selected.kind === "audio") return;
    const controller = new AbortController();
    void fetch(mediaUrl(config, "palette", selected.id, middle(selected)), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<string[]>;
      })
      .then(setColors)
      .catch(() => {});
    return () => controller.abort();
  }, [selected, config]);
  const importRef = useRef(importPaths);
  importRef.current = importPaths;
  useEffect(() => {
    if (!isTauri() || state.panel !== "media") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const rect = area.current?.getBoundingClientRect();
        const { x, y } = event.payload.position;
        const ratio = window.devicePixelRatio;
        if (
          rect &&
          x / ratio >= rect.left &&
          x / ratio <= rect.right &&
          y / ratio >= rect.top &&
          y / ratio <= rect.bottom
        )
          importRef.current(event.payload.paths);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => setError("无法接收拖入的文件"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [state.panel]);
  useEffect(() => {
    if (state.panel !== "media") return;
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input,textarea,select,[contenteditable=true]")) return;
      const key = e.key.toLowerCase();
      if (e.metaKey && ["+", "=", "-"].includes(key)) {
        e.preventDefault();
        update({
          ...state,
          mediaBrowser: { ...browser, size: Math.max(110, Math.min(280, size + (key === "-" ? -20 : 20))) },
        });
      }
      if (key === "q") {
        e.preventDefault();
        place();
      }
      if (
        state.preview === "media" &&
        selected &&
        state.media &&
        ["i", "o"].includes(key) &&
        selected.kind !== "image"
      ) {
        e.preventDefault();
        const media = { ...state.media };
        if (key === "i") {
          if (compare(parseRational(media.at, true), parseRational(mediaDuration(selected), true)) >= 0) return;
          media.in = media.at;
          if (media.out && compare(parseRational(media.out, true), parseRational(media.at, true)) <= 0)
            media.out = null;
        } else if (compare(parseRational(media.at, true), parseRational(media.in ?? "0s", true)) > 0)
          media.out = media.at;
        update({ ...state, media });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const folders = [
    ...new Set(
      media.flatMap(
        (m) =>
          m.organize?.folders?.flatMap((f) => f.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))) ?? [],
      ),
    ),
  ].sort((a, b) => {
    const left = a.split("/");
    const right = b.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const order = (left[i] ?? "").localeCompare(right[i] ?? "");
      if (order) return order;
    }
    return left.length - right.length;
  });
  const tags = [...new Set(media.flatMap((m) => m.organize?.tags ?? []))].sort();
  const visible = media.filter(
    (m) =>
      (scope === "all" ||
        (scope.startsWith("tag:") && m.organize?.tags?.includes(scope.slice(4))) ||
        (scope.startsWith("folder:") &&
          m.organize?.folders?.some((f) => f === scope.slice(7) || f.startsWith(`${scope.slice(7)}/`)))) &&
      [m.name, m.organize?.note, ...(m.organize?.tags ?? [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const used = (m: MediaView) =>
    m.uses ??
    new Set(
      project?.tracks.flatMap((t) => t.clips.filter((c) => c.media_id === m.id).map((c) => c.occurrence_id ?? c.id)) ??
        [],
    ).size;
  const durationText = shortDuration;
  const list = state.sub === "list";
  const range = selected ? mediaRange(selected, state) : null;
  const splitValues = (value: string) => [
    ...new Set(
      value
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const library = (
    <div ref={area} className="zc-media-library">
      <header className="zc-media-head">
        <span className="zc-media-scope">
          <select aria-label="素材范围" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">全部</option>
            {scope.startsWith("folder:") && !folders.includes(scope.slice(7)) && (
              <option value={scope}>{scope.slice(7)}（空）</option>
            )}
            {folders.map((f) => (
              <option
                key={f}
                value={`folder:${f}`}
              >{`${"　".repeat(f.split("/").length - 1)}${f.split("/").at(-1)}`}</option>
            ))}
            {tags.map((t) => (
              <option key={t} value={`tag:${t}`}>
                标签：{t}
              </option>
            ))}
          </select>
          <output aria-label="筛选数量">{visible.length}</output>
          <Icon name="down" />
        </span>
        <IconButton icon="search" label="搜索素材" pressed={searching} onClick={() => setSearching(!searching)} />
        <span className="zc-seg">
          {["grid", "list"].map((v) => (
            <IconButton
              key={v}
              icon={v}
              label={v === "grid" ? "网格" : "列表"}
              pressed={list === (v === "list")}
              onClick={() => update({ ...state, sub: v })}
            />
          ))}
        </span>
        <IconButton
          icon="plus"
          label="导入素材"
          disabled={busy || !project}
          onClick={() => {
            if (!isTauri()) {
              setImporting(!importing);
              return;
            }
            void open({ multiple: true, directory: false })
              .then((paths) => {
                if (paths) importPaths(Array.isArray(paths) ? paths : [paths]);
              })
              .catch(() => setError("文件选择失败"));
          }}
        />
      </header>
      {searching && (
        <input
          className="zc-input"
          aria-label="搜索素材内容"
          placeholder="名称、注释、标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {!isTauri() && importing && (
        <Field
          clear
          disabled={busy}
          label="导入文件路径（逗号分隔）"
          value=""
          commit={(value) => {
            importPaths(splitValues(value));
          }}
        />
      )}
      {busy && <output>正在处理…{progress !== null && <progress value={progress} max={1} />}</output>}
      {error && <p role="alert">{error}</p>}
      <div
        className={list ? "zc-media-list" : "zc-media-grid"}
        style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${size}px,1fr))` }}
      >
        {visible.map((m) => (
          <button
            type="button"
            key={m.id}
            draggable
            aria-pressed={selectedMedia.some((item) => item.id === m.id)}
            className="zc-media-card"
            onClick={(e) => choose(m, e.metaKey || e.ctrlKey)}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-zcut-media", m.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            {list ? (
              <>
                <Icon name={m.kind === "audio" ? "audio" : m.kind === "image" ? "image" : "clip"} />
                <strong title={m.name}>{m.name ?? "未命名素材"}</strong>
                <span>{m.kind !== "image" && durationText(m)}</span>
                <span className="zc-media-spec">
                  {m.video
                    ? `${m.video.width} × ${m.video.height}${m.kind === "video" ? ` · ${m.video.rate} 帧/秒` : ""}`
                    : `${m.audio?.sample_rate ?? "—"} Hz`}
                </span>
                <span role="img" aria-label={`评分 ${m.organize?.rating ?? 0} 星`}>
                  {"★".repeat(m.organize?.rating ?? 0) || "—"}
                </span>
                <span>{used(m)} 段</span>
              </>
            ) : (
              <>
                <span className="zc-media-film">
                  {m.kind === "audio" && project ? (
                    <AudioThumbnail project={project} media={m} config={config} width={size} />
                  ) : config ? (
                    (m.kind === "image" ? [0] : [0, 1, 2]).map((n) => (
                      <img
                        key={n}
                        alt=""
                        src={mediaUrl(config, "thumb", m.id, n === 1 ? middle(m) : n === 0 ? "0s" : printTwoThirds(m))}
                      />
                    ))
                  ) : (
                    <Icon name={m.kind === "image" ? "image" : "clip"} />
                  )}
                  <span className="zc-media-used">
                    {m.kind === "audio" && <Icon name="audio" />}
                    {used(m) ? `已用 ${used(m)} 段` : "未用"}
                  </span>
                  {m.kind !== "image" && <span className="zc-media-duration">{durationText(m)}</span>}
                  {state.media?.id === m.id && (state.media.in || state.media.out) && (
                    <RangeBar media={m} state={state} />
                  )}
                </span>
                <span className="zc-media-caption" title={[m.name, m.organize?.note].filter(Boolean).join(" · ")}>
                  {m.name ?? "未命名素材"}
                  {m.organize?.note && <small> · {m.organize.note}</small>}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
  const parameters = selected ? (
    <div className="zc-media-info" key={selected.id}>
      {config && selected.kind !== "audio" && (
        <img className="zc-media-cover" alt="素材封面" src={mediaUrl(config, "thumb", selected.id, middle(selected))} />
      )}
      <fieldset className="zc-palette" aria-label="主色">
        {colors.map((color, i) => (
          <button
            type="button"
            key={`${i}-${color}`}
            style={{ background: color }}
            title={color}
            aria-label={`复制色值 ${color}`}
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(color);
                } catch {
                  setError("无法复制色值");
                }
              })();
            }}
          />
        ))}
      </fieldset>
      <h3>{selected.name ?? "未命名素材"}</h3>
      <Field
        disabled={busy}
        label="注释"
        placeholder="添加注释"
        value={selected.organize?.note ?? ""}
        commit={(v) => organize("note", v)}
      />
      <Field
        disabled={busy}
        label="来源链接"
        placeholder="http://"
        value={selected.organize?.link ?? ""}
        commit={(v) => organize("link", v)}
      />
      {(["tags", "folders"] as const).map((field) => (
        <section className="zc-media-group" key={`${selected.id}-${field}`}>
          <h4>{field === "tags" ? "标签" : "文件夹"}</h4>
          <div className="zc-media-tags">
            {(field === "folders" ? joinedFolders : selected.organize?.tags)?.map((v) => (
              <span key={v} className="zc-tag">
                {field === "folders" && <Icon name="folder" />}
                {v}
                <button
                  type="button"
                  aria-label={`删除${field === "tags" ? "标签" : "文件夹"} ${v}`}
                  disabled={busy}
                  onClick={() =>
                    field === "folders"
                      ? void changeFolders(v, true)
                      : organize(
                          "tags",
                          selected.organize?.tags?.filter((s) => s !== v),
                        )
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <AddValue
              disabled={busy}
              label={field === "tags" ? "添加标签" : "添加文件夹"}
              options={field === "folders" ? folders : undefined}
              commit={(v) =>
                field === "folders"
                  ? void changeFolders(v)
                  : organize("tags", [...new Set([...(selected.organize?.tags ?? []), ...splitValues(v)])])
              }
            />
          </div>
        </section>
      ))}
      <section className="zc-media-group">
        <h4>基本信息</h4>
        <dl>
          <dt>评分</dt>
          <dd>
            <fieldset aria-label="评分" className="zc-stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  aria-label={`${n} 星`}
                  aria-pressed={(selected.organize?.rating ?? 0) >= n}
                  disabled={busy}
                  onClick={() => organize("rating", selected.organize?.rating === n ? 0 : n)}
                >
                  ★
                </button>
              ))}
            </fieldset>
          </dd>
          {selected.kind === "audio" ? (
            <>
              <dt>采样率</dt>
              <dd>{selected.audio?.sample_rate ?? "—"} Hz</dd>
              <dt>声道</dt>
              <dd>{selected.audio?.channels ?? "—"}</dd>
            </>
          ) : (
            <>
              <dt>尺寸</dt>
              <dd>{selected.video ? `${selected.video.width} × ${selected.video.height}` : "—"}</dd>
            </>
          )}
          {selected.kind === "video" && (
            <>
              <dt>帧率</dt>
              <dd>{selected.video ? `${selected.video.rate} 帧/秒` : "—"}</dd>
            </>
          )}
          {selected.kind !== "image" && (
            <>
              <dt>时长</dt>
              <dd>{durationText(selected)}</dd>
            </>
          )}
          <dt>格式</dt>
          <dd>{selected.name?.split(".").at(-1)?.toUpperCase()}</dd>
          <dt>卷名</dt>
          <dd>{selected.reel ?? "—"}</dd>
          {selected.kind !== "image" && (
            <>
              <dt>选中范围</dt>
              <dd>
                {range &&
                  timecode(range.source_start, {
                    edit_rate: selected.kind === "video" ? (selected.video?.rate ?? "25") : "25",
                    start_timecode: selected.start_timecode ?? "00:00:00:00",
                    drop_frame: Boolean(selected.start_timecode?.includes(";")),
                  } as ProjectView)}{" "}
                · {range && durationText({ ...selected, kind: "video", duration: range.duration })}
              </dd>
            </>
          )}
          <dt>时间线使用</dt>
          <dd>{used(selected)} 段</dd>
        </dl>
      </section>
      <button type="button" className="zc-btn" disabled={busy} onClick={() => place()}>
        加到时间线 <kbd>Q</kbd>
      </button>
      {isTauri() && selected.path && (
        <button
          type="button"
          className="zc-btn"
          onClick={() => {
            void revealItemInDir(selected.path ?? "").catch(() => setError("无法在访达中显示素材"));
          }}
        >
          在访达中显示
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  ) : (
    <p className="zc-muted">选择一份素材</p>
  );
  return { library, parameters, selected, place };
}

import { div, mul, printRational, rational } from "./timeline.js";

const printTwoThirds = (m: MediaView) =>
  m.kind === "image" ? "0s" : printRational(mul(parseRational(m.duration ?? "0s", true), rational(2n, 3n)), true);
export function RangeBar({ media, state }: { media: MediaView; state: UiState }) {
  const range = mediaRange(media, state);
  const total = parseRational(mediaDuration(media), true);
  if (total.numerator === 0n) return null;
  const percent = (value: string) => {
    const r = mul(div(parseRational(value, true), total), rational(100n));
    return Number(r.numerator) / Number(r.denominator);
  };
  return (
    <span
      className="zc-media-range"
      style={{ left: `${percent(range.source_start)}%`, width: `${percent(range.duration)}%` }}
    />
  );
}
