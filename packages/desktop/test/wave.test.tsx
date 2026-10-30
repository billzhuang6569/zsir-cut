// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClipView } from "../src/timeline.js";
import { rational } from "../src/timeline.js";
import { Wave, waveChunks, wavePeak } from "../src/Wave.js";
import { recordingCanvas } from "./canvas.js";

const raw = JSON.parse(readFileSync("fixtures/regressions/waveform-interval.zcut.json", "utf8"));
const input = raw.timelines[0].tracks[0].clips[0];
const clip: ClipView = {
  ...input,
  enabled: true,
  label: null,
  speed: "1",
  timeline_in: { t: input.timeline_start },
  timeline_out: { t: input.duration },
  source_in: { t: input.source_start },
  source_out: { t: input.duration },
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.classList.contains("zc-wave") ? -(this.parentElement?.scrollLeft ?? 0) : 0;
    return {
      left,
      right: left + (this.classList.contains("zc-wave") ? 10000 : 900),
      width: 900,
      top: 0,
      bottom: 48,
      height: 48,
      x: left,
      y: 0,
      toJSON: () => ({}),
    };
  });
});
it("aggregates every 100Hz bucket across the whole bar, including gaps and fractional edges", () => {
  const peaks = Array<number>(200).fill(0);
  peaks[24] = 1;
  expect(wavePeak(clip, peaks, 0, 3, 12)).toBe(1);
  expect(wavePeak(clip, peaks, 3, 6, 12)).toBe(0);
  peaks[25] = 0.8;
  expect(wavePeak(clip, peaks, 3, 6, 12)).toBe(0.8);
  expect(wavePeak(clip, peaks, 0, 3, rational(12000n, 1001n))).toBe(1);
});
it("maps reverse, hold jumps and direction changes without sampling skipped source ranges", () => {
  const peaks = Array<number>(600).fill(0);
  peaks[175] = 1;
  const reverse = {
    ...clip,
    time_map: [
      { at: { t: "0s" }, source: { t: "2s" }, interp: "linear" },
      { at: { t: "2s" }, source: { t: "0s" }, interp: "linear" },
    ],
  };
  expect(wavePeak(reverse, peaks, 0, 3, 12)).toBe(1);
  expect(wavePeak(reverse, peaks, 3, 6, 12)).toBe(0);
  const hold = {
    ...reverse,
    time_map: [
      { at: { t: "0s" }, source: { t: "1s" }, interp: "hold" },
      { at: { t: "1s" }, source: { t: "5s" }, interp: "linear" },
      { at: { t: "2s" }, source: { t: "4s" }, interp: "linear" },
    ],
  };
  expect(wavePeak(hold, peaks, 0, 3, 1)).toBe(0);
  peaks[100] = 0.4;
  expect(wavePeak(hold, peaks, 0, 1, 1)).toBe(0.4);
  const turn = {
    ...reverse,
    time_map: [
      { at: { t: "0s" }, source: { t: "0s" }, interp: "linear" },
      { at: { t: "1s" }, source: { t: "2s" }, interp: "linear" },
      { at: { t: "2s" }, source: { t: "0s" }, interp: "linear" },
    ],
  };
  expect(wavePeak(turn, peaks, 0, 3, 1)).toBe(1);
});
it("allocates only visible chunks, caps their width, and aligns bars when scrolled", () => {
  expect(waveChunks(10000000, 300001, 301601)).toEqual([
    { left: 300000, width: 768 },
    { left: 300768, width: 768 },
    { left: 301536, width: 66 },
  ]);
  expect(waveChunks(10, 20, 30)).toEqual([]);
  expect(waveChunks(10, 9, 20)).toEqual([{ left: 9, width: 1 }]);
});
it("shares pending and resolved source data, handles DPR/scroll/zoom, and ignores playhead updates", async () => {
  const canvas = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => canvas.context);
  vi.stubGlobal("devicePixelRatio", 2);
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => Array(200).fill(0.5) }));
  vi.stubGlobal("fetch", fetcher);
  const config = { port: 1, token: "wave-test" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (at: string, scale = 12) =>
    root.render(
      <div className="zc-timeline">
        <output>{at}</output>
        <Wave clip={{ ...clip }} width={10000} scale={scale} config={config} />
        <Wave clip={{ ...clip, id: "second" }} width={10000} scale={scale} config={config} />
      </div>,
    );
  try {
    await act(async () => render("0s"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("canvas")).toHaveLength(4);
    expect(host.querySelector("canvas")?.width).toBe(1536);
    expect(host.querySelector("canvas")?.height).toBe(96);
    const count = canvas.calls.length;
    await act(async () => render("1s"));
    expect(canvas.calls).toHaveLength(count);
    const scroller = host.firstElementChild as HTMLElement;
    scroller.scrollLeft = 2000;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(host.querySelector("canvas")?.style.left).toBe("1998px");
    expect(host.querySelectorAll("canvas")).toHaveLength(4);
    expect(canvas.calls.length).toBeGreaterThan(count);
    const scrolled = canvas.calls.length;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(canvas.calls).toHaveLength(scrolled);
    await act(async () => render("1s", 24));
    expect(canvas.calls.length).toBeGreaterThan(scrolled);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<div />));
    await act(async () => render("2s"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("canvas")).toHaveLength(4);
    vi.stubGlobal("devicePixelRatio", 1);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(host.querySelector("canvas")?.width).toBe(768);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it.each(["network", "http", "invalid", "empty", "silent"])("degrades quietly for %s", async (failure) => {
  const fetcher = vi.fn(async () => {
    if (failure === "network") throw new Error("offline");
    return { ok: failure !== "http", json: async () => (failure === "invalid" ? [null] : []) };
  });
  vi.stubGlobal("fetch", fetcher);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <Wave clip={clip} width={24} scale={12} config={{ port: 1, token: failure }} hasAudio={failure !== "silent"} />,
      ),
    );
    expect(host.querySelectorAll("canvas")).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(failure === "silent" ? 0 : 1);
    expect(getContext).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
