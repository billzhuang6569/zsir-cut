// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ProjectView } from "../src/connection.js";
import { initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";
import { recordingCanvas } from "./canvas.js";

it("follows decoded frames without repeated seeks and keeps React updates below frame rate", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs';
    import {dispatch} from './packages/core/src/index.ts';
    const project = 'fixtures/regressions/preview-native-clock.zcut.json';
    const raw = JSON.parse(readFileSync(project, 'utf8'));
    console.log(JSON.stringify({...((await dispatch('inspect', {project, view:'timeline'})).result),
      name:raw.name, revision:raw.revision, media:raw.media, cues:[], styles:[]}));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  const project = JSON.parse(run.stdout) as ProjectView;
  let scheduled: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    scheduled = undefined;
  });
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  let decoded = 0;
  let paused = true;
  const seeks = vi.fn((value: number) => {
    decoded = value;
  });
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(() => decoded);
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(seeks);
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
    paused = false;
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
    paused = true;
  });
  const canvas = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => canvas.context);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let state = { ...initialState(), playing: true };
  const config = { port: 1234, token: "test" };
  const update = vi.fn((next: typeof state) => {
    state = next;
    render();
  });
  const render = () =>
    root.render(
      <TimelinePreview
        project={project}
        state={state}
        update={update}
        config={config}
        call={async () => ({})}
        error={null}
        dragging={{ current: false }}
      />,
    );
  try {
    await act(render);
    expect(seeks.mock.calls.map(([value]) => value)).toEqual([10]);
    for (let i = 1; i <= 60; i++) {
      decoded = 10 + Math.floor(i / 2) / 30;
      await act(() => scheduled?.((i * 1000) / 60));
    }
    expect(update.mock.calls.length).toBeLessThanOrEqual(10);
    expect(update.mock.calls.length).toBeGreaterThan(0);
    expect(seeks).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("00:00:01:00");
    const count = update.mock.calls.length;
    await act(() => scheduled?.(1800)); // Decoder stalls: the timeline must not seek ahead.
    expect(update).toHaveBeenCalledTimes(count);
    expect(seeks).toHaveBeenCalledTimes(1);
    decoded = 12;
    await act(() => scheduled?.(2000));
    expect(seeks.mock.calls.at(-1)).toEqual([20]); // Same media, next clip has a different source in.
    expect(state.playhead).toEqual({ at: "2s" });
    state = { ...state, playhead: { at: "3s" } };
    await act(render);
    expect(seeks.mock.calls.at(-1)).toEqual([21]); // Explicit seek still works during playback.
    state = { ...state, range: { start: "2s", duration: "1s" }, loop: true };
    await act(render);
    decoded = 21.1;
    await act(() => scheduled?.(2200));
    expect(state.playhead).toEqual({ at: "2s" });
    expect(seeks.mock.calls.at(-1)).toEqual([20]);
    const css = readFileSync(new NodeURL("../src/timeline.css", import.meta.url), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      expect(getComputedStyle(container.querySelector(".zc-timeline") as Element).userSelect).toBe("none");
      const input = document.createElement("textarea");
      container.append(input);
      expect(getComputedStyle(input).userSelect).not.toBe("none");
      expect(css).toContain("-webkit-user-select: none");
    } finally {
      style.remove();
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
