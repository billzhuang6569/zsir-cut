// @vitest-environment jsdom
// biome-ignore-all lint/style/noNonNullAssertion: Fixed test fixtures have seven clips.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectView } from "../src/connection.js";
import { PreviewStream, usePreviewStream } from "../src/preview-stream.js";
import { initialState, type UiState } from "../src/state.js";
import type { ClipView } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";
import { TimelinePreview } from "./timeline-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const clips: ClipView[] = Array.from({ length: 7 }, (_, i) => ({
  id: `c${i}`,
  media_id: "m",
  label: null,
  enabled: true,
  speed: "1",
  timeline_in: { t: `${10 + i * 4}s` },
  timeline_out: { t: `${14 + i * 4}s` },
  source_in: { t: "20s" },
  source_out: { t: "24s" },
}));
const events: string[] = [];
const sources: FakeSource[] = [];
let finishAppend: (() => void) | undefined;
let holdAppend = false;
class FakeBuffer extends EventTarget {
  mode = "sequence";
  settings: [string, number][] = [];
  private offset = 0;
  private windowStart = 0;
  private windowEnd = Infinity;
  get timestampOffset() {
    return this.offset;
  }
  set timestampOffset(value: number) {
    this.settings.push(["timestampOffset", value]);
    this.offset = value;
  }
  get appendWindowStart() {
    return this.windowStart;
  }
  set appendWindowStart(value: number) {
    expect(value).toBeLessThan(this.windowEnd);
    this.settings.push(["appendWindowStart", value]);
    this.windowStart = value;
  }
  get appendWindowEnd() {
    return this.windowEnd;
  }
  set appendWindowEnd(value: number) {
    expect(value).toBeGreaterThan(this.windowStart);
    this.settings.push(["appendWindowEnd", value]);
    this.windowEnd = value;
  }
  end = 0;
  start = 0;
  updating = false;
  buffered = { length: 1, end: () => this.end, start: () => this.start };
  appendBuffer(bytes: ArrayBuffer) {
    expect(this.updating).toBe(false);
    this.updating = true;
    const id = new Uint8Array(bytes)[0];
    events.push(`append:${id}:${this.mode}`);
    expect(this.timestampOffset).toBe(this.appendWindowStart);
    expect(this.appendWindowEnd).toBeGreaterThan(this.appendWindowStart);
    const finish = () => {
      this.end += 4;
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    };
    if (holdAppend) finishAppend = finish;
    else queueMicrotask(finish);
  }
  remove(start: number, end: number) {
    expect(this.updating).toBe(false);
    events.push(`remove:${start}:${end}`);
    this.start = end;
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
}
class FakeSource extends EventTarget {
  static isTypeSupported = () => true;
  buffer = new FakeBuffer();
  readyState = "open";
  endOfStream() {
    this.readyState = "ended";
    events.push("end");
  }
  constructor() {
    super();
    sources.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }
  addSourceBuffer() {
    return this.buffer;
  }
}
let host: HTMLDivElement;
let root: Root | undefined;
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
};
beforeEach(() => {
  sources.length = 0;
  events.length = 0;
  holdAppend = false;
  finishAppend = undefined;
  vi.stubGlobal("MediaSource", FakeSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([Number(/c(\d)/.exec(url)?.[1])]).buffer,
    })),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = () => `blob:${sources.length}`;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
    events.push("play");
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const segment = (clip: ClipView) => ({ clip, url: `http://cache/${clip.id}`, duration: "4s" });
it("plays after the first segment in segments mode, maps three segments, and evicts old ranges", async () => {
  const video = document.createElement("video");
  const stream = new PreviewStream(
    video,
    segment(clips[0]!),
    (clip) => {
      const next = clips[clips.indexOf(clip) + 1];
      return next && segment(next);
    },
    () => "11s",
    () => events.push("active"),
    () => events.push("error"),
    "38s",
  );
  await settle();
  expect(events.slice(0, 4)).toEqual(["append:0:segments", "play", "active", "append:1:segments"]);
  expect(video.currentTime).toBe(1);
  for (const [decoded, at] of [
    [2, "12s"],
    [5, "15s"],
    [10, "20s"],
  ] as const) {
    video.currentTime = decoded;
    expect(stream.time()).toEqual({ at, ended: false });
    await settle();
  }
  video.currentTime = 18;
  stream.time();
  await settle();
  expect(events).toContain("remove:0:8");
  expect(events).toContain("end");
  expect(events.filter((event) => event.startsWith("append"))).toEqual(clips.map((_, i) => `append:${i}:segments`));
  stream.dispose();
});
it("waits for the first updateend to play and cancels the second append on seek", async () => {
  holdAppend = true;
  const video = document.createElement("video");
  const fail = vi.fn();
  const stream = new PreviewStream(
    video,
    segment(clips[0]!),
    () => segment(clips[1]!),
    () => "10s",
    vi.fn(),
    fail,
  );
  await settle();
  expect(events).toEqual(["append:0:segments"]);
  finishAppend?.();
  await settle();
  expect(events).toEqual(["append:0:segments", "play", "append:1:segments"]);
  stream.dispose();
  finishAppend?.();
  await settle();
  expect(events.filter((event) => event === "play")).toHaveLength(1);
  expect(fail).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

let api: ReturnType<typeof usePreviewStream>;
let at = "10s";
let enabled = true;
const playbackAt = { current: "10s" as string | null };
const config = { port: 1234, token: "secret token" };
const path = "/test.zcut.json";
const cache = () => ({
  directory_ok: true,
  projects: [{ project_id: "prj_test", path }],
  segments: clips.map((clip) => ({
    clip_id: clip.id,
    key: clip.id,
    state: "ready",
    duration: "4s" as string | undefined,
  })),
});
const project = {
  id: "timeline",
  name: "preview",
  revision: { id: "rev", seq: 0 },
  edit_rate: "25",
  duration: { t: "38s" },
  start_timecode: "00:00:00:00",
  drop_frame: false,
  markers: [],
  cues: [],
  styles: [],
  media: [{ id: "m", kind: "video" }],
  tracks: [{ id: "v", name: "video", kind: "video", enabled: true, clips }],
} as ProjectView;
const call = vi.fn(async () => cache());
function Player() {
  api = usePreviewStream({ project, top: project.tracks[0], path, config, call, enabled, at, playbackAt });
  return (
    <video ref={api.video} data-preview-mode={api.visible ? "mse" : "preroll"}>
      <track kind="captions" />
    </video>
  );
}
async function mount() {
  at = "10s";
  enabled = true;
  playbackAt.current = at;
  call.mockClear();
  root = createRoot(host);
  await act(async () => root?.render(<Player />));
  await act(() => api.sample(at));
  await settle();
}
async function sample(time: number) {
  if (!api.video.current) throw new Error("Missing video");
  api.video.current.currentTime = time;
  let mapped: string | null = null;
  await act(() => {
    mapped = api.sample(at);
  });
  return mapped;
}
it.each(["building", "missing"] as const)(
  "hands off at the %s segment's cut and resumes at the next opportunity",
  async (state) => {
    await mount();
    // c0-c2 are already appended. c3 must remain on the original player.
    const status = cache();
    status.segments[3]!.state = state;
    await act(() => window.dispatchEvent(new CustomEvent("desktop-preview-cache", { detail: status })));
    expect(await sample(12)).toBe("22s");
    expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
    expect(sources).toHaveLength(1);
    status.segments[3]!.state = "ready";
    await act(() => window.dispatchEvent(new CustomEvent("desktop-preview-cache", { detail: status })));
    at = "26s";
    playbackAt.current = at;
    await act(async () => root?.render(<Player />));
    await act(() => api.sample(at));
    await settle();
    expect(sources).toHaveLength(2);
    expect(host.querySelector("video")?.dataset.previewMode).toBe("mse");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/cache/prj_test/c4.mp4?token=secret%20token",
      expect.anything(),
    );
  },
);
it("resets the source and segment table on seek and pause, and sends playhead hints", async () => {
  await mount();
  at = "15s";
  await act(async () => root?.render(<Player />));
  expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  await act(() => api.sample(at));
  await settle();
  expect(sources).toHaveLength(2);
  expect(await sample(1)).toBe("15s");
  expect(call).toHaveBeenCalledWith("preview_cache_hint", { at: "15s" });
  enabled = false;
  await act(async () => root?.render(<Player />));
  expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
it("returns to the original player on a cache fetch failure", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("disk removed"));
  await mount();
  expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
  expect(events).not.toContain("play");
});

it.each([false, true])(
  "drives the real preview and pauses originals during startup (play rejected: %s)",
  async (rejectPlay) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas() as never);
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let state: UiState = { ...initialState(), project: path, playing: true, playhead: { at: "10s" } };
    const dragging = { current: false };
    const update = (next: typeof state) => {
      state = next;
      render();
    };
    const render = () =>
      root?.render(
        <TimelinePreview
          project={project}
          state={state}
          update={update}
          config={config}
          call={call}
          error={null}
          dragging={dragging}
        />,
      );
    root = createRoot(host);
    await act(async () => render());
    holdAppend = true;
    await act(() => frame?.(100));
    await settle();
    const video = host.querySelector<HTMLVideoElement>('video[data-preview-mode="mse"]');
    if (!video) throw new Error("Missing stream player");
    expect(video.style.visibility).toBe("");
    expect(video.style.zIndex).toBe("0");
    expect(video.style.opacity).toBe("0");
    const originals = [...host.querySelectorAll<HTMLVideoElement>('video[data-preview-mode="preroll"]')];
    for (const original of originals) {
      expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(original);
      expect(original.muted).toBe(true);
    }
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    await act(() => {
      for (const original of originals) original.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls).toHaveLength(plays);
    if (rejectPlay) vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("decode failed"));
    holdAppend = false;
    finishAppend?.();
    await settle();
    if (rejectPlay) {
      expect(video.style.opacity).toBe("0");
      expect(originals[0]?.muted).toBe(false);
      expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.slice(plays)).toEqual([video, originals[0]]);
      return;
    }
    expect(video.style.opacity).toBe("1");
    const status = cache();
    status.segments[3]!.state = "missing";
    await act(() => window.dispatchEvent(new CustomEvent("desktop-preview-cache", { detail: status })));
    for (const [decoded, expected] of [
      [2, "12s"],
      [5, "15s"],
      [10, "20s"],
    ] as const) {
      video.currentTime = decoded;
      await act(() => frame?.(1000 + decoded * 1000));
      expect(state.playhead).toEqual({ at: expected });
      expect(host.querySelector('[aria-label="播放时码"]')?.textContent).toBe(`00:00:${expected.slice(0, -1)}:00`);
    }
    video.currentTime = 12;
    await act(() => frame?.(14000));
    expect(state.playhead).toEqual({ at: "22s" });
    expect(video.style.opacity).toBe("0");
    expect(video.style.visibility).toBe("");
    expect(video.style.zIndex).toBe("0");
    const original = host.querySelector<HTMLVideoElement>(
      'video[data-preview-mode="preroll"][aria-label="时间线预览"]',
    );
    expect(original?.currentTime).toBe(20);
    expect(original?.style.visibility).toBe("");
    expect(call).toHaveBeenCalledWith("preview_cache_hint", { at: "22s" });
    status.segments[3]!.state = "ready";
    await act(() => window.dispatchEvent(new CustomEvent("desktop-preview-cache", { detail: status })));
    if (!original) throw new Error("Missing original player");
    original.currentTime = 24;
    await act(() => frame?.(15000));
    expect(state.playhead).toEqual({ at: "26s" });
    await act(() => frame?.(15100));
    await settle();
    expect(video.style.opacity).toBe("1");
    expect(sources).toHaveLength(2);
  },
);

