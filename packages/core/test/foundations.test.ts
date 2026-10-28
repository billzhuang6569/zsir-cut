import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  parseProject,
  parseRational,
  printRational,
  rational,
  sourceFrameAt,
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

it("shows the frame immediately before an exact reverse source boundary", async () => {
  const parsed = parseProject(await readFile("fixtures/projects/std-25.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("Fixture invalid");
  const track = parsed.project.timelines[0]?.tracks.find((entry) => entry.id === "trk_v1");
  const clip = track?.kind === "video" ? track.clips.find((entry) => entry.id === "clp_v7") : undefined;
  if (!clip) throw new Error("Reverse clip missing");
  expect(sourceFrameAt(clip, rational(2n), rational(25n))).toBe(1049n);
  expect(sourceFrameAt(clip, rational(1n, 25n), rational(25n))).toBe(1098n);
  expect(() => sourceFrameAt(clip, clip.duration, rational(25n))).toThrow(RangeError);
});

it("keeps a hold frame when its endpoint points backward", async () => {
  const parsed = parseProject(await readFile("fixtures/regressions/hold-falling-end-25.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("Regression fixture invalid");
  const track = parsed.project.timelines[0]?.tracks[0];
  if (track?.kind !== "video" || !track.clips[0]) throw new Error("Hold clip missing");
  expect(sourceFrameAt(track.clips[0], rational(0n), rational(25n))).toBe(25n);
  expect(sourceFrameAt(track.clips[0], rational(24n, 25n), rational(25n))).toBe(25n);
});

describe("timecode", () => {
  for (const [rate, fps] of [
    ["24000/1001", 24n],
    ["24", 24n],
    ["25", 25n],
    ["30000/1001", 30n],
    ["30", 30n],
    ["50", 50n],
    ["60000/1001", 60n],
    ["60", 60n],
  ] as const) {
    it(`${rate} round trips zero, one hour and the last frame of the day`, () => {
      for (const [frame, tc] of [
        [0n, "00:00:00:00"],
        [fps * 3600n, "01:00:00:00"],
        [fps * 86400n - 1n, `23:59:59:${fps - 1n}`],
      ] as const) {
        expect(frameToTimecode(frame, rate)).toBe(tc);
        expect(timecodeToFrame(tc, rate)).toBe(frame);
      }
      expect(frameToTimecode(fps * 86400n, rate)).toBe("00:00:00:00");
      expect(() => timecodeToFrame(`00:00:00:${fps}`, rate)).toThrow();
      if (rate !== "30000/1001" && rate !== "60000/1001") expect(() => frameToTimecode(0n, rate, true)).toThrow();
    });
  }
  for (const [rate, fps, dropped] of [
    ["30000/1001", 30n, 2n],
    ["60000/1001", 60n, 4n],
  ] as const) {
    it(`${rate} handles DF minute boundaries, day rollover and a nonzero start`, () => {
      const minute = fps * 60n,
        block = minute * 10n - dropped * 9n;
      const day = block * 144n;
      for (const [frame, tc] of [
        [0n, "00:00:00;00"],
        [minute - 1n, `00:00:59;${fps - 1n}`],
        [minute, `00:01:00;0${dropped}`],
        [block - 1n, `00:09:59;${fps - 1n}`],
        [block, "00:10:00;00"],
        [block * 6n, "01:00:00;00"],
        [day - 1n, `23:59:59;${fps - 1n}`],
      ] as const) {
        expect(frameToTimecode(frame, rate, true)).toBe(tc);
        expect(timecodeToFrame(tc, rate)).toBe(frame);
      }
      for (let number = 0n; number < dropped; number++)
        expect(() => timecodeToFrame(`00:01:00;0${number}`, rate)).toThrow();
      expect(frameToTimecode(day, rate, true)).toBe("00:00:00;00");
      expect(frameToTimecode(minute, rate, true, "01:00:00;00")).toBe(`01:01:00;0${dropped}`);
    });
  }
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
