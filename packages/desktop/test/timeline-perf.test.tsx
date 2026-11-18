// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { timelinePerfProject } from "../../../fixtures/synth/timeline-perf.ts";
import type { ProjectView } from "../src/connection.js";
import { initialState } from "../src/state.js";
import { add, parseRational, printRational, rulerTicks } from "../src/timeline.js";
import { intervalIndex, visibleIntervals } from "../src/timelineViewport.js";
import { TimelinePreview } from "./timeline-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("finds overlapping intervals and preserves original order and touching endpoints", () => {
  const items: [number, number][] = [
    [20, 25],
    [0, 40],
    [10, 15],
    [24, 30],
    [35, 39],
  ];
  expect(
    visibleIntervals(
      intervalIndex(items, (item) => item),
      25,
      30,
    ),
  ).toEqual([items[0], items[1], items[3]]);
  expect(
    visibleIntervals(
      intervalIndex(items, (item) => item),
      41,
      50,
    ),
  ).toEqual([]);
});

it("keeps global ruler phase in a distant fractional-rate viewport", () => {
  const ticks = rulerTicks(100_000, 145, "30000/1001", 74_000, 75_000);
  const full = rulerTicks(100_000, 145, "30000/1001");
  expect(ticks.length).toBeLessThan(80);
  expect(ticks).toEqual(full.slice(full.findIndex((tick) => tick.at === ticks[0]?.at)).slice(0, ticks.length));
});

function view(minutes: 30 | 60): ProjectView {
  const source = timelinePerfProject(minutes);
  const timeline = source.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  return {
    id: timeline.id,
    name: timeline.name,
    revision: source.revision,
    edit_rate: timeline.edit_rate,
    start_timecode: timeline.start_timecode,
    drop_frame: timeline.drop_frame,
    duration: { t: `${minutes * 60}s` },
    markers: [],
    styles: [],
    cues: [],
    media: source.media.map(({ id, kind, name, duration }) => ({ id, kind, name, duration })),
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({
        ...clip,
        enabled: true,
        speed: "1",
        timeline_in: { t: clip.timeline_start },
        timeline_out: {
          t: printRational(add(parseRational(clip.timeline_start, true), parseRational(clip.duration, true)), true),
        },
        source_in: { t: clip.source_start },
        source_out: { t: clip.duration },
      })),
    })),
  };
}

it("bounds mounted nodes for both benchmark sizes and restores offscreen selection", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroller = host.querySelector<HTMLElement>(".zc-timeline");
    return new DOMRect(this.classList.contains("zc-ruler") ? 100 - (scroller?.scrollLeft ?? 0) : 0, 0, 1000, 300);
  });
  const call = async () => ({});
  const dragging = { current: false };
  function Harness({ project }: { project: ProjectView }) {
    const [state, update] = useState(initialState);
    return (
      <TimelinePreview
        project={project}
        state={state}
        update={update}
        call={call}
        config={undefined}
        error={null}
        dragging={dragging}
        hideViewer
      />
    );
  }
  const count = (selector: string) => host.querySelectorAll(selector).length;
  const first = () => host.querySelector<HTMLButtonElement>('[data-selection-id="clp_perf_0_0"]');
  const scroll = async (scroller: HTMLElement, x: number) => {
    await act(async () => {
      scroller.scrollLeft = x;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise(requestAnimationFrame);
    });
  };
  const rows = [];
  try {
    for (const minutes of [30, 60] as const) {
      const project = view(minutes);
      project.markers = [
        { id: "start-review", at: { t: "2s" }, kind: "review", text: "起点标记" },
        { id: "middle-review", at: { t: `${minutes * 30}s` }, kind: "review", text: "中点标记" },
        { id: "chapter", at: { t: "0s" }, kind: "chapter", text: "整段章节" },
      ];
      await act(async () => root.render(<Harness key={minutes} project={project} />));
      const scroller = host.querySelector<HTMLElement>(".zc-timeline");
      if (!scroller) throw new Error("Missing scroller");
      const read = () => ({ clips: count(".zc-clip"), thumbnails: count(".zc-film-frame"), ticks: count(".zc-tick") });
      const start = read();
      expect(count('[data-marker-id="start-review"]')).toBe(1);
      expect(count('[data-marker-id="middle-review"]')).toBe(0);
      await act(async () => first()?.click());
      expect(first()?.classList.contains("is-selected")).toBe(true);
      await scroll(scroller, 48 * minutes * 30);
      expect(first()).toBeNull();
      const middle = read();
      expect(count('[data-marker-id="start-review"]')).toBe(0);
      expect(count('[data-marker-id="middle-review"]')).toBe(1);
      expect(count('[data-marker-id="chapter"]')).toBe(1);
      for (const counts of [start, middle]) {
        expect(counts.clips).toBeGreaterThan(0);
        expect(counts.clips).toBeLessThan(32);
        expect(counts.thumbnails).toBeLessThan(75);
        expect(counts.ticks).toBeLessThan(165);
      }
      rows.push({ minutes, start, middle });
      await scroll(scroller, 0);
      expect(first()?.classList.contains("is-selected")).toBe(true);
    }
    console.info("T10 jsdom, 1000px including 100px track labels, at 48px/s", JSON.stringify(rows));
  } finally {
    await act(async () => root.unmount());
    bounds.mockRestore();
    width.mockRestore();
    host.remove();
  }
});
