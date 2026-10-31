import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { expect, it, vi } from "vitest";
import { parseProject, projectSubtitles } from "../../core/src/index.ts";
import { rational as q } from "../../core/src/rational.ts";
import {
  type RenderStyle,
  renderSubtitle,
  type SubtitleFrame,
  subtitleAnimationState,
} from "../src/subtitle-render.ts";
import { renderSubtitle as renderS45 } from "./s45-subtitle-render.ts";

GlobalFonts.registerFromPath(
  fileURLToPath(new URL("../../../fixtures/fonts/Roboto-Regular.ttf", import.meta.url)),
  "ZcutTestRoboto",
);
const base: RenderStyle = {
  font_family: "ZcutTestRoboto",
  font_size: 0.2,
  color: "#FFFFFF",
  highlight: { color: "#FF8800" },
  outlines: [{ color: "#000000", width: 0.04 }],
  position: { anchor: "middle", margin_v: 0 },
};
const cases: [string, NonNullable<RenderStyle["animation"]>][] = [
  ...(["fade", "rise", "pop", "typewriter"] as const).map(
    (type) => [`in-${type}`, { in: { type, duration: q(1n) } }] as [string, NonNullable<RenderStyle["animation"]>],
  ),
  ...(["fade", "sink", "pop"] as const).map(
    (type) => [`out-${type}`, { out: { type, duration: q(1n) } }] as [string, NonNullable<RenderStyle["animation"]>],
  ),
  ...(["highlight", "fill", "jump"] as const).map(
    (word) => [`word-${word}`, { word }] as [string, NonNullable<RenderStyle["animation"]>],
  ),
];
const frame = (t = q(1n, 2n)): SubtitleFrame => ({
  t,
  duration: q(2n),
  words: [
    { text: "Hello", start: q(0n), end: q(1n) },
    { text: "world", start: q(1n), end: q(2n) },
  ],
});
function draw(style: RenderStyle, at?: SubtitleFrame, text = "Hello world") {
  const canvas = createCanvas(320, 180);
  renderSubtitle(canvas.getContext("2d"), text, style, 320, 180, at);
  return canvas;
}
const pixels = (canvas: ReturnType<typeof createCanvas>) =>
  Buffer.from(canvas.getContext("2d").getImageData(0, 0, 320, 180).data);
it.each(
  cases.flatMap(([name, animation]) =>
    (["start", "middle", "end"] as const).map((moment, index) => ({
      name: `${name}-${moment}`,
      animation,
      t: name.startsWith("out")
        ? q(BigInt(index + 2), 2n)
        : name.startsWith("word")
          ? index === 1
            ? q(3n, 2n)
            : q(BigInt(index))
          : q(BigInt(index), 2n),
    })),
  ),
)("matches $name golden with the S4.5 cross-OS tolerance and deterministic pixels", async ({ name, animation, t }) => {
  const canvas = draw({ ...base, animation }, frame(t));
  const expected = createCanvas(320, 180);
  expected
    .getContext("2d")
    .drawImage(
      await loadImage(
        await readFile(new URL(`../../../fixtures/golden/subtitle-animation/${name}.png`, import.meta.url)),
      ),
      0,
      0,
    );
  const actual = pixels(canvas),
    reference = pixels(expected);
  let different = 0;
  for (let i = 0; i < actual.length; i += 4)
    if ([0, 1, 2, 3].some((c) => Math.abs((actual[i + c] ?? 0) - (reference[i + c] ?? 0)) > 24)) different++;
  expect(different / (actual.length / 4)).toBeLessThanOrEqual(0.005);
  expect(pixels(draw({ ...base, animation }, frame(t))).equals(actual)).toBe(true);
});
it.each(cases)("keeps %s without t byte-identical to S4.5, including all static effects", (_name, animation) => {
  const style = {
    ...base,
    animation,
    italic: true,
    underline: true,
    letter_spacing: 0.1,
    shadow: { color: "#AA0000", blur: 0.1, distance: 0.2, angle: 60 },
    glow: { color: "#00FF00", blur: 0.2 },
  };
  const expected = createCanvas(320, 180);
  renderS45(expected.getContext("2d"), "Hello world", style, 320, 180);
  expect(pixels(draw(style)).equals(pixels(expected))).toBe(true);
});
it("computes easing, clamping and half-open word boundaries with exact rational time", () => {
  const state = (style: Partial<RenderStyle>, time = frame()) =>
    subtitleAnimationState("Hello world", { ...base, ...style }, time);
  expect(state({ animation: { in: { type: "fade", duration: "9s" } } }).opacity).toBe(0.875);
  expect(state({ animation: { out: { type: "fade", duration: "1s" } } }, frame(q(3n, 2n))).opacity).toBe(0.875);
  expect(state({ animation: { in: { type: "rise", duration: "1s" } } }).offset).toBe(0.0625);
  expect(state({ animation: { in: { type: "pop", duration: "1s" } } }).scale).toBe(0.95);
  expect(state({ animation: { in: { type: "typewriter", duration: "1s" } } }).visible).toBe(9);
  expect(state({ animation: { word: "highlight" } }, frame(q(1n))).words.map((word) => word.fill)).toEqual([0, 1]);
  const huge = 9007199254740993n;
  const timed = {
    t: q(huge * 2n + 1n, 2n),
    duration: q(huge + 1n),
    words: [{ text: "Hello world", start: q(huge), end: q(huge + 1n) }],
  };
  expect(state({ animation: { word: "fill" } }, timed).words[0]?.fill).toBe(0.5);
});
it("disables word animation for overrides, missing or incomplete times and preserves the static frame", () => {
  const style = { ...base, animation: { word: "jump" as const } };
  for (const at of [
    { ...frame(), text_override: true },
    { t: q(0n), duration: q(2n) },
    { ...frame(), words: frame().words?.slice(0, 1) },
  ]) {
    expect(subtitleAnimationState("Hello world", style, at).words).toEqual([]);
    expect(pixels(draw(style, at)).equals(pixels(draw(style)))).toBe(true);
  }
});
it("fills the current word progressively, retains completed words and handles inserted line breaks", () => {
  const style = { ...base, animation: { word: "fill" as const } };
  const state = (t: ReturnType<typeof q>) => subtitleAnimationState("Hello\nworld", style, frame(t));
  expect(state(q(0n)).words.map((word) => word.fill)).toEqual([0, 0]);
  expect(state(q(1n, 2n)).words.map((word) => word.fill)).toEqual([0.5, 0]);
  expect(state(q(3n, 2n)).words.map((word) => word.fill)).toEqual([1, 0.5]);
  expect(pixels(draw(style, frame(q(1n, 4n)))).equals(pixels(draw(style, frame(q(3n, 4n)))))).toBe(false);
});

