// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectView } from "../src/connection.js";
import { initialState } from "../src/state.js";
import { recordingCanvas } from "./canvas.js";

let TimelinePreview: typeof import("../src/TimelinePreview.js").TimelinePreview;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = { ...initialState(), playing: true };
let scheduled: FrameRequestCallback | undefined;
let now = 0;
let project: ProjectView;
const dragging = { current: false };
const config = { port: 1234, token: "test" };
const players = new Map<
  HTMLMediaElement,
  { time: number; ready: number; seeking: boolean; paused: boolean; rate: number; autoPlaying: boolean }
>();
const actions: { kind: string; element: HTMLMediaElement; visible: boolean; muted: boolean; time: number }[] = [];
function player(element: HTMLMediaElement) {
  let value = players.get(element);
  if (!value) {
    value = { time: 0, ready: 0, seeking: false, paused: true, rate: 1, autoPlaying: true };
    players.set(element, value);
  }
  return value;
}
function record(kind: string, element: HTMLMediaElement) {
  actions.push({
    kind,
    element,
    visible: !element.hasAttribute("data-preroll"),
    muted: element.muted,
    time: player(element).time,
  });
}
const update = (next: typeof state) => {
  state = next;
  render();
};
const render = () =>
  root.render(
    <TimelinePreview
      project={project}
      state={state}
      update={update}
      config={config}
      call={async () => ({})}
      error={null}
      dragging={dragging}
    />,
  );
const videos = () => [...host.querySelectorAll("video")] as [HTMLVideoElement, HTMLVideoElement];
async function tick(time: number) {
  const visible = videos().find((element) => !element.hasAttribute("data-preroll"));
  if (!visible) throw new Error("Missing visible player");
  player(visible).time = time;
  now += 100;
  await act(() => scheduled?.(now));
}
async function metadata(element: HTMLVideoElement, ready = 2) {
  player(element).ready = ready;
  await act(() => element.dispatchEvent(new Event("loadedmetadata")));
  await act(() => {
    player(element).seeking = false;
    element.dispatchEvent(new Event("seeked"));
  });
}

