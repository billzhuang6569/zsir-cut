// Gesture adaptations: OpenCut-app/opencut-classic, cf5e79e919144200294fb9fed22a222592a0aeea, MIT.
// Includes timeline/controllers/resize-controller.ts (trim preview/discard/commit).
// Copyright 2025-2026 OpenCut. See useTimelineGestures.ts and THIRD_PARTY_NOTICES.md.
// biome-ignore-all lint/suspicious/noArrayIndexKey: Film cells, waveform bars and ruler ticks are fixed geometric slots.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clip, Icon, IconButton } from "./components.js";
import { DESKTOP_AUTHOR, type ProjectView, type useTimelinePreferences } from "./connection.js";
import { loadMediaResource, type Thumbs, thumbnailStyle, useMediaCache } from "./media-cache.js";
import { usePreviewStream } from "./preview-stream.js";
import { useReverseAudio } from "./reverse-audio.js";
import { SubtitleCanvas } from "./SubtitleCanvas.js";
import { preventPointerSelection } from "./selection.js";
import type { UiState } from "./state.js";
import { subtitleStyleOps } from "./subtitles.js";
import {
  add,
  type ClipView,
  type CueView,
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
  pointerFrameTime,
  pointerTime,
  printRational,
  rational,
  rulerTicks,
  seekTarget,
  sourceAt,
  sourceSpeed,
  sub,
  timecode,
} from "./timeline.js";
import { editPoints, keyboardKey, splitAllAt, timelineEdit } from "./timelineActions.js";
import { moveClipPreview, moveGroup, moveInsert, moveTarget, snapEdges } from "./timelineMove.js";
import { cueTrimTarget, rollTarget, type TrimEdge, trimTarget } from "./timelineTrim.js";
import { useTimelineGestures } from "./useTimelineGestures.js";
import { Wave } from "./Wave.js";

export { Wave } from "./Wave.js";
import "./timeline.css";

let prerollLead = 0.3;

