import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { type RenderStyle, SUBTITLE_FALLBACK_FONTS, subtitleFontFamily } from "./subtitle-render.ts";

let fontFiles: string[] | undefined;
const resolved = new Set<string>();
const glyphs = new Map<string, boolean>();
const fontName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.(ttc|ttf|otf|otc)$/i, "")
    .replace(/[\s_-]/g, "")
    .replace(/(sc|tc|hk|jp|gb)$/, "");

export function resolveSubtitleFont(family: string): boolean {
  if (GlobalFonts.has(family)) return true;
  if (resolved.has(family)) return false;
  resolved.add(family);
  fontFiles ??= globSync([
    "/System/Library/Fonts/**/*.{ttf,otf,ttc,otc}",
    "/Library/Fonts/**/*.{ttf,otf,ttc,otc}",
    `${homedir()}/Library/Fonts/**/*.{ttf,otf,ttc,otc}`,
    "/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/*.{ttf,otf,ttc,otc}",
  ]).sort();
  for (const path of fontFiles) {
    if (!fontName(basename(path)).includes(fontName(family))) continue;
    try {
      if (GlobalFonts.registerFromPath(path)) glyphs.clear();
      if (!GlobalFonts.has(family) && /\.(ttc|otc)$/i.test(path)) {
        const collection = readFileSync(path);
        if (collection.length < 12 || collection.toString("ascii", 0, 4) !== "ttcf") continue;
        const count = collection.readUInt32BE(8);
        if (count > (collection.length - 12) / 4) continue;
        // Canvas loads only the first TTC face; select other faces in memory, keeping table offsets intact.
        for (let index = 1; index < count && !GlobalFonts.has(family); index++) {
          const offset = collection.readUInt32BE(12 + index * 4);
          if (offset > collection.length - 12) continue;
          collection.writeUInt32BE(offset, 12);
          if (GlobalFonts.register(collection)) glyphs.clear();
        }
      }
    } catch {
      // An unreadable or invalid local font must not prevent trying the next font.
    }
    if (GlobalFonts.has(family)) return true;
  }
  return false;
}

export function checkSubtitleFont(text: string, style: Pick<RenderStyle, "font_family" | "font_weight">) {
  const found = resolveSubtitleFont(style.font_family);
  for (const family of SUBTITLE_FALLBACK_FONTS) resolveSubtitleFont(family);
  const font = `${style.font_weight ?? 400} 32px ${subtitleFontFamily(style.font_family)}`;
  const canvas = createCanvas(80, 80);
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  const pixels = (char: string) => {
    ctx.clearRect(0, 0, 80, 80);
    ctx.fillText(char, 4, 48);
    return Buffer.from(ctx.getImageData(0, 0, 80, 80).data);
  };
  // Noncharacters have no glyph: compare ink, not advance widths (CJK is monospaced).
  const notdef = pixels("\u{10ffff}");
  const missing = [...new Set(text)].filter((char) => {
    if (/\s/u.test(char)) return false;
    const key = JSON.stringify([font, char]);
    let has = glyphs.get(key);
    if (has === undefined) {
      has = !pixels(char).equals(notdef);
      glyphs.set(key, has);
    }
    return !has;
  });
  return { found, missing };
}
