import type { Rational, StyleAnimation } from "../../core/dist/index.js";

/** Browser and Node canvases share this renderer; all dimensions are canvas pixels. */
export interface RenderStyle {
  font_family: string;
  font_weight?: number;
  font_size: number;
  color: string;
  italic?: boolean;
  underline?: boolean;
  letter_spacing?: number;
  align?: "left" | "center" | "right";
  outlines?: { color: string; width: number }[] | undefined;
  shadow?: { color: string; blur: number; distance: number; angle: number };
  glow?: { color: string; blur: number };
  highlight?: { color: string };
  animation?: StyleAnimation<Rational | string>;
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
  | "fillRect"
  | "shadowColor"
  | "shadowBlur"
  | "shadowOffsetX"
  | "shadowOffsetY"
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
    ctx.font = `${style.italic ? "italic " : ""}${style.font_weight ?? 400} ${size}px ${subtitleFontFamily(style.font_family)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    const spacing = (style.letter_spacing ?? 0) * size;
    const measure = (line: string) => ctx.measureText(line).width + Math.max(0, [...line].length - 1) * spacing;
    const limit = width * (style.position?.max_width ?? 0.8);
    const lines: string[] = [];
    for (const explicit of text.split("\n")) {
      let line = "";
      for (const char of explicit) {
        if (line && measure(line + char) > limit) {
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
    const outlines = style.outlines
      ? [...style.outlines].sort((a, b) => b.width - a.width)
      : style.outline
        ? [style.outline]
        : [];
    const outline = Math.max(0, ...outlines.map((item) => item.width)) * size;
    const boxWidth = Math.max(0, ...lines.map(measure)) + 2 * (padding + outline);
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
    const contentWidth = Math.max(0, ...lines.map(measure));
    const draw = (line: string, x: number, y: number, stroke: boolean) => {
      if (!spacing) {
        if (stroke) ctx.strokeText(line, x, y);
        else ctx.fillText(line, x, y);
        return;
      }
      ctx.textAlign = "left";
      let cursor = x - measure(line) / 2;
      let prefix = "";
      for (const char of line) {
        if (stroke) ctx.strokeText(char, cursor, y);
        else ctx.fillText(char, cursor, y);
        // Prefix widths retain kerning in the spacing layout.
        cursor += ctx.measureText(prefix + char).width - ctx.measureText(prefix).width + spacing;
        prefix += char;
      }
      ctx.textAlign = "center";
    };
    const rows = lines.map((line, index) => ({
      line,
      x: x + ((style.align === "left" ? -1 : style.align === "right" ? 1 : 0) * (contentWidth - measure(line))) / 2,
      y: top + padding + outline + ascent + index * step,
    }));
    ctx.fillStyle = style.color;
    // Paint effects for all lines below every outline; the box has already been drawn.
    for (const effect of [style.shadow, style.glow]) {
      if (!effect) continue;
      ctx.save();
      ctx.shadowColor = effect.color;
      ctx.shadowBlur = effect.blur * size;
      const distance = "distance" in effect && typeof effect.distance === "number" ? effect.distance * size : 0;
      const angle = "angle" in effect && typeof effect.angle === "number" ? (effect.angle * Math.PI) / 180 : 0;
      const outside = width + contentWidth * 2;
      ctx.shadowOffsetX = outside + Math.cos(angle) * distance;
      ctx.shadowOffsetY = Math.sin(angle) * distance;
      for (const row of rows) draw(row.line, row.x - outside, row.y, false);
      ctx.restore();
    }
    for (const row of rows) {
      for (const edge of outlines) {
        if (edge.width <= 0) continue;
        ctx.strokeStyle = edge.color;
        ctx.lineWidth = edge.width * size * 2;
        draw(row.line, row.x, row.y, true);
      }
      draw(row.line, row.x, row.y, false);
      if (style.underline)
        ctx.fillRect(
          row.x - measure(row.line) / 2,
          row.y + Math.max(1, size * 0.08),
          measure(row.line),
          Math.max(1, size * 0.05),
        );
    }
    return {
      lines,
      bounds: { x: x - boxWidth / 2, y: top, width: boxWidth, height: boxHeight },
      warnings: lines.length > (style.max_lines ?? 2) ? [{ code: "W_SUB_OVERFLOW" }] : [],
    };
  } finally {
    ctx.restore();
  }
}
