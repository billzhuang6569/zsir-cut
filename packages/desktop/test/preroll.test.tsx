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
  expect(b.muted).toBe(true);
  expect(b.style.position).toBe("absolute");
  expect(a.style.zIndex).toBe("1");
  expect(b.style.zIndex).toBe("0");
  expect(a.style.visibility).toBe("");
  expect(b.style.visibility).toBe("");
  await tick(11.96);
  expect(b.getAttribute("src")).toBeNull();
  await tick(12);
  expect(b.src).toBe(a.src);
  await metadata(b);
  expect(player(b).paused).toBe(false);
  expect(actions.filter((action) => action.element === b && ["seek", "play"].includes(action.kind))).toMatchObject([
    { kind: "seek", visible: false, muted: true, time: 18 },
    { kind: "play", visible: false, muted: true, time: 18 },
  ]);
  player(b).time = 18.5;
  await tick(12.5);
  player(b).time = 20.04;
  const cut = actions.length;
  await tick(14.04);
  expect(b.hasAttribute("data-preroll")).toBe(false);
  expect(a.hasAttribute("data-preroll")).toBe(true);
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
  expect(player(a).time).toBe(28);
  await act(() => {
    player(a).seeking = false;
    a.dispatchEvent(new Event("seeked"));
  });
  expect(player(a).paused).toBe(false);
  player(a).time = 30;
  const nextCut = actions.length;
  await tick(24);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(actions.slice(nextCut).filter((action) => ["seek", "play"].includes(action.kind))).toEqual([]);
  expect(state.playhead).toEqual({ at: "8s" });
});

it.each([0.12, -0.12])(
  "corrects offset %s once after playing, then restores the native rate at the cut",
  async (offset) => {
    const [, b] = videos();
    player(b).autoPlaying = false;
    await tick(12);
    await metadata(b);
    player(b).time = 18.5 + offset;
    await tick(12.5);
    expect(actions.filter((a) => a.element === b && a.kind === "rate")).toHaveLength(0);
    await act(() => b.dispatchEvent(new Event("playing")));
    await tick(12.5);
    expect(b.playbackRate).toBeCloseTo(1 - offset / 1.5);
    player(b).time = 19 + offset;
    await tick(13);
    player(b).time = 19.6 + offset;
    await tick(13.6);
    expect(actions.filter((a) => a.element === b && a.kind === "rate")).toHaveLength(1);
    player(b).time = 20;
    const cut = actions.length;
    await tick(14);
    expect(b.playbackRate).toBe(1);
    expect(actions.filter((a) => a.element === b && a.kind === "rate")).toHaveLength(2);
    expect(actions.slice(cut).some((a) => ["seek", "play"].includes(a.kind))).toBe(false);
    await tick(20.4);
    expect(actions.filter((a) => a.element === b && a.kind === "rate")).toHaveLength(2);
  },
);

it("does not rewind into the old clip when the incoming decoder lands just before its in point", async () => {
  const [, b] = videos();
  await tick(12);
  await metadata(b);
  player(b).time = 18.48;
  await tick(12.5);
  player(b).time = 19.98;
  const cut = actions.length;
  await tick(14);
  await tick(19.99);
  expect(state.playhead).toEqual({ at: "4s" });
  expect(b.hasAttribute("data-preroll")).toBe(false);
  expect(actions.slice(cut).some((action) => ["seek", "play"].includes(action.kind))).toBe(false);
  await tick(20.04);
  expect(state.playhead).toEqual({ at: "101/25s" });
});

it.each(["within a frame", "too late"])("does not adjust playbackRate when %s", async (condition) => {
  const [, b] = videos();
  await tick(12);
  await metadata(b);
  player(b).time = condition === "too late" ? 19.3 : 18.52;
  await tick(condition === "too late" ? 13.6 : 12.5);
  await tick(13.7);
  expect(actions.filter((a) => a.element === b && a.kind === "rate")).toHaveLength(0);
});

it("uses the source frame rate for correction and permits one adjustment exactly half a second before the cut", async () => {
  const [, b] = videos();
  const media = project.media[0];
  if (!media?.video) throw new Error("Missing video format");
  media.video.rate = "100";
  await tick(12);
  await metadata(b);
  player(b).time = 19.52;
  await tick(13.5);
  expect(b.playbackRate).toBeCloseTo(0.96);
  expect(actions.filter((action) => action.element === b && action.kind === "rate")).toHaveLength(1);
});

it("falls back when a jump close to the cut leaves insufficient time to start the lower decoder", async () => {
  const [a, b] = videos();
  await act(() => update({ ...state, playhead: { at: "19/5s" } }));
  player(a).seeking = false;
  player(b).autoPlaying = false;
  await tick(13.8);
  await metadata(b);
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
  expect(b.muted).toBe(true);
  const count = actions.length;
  await metadata(b);
  expect(actions).toHaveLength(count);
  await act(() => update({ ...state, playing: true }));
  await tick(12.2);
  expect(actions.slice(count)).toContainEqual(expect.objectContaining({ kind: "seek", element: b, time: 18.2 }));
});

it("uses the remaining decoded time when metadata is delayed", async () => {
  const [, b] = videos();
  await tick(12);
  await tick(12.6);
  await metadata(b);
  expect(player(b).time).toBeCloseTo(18.6);
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
  expect(player(a).time).toBe(28);
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

it("scales source preroll and correction by both clip speeds and follows the new top clock", async () => {
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
  expect(player(b).time).toBe(19);
  expect(b.playbackRate).toBe(0.5);
  player(b).time = 19.2;
  await tick(15);
  expect(b.playbackRate).toBeCloseTo(0.5 * (1 + 0.1 / 1.5));
  player(b).time = 20;
  const cut = actions.length;
  await tick(18);
  expect(b.playbackRate).toBe(0.5);
  expect(actions.slice(cut).some((action) => action.element === b && ["seek", "play"].includes(action.kind))).toBe(
    false,
  );
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
  await tick(14);
  expect(a.hasAttribute("data-preroll")).toBe(false);
  expect(player(a).time).toBe(20);
});
