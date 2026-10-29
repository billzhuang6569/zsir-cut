import { describe, expect, it } from "vitest";
import { type ClipView, frameAt, frameTime, pointerTime, printRational, sourceAt } from "../src/timeline.js";

describe("rational playhead and source mapping", () => {
  it("round trips NTSC frames exactly, including long positions", () => {
    for (const frame of [0n, 1n, 1800n, 999999999n])
      expect(frameAt(frameTime(frame, "30000/1001"), "30000/1001")).toBe(frame);
    expect(frameTime(1n, "30000/1001")).toBe("1001/30000s");
    expect(pointerTime(48, 48, "25")).toBe("1s");
    expect(frameTime(-1n, "25")).toBe("0s");
  });
  it("maps linear, hold, reverse and smooth-as-linear segments", () => {
    const clip: ClipView = {
      id: "c",
      media_id: "m",
      label: null,
      enabled: true,
      timeline_in: { t: "0s" },
      timeline_out: { t: "4s" },
      source_in: { t: "2s" },
      source_out: { t: "6s" },
      speed: "1",
    };
    expect(printRational(sourceAt(clip, "1s"), true)).toBe("3s");
    for (const interp of ["linear", "smooth", "hold"]) {
      clip.time_map = [
        { at: { t: "0s" }, source: { t: "6s" }, interp },
        { at: { t: "4s" }, source: { t: "2s" }, interp: "linear" },
      ];
      expect(printRational(sourceAt(clip, "1s"), true)).toBe(interp === "hold" ? "6s" : "5s");
    }
  });
});

it("reverses every audio channel without changing the decoded source", async () => {
  const { reverseBuffer } = await import("../src/reverse-audio.js");
  const channels = [new Float32Array([0.1, -0.5, 1]), new Float32Array([0, 0.25, -1])];
  const reversed = channels.map(() => new Float32Array(3));
  const input = {
    numberOfChannels: 2,
    length: 3,
    sampleRate: 48000,
    getChannelData: (index: number) => channels[index],
  } as AudioBuffer;
  const output = { getChannelData: (index: number) => reversed[index] } as AudioBuffer;
  const context = {
    createBuffer: (count: number, length: number, rate: number) => {
      expect([count, length, rate]).toEqual([2, 3, 48000]);
      return output;
    },
  };
  expect(reverseBuffer(context, input)).toBe(output);
  expect([...(reversed[0] ?? [])]).toEqual([...(channels[0] ?? [])].reverse());
  expect([...(reversed[1] ?? [])]).toEqual([-1, 0.25, 0]);
  expect(channels[0]?.[2]).toBe(1);
});
