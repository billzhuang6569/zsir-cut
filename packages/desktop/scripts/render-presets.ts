// Run from the repository root: node packages/desktop/scripts/render-presets.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveSubtitleFont } from "../../exporters/src/subtitle-fonts.ts";
import type { SubtitleCanvas } from "../../exporters/src/subtitle-render.ts";
import { renderPreset, subtitlePresets } from "../src/subtitle-presets.ts";

// Reuse the exporter's installed Node canvas dependency.
const { createCanvas } = createRequire(new URL("../../exporters/package.json", import.meta.url))(
  "@napi-rs/canvas",
) as typeof import("../../exporters/node_modules/@napi-rs/canvas/index.js");
assert(subtitlePresets.length >= 12);
for (const family of new Set(subtitlePresets.map((preset) => preset.fields.font_family))) {
  assert(resolveSubtitleFont(family), `Missing local font: ${family}`);
}
const width = 360,
  height = 240,
  caption = 32,
  columns = 3;
const canvas = createCanvas(columns * width, Math.ceil(subtitlePresets.length / columns) * (height + caption));
const ctx = canvas.getContext("2d");
for (const [i, preset] of subtitlePresets.entries()) {
  const x = (i % columns) * width,
    y = Math.floor(i / columns) * (height + caption);
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.rect(0, 0, width, height + caption);
  ctx.clip();
  renderPreset(ctx as unknown as SubtitleCanvas, preset.fields, width, height);
  ctx.fillStyle = "#1C1E22";
  ctx.fillRect(0, height, width, caption);
  ctx.fillStyle = "#E9EAED";
  ctx.font = '14px "PingFang SC"';
  ctx.fillText(`${preset.group} · ${preset.name}`, 12, height + 22);
  ctx.restore();
}
const directory = new URL("../../../.tmp/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = new URL("presets-sheet.png", directory);
const png = canvas.toBuffer("image/png");
assert(png.length > 1000 && png.subarray(1, 4).toString() === "PNG");
await writeFile(output, png);
console.log(`${subtitlePresets.length} presets: ${fileURLToPath(output)}`);