beforeEach(async () => {
  vi.resetModules();
  ({ TimelinePreview } = await import("../src/TimelinePreview.js"));
  state = { ...initialState(), playing: true };
  now = 0;
  actions.length = 0;
  players.clear();
  dragging.current = false;
  project = {
    id: "timeline",
    name: "剪点预加载",
    revision: { id: "revision", seq: 0 },
    edit_rate: "25",
    start_timecode: "00:00:00:00",
    drop_frame: false,
    duration: { t: "12s" },
    tracks: [
      {
        id: "v",
        name: "视频 A",
        kind: "video",
        enabled: true,
        clips: [0, 4, 8].map((start, index) => ({
          id: `clip${index}`,
          media_id: "media",
          label: null,
          enabled: true,
          speed: "1",
          timeline_in: { t: `${start}s` },
          timeline_out: { t: `${start + 4}s` },
          source_in: { t: `${10 + index * 10}s` },
          source_out: { t: `${14 + index * 10}s` },
          gain_db: index === 1 ? -6 : 0,
        })),
      },
    ],
    media: [{ id: "media", kind: "video", video: { rate: "25", width: 1920, height: 1080 } }],
    cues: [],
    styles: [],
    markers: [],
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    scheduled = undefined;
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).ready;
  });
  vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).seeking;
  });
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).time;
  });
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(function (
    this: HTMLMediaElement,
    time,
  ) {
    player(this).time = time;
    player(this).seeking = true;
    record("seek", this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "playbackRate", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).rate;
  });
  vi.spyOn(HTMLMediaElement.prototype, "playbackRate", "set").mockImplementation(function (
    this: HTMLMediaElement,
    rate,
  ) {
    player(this).rate = rate;
    record("rate", this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).paused;
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    record("play", this);
    player(this).paused = false;
    if (player(this).autoPlaying) this.dispatchEvent(new Event("playing"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    record("pause", this);
    player(this).paused = true;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recordingCanvas().context);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(render);
  await metadata(videos()[0]);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("runs muted two seconds ahead and swaps both ways without play or seek at either cut", async () => {
  const [a, b] = videos();
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(b.hasAttribute("data-preroll")).toBe(true);
  expect(b.dataset.prerollState).toBe("idle");
  expect(b.muted).toBe(true);
  expect(b.style.position).toBe("absolute");
  expect(a.style.zIndex).toBe("1");
  expect(b.style.zIndex).toBe("0");
  expect(a.style.visibility).toBe("");
  expect(b.style.visibility).toBe("");
  await tick(11.96);
  expect(b.getAttribute("src")).toBeNull();
  await tick(12);
  expect(b.dataset.prerollState).toBe("loading");
  expect(b.src).toBe(a.src);
  await metadata(b);
  expect(player(b).paused).toBe(false);
  expect(b.dataset.prerollState).toBe("running");
  expect(
    actions.filter((action) => action.element === b && ["seek", "play", "rate"].includes(action.kind)),
  ).toMatchObject([
    { kind: "seek", visible: false, muted: true, time: 18.3 },
    { kind: "play", visible: false, muted: true, time: 18.3 },
  ]);
  player(b).time = 18.3;
  await tick(12.5);
  player(b).time = 20.04;
  const cut = actions.length;
  await tick(14.04);
  expect(b.hasAttribute("data-preroll")).toBe(false);
  expect(a.hasAttribute("data-preroll")).toBe(true);
  expect(b.dataset.prerollState).toBe("swapped");
  expect(a.dataset.prerollState).toBe("idle");
  expect(b.style.zIndex).toBe("1");
  expect(a.style.zIndex).toBe("0");
  expect(a.muted).toBe(true);
  expect(b.muted).toBe(false);
  expect(player(a).paused).toBe(true);
  expect(b.getAttribute("aria-label")).toBe("时间线预览");
  expect(b.volume).toBeCloseTo(10 ** (-6 / 20));
  expect(b.playbackRate).toBe(1);
  expect(actions.slice(cut).map(({ kind, element }) => [kind, element === a ? "a" : "b"])).toEqual([["pause", "a"]]);
  expect(state.playhead).toEqual({ at: "101/25s" });
  await tick(20.4);
  expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:04:10");
  await tick(22);
  // The recycled decoder already has metadata; it still seeks and starts before the cut.
  expect(player(a).time).toBe(28.3);
  await act(() => {
    player(a).seeking = false;
    a.dispatchEvent(new Event("seeked"));
  });
  expect(player(a).paused).toBe(false);
  player(a).time = 30;
  const nextCut = actions.length;
  await tick(24);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(actions.slice(nextCut).filter((action) => ["seek", "play", "rate"].includes(action.kind))).toEqual([]);
  expect(state.playhead).toEqual({ at: "8s" });
});

it("never corrects rate or position after starting, even with decoder drift", async () => {
  const [, b] = videos();
  await tick(12);
  await metadata(b);
  const started = actions.length;
  for (const [topTime, lowerTime] of [
    [12.5, 18.7],
    [13, 19.8],
    [13.8, 19.9],
  ] as const) {
    player(b).time = lowerTime;
    await tick(topTime);
  }
  expect(actions.slice(started).filter((a) => a.element === b && ["seek", "rate", "play"].includes(a.kind))).toEqual(
    [],
  );
  expect(b.hasAttribute("data-preroll")).toBe(true);
});

it("swaps on the lower clock before the outgoing boundary, even between React publications", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  player(b).time = 19.99;
  await tick(13.8);
  expect(b.hasAttribute("data-preroll")).toBe(true);
  const cut = actions.length;
  player(b).time = 20;
  player(a).time = 13.9;
  now += 16;
  await act(() => scheduled?.(now));
  expect(b.hasAttribute("data-preroll")).toBe(false);
  expect(state.playhead).toEqual({ at: "4s" });
  expect(actions.slice(cut).map(({ kind, element }) => [kind, element === a ? "a" : "b"])).toEqual([["pause", "a"]]);
});

it.each([false, true])(
  "holds the outgoing frame and playhead at out until lower reaches in (time map: %s)",
  async (mapped) => {
    const [a, b] = videos();
    if (mapped) {
      const outgoing = project.tracks[0]?.clips[0];
      if (!outgoing) throw new Error("Missing outgoing clip");
      outgoing.time_map = [
        { at: { t: "0s" }, source: { t: "10s" }, interp: "linear" },
        { at: { t: "4s" }, source: { t: "14s" }, interp: "linear" },
      ];
    }
    await tick(12);
    await metadata(b);
    player(b).time = 19.8;
    const cut = actions.length;
    await tick(14);
    expect(a.hasAttribute("data-preroll")).toBe(false);
    expect(player(a).paused).toBe(true);
    expect(state.playhead).toEqual({ at: "4s" });
    expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:04:00");
    await tick(14);
    expect(player(a).time).toBe(14);
    player(b).time = 20;
    await tick(14);
    expect(b.hasAttribute("data-preroll")).toBe(false);
    expect(actions.slice(cut).map(({ kind, element }) => [kind, element === a ? "a" : "b"])).toEqual([["pause", "a"]]);
    await tick(20.4);
    expect(state.playhead).toEqual({ at: "22/5s" });
  },
);

it("falls back if the lower buffers after the top has started holding", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  player(b).time = 19.8;
  await tick(14);
  const held = actions.length;
  await act(() => b.dispatchEvent(new Event("waiting")));
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(b).paused).toBe(true);
  expect(player(a).paused).toBe(false);
  expect(actions.slice(held)).toContainEqual(expect.objectContaining({ kind: "seek", element: a, time: 20 }));
});

