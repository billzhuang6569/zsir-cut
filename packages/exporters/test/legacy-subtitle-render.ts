// Frozen reference: packages/exporters/src/subtitle-render.ts at ecb3afd (pre-S4.5). Do not update.
/** Browser and Node canvases share this renderer; all dimensions are canvas pixels. */
export interface RenderStyle {
  font_family: string;
  font_weight?: number;
  font_size: number;
  color: string;
  outline?: { color: string; width: number };
  box?: { color: string; padding?: number; radius?: number };
  position?: { anchor: "bottom" | "top" | "middle"; margin_v: number; offset_x?: number; max_width?: number };
  line_spacing?: number;
  max_lines?: number;
}
export type SubtitleCanvas = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "measureText"
  | "fillText"
  | "strokeText"
  | "beginPath"
  | "roundRect"
  | "fill"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "lineJoin"
  | "lineWidth"
  | "fillStyle"
  | "strokeStyle"
>;

export const SUBTITLE_FALLBACK_FONTS = [
  "PingFang SC",
  "Hiragino Sans GB",
  "Heiti SC",
  "Heiti TC",
  "Songti SC",
] as const;

export function subtitleFontFamily(family = "PingFang SC") {
  return `${[...new Set([family, ...SUBTITLE_FALLBACK_FONTS])].map((name) => JSON.stringify(name)).join(", ")}, sans-serif`;
}

export function renderSubtitle(ctx: SubtitleCanvas, text: string, style: RenderStyle, width: number, height: number) {
  ctx.save();
  try {
    const size = height * style.font_size;
    ctx.font = `${style.font_weight ?? 400} ${size}px ${subtitleFontFamily(style.font_family)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    const limit = width * (style.position?.max_width ?? 0.8);
    const lines: string[] = [];
    for (const explicit of text.split("\n")) {
      let line = "";
      for (const char of explicit) {
        if (line && ctx.measureText(line + char).width > limit) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
      lines.push(line);
    }
    const metrics = lines.map((line) => ctx.measureText(line));
    const ascent = Math.max(size * 0.8, ...metrics.map((item) => item.actualBoundingBoxAscent));
    const descent = Math.max(size * 0.2, ...metrics.map((item) => item.actualBoundingBoxDescent));
    const step = size * (style.line_spacing ?? 1.2);
    const contentHeight = ascent + descent + (lines.length - 1) * step;
    const padding = (style.box?.padding ?? 0) * size;
    const outline = (style.outline?.width ?? 0) * size;
    const boxWidth = Math.max(0, ...metrics.map((item) => item.width)) + 2 * (padding + outline);
    const boxHeight = contentHeight + 2 * (padding + outline);
    const x = width * (0.5 + (style.position?.offset_x ?? 0));
    const margin = height * (style.position?.margin_v ?? 0.08);
    const anchor = style.position?.anchor ?? "bottom";
    const top =
      anchor === "top" ? margin : anchor === "middle" ? (height - boxHeight) / 2 : height - margin - boxHeight;
    if (style.box) {
      ctx.fillStyle = style.box.color;
      ctx.beginPath();
      ctx.roundRect(x - boxWidth / 2, top, boxWidth, boxHeight, (style.box.radius ?? 0) * size);
      ctx.fill();
    }
    ctx.fillStyle = style.color;
    lines.forEach((line, index) => {
      const y = top + padding + outline + ascent + index * step;
      if (style.outline && outline > 0) {
        ctx.strokeStyle = style.outline.color;
        ctx.lineWidth = outline * 2;
        ctx.strokeText(line, x, y);
      }
      ctx.fillText(line, x, y);
    });
    return { lines, warnings: lines.length > (style.max_lines ?? 2) ? [{ code: "W_SUB_OVERFLOW" }] : [] };
  } finally {
    ctx.restore();
  }
}
