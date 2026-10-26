import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  add,
  ceil,
  compare,
  div,
  fingerprint,
  floor,
  frameToTimecode,
  mul,
  parseRational,
  printRational,
  rational,
  sub,
  timecodeToFrame,
} from "../src/index.js";

describe("rational", () => {
  it("parses and prints canonical time and rate", () => {
    expect(printRational(parseRational("1001/200s", true), true)).toBe("1001/200s");
    expect(printRational(parseRational("30000/1001"))).toBe("30000/1001");
    expect(printRational(rational(2n, 4n), true)).toBe("1/2s");
    for (const value of ["2/4s", "0/2s", "01s", "1/0s", "-1s", "1.5s"])
      expect(() => parseRational(value, true)).toThrow();
  });
  it("does exact arithmetic and negative rounding", () => {
    const a = rational(1n, 3n),
      b = rational(1n, 6n);
    expect(add(a, b)).toEqual(rational(1n, 2n));
    expect(sub(a, b)).toEqual(b);
    expect(mul(a, b)).toEqual(rational(1n, 18n));
    expect(div(a, b)).toEqual(rational(2n));
    expect(compare(a, b)).toBe(1);
    expect(floor(rational(-4n, 3n))).toBe(-2n);
    expect(ceil(rational(-4n, 3n))).toBe(-1n);
    expect(() => div(a, rational(0n))).toThrow();
  });
});

describe("timecode", () => {
  it("handles known drop-frame values and inverse", () => {
    for (const [frame, code] of [
      [0n, "00:00:00;00"],
      [1800n, "00:01:00;02"],
      [17982n, "00:10:00;00"],
      [107892n, "01:00:00;00"],
    ] as const) {
      expect(frameToTimecode(frame, "30000/1001", true)).toBe(code);
      expect(timecodeToFrame(code, "30000/1001")).toBe(frame);
    }
    expect(() => timecodeToFrame("00:01:00;00", "30000/1001")).toThrow();
  });
  it("supports non-drop and arbitrary starts", () => {
    expect(frameToTimecode(25n, "25", false, "10:00:01:12")).toBe("10:00:02:12");
    expect(frameToTimecode(1800n, "30000/1001", false)).toBe("00:01:00:00");
    expect(frameToTimecode(1800n, "30000/1001", true, "10:00:00;00")).toBe("10:01:00;02");
    expect(timecodeToFrame("10:00:01;12", "30000/1001")).toBe(1078962n);
  });
});

describe("sampled-sha256-v1", () => {
  it("hashes the whole file through 12 MiB and samples above it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-fingerprint-"));
    try {
      const path = join(directory, "media.bin");
      const block = 4 * 1024 * 1024;
      const whole = Buffer.alloc(block * 3, 7);
      await writeFile(path, whole);
      expect((await fingerprint(path)).value).toBe(createHash("sha256").update(whole).digest("hex"));
      const large = Buffer.alloc(block * 3 + 5, 7);
      large[block + 1] = 9;
      await writeFile(path, large);
      const expected = createHash("sha256")
        .update(`${large.length}\n`)
        .update(large.subarray(0, block))
        .update(large.subarray(Math.floor((large.length - block) / 2), Math.floor((large.length - block) / 2) + block))
        .update(large.subarray(large.length - block))
        .digest("hex");
      expect((await fingerprint(path)).value).toBe(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
