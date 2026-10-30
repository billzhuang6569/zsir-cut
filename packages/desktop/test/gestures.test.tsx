// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectView } from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { frameTime, pixelAt } from "../src/timeline.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = initialState();
let project: ProjectView;
const dragging = { current: false };
const call = vi.fn(async () => ({}));
const captures = new Map<number, HTMLElement>();
const get = (selector: string) => host.querySelector<HTMLElement>(selector) as HTMLElement;
const timeline = () => get(".zc-timeline");
const scale = () => Number((get('[aria-label="时间线缩放"]') as HTMLInputElement).value);
const render = () =>
  root.render(
    <TimelinePreview
      project={project}
      state={state}
      update={(next) => {
        state = next;
        render();
      }}
      config={undefined}
      call={call}
      error={null}
      dragging={dragging}
      hideViewer
    />,
  );
function pointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  extra: MouseEventInit & { pointerId?: number } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra });
  Object.defineProperty(event, "pointerId", { value: extra.pointerId ?? 1 });
  return act(async () => {
    target.dispatchEvent(event);
  });
}
const click = (target: HTMLElement, extra: MouseEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, ...extra }));
  });
async function box(x1: number, y1: number, x2: number, y2: number, keys: MouseEventInit = {}) {
  await pointer(timeline(), "pointerdown", x1, y1, keys);
  await pointer(timeline(), "pointermove", x2, y2);
  await pointer(timeline(), "pointerup", x2, y2);
  await click(timeline());
}
async function slider(value: number) {
  const input = get('[aria-label="时间线缩放"]') as HTMLInputElement;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(async () => {
  state = initialState();
  captures.clear();
  dragging.current = false;
  call.mockClear();
  project = {
    id: "timeline",
    name: "手势测试",
    revision: { id: "revision", seq: 0 },
    edit_rate: "25",
    start_timecode: "00:00:00:00",
    drop_frame: false,
    duration: { t: "120s" },
    tracks: [
      {
        id: "v",
        name: "视频 A",
        kind: "video",
        enabled: true,
        clips: [2, 8].map((start, i) => ({
          id: `c${i + 1}`,
          media_id: "media",
          label: `片段 ${i + 1}`,
          enabled: true,
          speed: "1",
          timeline_in: { t: `${start}s` },
          timeline_out: { t: `${start + 2}s` },
          source_in: { t: "0s" },
          source_out: { t: "2s" },
        })),
      },
      { id: "s", name: "字幕 A", kind: "subtitle", enabled: true, clips: [] },
    ],
    cues: [3, 6].map((start, i) => ({
      cue_id: "q",
      track_id: "s",
      start: `${start}s`,
      end: `${start + 1}s`,
      text: "字幕",
      style_id: "style",
      piece: i,
    })),
    media: [],
    styles: [],
    markers: [{ id: "chapter", at: { t: "12s" }, text: "章节", kind: "chapter" }],
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroller = host?.querySelector<HTMLElement>(".zc-timeline");
    let left = 0,
      top = 50,
      width = 500,
      height = 200;
    if (this.classList.contains("zc-ruler")) {
      left = 80 - (scroller?.scrollLeft ?? 0);
      height = 28;
    }
    if (this.dataset.selectionId) {
      left = 80 + Number.parseFloat(this.style.left) - (scroller?.scrollLeft ?? 0);
      top += (this.classList.contains("zc-clip-subtitle") ? 68 : 28) - (scroller?.scrollTop ?? 0);
      width = Number.parseFloat(this.style.width);
      height = 40;
    }
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(function (this: HTMLElement, id: number) {
      captures.set(id, this);
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: function (this: HTMLElement, id: number) {
      return captures.get(id) === this;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(function (this: HTMLElement, id: number) {
      captures.delete(id);
      const event = new Event("lostpointercapture", { bubbles: true });
      Object.defineProperty(event, "pointerId", { value: id });
      this.dispatchEvent(event);
    }),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(render);
  Object.defineProperty(timeline(), "clientWidth", { configurable: true, value: 500 });
  Object.defineProperty(timeline(), "clientHeight", { configurable: true, value: 200 });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("distinguishes a click from a 4px drag and captures the clip, suppressing only the drag click", async () => {
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 180, 85);
  expect(captures.get(1)).toBe(clip);
  expect(dragging.current).toBe(true);
  await pointer(clip, "pointermove", 183, 85);
  await pointer(clip, "pointerup", 183, 85);
  await click(clip);
  expect(state.selected).toEqual(["c1"]);
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
  await pointer(clip, "pointerdown", 180, 85);
  await pointer(clip, "pointermove", 184, 85);
  await pointer(clip, "pointerup", 184, 85);
  await click(clip, { ctrlKey: true });
  expect(state.selected).toEqual(["c1"]);
  await click(clip, { ctrlKey: true });
  expect(state.selected).toEqual([]);
  expect(call).not.toHaveBeenCalled();
});
it.each(["pointercancel", "lostpointercapture"])("recovers from %s and ignores other pointers", async (cancel) => {
  state = { ...state, selected: ["c2"] };
  await act(render);
  await pointer(timeline(), "pointerdown", 100, 80);
  await pointer(timeline(), "pointermove", 300, 150, { pointerId: 2 });
  expect(get(".zc-selection-box")).toBeNull();
  await pointer(timeline(), "pointermove", 300, 150);
  expect(get(".zc-selection-box")).not.toBeNull();
  await pointer(timeline(), cancel, 300, 150);
  expect(get(".zc-selection-box")).toBeNull();
  expect(dragging.current).toBe(false);
  expect(state.selected).toEqual(["c2"]);
  await box(100, 80, 300, 150);
  expect(state.selected).toEqual(["c1", "q"]);
});
it("selects intersecting clips and cue IDs once, adds with Shift and toggles with Cmd/Ctrl", async () => {
  await box(100, 77, 420, 150);
  expect(state.selected).toEqual(["c1", "q"]);
  await box(440, 77, 580, 110, { shiftKey: true });
  expect(state.selected).toEqual(["c1", "q", "c2"]);
  await box(100, 77, 300, 150, { metaKey: true });
  expect(state.selected).toEqual(["c2"]);
  await box(100, 77, 300, 150, { ctrlKey: true });
  expect(state.selected).toEqual(["c2", "c1", "q"]);
  await box(700, 77, 750, 150);
  expect(state.selected).toEqual([]);
  expect(call).not.toHaveBeenCalled();
});
it("keeps the start in content coordinates through horizontal and vertical scroll, with reverse drags", async () => {
  timeline().scrollLeft = 100;
  timeline().scrollTop = 20;
  await pointer(timeline(), "pointerdown", 320, 140);
  await pointer(timeline(), "pointermove", 200, 100);
  timeline().scrollLeft = 150;
  timeline().scrollTop = 30;
  await act(() => timeline().dispatchEvent(new Event("scroll")));
  expect(get(".zc-selection-box").style.left).toBe("350px");
  await pointer(timeline(), "pointerup", 30, 50);
  await click(timeline());
  expect(state.selected).toEqual(["c1", "q"]);
  await pointer(timeline(), "pointerdown", 400, 140);
  await pointer(timeline(), "pointerup", 400, 140);
  await click(timeline());
  expect(state.selected).toEqual([]);
});
it("scrubs through the shared seek state at 30000/1001, with threshold and cancel cleanup", async () => {
  project = { ...project, edit_rate: "30000/1001" };
  await act(render);
  await click(get('[aria-label="吸附"]'));
  const ruler = get(".zc-ruler"),
    head = get('[aria-label="播放头"]');
  await pointer(ruler, "pointerdown", 128.048, 55);
  expect(state.playhead).toEqual({ at: frameTime(30n, "30000/1001") });
  await pointer(ruler, "pointercancel", 128, 55);
  await pointer(head, "pointerdown", 128, 55);
  await pointer(head, "pointermove", 130, 55);
  expect(state.playhead).toEqual({ at: "1001/1000s" });
  await pointer(head, "pointermove", 176.096, 55);
  expect(state.playhead).toEqual({ at: frameTime(60n, "30000/1001") });
  await pointer(head, "lostpointercapture", 176, 55);
  expect(dragging.current).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
it("keeps the visible playhead fixed for slider, reset, keyboard, wheel and trackpad pinch", async () => {
  state = applyUi(state, "ui_seek", { at: frameTime(300n, "30000/1001") });
  project = { ...project, edit_rate: "30000/1001" };
  await act(render);
  timeline().scrollLeft = 200;
  const screen = () => 80 + pixelAt("1001/100s", scale()) - timeline().scrollLeft;
  const before = screen();
  await slider(96);
  expect(scale()).toBe(96);
  expect(screen()).toBeCloseTo(before, 8);
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", metaKey: true })));
  expect(scale()).toBe(108);
  expect(screen()).toBeCloseTo(before, 8);
  await click(get('[aria-label="缩放"]'));
  expect(scale()).toBe(48);
  expect(screen()).toBeCloseTo(before, 8);
  for (const keys of [{ ctrlKey: true }, { metaKey: true }]) {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, deltaY: -30, ...keys });
    await act(() => timeline().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(screen()).toBeCloseTo(before, 8);
  }
  expect(state.playhead).toEqual({ at: "1001/100s" });
  expect(call).not.toHaveBeenCalled();
});
it("anchors to the pointer when the playhead is offscreen, leaving ordinary scrolling alone", async () => {
  timeline().scrollLeft = 1000;
  await pointer(timeline(), "pointermove", 250, 150);
  const anchor = (1000 + 250 - 80) / 48;
  await slider(96);
  expect(80 + anchor * scale() - timeline().scrollLeft).toBeCloseTo(250);
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: 350,
    deltaY: 30,
    ctrlKey: true,
    deltaMode: 1,
  });
  const pixels = Math.round(timeline().scrollLeft + 350 - 80);
  const old = scale();
  await act(() => timeline().dispatchEvent(event));
  expect(80 + (pixels * scale()) / old - timeline().scrollLeft).toBeCloseTo(350);
  const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 30 });
  const value = scale();
  await act(() => timeline().dispatchEvent(plain));
  expect(plain.defaultPrevented).toBe(false);
  expect(scale()).toBe(value);
});
it("restores chapter preview on cancel, commits only an existing chapter drag, and clears on unmount", async () => {
  const marker = get(".zc-marker");
  await pointer(marker, "pointerdown", 656, 60);
  await pointer(marker, "pointermove", 700, 60);
  expect(marker.style.left).not.toBe("576px");
  await pointer(marker, "pointercancel", 700, 60);
  expect(marker.style.left).toBe("576px");
  expect(call).not.toHaveBeenCalled();
  await pointer(marker, "pointerdown", 656, 60);
  await pointer(marker, "pointermove", 704, 60);
  await pointer(marker, "pointerup", 704, 60);
  await click(marker);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({ ops: [{ op: "update_marker", marker_id: "chapter", at: "13s" }] }),
  );
  expect(state.playhead).toEqual({ at: "0s" });
  await pointer(timeline(), "pointerdown", 100, 150);
  await act(() => root.render(<div />));
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
});

it("supports WebKit pinch events across renders and removes native listeners on unmount", async () => {
  state = applyUi(state, "ui_seek", { at: "10s" });
  await act(render);
  timeline().scrollLeft = 200;
  const before = 80 + pixelAt("10s", scale()) - timeline().scrollLeft;
  const pinch = async (type: string, factor = 1) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { scale: factor, clientX: 400 });
    await act(() => timeline().dispatchEvent(event));
    return event;
  };
  expect((await pinch("gesturestart")).defaultPrevented).toBe(true);
  expect((await pinch("gesturechange", 1.5)).defaultPrevented).toBe(true);
  expect(scale()).toBe(72);
  expect(80 + pixelAt("10s", scale()) - timeline().scrollLeft).toBeCloseTo(before);
  await pinch("gesturechange", 2);
  expect(scale()).toBe(96);
  expect(80 + pixelAt("10s", scale()) - timeline().scrollLeft).toBeCloseTo(before);
  await pinch("gestureend");
  await pinch("gesturechange", 3);
  expect(scale()).toBe(96);
  const old = timeline();
  await act(() => root.render(<div />));
  const wheel = new WheelEvent("wheel", { cancelable: true, ctrlKey: true, deltaY: 30 });
  old.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(false);
});

