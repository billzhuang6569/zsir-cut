import { globSync } from "node:fs";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { expect, it, vi } from "vitest";
import { checkSubtitleFont, resolveSubtitleFont } from "../src/subtitle-fonts.ts";
import { renderSubtitle, SUBTITLE_FALLBACK_FONTS, subtitleFontFamily } from "../src/subtitle-render.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, globSync: vi.fn(fs.globSync) };
});

it("checks registered fonts first and caches one scan across missing families", () => {
  const registered = GlobalFonts.families[0]?.family;
  if (registered) {
    expect(resolveSubtitleFont(registered)).toBe(true);
    expect(globSync).not.toHaveBeenCalled();
  }
  expect(resolveSubtitleFont("Missing Zcut Scan Font")).toBe(false);
  expect(resolveSubtitleFont("Missing Zcut Scan Font")).toBe(false);
  expect(resolveSubtitleFont("Another Missing Zcut Font")).toBe(false);
  expect(globSync).toHaveBeenCalledTimes(1);
});

it("registers a discovered PingFang collection when available", (context) => {
  const found = resolveSubtitleFont("PingFang SC");
  if (!found) {
    context.skip("PingFang is not installed; Chinese fallback coverage is checked separately.");
    return;
  }
  expect(GlobalFonts.has("PingFang SC")).toBe(true);
  expect(GlobalFonts.families.some((font) => font.family === "PingFang SC")).toBe(true);
  expect(checkSubtitleFont("在物美很多商场都有", { font_family: "PingFang SC" })).toEqual({ found: true, missing: [] });
});

it.each(["PingFang SC", "Missing Zcut Chinese Font"])(
  "renders every Chinese character without .notdef using %s",
  (family, context) => {
    const text = "在物美很多商场都有";
    const style = { font_family: family, font_size: 0.2, color: "#ffffff" };
    const checked = checkSubtitleFont(text, style);
    if (!SUBTITLE_FALLBACK_FONTS.some((font) => GlobalFonts.has(font))) {
      context.skip("No Chinese font from the subtitle fallback chain is installed in this CI environment.");
      return;
    }
    expect(checked.missing).toEqual([]);
    const canvas = createCanvas(160, 160);
    const ctx = canvas.getContext("2d");
    const raster = (char: string) => {
      ctx.clearRect(0, 0, 160, 160);
      renderSubtitle(ctx, char, style, 160, 160);
      return Buffer.from(ctx.getImageData(0, 0, 160, 160).data);
    };
    const notdef = raster("\u{10ffff}");
    for (const char of text) {
      const actual = raster(char);
      expect(actual.equals(notdef), `${char} must not render as tofu`).toBe(false);
      expect(
        actual.some((value, index) => index % 4 === 3 && value > 0),
        `${char} must have ink`,
      ).toBe(true);
    }
  },
);

it("reports truly missing characters and shares the ordered CSS/Canvas chain", () => {
  expect(checkSubtitleFont("A\n \u{10ffff}\u{10ffff}", { font_family: "sans-serif" }).missing).toEqual(["\u{10ffff}"]);
  expect(subtitleFontFamily("Custom")).toBe(
    '"Custom", "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Heiti TC", "Songti SC", sans-serif',
  );
  expect(subtitleFontFamily("PingFang SC").match(/PingFang SC/g)).toHaveLength(1);
});
