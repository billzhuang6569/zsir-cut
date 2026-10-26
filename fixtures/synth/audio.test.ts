import { describe, expect, it } from "vitest";
import { pcmSample } from "./audio.js";

describe("synth audio", () => {
  it("uses the same channel-zero samples for both A rates and shifted external audio", () => {
    const tokens = [{ index: 0, text: "大家", start_ms: 500, end_ms: 900 }];
    for (const sample of [1, 24001, 48001, 96001]) {
      expect(pcmSample(sample, 1, tokens)[0]).toBe(pcmSample(sample, 11, tokens)[0]);
      expect(pcmSample(sample, 1, tokens)[0]).toBe(pcmSample(sample + 96000, 21, tokens, true)[0]);
    }
    expect(pcmSample(48000, 21, tokens, true)[0]).toBe(0);
  });
});
