// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectView } from "../src/connection.js";
import { initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { recordingCanvas } from "./canvas.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = { ...initialState(), playing: true };
let scheduled: FrameRequestCallback | undefined;
let now = 0;
let project: ProjectView;
const dragging = { current: false };
const config = { port: 1234, token: "test" };
const players = new Map<HTMLMediaElement, { time: number; ready: number; seeking: boolean; paused: boolean }>();
const actions: { kind: string; element: HTMLMediaElement; visible: boolean; muted: boolean; time: number }[] = [];
function player(element: HTMLMediaElement) {
  let value = players.get(element);
  if (!value) {
    value = { time: 0, ready: 0, seeking: false, paused: true };
    players.set(element, value);
  }
  return value;
}
function record(kind: string, element: HTMLMediaElement) {
  actions.push({
    kind,
    element,
    visible: element.style.visibility === "visible",
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
  const visible = videos().find((element) => element.style.visibility === "visible");
  if (!visible) throw new Error("Missing visible player");
  player(visible).time = time;
  now += 100;
  await act(() => scheduled?.(now));
}
async function metadata(element: HTMLVideoElement, ready = 2) {
  player(element).ready = ready;
  await act(() => element.dispatchEvent(new Event("loadedmetadata")));
}

beforeEach(async () => {
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
    media: [{ id: "media", kind: "video" }],
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
  vi.spyOn(performance, "now").mockReturnValue(0);
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
    record("seek", this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
    return player(this).paused;
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    record("play", this);
    player(this).paused = false;
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

it("prerolls the same media two seconds before the cut and swaps both ways without a visible seek", async () => {
  const [a, b] = videos();
  expect(b.muted).toBe(true);
  expect(b.style.position).toBe("absolute");
  await tick(11.96);
  expect(b.getAttribute("src")).toBeNull();
  await tick(12);
  expect(b.src).toBe(a.src);
  expect(player(b).paused).toBe(true);
  await metadata(b);
  expect(actions.filter((action) => action.kind === "seek" && action.element === b)).toMatchObject([
    { visible: false, muted: true, time: 20 },
  ]);
  const cut = actions.length;
  await tick(14.04);
  expect(b.style.visibility).toBe("visible");
  expect(a.style.visibility).toBe("hidden");
  expect(a.muted).toBe(true);
  expect(player(a).paused).toBe(true);
  expect(b.getAttribute("aria-label")).toBe("时间线预览");
  expect(b.volume).toBeCloseTo(10 ** (-6 / 20));
  expect(b.playbackRate).toBe(1);
  expect(actions.slice(cut).map(({ kind, element }) => [kind, element === a ? "a" : "b"])).toEqual([
    ["pause", "a"],
    ["play", "b"],
  ]);
  expect(state.playhead).toEqual({ at: "4s" });
  await tick(20.4);
  expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:04:10");
  await tick(22);
  expect(player(a).time).toBe(30);
  const nextCut = actions.length;
  await tick(24);
  expect(a.style.visibility).toBe("visible");
  expect(actions.slice(nextCut).some((action) => action.kind === "seek")).toBe(false);
  expect(state.playhead).toEqual({ at: "8s" });
});

it.each(["loading", "seeking"])("falls back to the visible player when preroll is %s", async (condition) => {
  const [a, b] = videos();
  await tick(12);
  if (condition === "seeking") {
    await metadata(b);
    player(b).seeking = true;
  }
  const cut = actions.length;
  await tick(14);
  expect(a.style.visibility).toBe("visible");
  expect(b.muted).toBe(true);
  expect(player(b).paused).toBe(true);
  expect(actions.slice(cut)).toContainEqual(
    expect.objectContaining({ kind: "seek", element: a, visible: true, time: 20 }),
  );
});

it("discards a prepared seek when scrubbing and ignores late metadata from discarded preroll", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  await act(() => update({ ...state, playhead: { at: "0s" } }));
  const discarded = actions.length;
  await metadata(b);
  expect(actions).toHaveLength(discarded);
  await tick(10.4);
  expect(player(a).time).toBe(10.4);
  const cut = actions.length;
  await tick(14);
  expect(a.style.visibility).toBe("visible");
  expect(actions.slice(cut)).toContainEqual(expect.objectContaining({ kind: "seek", element: a, time: 20 }));
});

it("keeps a discarded pending metadata callback from seeking after pause", async () => {
  const [, b] = videos();
  await tick(12);
  await act(() => update({ ...state, playing: false }));
  const count = actions.length;
  await metadata(b);
  expect(actions).toHaveLength(count);
  expect(player(b).paused).toBe(true);
  expect(b.muted).toBe(true);
});

it("waits for metadata when a recycled player loads different media", async () => {
  const [a, b] = videos();
  const third = project.tracks[0]?.clips[2];
  if (!third) throw new Error("Missing third clip");
  third.media_id = "other";
  project.media.push({ id: "other", kind: "video" });
  await tick(12);
  await metadata(b);
  await tick(14);
  const count = actions.filter((action) => action.kind === "seek" && action.element === a).length;
  await tick(22);
  expect(a.src).toContain("media_id=other");
  // The fake retains readyState=2 from the previous source until metadata arrives.
  expect(actions.filter((action) => action.kind === "seek" && action.element === a)).toHaveLength(count);
  await metadata(a);
  expect(player(a).time).toBe(30);
  await tick(24);
  expect(a.style.visibility).toBe("visible");
});

it.each(["map", "0", "-1"])("keeps an upcoming speed %s clip on the original seek path", async (speed) => {
  const [a, b] = videos();
  const upcoming = project.tracks[0]?.clips[1];
  if (!upcoming) throw new Error("Missing next clip");
  upcoming.speed = speed;
  if (speed !== "map") {
    upcoming.time_map = [
      { at: { t: "4s" }, source: { t: "20s" }, interp: "linear" },
      { at: { t: "8s" }, source: { t: speed === "0" ? "20s" : "16s" }, interp: "linear" },
    ];
  }
  await tick(12);
  expect(b.getAttribute("src")).toBeNull();
  await tick(14);
  expect(a.style.visibility).toBe("visible");
  expect(b.muted).toBe(true);
});

it("sets the prepared playback rate and follows its decoded time after the cut", async () => {
  const [, b] = videos();
  const upcoming = project.tracks[0]?.clips[1];
  if (!upcoming) throw new Error("Missing next clip");
  upcoming.speed = "2";
  upcoming.time_map = [
    { at: { t: "4s" }, source: { t: "20s" }, interp: "linear" },
    { at: { t: "8s" }, source: { t: "28s" }, interp: "linear" },
  ];
  await tick(12);
  await metadata(b);
  await tick(14);
  expect(b.playbackRate).toBe(2);
  await tick(20.8);
  expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:04:10");
});

it("does not reuse preroll while the playhead is being dragged", async () => {
  const [a, b] = videos();
  await tick(12);
  await metadata(b);
  dragging.current = true;
  await tick(14);
  expect(a.style.visibility).toBe("visible");
  expect(player(a).time).toBe(20);
  expect(player(b).paused).toBe(true);
});
