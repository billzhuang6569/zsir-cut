// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DESKTOP_AUTHOR, type ProjectView } from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { frameTime, pixelAt } from "../src/timeline.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = initialState();
let project: ProjectView;
let readOnly = false;
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
      readOnly={readOnly}
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
  readOnly = false;
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
    if (this.classList.contains("zc-track-lane")) {
      left = 80 - (scroller?.scrollLeft ?? 0);
      const lanes = [...(host?.querySelectorAll(".zc-track-lane") ?? [])];
      top = 78 + lanes.indexOf(this) * 40 - (scroller?.scrollTop ?? 0);
      height = 40;
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
  expect(call).not.toHaveBeenCalled();
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
  await pointer(clip, "pointerdown", 180, 85);
  await pointer(clip, "pointermove", 184, 85);
  await pointer(clip, "pointerup", 184, 85);
  await click(clip, { ctrlKey: true });
  expect(state.selected).toEqual(["c1"]);
  await click(clip, { ctrlKey: true });
  expect(state.selected).toEqual([]);
  expect(call).toHaveBeenCalledTimes(1);
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

it("drags the selected media group from a later clip with grab offset and one labeled edit", async () => {
  state = { ...state, selected: ["c1", "c2", "q"] };
  await act(render);
  const clip = get('[data-selection-id="c2"]');
  await pointer(clip, "pointerdown", 489, 85); // c2 starts at 464; grab 25px inside.
  await pointer(clip, "pointermove", 537, 85);
  expect(get('[data-selection-id="c1"]').style.left).toBe("144px");
  expect(clip.style.left).toBe("432px");
  expect(clip.style.opacity).toBe("0.5");
  expect(project.tracks[0]?.clips[0]?.timeline_in.t).toBe("2s");
  expect(call).not.toHaveBeenCalled();
  await pointer(clip, "pointerup", 585, 85); // Final release position must be used.
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      author: DESKTOP_AUTHOR,
      label: "移动片段",
      base_revision: "revision",
      timeline_id: "timeline",
      ops: [{ op: "move", clip_ids: ["c1", "c2"], to: "4s" }],
    }),
  );
  expect(clip.style.opacity).toBe("");
  expect(clip.style.left).toBe("384px");
});

it("previews linked audio at its relative offset and bases to on the earliest linked clip", async () => {
  const video = project.tracks[0]?.clips[0];
  if (!video) throw new Error("fixture");
  video.occurrence_id = "linked";
  project.tracks.push({
    id: "a",
    name: "音频",
    kind: "audio",
    enabled: true,
    clips: [{ ...video, id: "audio", timeline_in: { t: "1s" }, timeline_out: { t: "3s" } }],
  });
  await act(render);
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 240, 85);
  expect(get('[data-selection-id="audio"]').style.left).toBe("96px");
  expect(clip.style.left).toBe("144px");
  await pointer(clip, "pointerup", 240, 85);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "move", clip_ids: ["c1"], to: "2s" }],
    }),
  );
});

it.each(["Escape", "pointercancel", "lostpointercapture"])(
  "restores a leftward drag on %s without writing",
  async (cancel) => {
    const clip = get('[data-selection-id="c1"]');
    await pointer(clip, "pointerdown", 192, 85);
    await pointer(clip, "pointermove", 144, 85);
    expect(clip.style.left).toBe("48px");
    if (cancel === "Escape") await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: cancel })));
    else await pointer(clip, cancel, 144, 85);
    expect(clip.style.left).toBe("96px");
    expect(clip.style.opacity).toBe("");
    expect(get(".zc-snap-line")).toBeNull();
    expect(dragging.current).toBe(false);
    await pointer(clip, "pointerup", 144, 85);
    expect(call).not.toHaveBeenCalled();
  },
);