it.each(["metadata", "seek"])("falls back if %s completes too late to start preroll", async (delay) => {
  const [a, b] = videos();
  await tick(12);
  if (delay === "seek") {
    player(b).ready = 2;
    await act(() => b.dispatchEvent(new Event("loadedmetadata")));
  }
  await tick(13.5);
  await metadata(b);
  expect(b.dataset.prerollState).toBe(`fallback:${delay === "seek" ? "seek" : "metadata"}-too-late`);
  expect(a.dataset.prerollFallback).toBe(`${delay === "seek" ? "seek" : "metadata"}-too-late`);
  expect(player(b).paused).toBe(true);
  expect(actions.filter((action) => action.element === b && action.kind === "play")).toEqual([]);
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(a).time).toBe(20);
  expect(a.dataset.prerollFallback).toBe(`${delay === "seek" ? "seek" : "metadata"}-too-late`);
});

it("waits for the top clock to advance after scrub-then-play, even after playing fires", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playing: false, playhead: { at: "2s" } }));
  await metadata(a);
  now += 1500;
  player(a).autoPlaying = false;
  await act(() => update({ ...state, playing: true }));
  for (let i = 0; i < 4; i++) await tick(12);
  expect(b.dataset.prerollState).toBe("loading");
  await act(() => a.dispatchEvent(new Event("playing")));
  await tick(12);
  expect(b.dataset.prerollState).toBe("loading");
  expect(player(b).paused).toBe(true);
  await tick(12.04);
  await metadata(b);
  expect(player(b).time).toBeCloseTo(18.34);
  expect(b.dataset.prerollState).toBe("running");
  player(b).time = 20;
  await tick(14);
  expect(b.dataset.prerollState).toBe("swapped");
});

it("falls back when the top only becomes steady too close to the cut, without adapting lead", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playing: false, playhead: { at: "7/2s" } }));
  await metadata(a);
  await act(() => update({ ...state, playing: true }));
  await tick(13.5);
  expect(b.dataset.prerollState).toBe("fallback:top-not-steady");
  await tick(13.54);
  await tick(14);
  expect(b.getAttribute("src")).toBeNull();
  expect(a.dataset.prerollFallback).toBe("top-not-steady");
  expect(player(a).time).toBe(20);
  player(a).seeking = false;
  await tick(22);
  await metadata(b);
  expect(player(b).time).toBeCloseTo(28.3);
  expect(a.dataset.prerollFallback).toBe("top-not-steady");
  player(b).time = 30;
  await tick(24);
  expect(b.dataset.prerollFallback).toBe("top-not-steady");
});

it("does not mistake the top scrub seek completing for playback progress", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playing: false, playhead: { at: "2s" } }));
  player(a).time = 10;
  await act(() => update({ ...state, playing: true }));
  await tick(10);
  await act(() => {
    player(a).time = 12;
    player(a).seeking = false;
    a.dispatchEvent(new Event("seeked"));
  });
  await tick(12);
  expect(b.dataset.prerollState).toBe("loading");
  expect(player(b).paused).toBe(true);
  await tick(12.04);
  expect(b.dataset.prerollState).toBe("loading");
});

it("calibrates the actual early end after the top resumes from buffering", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  await act(() => a.dispatchEvent(new Event("waiting")));
  await tick(12);
  player(b).time = 20;
  await tick(13.8);
  expect(b.dataset.prerollState).toBe("swapped");
  await tick(22);
  expect(player(a).time).toBeCloseTo(28.2);
});