it("maps fractional timeline positions using the appended table", async () => {
  const fractional = clips.slice(0, 3).map((clip, index) => ({
    ...clip,
    timeline_in: { t: `${1 + index * 12}/3s` },
    timeline_out: { t: `${13 + index * 12}/3s` },
  }));
  const video = document.createElement("video");
  const stream = new PreviewStream(
    video,
    segment(fractional[0]!),
    (clip) => {
      const incoming = fractional[fractional.indexOf(clip) + 1];
      return incoming && segment(incoming);
    },
    () => "1/3s",
    vi.fn(),
    vi.fn(),
  );
  await settle();
  video.currentTime = 5;
  expect(stream.time()).toEqual({ at: "16/3s", ended: false });
  stream.dispose();
});

it("sums measured durations exactly and sets offsets and windows in order without reading buffered.end", async () => {
  const video = document.createElement("video");
  const durations = ["3288021/1000000s", "1001/300s", "1/3s"];
  const segments = clips.slice(0, 3).map((clip, i) => ({ ...segment(clip), duration: durations[i]! }));
  const stream = new PreviewStream(
    video,
    segments[0]!,
    (clip) => segments[clips.indexOf(clip) + 1],
    () => "10s",
    vi.fn(),
    vi.fn(),
  );
  const buffer = sources[0]!.buffer;
  buffer.buffered.end = () => {
    throw new Error("Buffered audio must not set the segment boundary");
  };
  await settle();
  expect(buffer.mode).toBe("segments");
  expect(stream.table.map(({ start, end }) => ({ start, end }))).toEqual([
    { start: "0s", end: "3288021/1000000s" },
    { start: "3288021/1000000s", end: "19874063/3000000s" },
    { start: "19874063/3000000s", end: "6958021/1000000s" },
  ]);
  expect(buffer.settings).toEqual(
    stream.table.flatMap(({ start, end }) => {
      const seconds = (value: string) => {
        const [n, d = "1"] = value.slice(0, -1).split("/");
        return Number(n) / Number(d);
      };
      return [
        ["appendWindowEnd", Infinity],
        ["timestampOffset", seconds(start)],
        ["appendWindowStart", seconds(start)],
        ["appendWindowEnd", seconds(end)],
      ];
    }),
  );
  video.currentTime = 3288021 / 1000000;
  expect(stream.time()).toEqual({ at: "14s", ended: false });
  stream.dispose();
});