it.each(["重叠 E_VALIDATION", "修订冲突 E_CONFLICT"])(
  "restores rejected moves and shows the existing prompt: %s",
  async (message) => {
    call.mockRejectedValueOnce(new Error(message));
    const clip = get('[data-selection-id="c1"]');
    await pointer(clip, "pointerdown", 192, 85);
    await pointer(clip, "pointermove", 240, 85);
    await pointer(clip, "pointerup", 240, 85);
    expect(clip.style.left).toBe("96px");
    expect(clip.style.opacity).toBe("");
    expect(host.textContent).toContain(message);
    expect(call).toHaveBeenCalledTimes(1);
  },
);

it("submits the target lane to core, including disallowed cross-track groups", async () => {
  project.tracks.push({ id: "v2", name: "视频 B", kind: "video", enabled: true, clips: [] });
  await act(render);
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 240, 165);
  expect(clip.style.transform).toBe("translateY(80px)");
  await pointer(clip, "pointerup", 240, 165);
  expect(call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "move", clip_ids: ["c1"], to: "3s", track_id: "v2" }],
    }),
  );
  state = { ...state, selected: ["c1", "c2"] };
  await act(render);
  call.mockRejectedValueOnce(new Error("Track change requires a single requested clip"));
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointerup", 240, 165);
  expect(call).toHaveBeenLastCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "move", clip_ids: ["c1", "c2"], to: "3s", track_id: "v2" }],
    }),
  );
  expect(host.textContent).toContain("Track change requires a single requested clip");
  expect(clip.style.transform).toBe("");
});

it("shows nearest edge snap distance/line and obeys the toggle during a drag", async () => {
  project.markers = [
    { id: "near", at: { t: "6s" }, text: "near", kind: "review" },
    { id: "far", at: { t: "152/25s" }, text: "far", kind: "review" },
  ];
  await act(render);
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 286, 85); // out edge ~5.96s; 6s wins over later 6.08s.
  expect(get('[aria-label="吸附距离"]').textContent).toBe("1.9px");
  expect(get(".zc-snap-line").style.left).toContain("288px");
  expect(clip.style.left).toBe("192px");
  await click(get('[aria-label="吸附"]'), { detail: 0 });
  await pointer(clip, "pointermove", 286, 85);
  expect(get(".zc-snap-line")).toBeNull();
  await pointer(clip, "pointerup", 286, 85);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({ ops: [{ op: "move", clip_ids: ["c1"], to: "99/25s" }] }),
  );
});

it("never moves subtitle bars and blocks writes in read-only or blade mode", async () => {
  const cue = get('[data-selection-id="q"]');
  await pointer(cue, "pointerdown", 240, 125);
  await pointer(cue, "pointermove", 288, 125);
  await pointer(cue, "pointerup", 288, 125);
  expect(call).not.toHaveBeenCalled();
  expect(cue.style.opacity).toBe("");
  readOnly = true;
  await act(render);
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointerup", 240, 85);
  expect(call).not.toHaveBeenCalled();
  readOnly = false;
  await act(render);
  await click(get('[aria-label="切割 B"]'), { detail: 0 });
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointerup", 240, 85);
  expect(call).not.toHaveBeenCalled();
});

it("includes scroll displacement, freezes the gesture revision, and cancels on timeline switch", async () => {
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 240, 85);
  timeline().scrollLeft = 48;
  await act(() => timeline().dispatchEvent(new Event("scroll")));
  expect(clip.style.left).toBe("192px");
  project = { ...project, revision: { id: "new-revision", seq: 1 } };
  await act(render);
  call.mockRejectedValueOnce(new Error("E_CONFLICT"));
  await pointer(clip, "pointerup", 240, 85);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({ base_revision: "revision", ops: [{ op: "move", clip_ids: ["c1"], to: "3s" }] }),
  );
  expect(clip.style.left).toBe("96px");
  call.mockClear();
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 240, 85);
  project = { ...project, id: "new-timeline" };
  await act(render);
  expect(clip.style.left).toBe("96px");
  expect(dragging.current).toBe(false);
  expect(call).not.toHaveBeenCalled();
});