it("rechecks top playback before starting a lower player whose seek was delayed", async () => {
  const [a, b] = videos();
  await tick(12);
  player(b).ready = 2;
  await act(() => b.dispatchEvent(new Event("loadedmetadata")));
  await act(() => a.dispatchEvent(new Event("waiting")));
  await act(() => {
    player(b).seeking = false;
    b.dispatchEvent(new Event("seeked"));
  });
  expect(b.dataset.prerollState).toBe("loading");
  expect(actions.filter((action) => action.element === b && action.kind === "play")).toEqual([]);
  await tick(12.04);
  expect(b.dataset.prerollState).toBe("running");
});

it("keeps listening when an old seeked arrives during a new seek after scrub-then-play", async () => {
  const [a, b] = videos();
  await tick(12);
  player(b).ready = 2;
  await act(() => b.dispatchEvent(new Event("loadedmetadata")));
  expect(player(b).seeking).toBe(true);
  await act(() => update({ ...state, playing: false }));
  await act(() => update({ ...state, playhead: { at: "2s" } }));
  await metadata(a);
  now += 1500;
  await act(() => update({ ...state, playing: true }));
  await tick(12.04);
  expect(b.dataset.prerollState).toBe("loading");
  await act(() => b.dispatchEvent(new Event("seeked")));
  expect(player(b).paused).toBe(true);
  await act(() => {
    player(b).seeking = false;
    b.dispatchEvent(new Event("seeked"));
  });
  expect(b.dataset.prerollState).toBe("running");
  player(b).time = 20;
  const cut = actions.length;
  await tick(14);
  expect(b.dataset.prerollState).toBe("swapped");
  expect(a.dataset.prerollFallback).toBeUndefined();
  expect(actions.slice(cut).filter((action) => ["seek", "play", "rate"].includes(action.kind))).toEqual([]);
});

it("starts a lower player if positioning is a no-op that does not emit seeked", async () => {
  const [, b] = videos();
  await tick(12);
  player(b).time = 18.3;
  vi.spyOn(b, "currentTime", "set").mockImplementation((time) => {
    player(b).seeking = time !== player(b).time;
    player(b).time = time;
    record("seek", b);
  });
  player(b).ready = 2;
  await act(() => b.dispatchEvent(new Event("loadedmetadata")));
  expect(b.dataset.prerollState).toBe("running");
  expect(actions.filter((action) => action.element === b && action.kind === "play")).toHaveLength(1);
});

it.each([
  { held: 0, left: 0.1, lead: 0.2 },
  { held: 0.2, left: 0, lead: 0.5 },
  { held: 2, left: 0, lead: 1 },
  { held: 0, left: 1, lead: 0.2 },
])("adapts lead once after a cut and clamps it: %j", async ({ held, left, lead }) => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  if (held) {
    player(b).time = 19.9;
    await tick(14);
    now += held * 1000 - 100;
  }
  player(b).time = 20;
  await tick(14 - left);
  await tick(21);
  await tick(22);
  expect(player(a).time).toBeCloseTo(28 + lead);
  const positions = actions.filter((action) => action.element === a && action.kind === "seek");
  expect(positions).toHaveLength(2);
  expect(positions[1]?.time).toBeCloseTo(28 + lead);
});

it("remembers calibrated lead across preview remounts in the app session", async () => {
  const [, b] = videos();
  await tick(12);
  await metadata(b);
  player(b).time = 20;
  await tick(13.8);
  await act(() => root.unmount());
  root = createRoot(host);
  state = { ...initialState(), playing: true };
  await act(render);
  await metadata(videos()[0]);
  await tick(12);
  await metadata(videos()[1]);
  expect(player(videos()[1]).time).toBeCloseTo(18.2);
});

it.each(["waiting", "seeked", "unready"])(
  "calibrates from element time despite a transient %s, then uses it at the next cut",
  async (event) => {
    const [a, b] = videos();
    await tick(12);
    await metadata(b);
    if (event === "unready") player(a).ready = 1;
    else await act(() => a.dispatchEvent(new Event(event)));
    await tick(13.6);
    player(a).ready = 2;
    // React still has 3.6s; the old element actually has only 0.08s left.
    player(a).time = 13.92;
    player(b).time = 20;
    now += 16;
    await act(() => scheduled?.(now));
    expect(Number(b.dataset.prerollLead)).toBeCloseTo(0.22);
    expect(player(a).time).toBe(13.92);
    await tick(22);
    await metadata(a);
    expect(player(a).time).toBeCloseTo(28.22);
    expect(a.dataset.prerollState).toBe("running");
    player(a).time = 30;
    await tick(24);
    expect(a.dataset.prerollState).toBe("swapped");
    expect(Number(a.dataset.prerollLead)).toBeCloseTo(0.22);
  },
);