it.each([undefined, "0s", "bad", "2/2s"])("uses P2.1 when the host duration is %s", async (duration) => {
  call.mockImplementationOnce(async () => {
    const status = cache();
    for (const item of status.segments) item.duration = duration;
    return status;
  });
  await mount();
  expect(sources).toHaveLength(0);
  expect(api.active.current).toBe(false);
  expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
});

it("starts a lone ready segment while its successor has no duration", async () => {
  call.mockImplementationOnce(async () => {
    const status = cache();
    for (const item of status.segments.slice(1)) item.duration = undefined;
    return status;
  });
  await mount();
  expect(events).toEqual(["append:0:segments", "play"]);
  expect(await sample(4)).toBe("14s");
  expect(api.active.current).toBe(false);
});

it("continues appending while the first play promise is pending", async () => {
  let played: (() => void) | undefined;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        played = resolve;
      }),
  );
  await mount();
  expect(events.filter((event) => event.startsWith("append"))).toHaveLength(3);
  expect(api.preparing).toBe(true);
  played?.();
  await settle();
  expect(api.visible).toBe(true);
  expect(api.preparing).toBe(false);
});

it("does not activate a disposed stream when its pending play completes", async () => {
  let played: (() => void) | undefined;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        played = resolve;
      }),
  );
  await mount();
  enabled = false;
  await act(async () => root?.render(<Player />));
  played?.();
  await settle();
  expect(api.visible).toBe(false);
  expect(api.active.current).toBe(false);
});

