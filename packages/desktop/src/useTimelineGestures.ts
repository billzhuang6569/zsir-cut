// Adapted from OpenCut-app/opencut-classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// element-interaction-controller.ts, selection-hit-testing.ts, zoom-controller.ts.
// Copyright 2025-2026 OpenCut.
// Also adapted from Augani/openreel-video (MIT), 367d7e90b61b5181f9861b852bb8b9d7a7d2954a:
// apps/web/src/components/editor/Timeline.tsx (marquee click suppression).
// Copyright (c) 2024-2026 Augustus Otu and Contributors. See THIRD_PARTY_NOTICES.md.
import {
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "./connection.js";
import { pixelAt, seekTarget } from "./timeline.js";

type Position = { x: number; y: number };
type Rectangle = { left: number; top: number; width: number; height: number };
type Modifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };
type Session = {
  pointerId: number;
  element: HTMLElement;
  origin: Position;
  moved: boolean;
  last: { clientX: number; clientY: number };
  move?: (event: { clientX: number; clientY: number }) => void;
  end?: (event: PointerEvent<HTMLElement>, moved: boolean) => void;
  cancel?: () => void;
};
export function selectionIds(previous: string[], hits: string[], keys: Modifiers) {
  const unique = [...new Set(hits)];
  if (keys.metaKey || keys.ctrlKey)
    return [...previous.filter((id) => !unique.includes(id)), ...unique.filter((id) => !previous.includes(id))];
  return keys.shiftKey ? [...new Set([...previous, ...unique])] : unique;
}