it("keeps jump word centres fixed and preserves the space beside each scaled word", async () => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/regressions/subtitle-jump-spacing.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const cue = projectSubtitles(parsed.project, "tl_main").cues[0];
  const style = parsed.project.subtitle_styles[0];
  if (!cue || !style) throw new Error("Missing jump regression cue/style");
  expect(cue.text).toBe("Hello world");
  const ctx = createCanvas(320, 180).getContext("2d");
  const words: { text: string; centre: number; left: number; right: number; scale: number; y: number }[] = [];
  let spaceWidth = 0;
  const spy = vi.spyOn(ctx, "fillText").mockImplementation((text, x, y) => {
    if (!text.trim()) return;
    spaceWidth = ctx.measureText(" ").width;
    const transform = ctx.getTransform();
    const centre = transform.a * x + transform.e;
    const half = (ctx.measureText(text).width * transform.a) / 2;
    const centreY = y - (180 * style.font_size * (0.8 - 0.2)) / 2;
    words.push({
      text,
      centre,
      left: centre - half,
      right: centre + half,
      scale: transform.a,
      y: transform.d * centreY + transform.f,
    });
  });
  try {
    for (const t of [q(0n), q(3n, 2n), q(2n)]) {
      const start = words.length;
      renderSubtitle(ctx, cue.text, style, 320, 180, { ...frame(t), words: cue.words });
      const pair = words.slice(start);
      expect(pair.map((word) => word.text)).toEqual(["Hello", "world"]);
      expect((pair[1]?.left ?? 0) - (pair[0]?.right ?? 0)).toBeGreaterThanOrEqual(spaceWidth);
    }
    const resting = words.slice(4);
    expect(resting.map((word) => word.text)).toEqual(["Hello", "world"]);
    for (const [index, pair] of [words.slice(0, 2), words.slice(2, 4), resting].entries()) {
      for (const [i, word] of pair.entries()) {
        expect(word.centre).toBeCloseTo(resting[i]?.centre ?? 0, 4);
        expect(word.y).toBeCloseTo(resting[i]?.y ?? 0, 4);
        expect(word.scale).toBeCloseTo(i === index ? 1.15 : 1, 4);
      }
    }
  } finally {
    spy.mockRestore();
  }
});

it("preserves the empty static box and restores caller drawing state after animation", () => {
  const style = {
    ...base,
    box: { color: "#FF0000", padding: 0.2 },
    animation: { in: { type: "fade" as const, duration: "1s" } },
  };
  const expected = createCanvas(320, 180);
  renderS45(expected.getContext("2d"), "", style, 320, 180);
  expect(pixels(draw(style, undefined, "")).equals(pixels(expected))).toBe(true);
  const canvas = createCanvas(320, 180),
    ctx = canvas.getContext("2d");
  ctx.globalAlpha = 0.6;
  renderSubtitle(ctx, "Hello world", style, 320, 180, frame());
  expect(ctx.globalAlpha).toBeCloseTo(0.6, 2);
  expect(ctx.getTransform().isIdentity).toBe(true);
});
