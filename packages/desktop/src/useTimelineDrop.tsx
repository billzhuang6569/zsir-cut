import { isTauri } from "@tauri-apps/api/core";
import { type DragEvent, type RefObject, useEffect, useRef, useState } from "react";
import { DESKTOP_AUTHOR, type ProjectView } from "./connection.js";
import { type MediaKind, type Placement, placeMedia, placementKinds, placementRange } from "./media.js";
import type { UiState } from "./state.js";
import { pixelAt, scrollTimelineEdge, timecode } from "./timeline.js";
import { dropMode, dropPosition, dropTime, dropTrack, fileName, MEDIA_DRAG } from "./timelineDrop.js";
import { importAndPlace, listenFileDrop, type TimelineLanding } from "./useFileDrop.js";

type Options = {
  enabled: boolean;
  readOnly: boolean;
  scroller: RefObject<HTMLElement | null>;
  project: ProjectView | null;
  state: UiState;
  placement: Placement;
  scale: number;
  playhead: string;
  snap: boolean;
  magnetic: boolean;
  preset: "fcp" | "premiere";
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
};

type Point = { x: number; y: number; altKey: boolean; metaKey: boolean };
type Drag =
  | { generation: number; source: "files"; firstPath: string | undefined }
  | { generation: number; source: "card"; id: string; grab: number };

type Preview = {
  landing: TimelineLanding;
  top: number;
  duration?: string;
  tracks: string[];
  added: { kind: MediaKind; top: number }[];
  error?: string;
};

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && y >= rect.top && x < rect.right && y < rect.bottom;

function resolveDrop(options: Options, drag: Drag, point: Point, commit = false) {
  const { project, state, scroller, scale, snap, playhead, placement, magnetic, preset } = options;
  const element = scroller.current;
  const ruler = element?.querySelector(".zc-ruler");
  const rulerRow = ruler?.parentElement;
  const content = rulerRow?.parentElement;
  if (!project || !element || !ruler || !rulerRow || !content) return null;
  const viewport = element.getBoundingClientRect();
  const { x, y } = point;
  if (!inside(viewport, x, y)) return null;
  const laneLeft = ruler.getBoundingClientRect().left;
  const label = laneLeft - viewport.left + element.scrollLeft;
  if (x < Math.max(laneLeft, viewport.left + label)) return null;
  const rows = [...element.querySelectorAll<HTMLElement>("[data-track-id].zc-track-lane")].map((lane) => {
    const { top, bottom } = lane.getBoundingClientRect();
    return { id: lane.dataset.trackId ?? "", top, bottom };
  });
  const rulerBottom = rulerRow.getBoundingClientRect().bottom;
  const spot = dropTrack(y, rulerBottom, rows);
  if (!spot) return null;
  const media = drag.source === "card" ? project.media.find((item) => item.id === drag.id) : undefined;
  if (drag.source === "card" && !media) return null;
  const at = dropTime(
    project,
    state,
    { x, left: viewport.left, scroll: element.scrollLeft, label, scale },
    snap,
    playhead,
    media,
    drag.source === "card" ? drag.grab : 0,
  );
  const landing = { target: spot.target, at, mode: dropMode(magnetic, preset, point) };
  const contentTop = content.getBoundingClientRect().top;
  const preview: Preview = { landing, top: spot.top - contentTop, tracks: [], added: [] };
  if (!media) {
    if ("track" in spot.target) {
      preview.tracks = [spot.target.track];
      if (project.tracks.find((track) => track.id === preview.tracks[0])?.kind === "subtitle")
        preview.error = "请选择视频轨或声音轨";
    } else if (drag.source === "files" && drag.firstPath) {
      const path = drag.firstPath;
      const known = project.media.find((item) => item.path === path);
      // shortcut: file extensions only guide the preview, use probed streams once import completes.
      const kind = known
        ? placementKinds(known, placement)[0]
        : /\.(wav|aif|aiff|mp3|m4a|flac|aac|opus)$/i.test(fileName(path)) || placement === "audio"
          ? "audio"
          : "video";
      if (kind) preview.added = [{ kind, top: preview.top }];
    }
    return { preview };
  }
  preview.duration = placementRange(project, media, state).duration;
  const plan = placeMedia(project, media, state, at, {
    target: spot.target,
    placement,
    mode: landing.mode,
    ...(commit ? {} : { trackId: (kind) => `preview-${kind}` }),
  });
  if ("error" in plan) {
    preview.error = plan.error;
    if ("track" in spot.target) preview.tracks = [spot.target.track];
    return { preview };
  }
  preview.duration = plan.op.duration;
  // Added rows are drawn over the insertion point so hovering never changes the hit geometry.
  const bottom = (rows.at(-1)?.bottom ?? rulerBottom) + 6 - contentTop;
  preview.added = plan.added.map(({ kind }, i) => ({
    kind,
    top: i === 0 && "index" in spot.target ? preview.top : bottom + (i > 0 ? 28 : 0),
  }));
  const added = new Set(plan.added.map(({ id }) => id));
  preview.tracks = plan.destinations.filter(({ id }) => !added.has(id)).map(({ id }) => id);
  return { preview, ops: [...plan.added, plan.op], label: `把 ${media.name ?? "素材"} 加到时间线` };
}