it("marks overlapping moves as blocked, skips the request on release, and allows touching edges", async () => {
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 480, 85);
  expect(clip.style.outline).toBe("2px solid var(--attention)");
  expect(clip.style.cursor).toBe("not-allowed");
  expect(clip.style.opacity).toBe("0.5");
  expect(call).not.toHaveBeenCalled();
  await pointer(clip, "pointerup", 480, 85);
  expect(call).not.toHaveBeenCalled();
  expect(clip.style.left).toBe("96px");
  expect(clip.style.outline).toBe("");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("这里放不下：会和其他片段重叠");
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 480, 85);
  await pointer(clip, "pointermove", 384, 85);
  expect(clip.style.outline).toBe("");
  await pointer(clip, "pointerup", 384, 85);
  expect(call).toHaveBeenCalledTimes(1);
});

it("checks the final release position even without a preceding blocked preview", async () => {
  const clip = get('[data-selection-id="c1"]');
  await pointer(clip, "pointerdown", 192, 85);
  await pointer(clip, "pointermove", 240, 85);
  await pointer(clip, "pointerup", 480, 85);
  expect(call).not.toHaveBeenCalled();
  expect(host.textContent).toContain("这里放不下：会和其他片段重叠");
});

async function prepareTrim(linked = false) {
  project.media = [{ id: "media", kind: "video", duration: "20s" }];
  const anchor = project.tracks[0]?.clips[0];
  if (!anchor) throw new Error("trim fixture");
  anchor.occurrence_id = "occ_trim";
  anchor.source_in.t = "1s";
  anchor.source_out.t = "3s";
  if (linked)
    project.tracks.push({
      id: "a",
      name: "声音 A",
      kind: "audio",
      enabled: true,
      clips: [{ ...anchor, id: "linked-audio", source_in: { t: "1s" } }],
    });
  await act(render);
  return get('[data-selection-id="c1"]');
}
const handle = (edge: string) => get(`[data-selection-id="c1"] [data-trim-edge="${edge}"]`);

it.each(["in", "out"])("previews %s trim and sends exactly one labeled desktop edit on release", async (edge) => {
  const clip = await prepareTrim(true);
  await pointer(handle(edge), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  expect(clip.style.width).toBe(edge === "in" ? "48px" : "144px");
  expect(get('[data-selection-id="linked-audio"]').style.width).toBe(clip.style.width);
  expect(call).not.toHaveBeenCalled();
  expect(project.tracks[0]?.clips[0]?.timeline_in.t).toBe("2s");
  await pointer(clip, "pointerup", 248, 85);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      author: DESKTOP_AUTHOR,
      base_revision: "revision",
      timeline_id: "timeline",
      label: edge === "in" ? "修剪片段入点" : "修剪片段出点",
      ops: [{ op: "trim", clip_id: "c1", edge, to: edge === "in" ? "3s" : "5s", ripple: false, linked: true }],
    }),
  );
  expect(clip.style.width).toBe("96px");
});

it("uses Alt during preview and release for a single-track J/L cut", async () => {
  const clip = await prepareTrim(true);
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  expect(get('[data-selection-id="linked-audio"]').style.width).toBe("144px");
  await pointer(clip, "pointermove", 248, 85, { altKey: true });
  expect(get('[data-selection-id="linked-audio"]').style.width).toBe("96px");
  await pointer(clip, "pointerup", 248, 85, { altKey: true });
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "trim", clip_id: "c1", edge: "out", to: "5s", ripple: false, linked: false }],
    }),
  );
});

it.each(["Escape", "pointercancel", "lostpointercapture"])("discards trim preview on %s", async (cancel) => {
  const clip = await prepareTrim();
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  if (cancel === "Escape") await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: cancel })));
  else await pointer(clip, cancel, 248, 85);
  expect(clip.style.width).toBe("96px");
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
  await pointer(clip, "pointerup", 248, 85);
  expect(call).not.toHaveBeenCalled();
});

