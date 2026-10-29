// biome-ignore-all lint/suspicious/noArrayIndexKey: Film cells, waveform bars and ruler ticks are fixed geometric slots.
import { useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import { Clip, Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import { useReverseAudio } from "./reverse-audio.js";
import {
  add,
  type ClipView,
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
  timecode,
} from "./timeline.js";
import "./timeline.css";

type Config = { port: number; token: string };
export function mediaUrl(config: Config, endpoint: string, id: string, at?: string) {
  const query = new URLSearchParams({ token: config.token, media_id: id, ...(at ? { at } : {}) });
  return `http://127.0.0.1:${config.port}/${endpoint}?${query}`;
}
function Film({
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
}
function Wave({
  clip,
  width,
  config,
  scale,
}: {
  clip: ClipView;
  width: number;
  scale: number;
  config: Config | undefined;
}) {
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    void fetch(mediaUrl(config, "peaks", clip.media_id), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("波形读取失败");
        return response.json() as Promise<number[]>;
      })
      .then(setPeaks)
      .catch(() => setPeaks([]));
    return () => controller.abort();
  }, [config, clip.media_id]);
  return (
    <svg className="zc-wave" width={width} height={48} viewBox={`0 0 ${width} 48`} aria-hidden="true">
      {Array.from({ length: Math.max(1, Math.floor(width / 3)) }, (_, i) => {
        const at = printRational(
          add(parseRational(clip.timeline_in.t, true), div(rational(BigInt(i * 3)), rational(BigInt(scale)))),
          true,
        );
        const index = Number(floor(mul(sourceAt(clip, at), rational(100n))));
        const height = Math.max(1, (peaks[index] ?? 0) * 26);
        return <rect key={i} x={i * 3} y={30 - height / 2} width={2} height={height} rx={1} />;
      })}
    </svg>
  );
}
export function TimelinePreview({
  project,
  state,
  update,
  config,
  call,
  error,
  dragging,
}: {
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  config: Config | undefined;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  error: string | null;
  dragging: React.MutableRefObject<boolean>;
}) {
  const [scale, setScale] = useState(48);
  const [snap, setSnap] = useState(true);
  const [tool, setTool] = useState("select");
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState(1n);
  const video = useRef<HTMLVideoElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const lastClip = useRef<string | undefined>(undefined);
  const latest = useRef({ state, project });
  latest.current = { state, project };
  const at = project ? seekTarget(project, project.cues, state.playhead) : "0s";
  const top = project?.tracks.find(
    (track) => track.kind === "video" && track.enabled && track.clips.some((clip) => clip.enabled),
  );
  const clip = top?.clips.find((item) => item.enabled && contains(item.timeline_in.t, item.timeline_out.t, at));
  const media = project?.media.find((item) => item.id === clip?.media_id);
  const speed = clip ? sourceSpeed(clip, at) : 0;
  const source = clip ? sourceAt(clip, at) : rational(0n);
  const src = config && clip ? mediaUrl(config, "media", clip.media_id) : undefined;
  useReverseAudio(
    media?.kind === "image" ? undefined : src,
    clip?.id,
    numberOf(source),
    speed * Number(direction),
    state.playing,
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
    playhead.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [project, state.playhead, update, state]);
  useEffect(() => {
    if (!state.playing || !project) return;
    let started = performance.now();
    let previous = seekTarget(project, project.cues, latest.current.state.playhead);
    let start = frameAt(previous, project.edit_rate);
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
      const frame = start + direction * floor(mul(elapsed, parseRational(project.edit_rate)));
      let next = frameTime(frame, project.edit_rate);
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
        started = now;
        start = frameAt(next, project.edit_rate);
      }
      previous = next;
      update({ ...current.state, playhead: { at: next } });
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [state.playing, project, direction, update]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (!clip) {
      if (element.readyState >= 1) element.pause();
      return;
    }
    const sync = () => {
      const seconds = numberOf(source);
      if (
        lastClip.current !== clip.id ||
        Math.abs(element.currentTime - seconds) > (state.playing && clip.speed === "1" ? 0.12 : 0.001)
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
      if (state.playing && playable) void element.play().catch(() => setWriteError("预览无法播放，请检查素材格式"));
      else element.pause();
    };
    if (element.readyState >= 1) sync();
    element.addEventListener("loadedmetadata", sync);
    return () => element.removeEventListener("loadedmetadata", sync);
  }, [clip, source, speed, state.playing, direction]);
  const write = async (verb: string, label: string, ops?: unknown[]) => {
    if (!project || busy) return;
    setBusy(true);
    setWriteError(null);
    try {
      await call(verb, {
        project: state.project,
        base_revision: project.revision.id,
        idempotency_key: crypto.randomUUID(),
        author: { kind: "human", name: "桌面用户" },
        label,
        ...(ops ? { timeline_id: project.id, ops } : {}),
      });
    } catch (error) {
      setWriteError(String(error));
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
        setScale((value) => Math.max(12, Math.min(192, value + (key === "-" ? -12 : 12))));
        return;
      }
      if (!project) return;
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
  const point = (x: number, element: HTMLElement) => {
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
    seek(target);
  };
  const width = project ? Math.max(800, pixelAt(project.duration.t, scale) + 100) : 800;
  const captions = project?.cues.filter((cue) => contains(cue.start, cue.end, at)) ?? [];
  return (
    <>
      <section aria-label="预览" className="zc-viewer">
        {(error || writeError) && <p role="alert">{error || writeError}</p>}
        <div className="zc-picture">
          {src && media?.kind === "image" ? (
            <img src={src} alt={media.name ?? "预览"} />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: Projected, styled captions are rendered immediately below the player.
            <video
              ref={video}
              src={src}
              playsInline
              aria-label="时间线预览"
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
          {captions.map((cue) => {
            const style = project?.styles.find((item) => item.id === cue.style_id);
            return (
              <span
                key={`${cue.track_id}-${cue.cue_id}-${cue.piece}`}
                className="zc-caption"
                style={{
                  fontFamily: style?.font_family,
                  ...{ "--cue-size": style?.font_size },
                  fontWeight: style?.font_weight,
                  color: style?.color,
                  background: style?.box?.color,
                  padding: style?.box?.padding,
                  WebkitTextStroke: style?.outline ? `${style.outline.width}em ${style.outline.color}` : undefined,
                  ...(style?.position?.anchor === "top"
                    ? { top: `${style.position.margin_v * 100}%`, bottom: "auto" }
                    : style?.position?.anchor === "middle"
                      ? { top: "50%", bottom: "auto" }
                      : { bottom: `${(style?.position?.margin_v ?? 0.08) * 100}%` }),
                }}
              >
                {cue.text}
              </span>
            );
          })}
        </div>
        <div className="zc-player">
          <IconButton
            icon={state.playing ? "stop" : "play"}
            label={state.playing ? "暂停" : "播放"}
            onClick={() => update({ ...state, playing: !state.playing })}
          />
          <output aria-label="播放时码">{project ? timecode(at, project) : "00:00:00:00"}</output>
        </div>
      </section>
      <section aria-label="工具栏" className="zc-toolbar">
        <IconButton icon="select" label="选择 A" pressed={tool === "select"} onClick={() => setTool("select")} />
        <IconButton
          icon="blade"
          label="切割 B"
          pressed={tool === "blade"}
          disabled={!project || busy}
          onClick={() => {
            setTool("blade");
            split();
          }}
        />
        <IconButton icon="marker" label="加标记 M" disabled={!project || busy} onClick={marker} />
        <IconButton icon="undo" label="撤销" disabled={!project || busy} onClick={() => void write("undo", "撤销")} />
        <IconButton icon="redo" label="重做" disabled={!project || busy} onClick={() => void write("redo", "重做")} />
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
      <section aria-label="时间线" className="zc-timeline">
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
                    {timecode(printRational(div(rational(BigInt(index * 96)), rational(BigInt(scale))), true), project)}
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
                    onClick={() => seek(marker.at.t)}
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
                <div className="zc-track-lane" style={{ width }}>
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
                          project.media.find((media) => media.id === item.media_id)?.name ?? item.label ?? item.media_id
                        }
                        selected={state.selected.includes(item.id)}
                        dimmed={
                          !track.enabled ||
                          !item.enabled ||
                          (state.selected.length > 0 && !state.selected.includes(item.id))
                        }
                        style={{ left: pixelAt(item.timeline_in.t, scale), width: clipWidth }}
                        onClick={() => {
                          update({ ...state, selected: [item.id] });
                          if (tool === "blade") split();
                        }}
                      >
                        {track.kind === "video" ? (
                          <Film clip={item} width={clipWidth} scale={scale} config={config} />
                        ) : (
                          <Wave clip={item} width={clipWidth} scale={scale} config={config} />
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
                          dimmed={!track.enabled || (state.selected.length > 0 && !state.selected.includes(cue.cue_id))}
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
  );
}