it("falls back if play is rejected", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("decode failed"));
  await mount();
  expect(api.active.current).toBe(false);
  expect(api.visible).toBe(false);
  expect(api.preparing).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

it("keeps buffered playback until the cut when a later cached file disappears", async () => {
  vi.mocked(fetch).mockImplementation(
    async (request) =>
      ({ ok: !String(request).includes("c2.mp4"), arrayBuffer: async () => new Uint8Array([0]).buffer }) as Response,
  );
  await mount();
  expect(host.querySelector("video")?.dataset.previewMode).toBe("mse");
  expect(await sample(2)).toBe("12s");
  expect(host.querySelector("video")?.dataset.previewMode).toBe("mse");
  expect(await sample(8)).toBe("18s");
  expect(host.querySelector("video")?.dataset.previewMode).toBe("preroll");
});

it("shows video cache gaps at timeline positions and opens cache settings without seeking", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas() as never);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const view = structuredClone(project);
  const videoTrack = view.tracks[0]!;
  videoTrack.clips[2]!.enabled = false;
  view.media.push({ ...view.media[0]!, id: "image", kind: "image" });
  videoTrack.clips[3]!.media_id = "image";
  view.tracks.push({ ...videoTrack, id: "audio", kind: "audio", clips: [{ ...clips[0]!, id: "audio" }] });
  view.tracks.push({ ...videoTrack, id: "disabled", enabled: false, clips: [{ ...clips[0]!, id: "disabled" }] });
  const status = cache();
  status.segments.forEach((segment, i) => {
    segment.state = i === 1 ? "building" : i < 4 ? "missing" : "ready";
  });
  status.segments.push(
    { clip_id: "audio", key: "audio", state: "missing", duration: undefined },
    { clip_id: "disabled", key: "disabled", state: "missing", duration: undefined },
  );
  const update = vi.fn();
  const settings = vi.fn();
  const state = { ...initialState(), project: path };
  const invoke = vi.fn(async () => status);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <TimelinePreview
        project={view}
        state={state}
        update={update}
        config={config}
        call={invoke}
        error={null}
        dragging={{ current: false }}
        onOpenSettings={settings}
      />,
    ),
  );
  const bars = host.querySelectorAll<HTMLButtonElement>(".zc-render-bar");
  expect(bars).toHaveLength(2);
  expect(bars[0]!.style.left).toBe("480px");
  expect(bars[0]!.style.width).toBe("192px");
  expect(bars[1]!.classList.contains("is-building")).toBe(true);
  expect(bars[0]!.title).toBe("这段还没准备好，播放到这里可能卡顿");
  const pointer = new Event("pointerdown", { bubbles: true });
  await act(() => {
    bars[0]!.dispatchEvent(pointer);
    bars[0]!.click();
  });
  expect(settings).toHaveBeenCalledWith("预览与缓存");
  expect(update).not.toHaveBeenCalled();
  await act(() =>
    window.dispatchEvent(new CustomEvent("desktop-preview-cache", { detail: { ...status, paused: "battery" } })),
  );
  expect(host.querySelector<HTMLButtonElement>(".zc-render-bar")!.title).toBe("用电池时暂停了预览准备，可在设置里关掉");
  await act(() =>
    window.dispatchEvent(
      new CustomEvent("desktop-preview-cache", {
        detail: { ...status, segments: status.segments.map((segment) => ({ ...segment, state: "ready" })) },
      }),
    ),
  );
  expect(host.querySelector(".zc-render-bar")).toBeNull();
});

it("sends a new hint when playback starts at the same playhead", async () => {
  at = "10s";
  enabled = false;
  root = createRoot(host);
  await act(async () => root?.render(<Player />));
  call.mockClear();
  enabled = true;
  await act(async () => root?.render(<Player />));
  expect(call).toHaveBeenCalledWith("preview_cache_hint", { at: "10s" });
});