it.each(["in", "out"])(
  "stops %s preview at a legal boundary and does not send an out-of-range release",
  async (edge) => {
    const clip = await prepareTrim();
    await pointer(handle(edge), "pointerdown", 200, 85);
    await pointer(clip, "pointermove", 500, 85);
    expect(clip.style.outline).toBe("2px solid var(--attention)");
    expect(Number.parseFloat(clip.style.width)).toBeCloseTo(edge === "in" ? 1.92 : 288);
    expect(call).not.toHaveBeenCalled();
    await pointer(clip, "pointerup", 500, 85);
    expect(call).not.toHaveBeenCalled();
    expect(clip.style.width).toBe("96px");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  },
);

it("clamps the source start, accepts returning to range and checks the final source end at release", async () => {
  const clip = await prepareTrim();
  const media = project.media[0];
  if (!media) throw new Error("media fixture");
  media.duration = "4s";
  await act(render);
  await pointer(handle("in"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 56, 85);
  expect(clip.style.left).toBe("48px");
  expect(clip.style.outline).toBe("2px solid var(--attention)");
  await pointer(clip, "pointermove", 248, 85);
  expect(clip.style.outline).toBe("");
  await pointer(clip, "pointerup", 248, 85);
  expect(call).toHaveBeenCalledTimes(1);
  call.mockClear();
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  await pointer(clip, "pointerup", 344, 85);
  expect(call).not.toHaveBeenCalled();
  expect(clip.style.width).toBe("96px");
});

it.each(["没能完成这次修改", "工程刚被别处改过，已刷新，请重试"])("restores rejected trim: %s", async (message) => {
  const clip = await prepareTrim();
  call.mockRejectedValueOnce(new Error(message));
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  await pointer(clip, "pointerup", 248, 85);
  expect(clip.style.width).toBe("96px");
  expect(clip.style.opacity).toBe("");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
});

it("shows trim snap feedback and respects its switch, including release without another move", async () => {
  const clip = await prepareTrim();
  project.markers = [{ id: "m", at: { t: "6s" }, text: "目标", kind: "review" }];
  await act(render);
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 294, 85);
  expect(get(".zc-snap-line").style.left).toContain("288px");
  expect(clip.style.width).toBe("192px");
  await click(get('[aria-label="吸附"]'), { detail: 0 });
  await pointer(clip, "pointerup", 294, 85);
  expect(call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      ops: [{ op: "trim", clip_id: "c1", edge: "out", to: "149/25s", ripple: false, linked: true }],
    }),
  );
});

it("has no trim handles for time maps, subtitles, read-only views or blade mode", async () => {
  await prepareTrim();
  const clip = project.tracks[0]?.clips[0];
  if (!clip) throw new Error("clip fixture");
  clip.time_map = [];
  await act(render);
  expect(handle("in")).toBeNull();
  expect(get('[data-selection-id="q"] [data-trim-edge]')).toBeNull();
  readOnly = true;
  await act(render);
  expect(host.querySelectorAll("[data-trim-edge]")).toHaveLength(0);
  readOnly = false;
  await act(render);
  await click(get('[aria-label="切割 B"]'), { detail: 0 });
  expect(host.querySelectorAll("[data-trim-edge]")).toHaveLength(0);
});

it("uses scroll displacement, freezes the starting revision and cancels trim on a timeline switch", async () => {
  const clip = await prepareTrim();
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  timeline().scrollLeft = 48;
  await act(() => timeline().dispatchEvent(new Event("scroll")));
  expect(clip.style.width).toBe("192px");
  project = { ...project, revision: { id: "later", seq: 1 } };
  await act(render);
  await pointer(clip, "pointerup", 248, 85);
  expect(call).toHaveBeenCalledWith("edit", expect.objectContaining({ base_revision: "revision" }));
  call.mockClear();
  await pointer(handle("out"), "pointerdown", 200, 85);
  await pointer(clip, "pointermove", 248, 85);
  project = { ...project, id: "different" };
  await act(render);
  expect(clip.style.width).toBe("96px");
  expect(dragging.current).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