export function useTimelineDrop(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const identity =
    options.enabled && !options.readOnly && options.state.project && options.project
      ? `${options.state.project}\0${options.project.id}`
      : null;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const active = useRef<Drag | null>(null);
  const pointer = useRef<Point | null>(null);
  const keys = useRef({ altKey: false, metaKey: false });
  const animation = useRef(0);
  const writing = useRef(false);
  const valid = (drag: Drag | null): drag is Drag => drag !== null && drag.generation === generation.current;
  const stopHover = () => {
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    pointer.current = null;
    setPreview(null);
  };
  const cancel = () => {
    active.current = null;
    stopHover();
  };
  const refresh = () => {
    const drag = active.current;
    if (valid(drag) && pointer.current) setPreview(resolveDrop(latest.current, drag, pointer.current)?.preview ?? null);
  };
  const scroll = () => {
    animation.current = 0;
    const element = latest.current.scroller.current;
    const point = pointer.current;
    if (!element || !point || !valid(active.current)) return;
    if (scrollTimelineEdge(element, point.x, point.y)) {
      refresh();
      animation.current = requestAnimationFrame(scroll);
    }
  };
  const hover = (point: Point) => {
    if (!valid(active.current)) return;
    pointer.current = point;
    refresh();
    if (!animation.current) animation.current = requestAnimationFrame(scroll);
  };
  const drop = async (point: Point, payload: string | string[]) => {
    const drag = active.current;
    cancel();
    const context = latest.current;
    const { project, state, call, placement } = context;
    if (!valid(drag) || writing.current || !project || !state.project || context.readOnly) return;
    const hit = resolveDrop(context, drag, point, true);
    if (!hit || hit.preview.error) return;
    const current = () => drag.generation === generation.current;
    writing.current = true;
    setError(null);
    try {
      if (drag.source === "files" && Array.isArray(payload)) {
        await importAndPlace(payload, project, state, hit.preview.landing, placement, call, current, setError);
      } else if (drag.source === "card" && drag.id === payload && hit.ops) {
        await call("edit", {
          project: state.project,
          timeline_id: project.id,
          base_revision: project.revision.id,
          idempotency_key: crypto.randomUUID(),
          author: DESKTOP_AUTHOR,
          label: hit.label,
          ops: hit.ops,
        });
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "无法放入时间线");
    } finally {
      writing.current = false;
    }
  };

  // Event handlers use latest so the session survives scroll, preference and revision updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Subscribe for a single project and writable view.
  useEffect(() => {
    setError(null);
    if (!identity) return;
    const start = (event: globalThis.DragEvent) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>("[data-media-id].zc-media-card");
      if (!card?.dataset.mediaId || !event.dataTransfer?.types?.includes(MEDIA_DRAG)) return;
      const { left, width } = card.getBoundingClientRect();
      const grab = width ? Math.round(1000 * Math.max(0, Math.min(1, (event.clientX - left) / width))) : 0;
      active.current = { source: "card", id: card.dataset.mediaId, generation: generation.current, grab };
    };
    const modifiers = (event: KeyboardEvent) => {
      if (active.current) {
        if (event.key === "Escape") cancel();
        else event.preventDefault();
      }
      keys.current = { altKey: event.altKey, metaKey: event.metaKey };
      if (pointer.current) {
        pointer.current = { ...pointer.current, ...keys.current };
        refresh();
      }
    };
    const blur = () => {
      keys.current = { altKey: false, metaKey: false };
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", cancel);
    window.addEventListener("keydown", modifiers, true);
    window.addEventListener("keyup", modifiers, true);
    window.addEventListener("blur", blur);
    const stop = listenFileDrop(
      ({ payload }) => {
        if (payload.type === "leave") {
          if (active.current?.source === "files") cancel();
          return;
        }
        const point = { ...dropPosition(payload.position, window.devicePixelRatio), ...keys.current };
        if (payload.type === "enter")
          active.current = { source: "files", generation: generation.current, firstPath: payload.paths[0] };
        if (active.current?.source !== "files") return;
        if (payload.type === "drop") void drop(point, payload.paths);
        else hover(point);
      },
      () => setError("无法接收拖入的文件"),
    );
    return () => {
      generation.current++;
      cancel();
      stop();
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("keydown", modifiers, true);
      window.removeEventListener("keyup", modifiers, true);
      window.removeEventListener("blur", blur);
    };
  }, [identity]);

  const eventPoint = (event: DragEvent<HTMLElement>) => ({
    x: event.clientX,
    y: event.clientY,
    altKey: event.altKey,
    metaKey: event.metaKey,
  });
  return {
    preview: identity ? preview : null,
    error: identity ? error : null,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!identity) return;
        if (active.current?.source === "card" && event.dataTransfer.types.includes(MEDIA_DRAG)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          hover(eventPoint(event));
        } else if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (
          active.current?.source === "card" &&
          !inside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
        )
          stopHover();
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!identity) return;
        if (event.dataTransfer.types.includes(MEDIA_DRAG)) {
          event.preventDefault();
          void drop(eventPoint(event), event.dataTransfer.getData(MEDIA_DRAG));
        } else if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          if (!isTauri()) setError("请在桌面应用中把文件拖到时间线");
        }
      },
    },
  };
}

