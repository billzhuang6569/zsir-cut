import { describe, expect, it } from "vitest";
import { decodeBarcode } from "./barcode.js";
import { baseFrame, HEIGHT, isWhiteFrame, overlayText, WIDTH } from "./picture.js";

describe("picture geometry", () => {
  it("marks the frames containing integer seconds", () => {
    expect([0, 25, 50].every((n) => isWhiteFrame(n, 25, 1))).toBe(true);
    expect(isWhiteFrame(24, 25, 1)).toBe(false);
    expect([0, 29, 59, 89].every((n) => isWhiteFrame(n, 30000, 1001))).toBe(true);
    expect(isWhiteFrame(30, 30000, 1001)).toBe(false);
    for (let k = 0; k < 120; k++) {
      const n = Math.floor((k * 30000) / 1001);
      expect(isWhiteFrame(n, 30000, 1001)).toBe(true);
      expect(n * 1001 <= k * 30000 && k * 30000 < (n + 1) * 1001).toBe(true);
    }
  });
  it("puts the 48 checksum bits on the bottom strip", () => {
    const frame = baseFrame(12, 17982, 30000, 1001);
    const bits = Array.from({ length: 48 }, (_, x) => Number(frame[((HEIGHT - 8) * WIDTH + x * 20 + 10) * 3]! > 127));
    expect(decodeBarcode(bits)).toEqual({ id: 12, frame: 17982 });
  });
  it("draws readable light and dark text on normal and white frames", () => {
    const rgba = Buffer.from([128, 128, 128, 128]);
    const normal = baseFrame(1, 1, 25, 1);
    const white = baseFrame(1, 0, 25, 1);
    overlayText(normal, rgba, 1, 1, 0, 0);
    overlayText(white, rgba, 1, 1, 0, 0, true);
    expect(normal[0]).toBeGreaterThan(38);
    expect(white[0]).toBeLessThan(255);
  });
});
