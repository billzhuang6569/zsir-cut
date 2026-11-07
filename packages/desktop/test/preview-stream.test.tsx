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
  mode = "segments";
  end = 0;
  start = 0;
  updating = false;
  buffered = { length: 1, end: () => this.end, start: () => this.start };
  appendBuffer(bytes: ArrayBuffer) {
    expect(this.updating).toBe(false);
    this.updating = true;
    const id = new Uint8Array(bytes)[0];
    events.push(`append:${id}:${this.mode}`);
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
const segment = (clip: ClipView) => ({ clip, url: `http://cache/${clip.id}` });
it("appends two segments in sequence mode before play, maps three segments, and evicts old ranges", async () => {
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
  expect(events.slice(0, 4)).toEqual(["append:0:sequence", "append:1:sequence", "play", "active"]);
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
  expect(events.filter((event) => event.startsWith("append"))).toEqual(clips.map((_, i) => `append:${i}:sequence`));
  stream.dispose();
});
it("waits for updateend of both startup segments, and cancels an in-flight append on seek", async () => {
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
  expect(events).toEqual(["append:0:sequence"]);
  finishAppend?.();
  await settle();
  expect(events).toEqual(["append:0:sequence", "append:1:sequence"]);
  stream.dispose();
  finishAppend?.();
  await settle();
  expect(events).not.toContain("play");
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
  segments: clips.map((clip) => ({ clip_id: clip.id, key: clip.id, state: "ready" })),
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

it("drives the real preview playhead and timecode through three cached clips, then falls back at the missing cut", async () => {
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
  await act(() => frame?.(100));
  await settle();
  const video = host.querySelector<HTMLVideoElement>('video[data-preview-mode="mse"]');
  if (!video) throw new Error("Missing stream player");
  expect(video.style.visibility).toBe("visible");
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
  expect(video.style.visibility).toBe("hidden");
  const original = host.querySelector<HTMLVideoElement>('video[data-preview-mode="preroll"][aria-label="时间线预览"]');
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
  expect(video.style.visibility).toBe("visible");
  expect(sources).toHaveLength(2);
});

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
    { clip_id: "audio", key: "audio", state: "missing" },
    { clip_id: "disabled", key: "disabled", state: "missing" },
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
