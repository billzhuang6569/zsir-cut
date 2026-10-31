import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { directStyleLosses } from "../../core/src/direct-export.ts";
import { parseProject } from "../../core/src/index.ts";
import { fcpxmlExporter, otioExporter, xmemlExporter } from "../src/index.ts";
import { type RenderStyle, renderSubtitle } from "../src/subtitle-render.ts";
import { renderSubtitle as renderLegacySubtitle } from "./legacy-subtitle-render.ts";

expect(
  GlobalFonts.registerFromPath(
    fileURLToPath(new URL("../../../fixtures/fonts/Roboto-Regular.ttf", import.meta.url)),
    "ZcutTestRoboto",
  ),
).not.toBeNull();

const base: RenderStyle = {
  font_family: "ZcutTestRoboto",
  font_size: 0.25,
  color: "#FFFFFF",
  outline: { color: "#000000", width: 0.06 },
  box: { color: "#20406088", padding: 0.2, radius: 0.1 },
};
const cases: Record<string, Partial<RenderStyle>> = {
  legacy: {},
  italic: { italic: true },
  underline: { underline: true },
  spacing: { letter_spacing: 0.3 },
  negative_spacing: { letter_spacing: -0.2 },
  left: { align: "left" },
  right: { align: "right" },
  outlines: {
    outlines: [
      { color: "#FF0000", width: 0.08 },
      { color: "#0000FF", width: 0.18 },
      { color: "#FFFF00", width: 0.03 },
    ],
  },
  shadow: { shadow: { color: "#FF0000AA", blur: 0.15, distance: 0.4, angle: 45 } },
  glow: { glow: { color: "#00FFFF", blur: 0.3 } },
  combined: {
    italic: true,
    underline: true,
    letter_spacing: 0.1,
    align: "right",
    outlines: [
      { color: "#880000", width: 0.2 },
      { color: "#FFAA00", width: 0.08 },
    ],
    shadow: { color: "#FF0000AA", blur: 0.15, distance: 0.4, angle: 45 },
    glow: { color: "#00FFFF", blur: 0.3 },
  },
};
function draw(style: RenderStyle, text = "Subtitle\nLegacy") {
  const canvas = createCanvas(320, 180);
  renderSubtitle(canvas.getContext("2d"), text, style, 320, 180);
  return canvas;
}
const pixels = (canvas: ReturnType<typeof createCanvas>) =>
  Buffer.from(canvas.getContext("2d").getImageData(0, 0, 320, 180).data);