it("measures the actual hold even when the animation timestamp is stale", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  player(a).time = 14;
  player(b).time = 19.9;
  now = 1000;
  await act(() => scheduled?.(900));
  expect(player(a).paused).toBe(true);
  now = 1200;
  player(b).time = 20;
  await act(() => scheduled?.(1050));
  expect(Number(b.dataset.prerollLead)).toBeCloseTo(0.5);
  await tick(22);
  await metadata(a);
  expect(player(a).time).toBeCloseTo(28.5);
});

it("loads during normal top startup two seconds before a cut and retries after a transient reset", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playing: false, playhead: { at: "2s" } }));
  await metadata(a);
  now += 1500;
  await act(() => update({ ...state, playing: true }));
  await tick(12);
  expect(a.dataset.prerollLead).toBe("0.3");
  expect(b.dataset.prerollState).toBe("loading");
  await metadata(b);
  expect(actions.filter((action) => action.element === b && action.kind === "seek")).toEqual([]);
  await tick(12.04);
  expect(player(b).time).toBeCloseTo(18.34);
  await act(() => a.dispatchEvent(new Event("waiting")));
  await metadata(b);
  expect(player(b).paused).toBe(true);
  await tick(12.08);
  expect(b.dataset.prerollState).toBe("running");
  player(b).time = 20;
  await tick(14);
  expect(b.dataset.prerollState).toBe("swapped");
  expect(a.dataset.prerollFallback).toBeUndefined();
  expect(b.dataset.prerollFallback).toBeUndefined();
});

it("falls back when a jump close to the cut leaves insufficient time to start the lower decoder", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playhead: { at: "19/5s" } }));
  player(a).seeking = false;
  player(b).autoPlaying = false;
  await tick(13.8);
  await metadata(b);
  expect(b.getAttribute("src")).toBeNull();
  const cut = actions.length;
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(b).paused).toBe(true);
  expect(actions.slice(cut)).toContainEqual(expect.objectContaining({ kind: "seek", element: a, time: 20 }));
});

it.each(["loading", "seeking", "starting", "buffering", "paused"])(
  "falls back when preroll is %s",
  async (condition) => {
    const [a, b] = videos();
    player(b).autoPlaying = condition !== "starting";
    await tick(12);
    if (condition !== "loading") {
      await metadata(b);
      player(b).seeking = condition === "seeking";
      player(b).paused = condition === "paused";
      if (condition === "buffering") await act(() => b.dispatchEvent(new Event("waiting")));
    }
    const cut = actions.length;
    await tick(14);
    expect(a.hasAttribute("data-preroll")).toBe(false);
    expect(b.muted).toBe(true);
    expect(player(b).paused).toBe(true);
    const reason = {
      loading: "loading",
      seeking: "seeking",
      starting: "not-running",
      buffering: "not-running",
      paused: "paused",
    }[condition];
    expect(b.dataset.prerollState).toBe(`fallback:${reason}`);
    expect(a.dataset.prerollFallback).toBe(reason);
    expect(actions.slice(cut)).toContainEqual(
      expect.objectContaining({ kind: "seek", element: a, visible: true, time: 20 }),
    );
  },
);

it.each(["running", "loading"])("discards %s preroll on scrub and ignores late events", async (condition) => {
  const [a, b] = videos();
  await tick(12);
  if (condition === "running") await metadata(b);
  await act(() => update({ ...state, playhead: { at: "0s" } }));
  expect(player(b).paused).toBe(true);
  expect(b.dataset.prerollState).toBe("idle");
  const discarded = actions.length;
  await metadata(b);
  await act(() => b.dispatchEvent(new Event("playing")));
  expect(actions).toHaveLength(discarded);
  player(a).seeking = false;
  await tick(10.4);
  const cut = actions.length;
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(actions.slice(cut)).toContainEqual(expect.objectContaining({ kind: "seek", element: a, time: 20 }));
});

it.each(["running", "loading"])("discards %s preroll on pause and prepares again on resume", async (condition) => {
  const [, b] = videos();
  await tick(12);
  if (condition === "running") await metadata(b);
  await act(() => update({ ...state, playing: false }));
  expect(player(b).paused).toBe(true);
  expect(b.dataset.prerollState).toBe("idle");
  expect(b.muted).toBe(true);
  const count = actions.length;
  await metadata(b);
  expect(actions).toHaveLength(count);
  await act(() => update({ ...state, playing: true }));
  await tick(12.2);
  expect(actions.slice(count)).toContainEqual(expect.objectContaining({ kind: "seek", element: b, time: 18.5 }));
});

