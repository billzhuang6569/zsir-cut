import { type RefObject, useLayoutEffect, useState } from "react";

export type PixelWindow = { left: number; right: number };

export function useTimelineViewport(
  scroller: RefObject<HTMLElement | null>,
  width: number,
  scale: number,
  enabled: boolean,
) {
  const [viewport, setViewport] = useState<PixelWindow | null | undefined>(null);
  // Re-measure after zoom anchoring applies the new scroll offset and after a timeline mounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Width and scale can change layout without a resize.
  useLayoutEffect(() => {
    const element = enabled ? scroller.current : null;
    const ruler = element?.querySelector(".zc-ruler");
    if (!element || !ruler) return;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const size = element.clientWidth;
      const offset = ruler.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
      const screen = Math.max(1, size - Math.max(0, offset));
      const left = Math.max(0, Math.floor(element.scrollLeft - screen));
      const right = Math.ceil(element.scrollLeft + 2 * screen);
      setViewport((previous) =>
        !size ? undefined : previous?.left === left && previous.right === right ? previous : { left, right },
      );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(element);
    observer?.observe(ruler);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, width, scale, enabled]);
  return viewport ?? { left: 0, right: viewport === null ? Math.min(width, 1600) : width };
}

export function intervalIndex<T>(items: readonly T[], bounds: (item: T) => [number, number]) {
  let furthest = Number.NEGATIVE_INFINITY;
  return items
    .map((item, order) => {
      const [start, end] = bounds(item);
      return { item, start, end, order, furthest };
    })
    .sort((a, b) => a.start - b.start)
    .map((entry) => {
      furthest = Math.max(furthest, entry.end);
      return { ...entry, furthest };
    });
}

export function visibleIntervals<T>(index: ReturnType<typeof intervalIndex<T>>, left: number, right: number): T[] {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((index[mid]?.furthest ?? Infinity) < left) lo = mid + 1;
    else hi = mid;
  }
  const matches = [];
  for (let i = lo; i < index.length; i++) {
    const entry = index[i];
    if (!entry || entry.start > right) break;
    if (entry.end >= left) matches.push(entry);
  }
  return matches.sort((a, b) => a.order - b.order).map(({ item }) => item);
}