const maxDifferentFraction = 0.005;
function differentFraction(actual: Buffer, expected: Buffer) {
  expect(actual.length).toBe(expected.length);
  let different = 0;
  for (let i = 0; i < actual.length; i += 4) {
    if ([0, 1, 2, 3].some((channel) => Math.abs((actual[i + channel] ?? 0) - (expected[i + channel] ?? 0)) > 24))
      different++;
  }
  return different / (actual.length / 4);
}
it("counts a pixel once only when an RGBA channel differs by more than 24", () => {
  expect(differentFraction(Buffer.from([24, 24, 24, 24, 0, 0, 0, 0]), Buffer.alloc(8))).toBe(0);
  for (const channel of [0, 1, 2, 3]) {
    const actual = Buffer.alloc(8);
    actual[channel] = 25;
    expect(differentFraction(actual, Buffer.alloc(8))).toBe(0.5);
  }
  expect(differentFraction(Buffer.alloc(8, 25), Buffer.alloc(8))).toBe(1);
});
it.each(Object.entries(cases))(
  "matches the %s Node golden within anti-aliasing tolerance and repeats deterministically",
  async (name, fields) => {
    const style = { ...base, ...fields };
    const reference = createCanvas(320, 180);
    reference
      .getContext("2d")
      .drawImage(
        await loadImage(
          await readFile(new URL(`../../../fixtures/golden/subtitle-styles/${name}.png`, import.meta.url)),
        ),
        0,
        0,
      );
    const canvas = draw(style);
    const rendered = pixels(canvas);
    expect(differentFraction(rendered, pixels(reference))).toBeLessThanOrEqual(maxDifferentFraction);
    expect(canvas.toBuffer("image/png").equals(draw(style).toBuffer("image/png"))).toBe(true);
    if (name !== "legacy")
      expect(differentFraction(rendered, pixels(draw(base)))).toBeGreaterThan(maxDifferentFraction * 2.5);
  },
);
it.each([
  [
    "outline only",
    {
      font_family: base.font_family,
      font_size: base.font_size,
      color: base.color,
      outline: { color: "#000000", width: 0.06 },
    },
    "Subtitle",
  ],
  ["box", base, "Subtitle"],
  ["multi-line", { ...base, line_spacing: 1.5 }, "Subtitle\nLegacy"],
  ["top anchor", { ...base, position: { anchor: "top", margin_v: 0.1 } }, "Subtitle"],
  ["middle anchor", { ...base, position: { anchor: "middle", margin_v: 0.3 } }, "Subtitle"],
  ["left offset", { ...base, position: { anchor: "bottom", margin_v: 0.08, offset_x: -0.2 } }, "Subtitle"],
  ["right offset", { ...base, position: { anchor: "bottom", margin_v: 0.08, offset_x: 0.2 } }, "Subtitle"],
  ["max_width wrapping", { ...base, position: { anchor: "top", margin_v: 0.05, max_width: 0.3 } }, "Subtitle Legacy"],
] as const)("keeps %s pixels byte-identical to the frozen pre-S4.5 renderer", (_name, style, text) => {
  const legacy = createCanvas(320, 180);
  renderLegacySubtitle(legacy.getContext("2d"), text, style, 320, 180);
  expect(pixels(draw(style, text)).equals(pixels(legacy))).toBe(true);
});
it("sorts outlines widest first, ignores legacy outline when layers exist, and stores animation without rendering it", () => {
  const outlines = cases.outlines?.outlines ?? [];
  const first = pixels(draw({ ...base, outlines }));
  expect(
    first.equals(pixels(draw({ ...base, outlines: [...outlines].reverse(), outline: { color: "#FF00FF", width: 2 } }))),
  ).toBe(true);
  expect(
    pixels(
      draw({
        ...base,
        highlight: { color: "#FF0000" },
        animation: { word: "jump", in: { type: "pop", duration: "1/2s" } },
      }),
    ).equals(pixels(draw(base))),
  ).toBe(true);
});
it("includes spacing in wrap decisions and returns the shared selection geometry", () => {
  const canvas = createCanvas(320, 180);
  const plain = renderSubtitle(
    canvas.getContext("2d"),
    "Subtitle Subtitle",
    { ...base, position: { anchor: "top", margin_v: 0.1, max_width: 0.5 } },
    320,
    180,
  );
  const spaced = renderSubtitle(
    canvas.getContext("2d"),
    "Subtitle Subtitle",
    { ...base, letter_spacing: 1, position: { anchor: "top", margin_v: 0.1, max_width: 0.5 } },
    320,
    180,
  );
  expect(spaced.lines.length).toBeGreaterThan(plain.lines.length);
  expect(spaced.bounds.y).toBe(18);
  expect(spaced.bounds.height).toBeGreaterThan(plain.bounds.height);
});
it.each([
  ["fcp-11-fcpxml-1.13", fcpxmlExporter],
  ["resolve-18.5-otio", otioExporter],
  ["premiere-25-xmeml-5", xmemlExporter],
] as const)("reports all unsupported fields once per style for %s", async (profile, exporter) => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok || !parsed.project.timelines[0]) throw new Error("fixture");
  const project = parsed.project;
  const style = project.subtitle_styles[0];
  if (!style) throw new Error("style");
  Object.assign(style, cases.combined, { highlight: { color: "#FF0000" }, animation: { word: "highlight" } });
  const srtLoss = directStyleLosses(project).find((item) => item.entity_id === style.id);
  expect(srtLoss).toMatchObject({
    reason_code: "R_STYLE_NOT_REPRESENTABLE",
    consequence: expect.stringContaining("highlight、animation"),
  });
  const losses = exporter
    .losses(project, parsed.project.timelines[0], profile)
    .filter((item) => item.entity_id === style.id && item.reason_code === "R_STYLE_NOT_REPRESENTABLE");
  expect(losses).toHaveLength(1);
  for (const field of [
    "italic",
    "underline",
    "letter_spacing",
    "align",
    "outlines",
    "shadow",
    "glow",
    "highlight",
    "animation",
  ])
    expect(losses[0]?.consequence).toContain(field);
});
