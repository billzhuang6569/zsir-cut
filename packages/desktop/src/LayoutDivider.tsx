import { type MutableRefObject, type PointerEvent, useEffect, useRef, useState } from "react";
import type { Layout } from "../../app-host/src/preferences.js";

export function LayoutDivider({
  field,
  label,
  value,
  dragging,
  change,
  commit,
  cancel,
}: {
  field: keyof Layout;
  label: string;
  value: number | null;
  dragging: MutableRefObject<boolean>;
  change: (value: number) => void;
  commit: (value: number | null) => void;
  cancel: () => void;
}) {
  const horizontal = field === "timeline_height";
  const min = horizontal ? 0.2 : field === "left_width" ? 200 : 240;
  const max = horizontal ? 0.75 : field === "left_width" ? 560 : 600;
  const [active, setActive] = useState(false);
  const session = useRef<{
    element: HTMLElement;
    pointer: number;
    origin: number;
    start: number;
    height: number;
    max: number;
    value: number;
  } | null>(null);
  const stop = (save: boolean) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    dragging.current = false;
    setActive(false);
    if (save && current.value !== current.start) commit(current.value);
    else cancel();
    if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        stop(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  useEffect(
    () => () => {
      const current = session.current;
      if (!current) return;
      session.current = null;
      dragging.current = false;
      if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    },
    [dragging],
  );
  const measure = (element: HTMLElement) => {
    const shell = element.closest<HTMLElement>(".zc-shell");
    const editor = shell?.querySelector<HTMLElement>(".zc-editor");
    const css = shell && getComputedStyle(shell);
    const left = shell?.querySelector(".zc-functions")?.getBoundingClientRect().width ?? 0;
    const right = shell?.querySelector(".zc-parameters")?.getBoundingClientRect().width ?? 0;
    const height = editor?.getBoundingClientRect().height || 1;
    const defaultWidth = Number.parseInt(
      css?.getPropertyValue(field === "left_width" ? "--panel-w" : "--inspector-w") ?? "",
      10,
    );
    const start = horizontal
      ? (value ?? 0.43)
      : (field === "left_width" ? left : right) || value || defaultWidth || (field === "left_width" ? 300 : 340);
    const preview = shell?.querySelector(".zc-preview-slot")?.getBoundingClientRect().width;
    return { start, height, max: horizontal || !preview ? max : Math.max(min, Math.min(max, start + preview - 360)) };
  };
  const clamp = (next: number, limit: number) =>
    horizontal
      ? Math.round(Math.max(min, Math.min(limit, next)) * 1000) / 1000
      : Math.round(Math.max(min, Math.min(limit, next)));
  const position = (event: PointerEvent<HTMLElement>) => (horizontal ? event.clientY : event.clientX);
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = session.current;
    if (!current || current.pointer !== event.pointerId) return;
    const delta = (position(event) - current.origin) * (field === "left_width" ? 1 : -1);
    current.value = clamp(current.start + delta / (horizontal ? current.height : 1), current.max);
    change(current.value);
  };
  return (
    <hr
      className={`zc-layout-divider zc-layout-${field}`}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value ?? (horizontal ? 0.43 : field === "left_width" ? 300 : 340)}
      tabIndex={0}
      data-dragging={active}
      onDoubleClick={() => commit(null)}
      onKeyDown={(event) => {
        const keys = horizontal ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const current = measure(event.currentTarget);
        const direction = (event.key === keys[0] ? -1 : 1) * (field === "left_width" ? 1 : -1);
        commit(clamp(current.start + (direction * 16) / (horizontal ? current.height : 1), current.max));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragging.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        const current = measure(event.currentTarget);
        session.current = {
          ...current,
          element: event.currentTarget,
          pointer: event.pointerId,
          origin: position(event),
          value: current.start,
        };
        dragging.current = true;
        setActive(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (session.current?.pointer !== event.pointerId) return;
        move(event);
        stop(true);
      }}
      onPointerCancel={(event) => {
        if (session.current?.pointer === event.pointerId) stop(false);
      }}
      onLostPointerCapture={(event) => {
        if (session.current?.pointer === event.pointerId) stop(false);
      }}
    />
  );
}
