// Word animation adapted from Augani/openreel-video caption-animation-renderer.ts,
// 367d7e90b61b5181f9861b852bb8b9d7a7d2954a (MIT).
// Copyright (c) 2024-2026 Augustus Otu and Contributors. See THIRD_PARTY_NOTICES.md.

import type { Rational, StyleAnimation } from "../../core/dist/index.js";

// Source execution must use current math; the browser build needs a statically bundled module.
const sourceRational = "../../core/src/rational.ts";
const { compare, div, floor, mul, parseRational, rational, sub }: typeof import("../../core/dist/rational.js") =
  import.meta.url.endsWith(".ts")
    ? await import(new URL(sourceRational, import.meta.url).href)
    : await import("../../core/dist/rational.js");

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
  | "globalAlpha"
  | "translate"
  | "scale"
  | "rect"
  | "clip"
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

export interface SubtitleWord {
  text: string;
  start: Rational;
  end: Rational;
}
export interface SubtitleFrame {
  t: Rational;
  duration: Rational;
  words?: SubtitleWord[] | undefined;
  text_override?: boolean | undefined;
}
const zero = rational(0n),
  one = rational(1n);
const min = (a: Rational, b: Rational) => (compare(a, b) < 0 ? a : b);
const progress = (t: Rational, duration: Rational) =>
  compare(t, zero) < 0 ? zero : compare(duration, zero) <= 0 ? one : min(one, div(t, duration));
const cube = (t: Rational) => mul(mul(t, t), t);
const number = (value: Rational) => Number(value.numerator) / Number(value.denominator);

/** Exact time arithmetic ends at this drawing state; identical states can share an overlay image. */
export function subtitleAnimationState(text: string, style: RenderStyle, frame?: SubtitleFrame) {
  const chars = [...text.replaceAll("\n", "")];
  const state = {
    opacity: 1,
    offset: 0,
    scale: 1,
    visible: chars.length,
    words: [] as { from: number; to: number; fill: number; scale: number }[],
  };
  if (!frame || !style.animation) return state;
  const halfDuration = div(frame.duration, rational(2n));
  for (const phase of ["in", "out"] as const) {
    const animation = style.animation[phase];
    if (!animation) continue;
    const configured =
      typeof animation.duration === "string" ? parseRational(animation.duration, true) : animation.duration;
    const span = phase === "in" ? min(configured, halfDuration) : configured;
    const elapsed = phase === "in" ? frame.t : sub(frame.t, sub(frame.duration, span));
    const raw = progress(elapsed, span);
    const eased = phase === "in" ? sub(one, cube(sub(one, raw))) : cube(raw);
    if (animation.type === "typewriter") {
      state.visible = Number(floor(mul(rational(BigInt(chars.length)), eased)));
      continue;
    }
    const p = number(eased);
    const amount = phase === "in" ? 1 - p : p;
    state.opacity *= 1 - amount;
    if (animation.type === "rise" || animation.type === "sink") state.offset += amount * 0.5;
    if (animation.type === "pop") state.scale *= 1 - amount * 0.4;
  }
  const mode = style.animation.word;
  if (!mode || mode === "none" || !style.highlight || frame.text_override || !frame.words?.length) return state;
  let cursor = 0;
  for (const word of frame.words) {
    // Layout inserts spaces and line breaks; only the token's displayed characters receive its color.
    if (!/^\s/u.test(word.text)) while (cursor < chars.length && /\s/u.test(chars[cursor] ?? "")) cursor++;
    const length = [...word.text].length;
    if (!length || chars.slice(cursor, cursor + length).join("") !== word.text) {
      state.words = [];
      return state;
    }
    const active = compare(frame.t, word.start) >= 0 && compare(frame.t, word.end) < 0;
    const fill =
      mode === "fill" ? number(progress(sub(frame.t, word.start), sub(word.end, word.start))) : active ? 1 : 0;
    state.words.push({ from: cursor, to: cursor + length, fill, scale: active && mode === "jump" ? 1.15 : 1 });
    cursor += length;
  }
  // Unmapped text means alignment is incomplete: disable the entire word effect.
  if (chars.slice(cursor).some((char) => !/\s/u.test(char))) state.words = [];
  return state;
}

