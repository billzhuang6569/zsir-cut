// biome-ignore-all lint/suspicious/noArrayIndexKey: Film cells, waveform bars and ruler ticks are fixed geometric slots.

import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Clip, Icon, IconButton } from "./components.js";
import { DESKTOP_AUTHOR, type ProjectView } from "./connection.js";
import { useReverseAudio } from "./reverse-audio.js";
import { SubtitleCanvas } from "./SubtitleCanvas.js";
import {
  add,
  type ClipView,
  ceil,
  compare,
  contains,
  div,
  floor,
  frameAt,
  frameTime,
  mul,
  numberOf,
  parseRational,
  pixelAt,
  pointerTime,
  printRational,
  rational,
  seekTarget,
  sourceAt,
  sourceSpeed,
  sub,
  timecode,
} from "./timeline.js";
import { Wave } from "./Wave.js";

export { Wave } from "./Wave.js";
import "./timeline.css";

type Config = { port: number; token: string };
export function mediaUrl(config: Config, endpoint: string, id: string, at?: string) {
  const query = new URLSearchParams({ token: config.token, media_id: id, ...(at ? { at } : {}) });
  return `http://127.0.0.1:${config.port}/${endpoint}?${query}`;
}
const Film = memo(function Film({
  clip,
  width,
  scale,
  config,
}: {
  clip: ClipView;
  width: number;
  scale: number;
  config: Config | undefined;
}) {
  return (
    <span className="zc-film" aria-hidden="true">
      {Array.from({ length: Math.max(1, Math.ceil(width / 96)) }, (_, index) => {
        const at = printRational(
          add(parseRational(clip.timeline_in.t, true), div(rational(BigInt(index * 96)), rational(BigInt(scale)))),
          true,
        );
        const source = printRational(sourceAt(clip, at), true);
        return (
          <span
            key={source + index}
            className="zc-film-frame"
            style={
              config
                ? {
                    backgroundImage: `url("${mediaUrl(config, "thumb", clip.media_id, source)}")`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }
                : {}
            }
          />
        );
      })}
    </span>
  );
});
export function TimelinePreview({
  project,
  state,
  update,
  config,
  call,
  error,
  errorDetail,
  dragging,
  readOnly = false,
  historyBanner,
  onHistory,
  viewerOnly = false,
  hideViewer = false,
  onMediaDrop,
}: {
  readOnly?: boolean;
  historyBanner?: ReactNode;
  onHistory?: () => void;
  viewerOnly?: boolean;
  hideViewer?: boolean;
  onMediaDrop?: (id: string, at: string, track: string) => void;
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  config: Config | undefined;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  error: string | null;
  errorDetail?: string | undefined;
  dragging: React.MutableRefObject<boolean>;
}) {
  const [drop, setDrop] = useState<{ track: string; at: string } | null>(null);
  const [scale, setScale] = useState(48);
  const [snap, setSnap] = useState(true);
  const [tool, setTool] = useState("select");
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeErrorDetail, setWriteErrorDetail] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState(1n);
  const video = useRef<HTMLVideoElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLOutputElement>(null);
  const playbackAt = useRef<string | null>(null);
  const lastClip = useRef<string | undefined>(undefined);
  const latest = useRef({ state, project });
  latest.current = { state, project };
  const at = project ? seekTarget(project, project.cues, state.playhead) : "0s";
  const top = project?.tracks.find(
    (track) =>
      (track.kind === "video" || (viewerOnly && track.kind === "audio")) &&
      track.enabled &&
      track.clips.some((clip) => clip.enabled),
  );
  const clip = top?.clips.find(
    (item) => item.enabled && (viewerOnly || contains(item.timeline_in.t, item.timeline_out.t, at)),
  );
  const boundaries = useMemo(() => {
    if (!project) return [];
    return [
      ...(top?.clips.flatMap((item) => [item.timeline_in.t, item.timeline_out.t]) ?? []),
      ...project.cues.flatMap((cue) => [cue.start, cue.end]),
    ].map((time) => ceil(mul(parseRational(time, true), parseRational(project.edit_rate))));
  }, [project, top]);
  const media = project?.media.find((item) => item.id === clip?.media_id);
  const speed = clip ? sourceSpeed(clip, at) : 0;
  const source = clip ? sourceAt(clip, at) : rational(0n);
  const src = config && clip ? mediaUrl(config, "media", clip.media_id) : undefined;
  useReverseAudio(
    media?.kind === "image" ? undefined : src,
    clip?.id,
    numberOf(source),
    speed * Number(direction),
    state.playing && !hideViewer,
    clip?.gain_db ?? 0,
    setWriteError,
  );
  const seek = (target: string) => {
    if (!project) return;
    const value =
      compare(parseRational(target, true), parseRational(project.duration.t, true)) > 0 ? project.duration.t : target;
    update({ ...latest.current.state, playhead: { at: value } });
  };
  useEffect(() => {
    if (!project) return;
    const target = seekTarget(project, project.cues, state.playhead);
    if (!("at" in state.playhead)) update({ ...state, playhead: { at: target } });
    const head = playhead.current;
    const scroller = head?.closest(".zc-timeline");
    if (head && scroller) {
      const x = head.offsetLeft;
      if (x < scroller.scrollLeft) scroller.scrollLeft = x;
      else if (x > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x - scroller.clientWidth;
    }
  }, [project, state.playhead, update, state]);
  useEffect(() => {
    if (hideViewer || !state.playing || !project) return;
    let started = performance.now();
    let previous = seekTarget(project, project.cues, latest.current.state.playhead);
    let start = frameAt(previous, project.edit_rate);
    let published = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      const current = latest.current;
      if (!current.project || !current.state.playing) return;
      const target = seekTarget(project, project.cues, current.state.playhead);
      if (target !== previous) {
        started = now;
        start = frameAt(target, project.edit_rate);
      }
      const elapsed = rational(BigInt(Math.max(0, Math.round((now - started) * 1000))), 1_000_000n);
      let frame = start + direction * floor(mul(elapsed, parseRational(project.edit_rate)));
      const active = top?.clips.find(
        (item) => item.enabled && contains(item.timeline_in.t, item.timeline_out.t, target),
      );
      const element = video.current;
      const native =
        active &&
        active.speed !== "map" &&
        direction > 0n &&
        sourceSpeed(active, target) >= 0.0625 &&
        sourceSpeed(active, target) <= 16 &&
        project.media.find((item) => item.id === active.media_id)?.kind !== "image";
      // Let decoding/buffering drive forward playback instead of seeking to catch a wall clock.
      if (native && element && element.readyState >= 2 && !element.seeking && lastClip.current === active.id) {
        const decoded = rational(BigInt(Math.round(element.currentTime * 1_000_000)), 1_000_000n);
        frame = floor(
          mul(
            add(
              parseRational(active.timeline_in.t, true),
              div(sub(decoded, parseRational(active.source_in.t, true)), parseRational(active.speed)),
            ),
            parseRational(project.edit_rate),
          ),
        );
      } else if (native) frame = frameAt(target, project.edit_rate);
      let next = frameTime(frame, project.edit_rate);
      let looped = false;
      const range = current.state.range;
      const end = range
        ? printRational(add(parseRational(range.start, true), parseRational(range.duration, true)), true)
        : project.duration.t;
      if (
        compare(parseRational(next, true), parseRational(end, true)) >= 0 ||
        (direction < 0n && frame <= (range ? frameAt(range.start, project.edit_rate) : 0n))
      ) {
        next = current.state.loop
          ? direction > 0n
            ? (range?.start ?? "0s")
            : end
          : direction > 0n
            ? end
            : (range?.start ?? "0s");
        if (!current.state.loop) {
          update({ ...current.state, playing: false, playhead: { at: next } });
          return;
        }
        looped = true;
        started = now;
        start = frameAt(next, project.edit_rate);
      }
      if (playhead.current) playhead.current.style.left = `calc(var(--track-label-w) + ${pixelAt(next, scale)}px)`;
      if (clock.current) clock.current.textContent = timecode(next, project);
      const from = frameAt(target, project.edit_rate),
        to = frameAt(next, project.edit_rate);
      const boundary = boundaries.some((frame) => (frame > from && frame <= to) || (frame <= from && frame > to));
      if (next !== target && (now - published >= 100 || boundary || looped)) {
        playbackAt.current = looped ? null : next;
        previous = next;
        published = now;
        update({ ...current.state, playhead: { at: next } });
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [state.playing, project, direction, update, hideViewer, scale, top, boundaries]);
  useEffect(() => {
    const element = video.current;
    if (!element || hideViewer) return;
    if (!clip) {
      if (element.readyState >= 1) element.pause();
      return;
    }
    const sync = () => {
      const seconds = numberOf(source);
      if (
        lastClip.current !== clip.id ||
        ((at !== playbackAt.current || clip.speed === "map" || direction < 0n) &&
          Math.abs(element.currentTime - seconds) > 0.001)
      )
        element.currentTime = seconds;
      lastClip.current = clip.id;
      element.volume = Math.min(1, 10 ** ((clip.gain_db ?? 0) / 20));
      const rate = speed * Number(direction);
      const playable = rate >= 0.0625 && rate <= 16;
      if (playable) {
        element.playbackRate = rate;
        element.preservesPitch = true;
      }
      if (state.playing && playable) {
        if (element.paused) void element.play().catch(() => setWriteError("预览无法播放，请检查素材格式"));
      } else element.pause();
    };
    if (element.readyState >= 1) sync();
    element.addEventListener("loadedmetadata", sync);
    return () => element.removeEventListener("loadedmetadata", sync);
  }, [clip, source, speed, state.playing, direction, hideViewer, at]);
  const markerDrag = useRef<number | null>(null);
  const markerMoved = useRef(false);
  const write = async (verb: string, label: string, ops?: unknown[]) => {
    if (!project || busy || readOnly) return;
    setBusy(true);
    setWriteError(null);
    setWriteErrorDetail(undefined);
    try {
      await call(verb, {
        project: state.project,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label,
        ...(ops ? { timeline_id: project.id, ops } : {}),
      });
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : "操作失败，请重试");
      setWriteErrorDetail(error instanceof Error ? String(error.cause ?? error.message) : undefined);
    } finally {
      setBusy(false);
    }
  };
  const split = () => {
    if (!project) return;
    const cut = frameTime(frameAt(at, project.edit_rate), project.edit_rate);
    const clips = project.tracks
      .filter((track) => track.enabled && track.kind !== "subtitle")
      .flatMap((track) => track.clips)
      .filter(
        (item) => item.enabled && contains(item.timeline_in.t, item.timeline_out.t, cut) && item.timeline_in.t !== cut,
      );
    const selected = clips.filter((item) => state.selected.includes(item.id));
    const targets = selected.length ? selected : clips;
    if (targets.length)
      void write(
        "edit",
        `在 ${timecode(at, project)} 切开`,
        targets.map((item) => ({ op: "split", clip_id: item.id, at: cut })),
      );
  };
  const marker = () =>
    project &&
    void write("edit", `在 ${timecode(at, project)} 加标记`, [
      {
        op: "add_marker",
        at: frameTime(frameAt(at, project.edit_rate), project.edit_rate),
        duration: "0s",
        kind: "review",
        text: "标记",
      },
    ]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]"))
        return;
      const key = event.key.toLowerCase();
      if (event.metaKey && ["+", "=", "-"].includes(key)) {
        event.preventDefault();
        if (state.panel === "media") return;
        setScale((value) => Math.max(12, Math.min(192, value + (key === "-" ? -12 : 12))));
        return;
      }
      if (!project || hideViewer) return;
      if (viewerOnly && ["a", "b", "m", "z"].includes(key)) return;
      if ([" ", "j", "k", "l", "arrowleft", "arrowright", "a", "b", "m"].includes(key)) event.preventDefault();
      if (key === "a") setTool("select");
      if (key === "b") setTool("blade");
      if (key === "m") marker();
      if (key === "k") update({ ...state, playing: false });
      if (key === " " || key === "j" || key === "l") {
        setDirection(key === "j" ? -1n : 1n);
        update({ ...state, playing: key === " " ? !state.playing : true });
      }
      if (key === "arrowleft" || key === "arrowright") {
        update({
          ...state,
          playing: false,
          playhead: {
            at: seekTarget(project, project.cues, {
              at: frameTime(frameAt(at, project.edit_rate) + (key === "arrowleft" ? -1n : 1n), project.edit_rate),
            }),
          },
        });
      }
      if (event.metaKey && key === "z") {
        event.preventDefault();
        void write(event.shiftKey ? "redo" : "undo", event.shiftKey ? "重做" : "撤销");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const dropPoint = (x: number, element: HTMLElement) => {
    if (!project) return;
    let target = pointerTime(x - element.getBoundingClientRect().left, scale, project.edit_rate);
    if (snap) {
      const points = [
        ...project.markers.map((marker) => marker.at.t),
        ...project.tracks.flatMap((track) => track.clips.flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t])),
      ];
      const nearest = points.sort(
        (a, b) =>
          Math.abs(pixelAt(a, scale) - pixelAt(target, scale)) - Math.abs(pixelAt(b, scale) - pixelAt(target, scale)),
      )[0];
      if (nearest && Math.abs(pixelAt(nearest, scale) - pixelAt(target, scale)) <= 8) target = nearest;
    }
    return target;
  };
  const point = (x: number, element: HTMLElement) => {
    const target = dropPoint(x, element);
    if (target) {
      update({ ...latest.current.state, preview: "timeline", playing: false, playhead: { at: target } });
    }
  };
  const width = project ? Math.max(800, pixelAt(project.duration.t, scale) + 100) : 800;
  const visibleCues = project?.cues.filter((cue) => contains(cue.start, cue.end, at)) ?? [];
  const captionKey = visibleCues.map((cue) => `${cue.cue_id}:${cue.piece}:${cue.text}:${cue.style_id}`).join("\0");
  // Keep the canvas unchanged between caption boundaries.
  // biome-ignore lint/correctness/useExhaustiveDependencies: captionKey includes every rendered cue field.
  const captions = useMemo(() => visibleCues, [project, captionKey]);
  return (
    <>
      {!hideViewer && (
        <section aria-label="预览" className="zc-viewer">
          {(error || writeError) && (
            <p role="alert" title={error ? errorDetail : writeErrorDetail}>
              {error || writeError}
            </p>
          )}
          {viewerOnly && <h3>{project?.name}</h3>}
          <div
            className="zc-picture"
            style={{ aspectRatio: `${project?.format?.width ?? 1920} / ${project?.format?.height ?? 1080}` }}
          >
            {src && media?.kind === "image" ? (
              <img src={src} alt={media.name ?? "预览"} />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: Projected, styled captions are rendered immediately below the player.
              <video
                ref={video}
                src={src}
                playsInline
                aria-label={viewerOnly ? "素材预览" : "时间线预览"}
                onError={() => setWriteError("预览无法读取，请检查素材或代理")}
              />
            )}
            {clip?.speed === "map" && (
              <span
                className="zc-approx"
                title="近似：平滑变速按线性映射；倒放与静帧逐帧定位，倒放声音按采样近似；无转场混合或画面变换"
              >
                近似
              </span>
            )}
            <SubtitleCanvas cues={captions} styles={project?.styles ?? []} format={project?.format} />
          </div>
          <div className="zc-player">
            <IconButton
              icon={state.playing ? "stop" : "play"}
              label={state.playing ? "暂停" : "播放"}
              onClick={() => update({ ...state, playing: !state.playing })}
            />
            <output ref={clock} aria-label="播放时码">
              {project ? timecode(at, project) : "00:00:00:00"}
            </output>
          </div>
          {viewerOnly && project && (
            <div className="zc-source-scrub">
              <input
                type="range"
                aria-label="素材进度"
                min={0}
                max={Number(frameAt(project.duration.t, project.edit_rate))}
                value={Number(frameAt(at, project.edit_rate))}
                onChange={(e) => seek(frameTime(BigInt(e.target.value), project.edit_rate))}
              />
              {state.media && (
                <span
                  className="zc-source-range"
                  style={{
                    left: `${pixelAt(state.media.in ?? "0s", 100) / pixelAt(project.duration.t, 1)}%`,
                    width: `${(pixelAt(state.media.out ?? project.duration.t, 100) - pixelAt(state.media.in ?? "0s", 100)) / pixelAt(project.duration.t, 1)}%`,
                  }}
                />
              )}
            </div>
          )}
        </section>
      )}
      {!viewerOnly && (
        <>
          <section aria-label="工具栏" className="zc-toolbar">
            {historyBanner}
            <IconButton icon="select" label="选择 A" pressed={tool === "select"} onClick={() => setTool("select")} />
            <IconButton
              icon="blade"
              label="切割 B"
              pressed={tool === "blade"}
              disabled={!project || busy || readOnly}
              onClick={() => {
                setTool("blade");
                split();
              }}
            />
            <IconButton icon="marker" label="加标记 M" disabled={!project || busy || readOnly} onClick={marker} />
            <IconButton
              icon="undo"
              label="撤销"
              disabled={!project || busy || readOnly}
              onClick={() => void write("undo", "撤销")}
            />
            <IconButton
              icon="redo"
              label="重做"
              disabled={!project || busy || readOnly}
              onClick={() => void write("redo", "重做")}
            />
            <IconButton icon="history" label="历史 ⌘ Y" pressed={state.history?.open === true} onClick={onHistory} />
            <IconButton icon="snap" label="吸附" pressed={snap} onClick={() => setSnap(!snap)} />
            <span className="zc-grow" />
            <span className="zc-count" title="片段">
              <Icon name="clip" />
              {project?.tracks.reduce((count, track) => count + track.clips.length, 0) ?? 0}
            </span>
            <span className="zc-count" title="字幕">
              <Icon name="subtitle" />
              {project?.cues.length ?? 0}
            </span>
            <IconButton icon="search" label="缩放" onClick={() => setScale(48)} />
            <input
              aria-label="时间线缩放"
              type="range"
              min={12}
              max={192}
              step={12}
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </section>
          <section
            aria-label="时间线"
            className="zc-timeline"
            onPointerDownCapture={() => {
              if (state.preview === "media") update({ ...state, preview: "timeline", playing: false });
            }}
          >
            {project && (
              <div className="zc-timeline-content" style={{ width: `calc(var(--track-label-w) + ${width}px)` }}>
                <div className="zc-ruler-row">
                  <span className="zc-track-name" />
                  <div
                    className="zc-ruler"
                    style={{ width }}
                    role="slider"
                    tabIndex={0}
                    aria-label="时间标尺"
                    aria-valuemin={0}
                    aria-valuemax={Number(frameAt(project.duration.t, project.edit_rate))}
                    aria-valuenow={Number(frameAt(at, project.edit_rate))}
                    onPointerDown={(event) => {
                      dragging.current = true;
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      point(event.clientX, event.currentTarget);
                    }}
                    onPointerMove={(event) => {
                      if (dragging.current) point(event.clientX, event.currentTarget);
                    }}
                    onPointerUp={() => {
                      dragging.current = false;
                    }}
                    onLostPointerCapture={() => {
                      dragging.current = false;
                    }}
                    onPointerCancel={() => {
                      dragging.current = false;
                    }}
                  >
                    {Array.from({ length: Math.ceil(width / 96) }, (_, index) => (
                      <span key={index} className="zc-tick" style={{ left: index * 96 }}>
                        {timecode(
                          printRational(div(rational(BigInt(index * 96)), rational(BigInt(scale))), true),
                          project,
                        )}
                      </span>
                    ))}
                    {project.markers.map((marker) => (
                      <button
                        type="button"
                        key={marker.id}
                        className="zc-marker"
                        title={marker.text}
                        aria-label={marker.text}
                        style={{ left: pixelAt(marker.at.t, scale) }}
                        onPointerDown={(event) => {
                          if (marker.kind !== "chapter" || busy || readOnly) return;
                          event.stopPropagation();
                          markerMoved.current = false;
                          markerDrag.current = event.clientX;
                          dragging.current = true;
                          event.currentTarget.setPointerCapture?.(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                          if (markerDrag.current === null) return;
                          event.stopPropagation();
                          const ruler = event.currentTarget.parentElement;
                          if (ruler)
                            event.currentTarget.style.left = `${pixelAt(seekTarget(project, project.cues, { at: dropPoint(event.clientX, ruler) ?? marker.at.t }), scale)}px`;
                        }}
                        onPointerUp={(event) => {
                          if (markerDrag.current === null) return;
                          event.stopPropagation();
                          const moved = Math.abs(event.clientX - markerDrag.current) > 2;
                          markerMoved.current = moved;
                          markerDrag.current = null;
                          dragging.current = false;
                          event.currentTarget.style.left = `${pixelAt(marker.at.t, scale)}px`;
                          const ruler = event.currentTarget.parentElement;
                          if (!moved || !ruler) return;
                          const target = seekTarget(project, project.cues, {
                            at: dropPoint(event.clientX, ruler) ?? marker.at.t,
                          });
                          if (target !== marker.at.t)
                            void write("edit", `移动章节「${marker.text}」`, [
                              { op: "update_marker", marker_id: marker.id, at: target },
                            ]);
                        }}
                        onPointerCancel={(event) => {
                          markerDrag.current = null;
                          dragging.current = false;
                          event.currentTarget.style.left = `${pixelAt(marker.at.t, scale)}px`;
                        }}
                        onLostPointerCapture={(event) => {
                          markerDrag.current = null;
                          dragging.current = false;
                          event.currentTarget.style.left = `${pixelAt(marker.at.t, scale)}px`;
                        }}
                        onClick={() => {
                          if (!markerMoved.current) seek(marker.at.t);
                          markerMoved.current = false;
                        }}
                      >
                        ▼
                      </button>
                    ))}
                  </div>
                </div>
                {project.tracks.map((track) => (
                  <div key={track.id} className={`zc-track zc-track-${track.kind}`}>
                    <span className="zc-track-name" title={track.name}>
                      {track.name}
                    </span>
                    {/* biome-ignore lint/a11y/useSemanticElements: A timeline drop lane is not a form fieldset. */}
                    <div
                      role="group"
                      aria-label={`${track.name} 放置区域`}
                      className="zc-track-lane"
                      style={{ width }}
                      onDragOver={(event) => {
                        if (
                          readOnly ||
                          track.kind === "subtitle" ||
                          !event.dataTransfer.types.includes("application/x-zcut-media")
                        )
                          return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        const at = dropPoint(event.clientX, event.currentTarget);
                        if (at) setDrop({ track: track.id, at });
                      }}
                      onDragLeave={() => setDrop(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        const at = dropPoint(event.clientX, event.currentTarget);
                        const id = event.dataTransfer.getData("application/x-zcut-media");
                        if (id && at && !readOnly) onMediaDrop?.(id, at, track.id);
                        setDrop(null);
                      }}
                    >
                      {drop?.track === track.id && (
                        <span className="zc-drop-preview" style={{ left: pixelAt(drop.at, scale) }} />
                      )}
                      {track.clips.map((item) => {
                        const clipWidth = Math.max(
                          1,
                          pixelAt(item.timeline_out.t, scale) - pixelAt(item.timeline_in.t, scale),
                        );
                        return (
                          <Clip
                            key={item.id}
                            kind={track.kind}
                            label={
                              project.media.find((media) => media.id === item.media_id)?.name ??
                              item.label ??
                              item.media_id
                            }
                            selected={state.selected.includes(item.id)}
                            dimmed={
                              !track.enabled ||
                              !item.enabled ||
                              (state.selected.length > 0 && !state.selected.includes(item.id))
                            }
                            style={{ left: pixelAt(item.timeline_in.t, scale), width: clipWidth }}
                            onClick={() => {
                              update({ ...state, preview: "timeline", playing: false, selected: [item.id] });
                              if (tool === "blade") split();
                            }}
                          >
                            {track.kind === "video" ? (
                              <Film clip={item} width={clipWidth} scale={scale} config={config} />
                            ) : (
                              <Wave
                                clip={item}
                                width={clipWidth}
                                scale={scale}
                                config={config}
                                hasAudio={project.media.some(
                                  (media) => media.id === item.media_id && (media.kind === "audio" || !!media.audio),
                                )}
                              />
                            )}
                          </Clip>
                        );
                      })}
                      {track.kind === "subtitle" &&
                        project.cues
                          .filter((cue) => cue.track_id === track.id)
                          .map((cue) => (
                            <Clip
                              key={`${cue.cue_id}-${cue.piece}-${cue.start}`}
                              kind="subtitle"
                              label={cue.text.replaceAll("\n", " ")}
                              selected={state.selected.includes(cue.cue_id)}
                              dimmed={
                                !track.enabled || (state.selected.length > 0 && !state.selected.includes(cue.cue_id))
                              }
                              style={{
                                left: pixelAt(cue.start, scale),
                                width: Math.max(1, pixelAt(cue.end, scale) - pixelAt(cue.start, scale)),
                              }}
                              onClick={() => update({ ...state, selected: [cue.cue_id] })}
                            />
                          ))}
                    </div>
                  </div>
                ))}
                <div
                  ref={playhead}
                  className="zc-playhead"
                  style={{ left: `calc(var(--track-label-w) + ${pixelAt(at, scale)}px)` }}
                >
                  <button
                    type="button"
                    aria-label="播放头"
                    onPointerDown={(event) => {
                      dragging.current = true;
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const ruler = event.currentTarget
                        .closest(".zc-timeline-content")
                        ?.querySelector<HTMLElement>(".zc-ruler");
                      if (dragging.current && ruler) point(event.clientX, ruler);
                    }}
                    onPointerUp={() => {
                      dragging.current = false;
                    }}
                    onLostPointerCapture={() => {
                      dragging.current = false;
                    }}
                    onPointerCancel={() => {
                      dragging.current = false;
                    }}
                  >
                    ▼
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