export function DropGhost({
  preview,
  project,
  scale,
  track,
}: {
  preview: Preview | null;
  project: ProjectView;
  scale: number;
  track?: string;
}) {
  if (!preview || (track && !preview.tracks.includes(track))) return null;
  const { landing, error } = preview;
  const label = `${timecode(landing.at, project)} · ${landing.mode === "insert" ? "插入" : "覆盖"}`;
  const className = `zc-drop-preview${error ? " is-invalid" : ""}`;
  const style = {
    left: pixelAt(landing.at, scale),
    width: preview.duration ? Math.max(2, pixelAt(preview.duration, scale)) : undefined,
  };
  if (track)
    return (
      <div className="zc-drop-lane">
        <span className={className} style={style}>
          <span>{error ?? label}</span>
        </span>
      </div>
    );
  const rows = preview.added.length ? preview.added : preview.tracks.length ? [] : [{ top: preview.top, kind: null }];
  return rows.map(({ top, kind }) => (
    <div key={kind ?? "drop"} className="zc-drop-new-track" style={{ top }}>
      <span className={className} style={style}>
        <span>
          {error ?? (kind ? `新建${kind === "video" ? "视频" : "声音"}轨 · ${label}` : `新建轨道 · ${label}`)}
        </span>
      </span>
    </div>
  ));
}