it("supports modified clip/cue clicks and keeps keyboard clicks available after a cancelled gesture", async () => {
  await click(get('[data-selection-id="c1"]'));
  await click(get('[data-selection-id="q"]'), { shiftKey: true });
  expect(state.selected).toEqual(["c1", "q"]);
  await click(get('[data-selection-id="q"]'), { metaKey: true });
  expect(state.selected).toEqual(["c1"]);
  await pointer(timeline(), "pointerdown", 100, 140);
  await pointer(timeline(), "pointercancel", 100, 140);
  await click(get('[data-selection-id="c2"]'), { detail: 0 });
  expect(state.selected).toEqual(["c2"]);
  expect(applyUi(state, "ui_state", {}).selected).toEqual(["c2"]);
  expect(call).not.toHaveBeenCalled();
});

it("cancels an active marquee when switching timelines and ignores non-primary starts", async () => {
  await pointer(timeline(), "pointerdown", 100, 100, { button: 2 });
  expect(dragging.current).toBe(false);
  await pointer(timeline(), "pointerdown", 100, 100);
  await pointer(timeline(), "pointermove", 300, 150);
  await pointer(timeline(), "pointerup", 300, 150, { pointerId: 2 });
  expect(dragging.current).toBe(true);
  project = { ...project, id: "another-timeline" };
  await act(render);
  expect(dragging.current).toBe(false);
  expect(get(".zc-selection-box")).toBeNull();
  expect(captures.size).toBe(0);
  expect(call).not.toHaveBeenCalled();
});