function editCursor(mode: "trim" | "ripple" | "roll", edge: TrimEdge = "out") {
  const bracket = edge === "in" ? "M15 5H10V19H15" : "M9 5H14V19H9";
  const path = mode === "roll" ? "M9 5H6V19H9M15 5H18V19H15M9 12H15" : bracket;
  const film = mode === "ripple" ? '<path d="M2 8V16M5 8V16M19 12H23M21 10L23 12L21 14"/>' : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="4"><path d="${path}"/></g><g fill="none" stroke="white" stroke-width="2"><path d="${path}"/>${film}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ew-resize`;
}

const cueKey = (cue: CueView) => `${cue.track_id}:${cue.cue_id}:${cue.piece}:${cue.start}`;

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
  const film = useRef<HTMLSpanElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = film.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const media = useMediaCache(config, clip.media_id);
  const [thumbs, setThumbs] = useState<Thumbs>();
  const [color, setColor] = useState<string>();
  useEffect(() => {
    let live = true;
    setThumbs(undefined);
    if (config && media?.key && media.thumbs)
      void loadMediaResource(config, media.key, "thumbs.json", (response) => response.json() as Promise<Thumbs>).then(
        (value) => {
          if (live) setThumbs(value);
        },
      );
    return () => {
      live = false;
    };
  }, [config, media?.key, media?.thumbs]);
  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    void fetch(mediaUrl(config, "palette", clip.media_id), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((colors: string[]) => {
        if (!controller.signal.aborted) setColor(colors[4]);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [config, clip.media_id]);
  const sources = Array.from({ length: Math.max(1, Math.ceil(width / 96)) }, (_, index) => {
    const at = printRational(
      add(parseRational(clip.timeline_in.t, true), div(rational(BigInt(index * 96)), rational(BigInt(scale)))),
      true,
    );
    return printRational(sourceAt(clip, at), true);
  });
  return (
    <span ref={film} className="zc-film" aria-hidden="true" style={{ backgroundColor: color }}>
      {sources.map((source, index) => {
        const other = sources[index + 1] ?? sources[index - 1];
        const gap = other ? sub(parseRational(other, true), parseRational(source, true)) : rational(96n, BigInt(scale));
        const span = gap.numerator < 0n ? mul(gap, rational(-1n)) : gap;
        const fine = Boolean(thumbs && compare(span, parseRational(thumbs.interval, true)) < 0);
        return (
          <span key={source + index} className="zc-film-frame">
            <span
              style={
                config && media?.fallback
                  ? {
                      backgroundImage: `url("${mediaUrl(config, "thumb", clip.media_id, source)}")`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }
                  : config && media && thumbs
                    ? thumbnailStyle(config, media.key, thumbs, source, fine, 96, height)
                    : {}
              }
            />
          </span>
        );
      })}
    </span>
  );
});

export function TimelinePreview({
  preferences,
  project,
  state,
  update,
  config,
  call,
  error,
  errorDetail,
  dragging,
  readOnly = false,
  revisionControlsTarget,
  viewerTarget,
  viewerOnly = false,
  hideTimeline = false,
  hideViewer = false,
  onOpenSettings,
  onMediaDrop,
  onEditSubtitle,
  subtitlePreview,
  onSubtitleStyle,
}: {
  preferences: ReturnType<typeof useTimelinePreferences>;
  onEditSubtitle?: (cue: CueView) => void;
  subtitlePreview?: { fields: Partial<import("./timeline.js").StyleView>; cue_ids?: string[] | undefined } | undefined;
  onSubtitleStyle?: (
    cue: import("./timeline.js").CueView,
    patch: Partial<import("./timeline.js").StyleView>,
    commit: boolean,
  ) => void;
  readOnly?: boolean;
  revisionControlsTarget?: HTMLElement | null;
  viewerTarget?: HTMLElement | null;
  viewerOnly?: boolean;
  hideTimeline?: boolean;
  hideViewer?: boolean;
  onOpenSettings?: (page?: "预览与缓存") => void;
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
  const [subtitleDraft, setSubtitleDraft] = useState<Partial<import("./timeline.js").StyleView> | null>(null);
  const [drop, setDrop] = useState<{ track: string; at: string } | null>(null);
  const [scale, setScale] = useState(48);
  const [movePreview, setMovePreview] = useState<{
    ids: string[];
    anchor: string;
    blocked: boolean;
    y: number;
    target: ReturnType<typeof moveTarget> & { insert?: NonNullable<ReturnType<typeof moveInsert>>["insert"] };
  } | null>(null);
  const [trimPreview, setTrimPreview] = useState<
    (ReturnType<typeof trimTarget> & { edge: TrimEdge; following?: ClipView[] }) | null
  >(null);
  const [metaKey, setMetaKey] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<{
    x: number;
    y: number;
    delta: string;
    durations: string[];
    cursor: string;
  } | null>(null);
  useEffect(() => {
    const modifiers = (event: KeyboardEvent) => setMetaKey(event.metaKey);
    const reset = () => setMetaKey(false);
    window.addEventListener("keydown", modifiers);
    window.addEventListener("keyup", modifiers);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", modifiers);
      window.removeEventListener("keyup", modifiers);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const [cuePreview, setCuePreview] = useState<{
    cue: CueView;
    edge: TrimEdge;
    target: NonNullable<ReturnType<typeof cueTrimTarget>>;
  } | null>(null);
  const [cueMenu, setCueMenu] = useState<{ cue: CueView; x: number; y: number; element: HTMLElement } | null>(null);
  useEffect(() => {
    if (!cueMenu) return;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (event.target as Element).closest(".zc-cue-menu")) return;
      setCueMenu(null);
      if (event instanceof KeyboardEvent) cueMenu.element.focus();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [cueMenu]);
  const cueMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cueMenu) cueMenuRef.current?.querySelector("button")?.focus();
  }, [cueMenu]);
  const gestures = useTimelineGestures({
    project,
    state,
    update,
    dragging,
    scale,
    setScale,
    clipDrag: (event, element) => {
      if (!project || busy || readOnly || (tool !== "select" && tool !== "roll")) return;
      const id = element.dataset.selectionId;
      const edge = (event.target as Element).closest<HTMLElement>("[data-trim-edge]")?.dataset.trimEdge as
        | TrimEdge
        | undefined;
      if (element.dataset.cueKey) {
        const cue = project.cues.find((cue) => cueKey(cue) === element.dataset.cueKey);
        if (!cue || !edge || tool !== "select") return;
        const origin = Math.round(event.clientX);
        const scroll = gestures.scroller.current?.scrollLeft ?? 0;
        const calculate = (point: { clientX: number }) =>
          cueTrimTarget(
            project,
            cue,
            edge,
            Math.round(point.clientX) - origin + Math.round((gestures.scroller.current?.scrollLeft ?? 0) - scroll),
            scale,
            snapRef.current,
            seekTarget(project, project.cues, latest.current.state.playhead),
          );
        return {
          move: (point) => {
            const target = calculate(point);
            if (target) setCuePreview({ cue, edge, target });
          },
          end: (point, moved) => {
            setCuePreview(null);
            if (!moved) return;
            const target = calculate(point);
            if (target && target.to !== (edge === "in" ? cue.start : cue.end))
              void write("edit", "调整字幕时间", [target.op]);
          },
          cancel: () => setCuePreview(null),
        };
      }
      const track = project.tracks.find(
        (track) => track.kind !== "subtitle" && track.clips.some((clip) => clip.id === id),
      );
      if (!id || !track) return;
      if (edge && tool === "roll") {
        const anchor = track.clips.find((clip) => clip.id === id);
        const at = edge === "in" ? anchor?.timeline_in.t : anchor?.timeline_out.t;
        const point = points.find((point) => point.track_id === track.id && point.at === at);
        const left = track.clips.find((clip) => clip.id === point?.clip_id);
        if (left) return rollDrag(event, left, point);
      }
      if (edge) {
        const anchor = track.clips.find((clip) => clip.id === id);
        if (!anchor || anchor.time_map || anchor.speed === "map") return;
        const origin = Math.round(event.clientX);
        const scroll = gestures.scroller.current?.scrollLeft ?? 0;
        const calculate = (point: { clientX: number; altKey: boolean; metaKey: boolean }) =>
          trimTarget(
            project,
            anchor,
            edge,
            !point.altKey,
            Math.round(point.clientX) - origin + Math.round((gestures.scroller.current?.scrollLeft ?? 0) - scroll),
            scale,
            snapRef.current,
            seekTarget(project, project.cues, latest.current.state.playhead),
            dragMagnetic(point.metaKey),
          );
        return {
          move: (point) => {
            const target = calculate(point);
            setTrimPreview({ ...target, edge });
            const to = parseRational(target.to, true);
            feedback(
              point,
              sub(to, parseRational(edge === "in" ? anchor.timeline_in.t : anchor.timeline_out.t, true)),
              [
                edge === "in"
                  ? sub(parseRational(anchor.timeline_out.t, true), to)
                  : sub(to, parseRational(anchor.timeline_in.t, true)),
              ],
              editCursor(dragMagnetic(point.metaKey) ? "ripple" : "trim", edge),
            );
          },
          end: (point, moved) => {
            setTrimPreview(null);
            setDragFeedback(null);
            if (!moved) return;
            const result = calculate(point);
            if (result.blocked) {
              setWriteError(result.reason);
              setWriteErrorDetail(undefined);
              return;
            }
            if (result.to === (edge === "in" ? anchor.timeline_in.t : anchor.timeline_out.t)) return;
            void write("edit", edge === "in" ? "修剪片段入点" : "修剪片段出点", [
              {
                op: "trim",
                clip_id: id,
                edge,
                to: result.to,
                ripple: dragMagnetic(point.metaKey),
                linked: !point.altKey,
              },
            ]);
          },
          cancel: () => {
            setTrimPreview(null);
            setDragFeedback(null);
          },
        };
      }
      if (tool !== "select") return;
      const group = moveGroup(project, state.selected, id);
      const origin = Math.round(event.clientX);
      const scroll = gestures.scroller.current?.scrollLeft ?? 0;
      const lane = element.closest<HTMLElement>(".zc-track-lane");
      const calculate = (event: { clientX: number; clientY: number; metaKey: boolean }) => {
        const magnetic = dragMagnetic(event.metaKey);
        const targetLane = [...(gestures.scroller.current?.querySelectorAll<HTMLElement>(".zc-track-lane") ?? [])].find(
          (lane) => {
            const rect = lane.getBoundingClientRect();
            return event.clientY >= rect.top && event.clientY < rect.bottom;
          },
        );
        const target = moveTarget(
          project,
          group,
          Math.round(event.clientX) - origin + Math.round((gestures.scroller.current?.scrollLeft ?? 0) - scroll),
          scale,
          snapRef.current,
          seekTarget(project, project.cues, latest.current.state.playhead),
        );
        const trackId = targetLane?.dataset.trackId ?? track.id;
        const pointer = div(
          rational(BigInt(Math.round(event.clientX - ((targetLane ?? lane)?.getBoundingClientRect().left ?? 0)))),
          rational(BigInt(scale)),
        );
        const insertion = magnetic ? moveInsert(project, group, target, id, trackId, pointer) : null;
        const blocked = magnetic && new Set(group.moving.map((clip) => clip.occurrence_id ?? clip.id)).size !== 1;
        return {
          target: blocked ? target : (insertion ?? target),
          blocked,
          insert: !!insertion && !blocked,
          trackId,
          y: targetLane && lane ? targetLane.getBoundingClientRect().top - lane.getBoundingClientRect().top : 0,
        };
      };
      return {
        move: (event) => {
          const preview = calculate(event);
          const anchor = group.moving.find((clip) => clip.id === id);
          if (anchor)
            feedback(
              event,
              sub(parseRational(preview.target.to, true), group.earliest),
              [sub(parseRational(anchor.timeline_out.t, true), parseRational(anchor.timeline_in.t, true))],
              dragMagnetic(event.metaKey) ? "copy" : "grabbing",
            );
          setMovePreview({
            ids: group.moving.map((clip) => clip.id),
            anchor: id,
            blocked: preview.blocked,
            y: preview.y,
            target: preview.target,
          });
        },
        end: (event, moved) => {
          setMovePreview(null);
          setDragFeedback(null);
          if (!moved) return;
          const result = calculate(event);
          if (result.blocked) {
            setWriteError("一次只能插入一组片段");
            setWriteErrorDetail(undefined);
            return;
          }
          void write("edit", "移动片段", [
            {
              op: "move",
              clip_ids: group.requested.map((clip) => clip.id),
              to: result.target.to,
              mode: dragMagnetic(event.metaKey) ? "insert" : "place",
              ...(result.trackId !== track.id ? { track_id: result.trackId } : {}),
            },
          ]);
        },
        cancel: () => {
          setMovePreview(null);
          setDragFeedback(null);
        },
      };
    },
  });
  const [tool, setTool] = useState("select");
  const temporaryTool = useRef<{ key: string; previous: string; started: number; used: boolean } | null>(null);
  const [bladeHover, setBladeHover] = useState<{ id: string; x: number; shift: boolean; alt: boolean } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeErrorDetail, setWriteErrorDetail] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { keymap, preset, snap, magnetic, trackHeight, setUi } = preferences;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  function dragMagnetic(meta: boolean) {
    return preset === "premiere" && meta ? !magnetic : magnetic;
  }
  function feedback(
    point: { clientX: number; clientY: number },
    delta: ReturnType<typeof rational>,
    durations: ReturnType<typeof rational>[],
    cursor: string,
  ) {
    if (!project) return;
    const elapsed = { ...project, start_timecode: "00:00:00:00" };
    const negative = delta.numerator < 0n;
    setDragFeedback({
      x: point.clientX + 16,
      y: point.clientY + 20,
      cursor,
      delta: `${negative ? "−" : "+"}${timecode(printRational(negative ? mul(delta, rational(-1n)) : delta, true), elapsed)}`,
      durations: durations.map((duration) => timecode(printRational(duration, true), elapsed)),
    });
  }
  function rollDrag(
    event: React.PointerEvent<HTMLElement>,
    left: ClipView,
    point?: ReturnType<typeof editPoints>[number],
  ) {
    if (!project) return {};
    const origin = Math.round(event.clientX);
    const scroll = gestures.scroller.current?.scrollLeft ?? 0;
    const calculate = (point: { clientX: number }) =>
      rollTarget(
        project,
        left,
        Math.round(point.clientX) - origin + Math.round((gestures.scroller.current?.scrollLeft ?? 0) - scroll),
        scale,
        snapRef.current,
        seekTarget(project, project.cues, latest.current.state.playhead),
      );
    const reset = () => {
      setTrimPreview(null);
      setDragFeedback(null);
    };
    return {
      move: (event: { clientX: number; clientY: number }) => {
        const target = calculate(event);
        setTrimPreview({ ...target, edge: "out" });
        const to = parseRational(target.to, true);
        feedback(
          event,
          sub(to, parseRational(left.timeline_out.t, true)),
          [
            sub(to, parseRational(left.timeline_in.t, true)),
            ...target.following.slice(0, 1).map((right) => sub(parseRational(right.timeline_out.t, true), to)),
          ],
          editCursor("roll"),
        );
      },
      end: (event: React.PointerEvent<HTMLElement>, moved: boolean) => {
        reset();
        if (!moved) return;
        const target = calculate(event);
        if (target.blocked) {
          setWriteError(target.reason);
          setWriteErrorDetail(undefined);
          return;
        }
        if (target.to !== left.timeline_out.t)
          void write("edit", "拖动剪点", [{ op: "roll", clip_id: left.id, edge: "out", to: target.to }]).then((ok) => {
            if (ok && point) updateRollSelection(point, target.to);
          });
      },
      cancel: reset,
    };
  }
  const [direction, setDirection] = useState(1n);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const activeVideo = useRef(0);
  const [visibleVideo, setVisibleVideo] = useState(0);
  const topPlayback = useRef({ time: 0, steady: false });
  const failedPreroll = useRef<string>();
  const preroll = useRef<{
    clip: ClipView;
    element: HTMLVideoElement;
    running: boolean;
    outgoing: ClipView;
    heldAt: number | null;
    prepare: () => void;
    cancel: () => void;
  } | null>(null);
  const discardPreroll = useCallback((reason?: string) => {
    failedPreroll.current = reason ? (preroll.current?.outgoing.id ?? lastClip.current) : undefined;
    const lower = videos.current[1 - activeVideo.current];
    if (lower) lower.dataset.prerollState = reason ? `fallback:${reason}` : "idle";
    if (reason) {
      const top = videos.current[activeVideo.current];
      if (top) top.dataset.prerollFallback = reason;
    }
    if (preroll.current) {
      preroll.current.element.pause();
      preroll.current.element.muted = true;
    }
    preroll.current?.cancel();
    preroll.current = null;
  }, []);
  const resetTopPlayback = (element: HTMLVideoElement) => {
    if (element !== videos.current[activeVideo.current]) return;
    topPlayback.current = { time: element.currentTime, steady: false };
  };
  const pauseOriginal = useCallback(() => {
    discardPreroll();
    for (const video of videos.current) {
      video?.pause();
      if (video) video.muted = true;
    }
  }, [discardPreroll]);
  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLOutputElement>(null);
  const playbackAt = useRef<string | null>(null);
  const subtitleAt = useRef<string | null>(null);
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
  const points = useMemo(() => (project ? editPoints(project) : []), [project]);
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
  const {
    video: streamVideo,
    visible: streamVisible,
    preparing: streamPreparing,
    active: streamActive,
    sample: sampleStream,
    cacheStatus,
  } = usePreviewStream({
    project,
    top,
    path: viewerOnly || readOnly ? null : state.project,
    config,
    call,
    enabled: state.playing && direction > 0n && !hideViewer && !viewerOnly && !readOnly && !dragging.current,
    at,
    playbackAt,
    prepare: pauseOriginal,
  });
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
    if (!("at" in state.playhead)) update({ ...latest.current.state, playhead: { at: target } });
    const head = playhead.current;
    const scroller = head?.closest(".zc-timeline");
    if (head && scroller) {
      const x = head.offsetLeft;
      if (x < scroller.scrollLeft) scroller.scrollLeft = x;
      else if (x > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x - scroller.clientWidth;
    }
  }, [project, state.playhead, update]);
  useEffect(() => {
    if (hideViewer || !state.playing || !project) return;
    subtitleAt.current = seekTarget(project, project.cues, latest.current.state.playhead);
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
        discardPreroll();
      }
      if (dragging.current) discardPreroll();
      const elapsed = rational(BigInt(Math.max(0, Math.round((now - started) * 1000))), 1_000_000n);
      let frame = start + direction * floor(mul(elapsed, parseRational(project.edit_rate)));
      const active =
        preroll.current?.outgoing ??
        top?.clips.find((item) => item.enabled && contains(item.timeline_in.t, item.timeline_out.t, target));
      const element = videos.current[activeVideo.current];
      const playback = topPlayback.current;
      if (element) {
        if (element.paused || element.seeking || element.readyState < 2) playback.steady = false;
        else if (element.currentTime > playback.time) playback.steady = true;
        playback.time = element.currentTime;
      }
      const outgoingRate = active ? sourceSpeed(active, active.timeline_in.t) : 0;
      const native =
        active &&
        active.speed !== "map" &&
        direction > 0n &&
        outgoingRate >= 0.0625 &&
        outgoingRate <= 16 &&
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
        // Source-to-frame rounding must not select the previous clip again.
        const first = frameAt(active.timeline_in.t, project.edit_rate);
        if (frame < first) frame = first;
      } else if (native) frame = frameAt(target, project.edit_rate);
      const streamed = !dragging.current ? sampleStream(target) : null;
      if (streamed) frame = frameAt(streamed, project.edit_rate);
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
      if (streamActive.current) {
        pauseOriginal();
      }
      if (looped) discardPreroll();
      let swapped = false;
      let fallback = false;
      if (
        !streamActive.current &&
        !streamed &&
        native &&
        element &&
        config &&
        !viewerOnly &&
        !dragging.current &&
        !looped
      ) {
        const upcoming = top?.clips.find(
          (item) => item.enabled && contains(item.timeline_in.t, item.timeline_out.t, active.timeline_out.t),
        );
        const boundary = parseRational(active.timeline_out.t, true);
        const outgoingEnd = numberOf(sourceAt(active, active.timeline_out.t));
        const remaining = (outgoingEnd - element.currentTime) / outgoingRate;
        const upcomingRate = upcoming ? sourceSpeed(upcoming, active.timeline_out.t) : 0;
        const unsupported =
          upcoming?.speed === "map" || upcomingRate < 0.0625 || upcomingRate > 16
            ? "unsupported-speed"
            : project.media.find((item) => item.id === upcoming?.media_id)?.kind === "image"
              ? "image"
              : upcoming && compare(sub(parseRational(upcoming.timeline_out.t, true), boundary), rational(2n)) < 0
                ? "short-clip"
                : null;
        if (
          upcoming &&
          upcoming.id !== active.id &&
          !unsupported &&
          failedPreroll.current !== active.id &&
          remaining <= 2 &&
          remaining > prerollLead + 0.3 &&
          !preroll.current
        ) {
          const lower = videos.current[1 - activeVideo.current];
          if (lower) {
            lower.pause();
            lower.muted = true;
            lower.dataset.prerollState = "loading";
            let metadataReady = false;
            let positioned = false;
            let starting = false;
            const lead = prerollLead;
            const prepared = {
              clip: upcoming,
              element: lower,
              running: false,
              outgoing: active,
              heldAt: null as number | null,
              prepare: () => {
                if (!positioned && metadataReady) position();
                else if (positioned && !starting) run();
              },
              cancel: () => {
                lower.removeEventListener("loadedmetadata", loaded);
                lower.removeEventListener("seeked", run);
                lower.removeEventListener("playing", playing);
                lower.removeEventListener("waiting", waiting);
              },
            };
            const rate = sourceSpeed(upcoming, active.timeline_out.t);
            const playing = () => {
              if (preroll.current === prepared) {
                prepared.running = true;
                lower.dataset.prerollState = "running";
              }
            };
            const waiting = () => {
              prepared.running = false;
              lower.dataset.prerollState = "loading";
            };
            const run = () => {
              if (preroll.current !== prepared || lower.seeking || starting) return;
              if (!topPlayback.current.steady || element.paused || element.seeking || element.readyState < 2) {
                if ((outgoingEnd - element.currentTime) / outgoingRate <= lead + 0.3) discardPreroll("top-not-steady");
                return;
              }
              if ((outgoingEnd - element.currentTime) / outgoingRate <= lead + 0.3) {
                discardPreroll("seek-too-late");
                return;
              }
              lower.removeEventListener("seeked", run);
              starting = true;
              void lower.play().catch(() => {
                if (preroll.current === prepared) discardPreroll("play-rejected");
              });
            };
            const position = () => {
              if (
                preroll.current !== prepared ||
                positioned ||
                !topPlayback.current.steady ||
                element.paused ||
                element.seeking ||
                element.readyState < 2
              )
                return;
              const left = (outgoingEnd - element.currentTime) / outgoingRate;
              const seconds = numberOf(sourceAt(upcoming, active.timeline_out.t)) + (lead - left) * rate;
              if (left <= lead + 0.3 || seconds < 0) {
                discardPreroll(seconds < 0 ? "no-source-handle" : "metadata-too-late");
                return;
              }
              if (lower.playbackRate !== rate) lower.playbackRate = rate;
              lower.preservesPitch = true;
              positioned = true;
              // A queued seeked from before a scrub must not consume the new seek's listener.
              lower.addEventListener("seeked", run);
              lower.currentTime = seconds;
              if (!lower.seeking) run();
            };
            const loaded = () => {
              metadataReady = true;
              position();
            };
            preroll.current = prepared;
            lower.addEventListener("playing", playing);
            lower.addEventListener("waiting", waiting);
            lower.addEventListener("loadedmetadata", loaded, { once: true });
            const url = mediaUrl(config, "media", upcoming.media_id);
            if (lower.getAttribute("src") !== url) lower.src = url;
            else if (lower.readyState >= 1) loaded();
          }
        }
        preroll.current?.prepare();
        const prepared = preroll.current;
        if (prepared) {
          const incoming = prepared.element;
          const running = prepared.running && !incoming.paused && incoming.readyState >= 2 && !incoming.seeking;
          if (running && incoming.currentTime >= numberOf(sourceAt(prepared.clip, active.timeline_out.t))) {
            if (!element.paused) element.pause();
            const earlyEnd = Math.max(0, (outgoingEnd - element.currentTime) / outgoingRate);
            const held = prepared.heldAt === null ? 0 : (performance.now() - prepared.heldAt) / 1000;
            prerollLead = Math.min(1, Math.max(0.2, prerollLead + held - earlyEnd));
            element.muted = true;
            element.style.zIndex = "0";
            element.setAttribute("data-preroll", "");
            element.dataset.prerollState = "idle";
            incoming.volume = Math.min(1, 10 ** ((prepared.clip.gain_db ?? 0) / 20));
            incoming.muted = false;
            incoming.style.zIndex = "1";
            incoming.removeAttribute("data-preroll");
            incoming.dataset.prerollState = "swapped";
            if (element.dataset.prerollFallback) incoming.dataset.prerollFallback = element.dataset.prerollFallback;
            topPlayback.current = { time: incoming.currentTime, steady: true };
            activeVideo.current = 1 - activeVideo.current;
            setVisibleVideo(activeVideo.current);
            lastClip.current = prepared.clip.id;
            const decoded = rational(BigInt(Math.round(incoming.currentTime * 1_000_000)), 1_000_000n);
            const landed = add(
              boundary,
              div(sub(decoded, sourceAt(prepared.clip, active.timeline_out.t)), parseRational(prepared.clip.speed)),
            );
            next =
              compare(landed, boundary) < 0
                ? active.timeline_out.t
                : frameTime(floor(mul(landed, parseRational(project.edit_rate))), project.edit_rate);
            prepared.cancel();
            preroll.current = null;
            swapped = true;
          } else if (remaining <= 0) {
            if (running) {
              if (prepared.heldAt === null) {
                element.pause();
                prepared.heldAt = performance.now();
              }
              next = active.timeline_out.t;
            } else {
              fallback = prepared.heldAt !== null;
              discardPreroll(
                incoming.seeking
                  ? "seeking"
                  : incoming.readyState < 2
                    ? "loading"
                    : incoming.paused
                      ? "paused"
                      : "not-running",
              );
            }
          }
        } else if (
          upcoming &&
          upcoming.id !== active.id &&
          remaining <= 2 &&
          failedPreroll.current !== active.id &&
          (unsupported || remaining <= prerollLead + 0.3)
        ) {
          discardPreroll(unsupported ?? (playback.steady ? "insufficient-time" : "top-not-steady"));
        }
      }
      subtitleAt.current = next;
      if (playhead.current) playhead.current.style.left = `calc(var(--track-label-w) + ${pixelAt(next, scale)}px)`;
      if (clock.current) clock.current.textContent = timecode(next, project);
      const from = frameAt(target, project.edit_rate),
        to = frameAt(next, project.edit_rate);
      const boundary = boundaries.some((frame) => (frame > from && frame <= to) || (frame <= from && frame > to));
      if ((next !== target || fallback) && (now - published >= 100 || boundary || looped || swapped || fallback)) {
        playbackAt.current = looped ? null : next;
        previous = next;
        published = now;
        update({ ...current.state, playhead: { at: next } });
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animation);
      discardPreroll();
    };
  }, [
    state.playing,
    project,
    direction,
    update,
    hideViewer,
    scale,
    top,
    boundaries,
    config,
    viewerOnly,
    dragging,
    discardPreroll,
    sampleStream,
    streamActive,
    pauseOriginal,
  ]);
  useEffect(() => {
    if (streamVisible || streamPreparing) {
      pauseOriginal();
      return;
    }
    if (at !== playbackAt.current) discardPreroll();
    // Publishing the held boundary must not load or restart the next clip on the paused top.
    if (state.playing && preroll.current?.heldAt != null) return;
    const element = videos.current[visibleVideo];
    if (!element || hideViewer) return;
    if (src && element.getAttribute("src") !== src) {
      lastClip.current = undefined;
      element.src = src;
    } else if (!src) element.removeAttribute("src");
    if (!clip) {
      if (element.readyState >= 1) element.pause();
      return;
    }
    const sync = () => {
      if (streamActive.current) return;
      const seconds = numberOf(source);
      if (
        lastClip.current !== clip.id ||
        ((at !== playbackAt.current || clip.speed === "map" || direction < 0n) &&
          Math.abs(element.currentTime - seconds) > 0.001)
      ) {
        element.currentTime = seconds;
        topPlayback.current = { time: seconds, steady: false };
      }
      lastClip.current = clip.id;
      element.volume = Math.min(1, 10 ** ((clip.gain_db ?? 0) / 20));
      const rate = speed * Number(direction);
      const playable = rate >= 0.0625 && rate <= 16;
      if (playable) {
        if (element.playbackRate !== rate) element.playbackRate = rate;
        element.preservesPitch = true;
      }
      if (state.playing && playable) {
        if (element.paused) {
          topPlayback.current = { time: element.currentTime, steady: false };
          void element.play().catch(() => setWriteError("预览无法播放，请检查素材格式"));
        }
      } else element.pause();
    };
    if (element.readyState >= 1) sync();
    element.addEventListener("loadedmetadata", sync);
    return () => element.removeEventListener("loadedmetadata", sync);
  }, [
    clip,
    source,
    speed,
    state.playing,
    direction,
    hideViewer,
    at,
    src,
    visibleVideo,
    discardPreroll,
    streamVisible,
    streamPreparing,
    streamActive,
    pauseOriginal,
  ]);
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
      return true;
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : "操作失败，请重试");
      setWriteErrorDetail(error instanceof Error ? String(error.cause ?? error.message) : undefined);
    } finally {
      setBusy(false);
    }
  };
  const updateRollSelection = (point: { track_id: string; at: string }, to: string) => {
    const current = latest.current.state;
    if (
      current.project === state.project &&
      current.edit_point?.track_id === point.track_id &&
      current.edit_point.at === point.at
    )
      update({ ...current, edit_point: { track_id: point.track_id, at: to } });
  };
  const editAction = (action: string) => {
    if (!project) return;
    const edit = timelineEdit(action, project, state, at, magnetic);
    if (edit?.ops.length)
      void write("edit", edit.label, edit.ops).then((ok) => {
        const op = edit.ops[0];
        if (ok && op && op.op === "roll" && "to" in op && typeof op.to === "string" && state.edit_point)
          updateRollSelection(state.edit_point, op.to);
      });
    return edit !== null;
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
    const modifiers = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.key === "Alt")
        setBladeHover((hover) => hover && { ...hover, shift: event.shiftKey, alt: event.altKey });
    };
    const keydown = (event: KeyboardEvent) => {
      modifiers(event);
      if (event.defaultPrevented || event.isComposing || state.export?.open) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable=true],[role="dialog"]')
      )
        return;
      const action = Object.entries(keymap).find(([, key]) => key === keyboardKey(event))?.[0];
      if (!action) return;
      // The source viewer owns transport while the timeline remains mounted below it.
      if (
        hideViewer &&
        state.preview === "media" &&
        ![
          "open_settings",
          "toggle_history",
          "toggle_snap",
          "toggle_magnetic",
          "track_taller",
          "track_shorter",
        ].includes(action)
      )
        return;
      if (
        viewerOnly &&
        !["play_pause", "shuttle_back", "shuttle_stop", "shuttle_fwd", "step_back", "step_fwd"].includes(action)
      )
        return;
      event.preventDefault();
      if (action === "open_settings") {
        onOpenSettings?.();
        return;
      }
      if (action === "toggle_history") {
        update({
          ...state,
          history: {
            revision: null,
            label: null,
            ...state.history,
            open: !state.history?.open,
            viewing: state.history?.revision ?? null,
          },
        });
        return;
      }
      if (action === "toggle_snap") {
        void setUi({ snap: !snap });
        return;
      }
      if (action === "toggle_magnetic") {
        void setUi({ magnetic: !magnetic });
        return;
      }
      if (action === "track_taller" || action === "track_shorter") {
        const heights = ["s", "m", "l"] as const;
        void setUi({
          track_height:
            heights[Math.max(0, Math.min(2, heights.indexOf(trackHeight) + (action === "track_taller" ? 1 : -1)))] ??
            "m",
        });
        return;
      }
      if (action === "zoom_in" || action === "zoom_out" || action === "zoom_fit") {
        if (state.panel === "media" || !project) return;
        const pixels = Math.max(12, (gestures.scroller.current?.clientWidth ?? 800) - 80);
        const seconds = parseRational(project.duration.t, true);
        const fit = seconds.numerator > 0n ? Number((BigInt(pixels) * seconds.denominator) / seconds.numerator) : 48;
        gestures.zoom(action === "zoom_fit" ? fit : scale + (action === "zoom_out" ? -12 : 12));
        return;
      }
      if (!project || dragging.current) return;
      if (action.startsWith("tool_")) {
        if (event.repeat) return;
        temporaryTool.current = {
          key: event.code || event.key.toLowerCase(),
          previous: temporaryTool.current?.previous ?? tool,
          started: performance.now(),
          used: false,
        };
        setBladeHover(null);
        setTool(action.slice(5));
        return;
      }
      if (action === "undo" || action === "redo") {
        void write(action, action === "undo" ? "撤销" : "重做");
        return;
      }
      if (action === "add_marker") {
        marker();
        return;
      }
      if (editAction(action)) return;
      if (action === "prev_edit" || action === "next_edit") {
        jumpCut(action === "prev_edit" ? -1 : 1);
        return;
      }
      if (action === "next_review") {
        const next = project.markers
          .filter(
            (marker) =>
              marker.kind === "review" && compare(parseRational(marker.at.t, true), parseRational(at, true)) > 0,
          )
          .sort((a, b) => compare(parseRational(a.at.t, true), parseRational(b.at.t, true)))[0];
        if (next) seek(next.at.t);
        return;
      }
      if (action === "mark_in" || action === "mark_out") {
        const head = parseRational(at, true);
        const start = action === "mark_in" ? head : parseRational(state.range?.start ?? "0s", true);
        const end =
          action === "mark_out"
            ? head
            : state.range
              ? add(parseRational(state.range.start, true), parseRational(state.range.duration, true))
              : parseRational(project.duration.t, true);
        if (compare(end, start) > 0)
          update({
            ...state,
            range: { start: printRational(start, true), duration: printRational(sub(end, start), true) },
          });
        return;
      }
      if (action === "shuttle_stop") update({ ...state, playing: false });
      if (["play_pause", "shuttle_back", "shuttle_fwd"].includes(action)) {
        setDirection(
          action === "shuttle_back"
            ? direction < 0n
              ? direction <= -8n
                ? -16n
                : direction * 2n
              : -1n
            : action === "shuttle_fwd"
              ? direction > 0n && state.playing
                ? direction >= 8n
                  ? 16n
                  : direction * 2n
                : 1n
              : 1n,
        );
        update({ ...state, playing: action === "play_pause" ? !state.playing : true });
      }
      if (action === "step_back" || action === "step_fwd")
        update({
          ...state,
          playing: false,
          playhead: {
            at: seekTarget(project, project.cues, {
              at: frameTime(frameAt(at, project.edit_rate) + (action === "step_back" ? -1n : 1n), project.edit_rate),
            }),
          },
        });
    };
    const keyup = (event: KeyboardEvent) => {
      modifiers(event);
      const held = temporaryTool.current;
      if (!held || held.key !== (event.code || event.key.toLowerCase())) return;
      temporaryTool.current = null;
      if (held.used || performance.now() - held.started >= 300) {
        setTool(held.previous);
        setBladeHover(null);
      }
    };
    const blur = () => {
      if (temporaryTool.current) setTool(temporaryTool.current.previous);
      temporaryTool.current = null;
      setBladeHover(null);
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  });
  const bladePoint = (x: number) => {
    const scroller = gestures.scroller.current;
    const ruler = scroller?.querySelector<HTMLElement>(".zc-ruler");
    if (!project || !scroller || !ruler) return null;
    const left = scroller.getBoundingClientRect().left;
    const label = ruler.getBoundingClientRect().left - left + scroller.scrollLeft;
    const cut = pointerFrameTime(x - left + scroller.scrollLeft - label, scale, project.edit_rate);
    return snapEdges(project, [], ["0s"], rational(0n), parseRational(cut, true), scale, snap, at);
  };
  const bladeTarget = tool === "blade" && bladeHover && !dragging.current ? bladePoint(bladeHover.x) : null;
  const bladeClip = project?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === bladeHover?.id);
  const bladeTracks =
    project?.tracks.filter(
      (track) =>
        track.kind !== "subtitle" &&
        (bladeHover?.shift ||
          track.clips.some(
            (clip) =>
              clip.id === bladeClip?.id ||
              (!bladeHover?.alt && bladeClip?.occurrence_id && clip.occurrence_id === bladeClip.occurrence_id),
          )),
    ) ?? [];
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
  const cueEndpoints = useMemo(() => {
    const endpoints = new Map<string, { in: string | undefined; out: string | undefined }>();
    for (const transcript of project?.transcripts ?? []) {
      const indexes = new Map(transcript.tokens.map((token, index) => [token.id, index]));
      for (const cue of transcript.cues) {
        const first = indexes.get(cue.first_token),
          last = indexes.get(cue.last_token);
        if (first === undefined || last === undefined) continue;
        const visible = transcript.tokens.slice(first, last + 1).filter((token) => token.text);
        endpoints.set(cue.id, { in: visible[0]?.id, out: visible.at(-1)?.id });
      }
    }
    return endpoints;
  }, [project?.transcripts]);
  const snapPreview = cuePreview?.target ?? trimPreview ?? movePreview?.target;
  const organizing = new Set([
    ...(project?.unprocessedTranscripts ?? []),
    ...(project?.subtitlePass?.progress
      ?.filter((item) => item.phase !== "proofread" && project.subtitlePass?.phase !== "proofread")
      .map((item) => item.transcript_id) ?? []),
    ...(project?.subtitlePass?.warnings
      .filter((item) => item.code === "W_SUB_PASS_FALLBACK")
      .map((item) => item.transcript_id)
      .filter((id): id is string => Boolean(id)) ?? []),
  ]);
  const visibleCues =
    project?.cues.filter((cue) => contains(cue.start, cue.end, at) && !organizing.has(cue.transcript_id ?? "")) ?? [];
  const captionKey = visibleCues.map((cue) => `${cue.cue_id}:${cue.piece}:${cue.text}:${cue.style_id}`).join("\0");
  // Keep the canvas unchanged between caption boundaries.
  // biome-ignore lint/correctness/useExhaustiveDependencies: captionKey includes every rendered cue field.
  const captions = useMemo(() => visibleCues, [project, captionKey]);
  const previewTracks = project?.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) =>
      movePreview
        ? moveClipPreview(clip, movePreview.ids, movePreview.target.delta, movePreview.target.insert)
        : [clip],
    ),
  }));
  const revisionControls = (
    <>
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
    </>
  );
  function jumpCut(direction: -1 | 1) {
    if (!project) return;
    const cuts = [
      "0s",
      project.duration.t,
      ...project.tracks.flatMap((track) => track.clips.flatMap((clip) => [clip.timeline_in.t, clip.timeline_out.t])),
    ].sort((a, b) => compare(parseRational(a, true), parseRational(b, true)));
    const candidates = cuts.filter((cut) => compare(parseRational(cut, true), parseRational(at, true)) === direction);
    seek((direction === -1 ? candidates.at(-1) : candidates[0]) ?? at);
  }
  const viewer = (
    <section aria-label="预览" className="zc-viewer zc-panel">
      {(error || writeError) && (
        <p role="alert" title={error ? errorDetail : writeErrorDetail}>
          {error || writeError}
        </p>
      )}
      <div className="zc-preview-head">
        <span className="zc-chip is-sm">
          <Icon name="media" size={12} />
          {viewerOnly ? "素材" : "时间线"}
        </span>
        <span className="zc-meta">
          {project?.format?.width ?? 1920}×{project?.format?.height ?? 1080} · {project?.edit_rate ?? "25"} fps
        </span>
        <span className="zc-grow" />
        <span className="zc-meta">适合窗口</span>
      </div>
      <div
        className="zc-picture"
        onPointerDownCapture={(event) => {
          if (event.button !== 0) return;
          preventPointerSelection(event);
          window.getSelection()?.removeAllRanges();
        }}
        style={{ aspectRatio: `${project?.format?.width ?? 1920} / ${project?.format?.height ?? 1080}` }}
      >
        {src && media?.kind === "image" ? (
          <img src={src} alt={media.name ?? "预览"} />
        ) : (
          [0, 1].map((index) => (
            <video
              key={index}
              ref={(element) => {
                videos.current[index] = element;
              }}
              data-preview-mode="preroll"
              playsInline
              preload="auto"
              muted={index !== visibleVideo || streamVisible || streamPreparing}
              data-preroll={streamVisible || index !== visibleVideo ? "" : undefined}
              data-preroll-lead={index === visibleVideo ? prerollLead : undefined}
              data-preroll-state="idle"
              onWaiting={(event) => resetTopPlayback(event.currentTarget)}
              onSeeked={(event) => resetTopPlayback(event.currentTarget)}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: index === visibleVideo ? 1 : 0,
                visibility: streamVisible ? "hidden" : undefined,
              }}
              aria-hidden={streamVisible || index !== visibleVideo}
              aria-label={
                !streamVisible && index === visibleVideo ? (viewerOnly ? "素材预览" : "时间线预览") : undefined
              }
              onError={() => setWriteError("预览无法读取，请检查素材或代理")}
            />
          ))
        )}
        {/* biome-ignore lint/a11y/useMediaCaption: SubtitleCanvas renders the editable timeline captions. */}
        <video
          ref={streamVideo}
          data-preview-mode="mse"
          data-preroll={!streamVisible ? "" : undefined}
          playsInline
          preload="auto"
          aria-label={streamVisible ? "时间线预览" : undefined}
          aria-hidden={!streamVisible}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: streamVisible ? 1 : 0,
            opacity: streamVisible ? 1 : 0,
          }}
        />
        {clip?.speed === "map" && (
          <span
            className="zc-approx"
            title="近似：平滑变速按线性映射；倒放与静帧逐帧定位，倒放声音按采样近似；无转场混合或画面变换"
          >
            近似
          </span>
        )}
        <SubtitleCanvas
          cues={captions}
          at={at}
          playback={subtitleAt}
          playing={state.playing}
          styles={project?.styles ?? []}
          preview={subtitlePreview ?? (subtitleDraft ? { fields: subtitleDraft } : undefined)}
          format={project?.format}
          selected={state.selected}
          dragging={dragging}
          select={
            viewerOnly
              ? undefined
              : (cue) =>
                  update({
                    ...latest.current.state,
                    selected: [cue.cue_id],
                    subtitle_selection: { cue_ids: [cue.cue_id], editing: null },
                  })
          }
          edit={(cue) => {
            if (readOnly) return;
            update({
              ...latest.current.state,
              panel: "subtitles",
              sub: "subtitles",
              selected: [cue.cue_id],
              subtitle_selection: { cue_ids: [cue.cue_id], editing: cue.cue_id },
              subtitleBrowser: {
                ...latest.current.state.subtitleBrowser,
                search: "",
                find: latest.current.state.subtitleBrowser?.find ?? "",
                replace: latest.current.state.subtitleBrowser?.replace ?? "",
                matchCase: latest.current.state.subtitleBrowser?.matchCase ?? false,
              },
              history: { open: false, revision: null, label: null },
            });
            onEditSubtitle?.(cue);
          }}
          change={
            readOnly || viewerOnly
              ? undefined
              : (onSubtitleStyle ??
                ((cue, patch, commit) => {
                  setSubtitleDraft(patch);
                  if (commit && project)
                    void write("edit", "调整字幕样式", subtitleStyleOps(project, [cue.cue_id], patch, false));
                }))
          }
        />
      </div>
      <div className="zc-player">
        <IconButton icon="inOut" label="设入点 I" />
        <output ref={clock} aria-label="播放时码">
          {project ? timecode(at, project) : "00:00:00:00"}
        </output>
        <span className="zc-meta">/ {project ? timecode(project.duration.t, project) : "00:00:00:00"}</span>
        <span className="zc-grow" />
        <IconButton icon="back" label="上一个剪点" onClick={() => jumpCut(-1)} disabled={!project} />
        <button
          type="button"
          className="zc-icon-btn zc-play-button"
          aria-label={state.playing ? "暂停" : "播放"}
          onClick={() => update({ ...state, playing: !state.playing })}
        >
          <Icon name={state.playing ? "pause" : "play"} />
        </button>
        <IconButton icon="fwd" label="下一个剪点" onClick={() => jumpCut(1)} disabled={!project} />
        <span className="zc-grow" />
        <IconButton
          icon="volume"
          label="音量"
          onClick={() => {
            const video = videos.current[visibleVideo];
            if (video) video.muted = !video.muted;
          }}
        />
        <IconButton
          icon="fit"
          label="全屏"
          onClick={(event) => {
            void event.currentTarget.closest(".zc-viewer")?.requestFullscreen?.();
          }}
        />
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
  );
  return (
    <>
      {cueMenu && (
        <div
          ref={cueMenuRef}
          role="menu"
          aria-label="字幕片段"
          className="zc-cue-menu"
          style={{ left: cueMenu.x, top: cueMenu.y }}
        >
          <IconButton
            icon="refresh"
            label="恢复自动时间"
            role="menuitem"
            disabled={
              busy ||
              readOnly ||
              !project?.transcripts?.some((item) => item.cues.some((cue) => cue.id === cueMenu.cue.cue_id))
            }
            onClick={() => {
              setCueMenu(null);
              cueMenu.element.focus();
              void write("edit", "恢复自动时间", [{ op: "set_cue", cue_id: cueMenu.cue.cue_id, timing: null }]);
            }}
          />
        </div>
      )}
      {!hideViewer && (viewerTarget ? createPortal(viewer, viewerTarget) : viewer)}
      {!viewerOnly && !hideTimeline && (
        <section className="zc-timeline-card zc-panel" aria-label="时间线卡片">
          <section aria-label="工具栏" className="zc-toolbar">
            <IconButton
              icon="select"
              label={`选择 ${keymap.tool_select ?? ""}`}
              pressed={tool === "select"}
              onClick={() => {
                setBladeHover(null);
                setTool("select");
              }}
            />
            <IconButton
              icon="blade"
              label={`切割 ${keymap.tool_blade ?? ""}`}
              pressed={tool === "blade"}
              disabled={!project || busy || readOnly}
              onClick={() => {
                setBladeHover(null);
                setTool("blade");
              }}
            />
            <IconButton
              icon="marker"
              label={`加标记 ${keymap.add_marker ?? ""}`}
              disabled={!project || busy || readOnly}
              onClick={marker}
            />
            {revisionControlsTarget ? createPortal(revisionControls, revisionControlsTarget) : revisionControls}
            <IconButton
              icon="snap"
              label="吸附"
              title={`吸附 ${keymap.toggle_snap ?? ""}`.trim()}
              pressed={snap}
              onClick={() => void setUi({ snap: !snap })}
            />
            <IconButton
              icon="magnet"
              label="磁性"
              title={`磁性 ${keymap.toggle_magnetic ?? ""}`.trim()}
              pressed={magnetic}
              onClick={() => void setUi({ magnetic: !magnetic })}
            />
            <IconButton
              icon="roll"
              label={`滚动编辑 ${keymap.tool_roll ?? ""}`}
              pressed={tool === "roll"}
              onClick={() => {
                setBladeHover(null);
                setTool("roll");
              }}
            />
            <span className="zc-grow" />
            <span className="zc-count" title="片段">
              <Icon name="clip" />
              {project?.tracks.reduce((count, track) => count + track.clips.length, 0) ?? 0}
            </span>
            <span className="zc-count" title="字幕">
              <Icon name="subtitle" />
              {project?.cues.length ?? 0}
            </span>
            <IconButton icon="search" label="缩放" onClick={() => gestures.zoom(48)} />
            <input
              aria-label="时间线缩放"
              type="range"
              min={12}
              max={192}
              step={1}
              value={scale}
              onChange={(event) => gestures.zoom(Number(event.target.value))}
            />
          </section>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Timeline keyboard actions are handled by the window listener. */}
          <section
            aria-label="时间线"
            className={`zc-timeline zc-track-height-${trackHeight}${tool === "blade" ? " is-blade" : ""}`}
            ref={gestures.scroller}
            {...gestures.handlers}
            onPointerDown={(event) => {
              if (tool !== "blade" || (event.target as Element).closest(".zc-clip-video,.zc-clip-audio"))
                gestures.handlers.onPointerDown(event);
            }}
            onClick={(event) => {
              if (tool !== "blade") gestures.handlers.onClick(event);
            }}
            onPointerMove={(event) => {
              gestures.handlers.onPointerMove(event);
              setMetaKey(event.metaKey);
              const clip = (event.target as Element).closest<HTMLElement>(".zc-clip-video,.zc-clip-audio");
              setBladeHover(
                tool === "blade" && clip && !dragging.current
                  ? { id: clip.dataset.selectionId ?? "", x: event.clientX, shift: event.shiftKey, alt: event.altKey }
                  : null,
              );
            }}
            onPointerLeave={() => setBladeHover(null)}
            onPointerDownCapture={(event) => {
              if (temporaryTool.current) temporaryTool.current.used = true;
              setBladeHover(null);
              if (
                event.button === 0 &&
                !(event.target as Element).closest(
                  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.zc-selectable,p[role="alert"]',
                )
              ) {
                preventPointerSelection(event);
                window.getSelection()?.removeAllRanges();
              }
              if (tool !== "blade" && state.preview === "media")
                update({ ...state, preview: "timeline", playing: false });
            }}
          >
            {hideViewer && (error || writeError) && (
              <p role="alert" title={error ? errorDetail : writeErrorDetail}>
                {error || writeError}
              </p>
            )}
            {dragFeedback &&
              createPortal(
                <>
                  <style>{`body * { cursor: ${dragFeedback.cursor} !important; }`}</style>
                  <output
                    className="zc-drag-feedback"
                    aria-label="拖动反馈"
                    style={{ left: dragFeedback.x, top: dragFeedback.y }}
                  >
                    <span>{dragFeedback.delta}</span>
                    <span>时长 {dragFeedback.durations.join(" / ")}</span>
                  </output>
                </>,
                document.body,
              )}
            {project && (
              <div className="zc-timeline-content" style={{ width: `calc(var(--track-label-w) + ${width}px)` }}>
                {movePreview?.target.insert && (
                  <div
                    role="img"
                    className="zc-insert-line"
                    aria-label="插入位置"
                    style={{ left: `calc(var(--track-label-w) + ${pixelAt(movePreview.target.to, scale)}px)` }}
                  />
                )}
                {snap && snapPreview?.line != null && (
                  <div
                    className="zc-snap-line"
                    style={{ left: `calc(var(--track-label-w) + ${pixelAt(snapPreview.line, scale)}px)` }}
                  />
                )}
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
                      const ruler = event.currentTarget;
                      if (gestures.start(event, { move: (event) => point(event.clientX, ruler) }))
                        point(event.clientX, ruler);
                    }}
                  >
                    {project.markers
                      .filter((marker) => marker.kind === "chapter")
                      .sort((a, b) => compare(parseRational(a.at.t, true), parseRational(b.at.t, true)))
                      .map((marker, index, chapters) => (
                        <span
                          key={marker.id}
                          className={`zc-chapter-bar${index % 2 ? " is-alternate" : ""}`}
                          title={`章节：${marker.text}`}
                          style={{
                            left: pixelAt(marker.at.t, scale),
                            width: Math.max(
                              0,
                              pixelAt(chapters[index + 1]?.at.t ?? project.duration.t, scale) -
                                pixelAt(marker.at.t, scale),
                            ),
                          }}
                        >
                          <button
                            type="button"
                            className="zc-chapter-edge"
                            aria-label={`移动章节「${marker.text}」起点`}
                            title={`章节：${marker.text}`}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              if (busy || readOnly) return;
                              const element = event.currentTarget.parentElement;
                              const ruler = element?.parentElement;
                              if (!element || !ruler) return;
                              const left = element.style.left;
                              const width = element.style.width;
                              const reset = () => {
                                element.style.left = left;
                                element.style.width = width;
                              };
                              gestures.start(event, {
                                move: (event) => {
                                  const target = seekTarget(project, project.cues, {
                                    at: dropPoint(event.clientX, ruler) ?? marker.at.t,
                                  });
                                  const end = pixelAt(chapters[index + 1]?.at.t ?? project.duration.t, scale);
                                  element.style.left = `${pixelAt(target, scale)}px`;
                                  element.style.width = `${Math.max(0, end - pixelAt(target, scale))}px`;
                                },
                                end: (event, moved) => {
                                  reset();
                                  if (!moved) return;
                                  const target = seekTarget(project, project.cues, {
                                    at: dropPoint(event.clientX, ruler) ?? marker.at.t,
                                  });
                                  if (target !== marker.at.t)
                                    void write("edit", `移动章节「${marker.text}」`, [
                                      { op: "update_marker", marker_id: marker.id, at: target },
                                    ]);
                                },
                                cancel: reset,
                              });
                            }}
                            onClick={() => seek(marker.at.t)}
                          />
                        </span>
                      ))}
                    {!readOnly &&
                      !viewerOnly &&
                      project.tracks.flatMap((track) =>
                        track.kind !== "video" || !track.enabled
                          ? []
                          : track.clips.flatMap((clip) => {
                              if (
                                !clip.enabled ||
                                project.media.find((media) => media.id === clip.media_id)?.kind !== "video"
                              )
                                return [];
                              const segment = cacheStatus?.segments?.find((segment) => segment.clip_id === clip.id);
                              if (!segment || segment.state === "ready") return [];
                              const message =
                                cacheStatus?.paused === "battery"
                                  ? "用电池时暂停了预览准备，可在设置里关掉"
                                  : "这段还没准备好，播放到这里可能卡顿";
                              return (
                                <button
                                  key={clip.id}
                                  type="button"
                                  className={`zc-render-bar${segment.state === "building" ? " is-building" : ""}`}
                                  title={message}
                                  aria-label={`${message}，打开预览与缓存设置`}
                                  style={{
                                    left: pixelAt(clip.timeline_in.t, scale),
                                    width: Math.max(
                                      0,
                                      pixelAt(clip.timeline_out.t, scale) - pixelAt(clip.timeline_in.t, scale),
                                    ),
                                  }}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={() => onOpenSettings?.("预览与缓存")}
                                />
                              );
                            }),
                      )}
                    {rulerTicks(width, scale, project.edit_rate).map((tick) => (
                      <span
                        key={tick.at}
                        className={`zc-tick${tick.major ? " is-major" : ""}`}
                        style={{ left: tick.left }}
                      >
                        {tick.major ? tick.label : null}
                      </span>
                    ))}
                    {project.markers
                      .filter((marker) => marker.kind !== "chapter")
                      .map((marker) => (
                        <button
                          type="button"
                          key={marker.id}
                          className="zc-marker"
                          title={marker.text}
                          aria-label={marker.text}
                          style={{ left: pixelAt(marker.at.t, scale) }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => seek(marker.at.t)}
                        />
                      ))}
                  </div>
                </div>
                {previewTracks?.map((track) => (
                  <div key={track.id} className={`zc-track zc-track-${track.kind}`}>
                    <span className="zc-track-name zc-track-head" role="img" title={track.name} aria-label={track.name}>
                      <Icon name={track.kind === "video" ? "eye" : track.kind === "audio" ? "volume" : "subtitles"} />
                    </span>
                    {/* biome-ignore lint/a11y/useSemanticElements: A timeline drop lane is not a form fieldset. */}
                    <div
                      role="group"
                      aria-label={`${track.name} 放置区域`}
                      className="zc-track-lane"
                      data-track-id={track.id}
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
                      {bladeTarget && bladeTracks.some((item) => item.id === track.id) && (
                        <span
                          aria-hidden="true"
                          className={`zc-blade-line${bladeTarget.line !== null ? " is-snapped" : ""}`}
                          style={{ left: pixelAt(bladeTarget.to, scale) }}
                        >
                          {bladeTracks[0]?.id === track.id && <output>{timecode(bladeTarget.to, project)}</output>}
                        </span>
                      )}
                      {drop?.track === track.id && (
                        <span className="zc-drop-preview" style={{ left: pixelAt(drop.at, scale) }} />
                      )}
                      {points
                        .filter((point) => point.track_id === track.id)
                        .map((point) => (
                          <button
                            type="button"
                            key={`seam:${point.at}`}
                            aria-label={`剪点 ${track.name} ${timecode(point.at, project)}`}
                            aria-pressed={
                              state.edit_point?.track_id === point.track_id && state.edit_point.at === point.at
                            }
                            className={`zc-seam${trimPreview?.blocked && trimPreview.following && trimPreview.clips.some((clip) => clip.id === point.clip_id) ? " is-blocked" : ""}${state.edit_point?.track_id === point.track_id && state.edit_point.at === point.at ? " is-selected" : ""}`}
                            data-edit-cursor={tool === "roll" ? "roll" : undefined}
                            style={{
                              left: pixelAt(
                                trimPreview?.following && trimPreview.clips.some((clip) => clip.id === point.clip_id)
                                  ? trimPreview.to
                                  : point.at,
                                scale,
                              ),
                              cursor: tool === "roll" ? editCursor("roll") : "default",
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (tool === "blade") return;
                              update({
                                ...latest.current.state,
                                selected: [],
                                preview: "timeline",
                                playing: false,
                                edit_point: { track_id: point.track_id, at: point.at },
                              });
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              if (tool === "blade") return;
                              update({
                                ...latest.current.state,
                                selected: [],
                                preview: "timeline",
                                playing: false,
                                edit_point: { track_id: point.track_id, at: point.at },
                              });
                              if (readOnly || busy || tool !== "roll") return;
                              const left = track.clips.find((clip) => clip.id === point.clip_id);
                              if (left) gestures.start(event, rollDrag(event, left, point));
                            }}
                          />
                        ))}
                      {track.clips.map((original) => {
                        const following = trimPreview?.following?.some((clip) => clip.id === original.id);
                        const trimming = following || trimPreview?.clips.some((clip) => clip.id === original.id);
                        const previewEdge = following ? "in" : trimPreview?.edge;
                        const item =
                          trimming && trimPreview
                            ? {
                                ...original,
                                ...(previewEdge === "in"
                                  ? {
                                      timeline_in: { t: trimPreview.to },
                                      source_in: {
                                        t:
                                          project.media.find((media) => media.id === original.media_id)?.kind ===
                                          "image"
                                            ? "0s"
                                            : printRational(
                                                add(
                                                  parseRational(original.source_in.t, true),
                                                  sub(
                                                    parseRational(trimPreview.to, true),
                                                    parseRational(original.timeline_in.t, true),
                                                  ),
                                                ),
                                                true,
                                              ),
                                      },
                                    }
                                  : { timeline_out: { t: trimPreview.to } }),
                              }
                            : original;
                        const clipWidth = Math.max(
                          1,
                          pixelAt(item.timeline_out.t, scale) - pixelAt(item.timeline_in.t, scale),
                        );
                        return (
                          <Clip
                            key={item.id}
                            selectionId={item.id}
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
                            style={{
                              cursor: tool === "roll" ? "default" : undefined,
                              left: pixelAt(item.timeline_in.t, scale),
                              width: clipWidth,
                              ...(trimming
                                ? {
                                    opacity: 0.5,
                                    outline: trimPreview?.blocked ? "2px solid var(--attention)" : undefined,
                                    zIndex: 4,
                                  }
                                : {}),
                              ...(movePreview?.ids.includes(item.id)
                                ? {
                                    opacity: 0.5,
                                    outline: movePreview.blocked ? "2px solid var(--attention)" : undefined,
                                    cursor: movePreview.blocked ? "not-allowed" : undefined,
                                    zIndex: 4,
                                    transform:
                                      item.id === movePreview.anchor ? `translateY(${movePreview.y}px)` : undefined,
                                  }
                                : {}),
                            }}
                            onClick={(event) => {
                              if (tool !== "blade") {
                                gestures.select([item.id], event);
                                return;
                              }
                              if (busy || readOnly || track.kind === "subtitle") return;
                              const target = bladePoint(event.clientX);
                              if (
                                !target ||
                                !contains(item.timeline_in.t, item.timeline_out.t, target.to) ||
                                compare(parseRational(target.to, true), parseRational(item.timeline_in.t, true)) <= 0
                              )
                                return;
                              void write(
                                "edit",
                                event.shiftKey ? "所有轨道在落点切开" : "切开片段",
                                event.shiftKey
                                  ? splitAllAt(project, target.to)
                                  : [
                                      {
                                        op: "split",
                                        clip_id: item.id,
                                        at: target.to,
                                        ...(event.altKey ? { linked: false } : {}),
                                      },
                                    ],
                              );
                            }}
                          >
                            {track.kind !== "subtitle" &&
                              (tool === "select" || tool === "roll") &&
                              !readOnly &&
                              !busy &&
                              !original.time_map &&
                              original.speed !== "map" &&
                              (["in", "out"] as const).map((edge) => {
                                const connected = points.some(
                                  (point) =>
                                    point.track_id === track.id &&
                                    point.at === (edge === "in" ? original.timeline_in.t : original.timeline_out.t),
                                );
                                const mode =
                                  tool === "roll" && connected ? "roll" : dragMagnetic(metaKey) ? "ripple" : "trim";
                                return (
                                  <span
                                    key={edge}
                                    aria-hidden="true"
                                    data-trim-edge={edge}
                                    data-edit-cursor={mode}
                                    style={{ cursor: editCursor(mode, edge) }}
                                    className={`zc-trim-handle zc-trim-${edge}${trimming && previewEdge === edge && trimPreview?.blocked ? " is-blocked" : ""}`}
                                    title={
                                      mode === "roll"
                                        ? "拖动滚动剪点"
                                        : edge === "in"
                                          ? "拖动修剪入点；Option/Alt 只修剪单轨"
                                          : "拖动修剪出点；Option/Alt 只修剪单轨"
                                    }
                                  />
                                );
                              })}
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
                          .map((cue) => {
                            const trimming = cuePreview?.cue === cue;
                            const endpoints = cueEndpoints.get(cue.cue_id);
                            const shown = cue.tokens?.map((token) => token.id) ?? cue.token_ids;
                            const start = trimming && cuePreview.edge === "in" ? cuePreview.target.to : cue.start;
                            const end = trimming && cuePreview.edge === "out" ? cuePreview.target.to : cue.end;
                            return (
                              <Clip
                                key={cueKey(cue)}
                                cueKey={cueKey(cue)}
                                selectionId={cue.cue_id}
                                kind="subtitle"
                                label={cue.text.replaceAll("\n", " ")}
                                selected={state.selected.includes(cue.cue_id)}
                                dimmed={
                                  !track.enabled || (state.selected.length > 0 && !state.selected.includes(cue.cue_id))
                                }
                                style={{
                                  left: pixelAt(start, scale),
                                  width: Math.max(1, pixelAt(end, scale) - pixelAt(start, scale)),
                                  cursor: "not-allowed",
                                  ...(trimming ? { opacity: 0.5, zIndex: 4 } : {}),
                                }}
                                onClick={(event) => {
                                  if (tool !== "blade") gestures.select([cue.cue_id], event);
                                }}
                                onDoubleClick={() => {
                                  if (readOnly || tool === "blade") return;
                                  update({
                                    ...latest.current.state,
                                    panel: "subtitles",
                                    sub: "subtitles",
                                    preview: "timeline",
                                    playing: false,
                                    selected: [cue.cue_id],
                                    playhead: { at: cue.start },
                                    subtitleBrowser: {
                                      ...state.subtitleBrowser,
                                      search: "",
                                      find: state.subtitleBrowser?.find ?? "",
                                      replace: state.subtitleBrowser?.replace ?? "",
                                      matchCase: state.subtitleBrowser?.matchCase ?? false,
                                    },
                                    history: { open: false, revision: null, label: null },
                                  });
                                  onEditSubtitle?.(cue);
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  if (!readOnly)
                                    setCueMenu({
                                      cue,
                                      x: event.clientX,
                                      y: event.clientY,
                                      element: event.currentTarget,
                                    });
                                }}
                              >
                                {!readOnly &&
                                  !busy &&
                                  tool === "select" &&
                                  (["in", "out"] as const).map(
                                    (edge) =>
                                      endpoints?.[edge] &&
                                      (!shown || (edge === "in" ? shown[0] : shown.at(-1)) === endpoints[edge]) && (
                                        <span
                                          key={edge}
                                          aria-hidden="true"
                                          data-trim-edge={edge}
                                          className={`zc-trim-handle zc-trim-${edge}`}
                                          title={edge === "in" ? "调整字幕开始时间" : "调整字幕结束时间"}
                                        />
                                      ),
                                  )}
                              </Clip>
                            );
                          })}
                    </div>
                  </div>
                ))}
                {gestures.box && <div aria-hidden="true" className="zc-selection-box" style={gestures.box} />}
                <div
                  ref={playhead}
                  className="zc-playhead"
                  style={{ left: `calc(var(--track-label-w) + ${pixelAt(at, scale)}px)` }}
                >
                  <button
                    type="button"
                    aria-label="播放头"
                    onPointerDown={(event) => {
                      const ruler = event.currentTarget
                        .closest(".zc-timeline-content")
                        ?.querySelector<HTMLElement>(".zc-ruler");
                      if (ruler) gestures.start(event, { move: (event) => point(event.clientX, ruler) });
                    }}
                  >
                    ▼
                  </button>
                </div>
              </div>
            )}
          </section>
        </section>
      )}
    </>
  );
}