it("uses the remaining decoded time when metadata is delayed", async () => {
  const [, b] = videos();
  await tick(12);
  await tick(12.6);
  await metadata(b);
  expect(player(b).time).toBeCloseTo(18.9);
  expect(player(b).paused).toBe(false);
});

it("waits for metadata when a recycled player loads different media", async () => {
  const [a, b] = videos();
  const third = project.tracks[0]?.clips[2];
  if (!third) throw new Error("Missing third clip");
  third.media_id = "other";
  project.media.push({ id: "other", kind: "video" });
  await tick(12);
  await metadata(b);
  player(b).time = 20;
  await tick(14);
  const count = actions.filter((action) => action.kind === "seek" && action.element === a).length;
  await tick(22);
  expect(a.src).toContain("media_id=other");
  expect(actions.filter((action) => action.kind === "seek" && action.element === a)).toHaveLength(count);
  await metadata(a);
  expect(player(a).time).toBe(28.3);
  expect(player(a).paused).toBe(false);
  player(a).time = 30;
  await tick(24);
  expect(a.hasAttribute("data-preroll")).toBe(false);
});

it.each(["map", "0", "-1", "image", "short", "no source handle"])(
  "keeps an upcoming %s clip on the original seek path",
  async (kind) => {
    const [a, b] = videos();
    const upcoming = project.tracks[0]?.clips[1];
    if (!upcoming) throw new Error("Missing next clip");
    if (["map", "0", "-1"].includes(kind)) {
      upcoming.speed = kind;
      if (kind !== "map") {
        upcoming.time_map = [
          { at: { t: "4s" }, source: { t: "20s" }, interp: "linear" },
          { at: { t: "8s" }, source: { t: kind === "0" ? "20s" : "16s" }, interp: "linear" },
        ];
      }
    } else if (kind === "image") {
      upcoming.media_id = "image";
      project.media.push({ id: "image", kind: "image" });
    } else if (kind === "short") upcoming.timeline_out.t = "5s";
    else upcoming.source_in.t = "0s";
    await tick(12);
    await metadata(b);
    expect(player(b).paused).toBe(true);
    await tick(14);
    expect(a.hasAttribute("data-preroll")).toBe(false);
    expect(b.muted).toBe(true);
  },
);

it("scales source preroll and lead by both clip speeds and follows the new top clock", async () => {
  const [a, b] = videos();
  const outgoing = project.tracks[0]?.clips[0];
  const upcoming = project.tracks[0]?.clips[1];
  if (!outgoing || !upcoming) throw new Error("Missing clips");
  outgoing.speed = "2";
  outgoing.source_out.t = "18s";
  outgoing.time_map = [
    { at: { t: "0s" }, source: { t: "10s" }, interp: "linear" },
    { at: { t: "4s" }, source: { t: "18s" }, interp: "linear" },
  ];
  upcoming.speed = "1/2";
  upcoming.source_out.t = "22s";
  upcoming.time_map = [
    { at: { t: "4s" }, source: { t: "20s" }, interp: "linear" },
    { at: { t: "8s" }, source: { t: "22s" }, interp: "linear" },
  ];
  await tick(14);
  await metadata(b);
  expect(player(b).time).toBe(19.15);
  expect(b.playbackRate).toBe(0.5);
  player(b).time = 19.2;
  await tick(15);
  expect(b.playbackRate).toBe(0.5);
  player(b).time = 20;
  const cut = actions.length;
  await tick(18);
  expect(b.playbackRate).toBe(0.5);
  expect(actions.slice(cut).some((action) => ["seek", "play", "rate"].includes(action.kind))).toBe(false);
  expect(a.muted).toBe(true);
  await tick(20.2);
  expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:04:10");
});

it("discards running preroll while the playhead is being dragged", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  dragging.current = true;
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(a).time).toBe(20);
  expect(player(b).paused).toBe(true);
});

it("falls back after a preroll play rejection", async () => {
  const [a, b] = videos();
  await tick(12);
  vi.mocked(b.play).mockRejectedValueOnce(new Error("decode failed"));
  await metadata(b);
  expect(player(b).paused).toBe(true);
  expect(b.dataset.prerollState).toBe("fallback:play-rejected");
  expect(a.dataset.prerollFallback).toBe("play-rejected");
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(a).time).toBe(20);
});