export function renderSubtitle(
  ctx: SubtitleCanvas,
  text: string,
  style: RenderStyle,
  width: number,
  height: number,
  frame?: SubtitleFrame,
) {
  const animation = subtitleAnimationState(text, style, frame);
  ctx.save();
  try {
    const size = height * style.font_size;
    ctx.font = `${style.italic ? "italic " : ""}${style.font_weight ?? 400} ${size}px ${subtitleFontFamily(style.font_family)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    const spacing = (style.letter_spacing ?? 0) * size;
    const measure = (line: string) => ctx.measureText(line).width + Math.max(0, [...line].length - 1) * spacing;
    // Reserve jump-sized slots for every frame so scaling cannot consume spaces or move neighboring words.
    const wordScale = style.animation?.word === "jump" && animation.words.length ? 1.15 : 1;
    const layoutWidth = (line: string) => measure(line) * wordScale;
    const limit = width * (style.position?.max_width ?? 0.8);
    const lines: string[] = [];
    for (const explicit of text.split("\n")) {
      let line = "";
      for (const char of explicit) {
        if (line && layoutWidth(line + char) > limit) {
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
    const boxWidth = Math.max(0, ...lines.map(layoutWidth)) + 2 * (padding + outline);
    const boxHeight = contentHeight + 2 * (padding + outline);
    const x = width * (0.5 + (style.position?.offset_x ?? 0));
    const margin = height * (style.position?.margin_v ?? 0.08);
    const anchor = style.position?.anchor ?? "bottom";
    const top =
      anchor === "top" ? margin : anchor === "middle" ? (height - boxHeight) / 2 : height - margin - boxHeight;
    if (animation.opacity !== 1) ctx.globalAlpha *= animation.opacity;
    if (animation.offset || animation.scale !== 1) {
      ctx.translate(x, top + boxHeight / 2 + animation.offset * size);
      ctx.scale(animation.scale, animation.scale);
      ctx.translate(-x, -top - boxHeight / 2);
    }
    if (style.box && !(frame && style.animation?.in?.type === "typewriter" && animation.visible === 0)) {
      ctx.fillStyle = style.box.color;
      ctx.beginPath();
      ctx.roundRect(x - boxWidth / 2, top, boxWidth, boxHeight, (style.box.radius ?? 0) * size);
      ctx.fill();
    }
    const contentWidth = Math.max(0, ...lines.map(layoutWidth));
    const drawPlain = (line: string, x: number, y: number, stroke: boolean) => {
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
    let offset = 0;
    const rows = lines.map((line, index) => {
      const row = {
        line,
        offset,
        x:
          x +
          ((style.align === "left" ? -1 : style.align === "right" ? 1 : 0) * (contentWidth - layoutWidth(line))) / 2,
        y: top + padding + outline + ascent + index * step,
      };
      offset += [...line].length;
      return row;
    });
    const segmented =
      wordScale !== 1 ||
      animation.visible < [...text.replaceAll("\n", "")].length ||
      animation.words.some((word) => word.fill || word.scale !== 1);
    const draw = (row: (typeof rows)[number], stroke: boolean, colored = true) => {
      if (!segmented) {
        drawPlain(row.line, row.x, row.y, stroke);
        return;
      }
      const chars = [...row.line];
      const left = row.x - layoutWidth(row.line) / 2;
      for (let i = 0; i < chars.length; ) {
        const at = row.offset + i;
        if (at >= animation.visible) break;
        const word = animation.words.find((word) => at >= word.from && at < word.to);
        const stop = Math.min(chars.length, animation.visible - row.offset, word ? word.to - row.offset : i + 1);
        const part = chars.slice(i, stop).join("");
        const prefix = chars.slice(0, i).join("");
        const before = (ctx.measureText(prefix).width + i * spacing) * wordScale;
        const length =
          (ctx.measureText(prefix + part).width - ctx.measureText(prefix).width + Math.max(0, stop - i - 1) * spacing) *
          wordScale;
        const centre = left + before + length / 2;
        ctx.save();
        if (word && word.scale !== 1) {
          ctx.translate(centre, row.y + (descent - ascent) / 2);
          ctx.scale(word.scale, word.scale);
          ctx.translate(-centre, -row.y - (descent - ascent) / 2);
        }
        if (!stroke && colored && word?.fill === 1 && style.highlight) ctx.fillStyle = style.highlight.color;
        drawPlain(part, centre, row.y, stroke);
        if (!stroke && colored && word && word.fill > 0 && word.fill < 1 && style.highlight) {
          ctx.save();
          ctx.beginPath();
          // Fill progresses across the whole word, including a word wrapped over rows.
          const all = [...text.replaceAll("\n", "")];
          const wordWidth = measure(all.slice(word.from, word.to).join(""));
          const consumed = measure(all.slice(word.from, at).join("")) + (at > word.from ? spacing : 0);
          ctx.rect(
            left + before,
            row.y - ascent - size,
            Math.max(0, Math.min(length, wordWidth * word.fill - consumed)),
            ascent + descent + size * 2,
          );
          ctx.clip();
          ctx.fillStyle = style.highlight.color;
          drawPlain(part, centre, row.y, false);
          ctx.restore();
        }
        ctx.restore();
        i = stop;
      }
    };
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
      for (const row of rows) draw({ ...row, x: row.x - outside }, false, false);
      ctx.restore();
    }
    for (const row of rows) {
      for (const edge of outlines) {
        if (edge.width <= 0) continue;
        ctx.strokeStyle = edge.color;
        ctx.lineWidth = edge.width * size * 2;
        draw(row, true);
      }
      draw(row, false);
      if (style.underline && animation.visible >= row.offset + [...row.line].length)
        ctx.fillRect(
          row.x - layoutWidth(row.line) / 2,
          row.y + Math.max(1, size * 0.08),
          layoutWidth(row.line),
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