export function useTimelineGestures({
  project,
  state,
  update,
  dragging,
  scale,
  setScale,
  clipDrag,
}: {
  project: ProjectView | null;
  state: UiState;
  update: (state: UiState) => void;
  dragging: MutableRefObject<boolean>;
  scale: number;
  setScale: (scale: number) => void;
  clipDrag?: (
    event: PointerEvent<HTMLElement>,
    element: HTMLElement,
  ) => Pick<Session, "move" | "end" | "cancel"> | undefined;
}) {
  const scroller = useRef<HTMLElement>(null);
  const session = useRef<Session | null>(null);
  const suppressClick = useRef(false);
  const pointer = useRef<Position | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const [box, setBox] = useState<Rectangle | null>(null);
  const latest = useRef({ project, state, update, scale });
  latest.current = { project, state, update, scale };

  const finish = (cancelled: boolean, event?: PointerEvent<HTMLElement>) => {
    const active = session.current;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    if (!cancelled && event && Math.hypot(event.clientX - active.origin.x, event.clientY - active.origin.y) >= 4)
      active.moved = true;
    session.current = null;
    dragging.current = false;
    suppressClick.current = cancelled || active.moved;
    setBox(null);
    if (cancelled) active.cancel?.();
    else if (event) active.end?.(event, active.moved);
    if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        finish(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const start = (
    event: PointerEvent<HTMLElement>,
    callbacks: Pick<Session, "move" | "end" | "cancel"> = {},
    element = event.currentTarget,
  ) => {
    if (event.button !== 0 || session.current) return false;
    suppressClick.current = false;
    session.current = {
      pointerId: event.pointerId,
      element,
      last: { clientX: event.clientX, clientY: event.clientY },
      origin: { x: event.clientX, y: event.clientY },
      moved: false,
      ...callbacks,
    };
    dragging.current = true;
    element.setPointerCapture?.(event.pointerId);
    return true;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching timelines must cancel an active gesture.
  useEffect(
    () => () => {
      const active = session.current;
      session.current = null;
      if (!active) return;
      setBox(null);
      dragging.current = false;
      active.cancel?.();
      if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    },
    [dragging, project?.id],
  );

  const contentPoint = (event: { clientX: number; clientY: number }) => {
    const element = scroller.current;
    const rect = element?.getBoundingClientRect();
    return {
      x: Math.round(event.clientX - (rect?.left ?? 0) + (element?.scrollLeft ?? 0)),
      y: Math.round(event.clientY - (rect?.top ?? 0) + (element?.scrollTop ?? 0)),
    };
  };
  const rectangle = (origin: Position, event: { clientX: number; clientY: number }): Rectangle => {
    const end = contentPoint(event);
    return {
      left: Math.min(origin.x, end.x),
      top: Math.min(origin.y, end.y),
      width: Math.abs(end.x - origin.x),
      height: Math.abs(end.y - origin.y),
    };
  };
  const select = (ids: string[], keys: Modifiers) => {
    const { state, update } = latest.current;
    update({ ...state, preview: "timeline", playing: false, selected: selectionIds(state.selected, ids, keys) });
  };
  const zoom = useCallback(
    (value: number, clientX?: number) => {
      const { project, state, scale } = latest.current;
      const next = Math.max(12, Math.min(192, Math.round(value)));
      const element = scroller.current;
      if (next === scale) return;
      if (project && element) {
        const ruler = element.querySelector<HTMLElement>(".zc-ruler");
        const left = element.getBoundingClientRect().left;
        const label = (ruler?.getBoundingClientRect().left ?? left) - left + element.scrollLeft;
        const head = pixelAt(seekTarget(project, project.cues, state.playhead), scale);
        const screen = label + head - element.scrollLeft;
        if (screen >= label && screen <= element.clientWidth) {
          pendingScroll.current =
            element.scrollLeft + pixelAt(seekTarget(project, project.cues, state.playhead), next) - head;
        } else {
          const anchor = Math.round(
            Math.max(
              label,
              Math.min(element.clientWidth, (clientX ?? pointer.current?.x ?? left + element.clientWidth / 2) - left),
            ),
          );
          const pixels = Math.round(element.scrollLeft + anchor - label);
          pendingScroll.current = label + (pixels * next) / scale - anchor;
        }
      }
      latest.current.scale = next;
      setScale(next);
    },
    [setScale],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Apply the pending scroll after the new scale changes content width.
  useLayoutEffect(() => {
    if (scroller.current && pendingScroll.current !== null) {
      scroller.current.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [scale]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Native listeners read current render state through latest.
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoom(latest.current.scale * Math.exp((-Math.sign(delta) * Math.min(Math.abs(delta), 30)) / 300), event.clientX);
    };
    let pinchScale: number | null = null;
    const pinchStart = (event: Event) => {
      event.preventDefault();
      pinchScale = latest.current.scale;
    };
    const pinchChange = (event: Event) => {
      const gesture = event as Event & { scale: number; clientX: number };
      if (pinchScale === null || !Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
      event.preventDefault();
      zoom(pinchScale * gesture.scale, gesture.clientX);
    };
    const pinchEnd = () => {
      pinchScale = null;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", pinchStart, { passive: false });
    element.addEventListener("gesturechange", pinchChange, { passive: false });
    element.addEventListener("gestureend", pinchEnd);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", pinchStart);
      element.removeEventListener("gesturechange", pinchChange);
      element.removeEventListener("gestureend", pinchEnd);
    };
  }, [zoom]);
  return {
    scroller,
    box,
    start,
    zoom,
    select,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        const target = event.target as Element;
        if (target.closest("input,textarea,select,[contenteditable=true],.zc-ruler,.zc-playhead,.zc-track-name"))
          return;
        const clip = target.closest<HTMLElement>(".zc-clip");
        if (clip) {
          start(event, clipDrag?.(event, clip) ?? {}, clip);
          return;
        }
        const origin = contentPoint(event);
        const previous = [...latest.current.state.selected];
        const keys = { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
        start(event, {
          move: (event) => setBox(rectangle(origin, event)),
          end: (event, moved) => {
            if (!moved) return;
            const rect = rectangle(origin, event);
            const hits: string[] = [];
            for (const item of scroller.current?.querySelectorAll<HTMLElement>("[data-selection-id]") ?? []) {
              const bounds = item.getBoundingClientRect();
              const position = contentPoint({ clientX: bounds.left, clientY: bounds.top });
              if (
                position.x <= rect.left + rect.width &&
                position.x + bounds.width >= rect.left &&
                position.y <= rect.top + rect.height &&
                position.y + bounds.height >= rect.top
              )
                hits.push(item.dataset.selectionId as string);
            }
            const { state, update } = latest.current;
            update({ ...state, selected: selectionIds(previous, hits, keys) });
          },
        });
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        pointer.current = { x: event.clientX, y: event.clientY };
        const active = session.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - active.origin.x, event.clientY - active.origin.y) >= 4) active.moved = true;
        active.last = { clientX: event.clientX, clientY: event.clientY };
        if (active.moved) active.move?.(event);
      },
      onScroll() {
        const active = session.current;
        if (active?.moved) active.move?.(active.last);
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => finish(false, event),
      onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(true, event),
      onLostPointerCapture: (event: PointerEvent<HTMLElement>) => finish(true, event),
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onClick(event: MouseEvent<HTMLElement>) {
        if (
          (event.target as Element).closest(
            "button,input,textarea,select,[contenteditable=true],.zc-ruler,.zc-track-name",
          )
        )
          return;
        select([], event);
      },
    },
  };
}
