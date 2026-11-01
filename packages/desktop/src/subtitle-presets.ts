import { rational } from "../../core/src/rational.ts";
import { type RenderStyle, renderSubtitle, type SubtitleCanvas } from "../../exporters/src/subtitle-render.ts";

export const presetGroups = ["基础", "综艺", "访谈", "逐字", "动画"] as const;
type PresetFields = Omit<RenderStyle, "position" | "max_lines">;
export interface SubtitlePreset {
  name: string;
  group: (typeof presetGroups)[number];
  fields: PresetFields;
}
const base = { font_family: "PingFang SC", font_weight: 600, font_size: 0.045, color: "#FFFFFF" };
export const subtitlePresets: SubtitlePreset[] = [
  { name: "经典白字", group: "基础", fields: { ...base, outline: { color: "#000000", width: 0.07 } } },
  {
    name: "白底黑字",
    group: "基础",
    fields: { ...base, color: "#181818", box: { color: "#FFFFFF", padding: 0.25, radius: 0.12 } },
  },
  {
    name: "醒目黄字",
    group: "基础",
    fields: { ...base, color: "#FFD84A", outline: { color: "#181818", width: 0.06 } },
  },
  {
    name: "综艺大黄",
    group: "综艺",
    fields: {
      ...base,
      font_weight: 800,
      font_size: 0.052,
      color: "#FFE34D",
      outlines: [
        { color: "#513314", width: 0.06 },
        { color: "#101010", width: 0.13 },
      ],
    },
  },
  {
    name: "元气橙白",
    group: "综艺",
    fields: {
      ...base,
      font_weight: 800,
      italic: true,
      outlines: [
        { color: "#E76622", width: 0.08 },
        { color: "#202020", width: 0.14 },
      ],
    },
  },
  {
    name: "粉色强调",
    group: "综艺",
    fields: {
      ...base,
      font_weight: 800,
      color: "#FF92BA",
      outline: { color: "#351B30", width: 0.1 },
      shadow: { color: "#00000099", blur: 0.05, distance: 0.1, angle: 90 },
    },
  },
  {
    name: "轻盈访谈",
    group: "访谈",
    fields: {
      ...base,
      font_weight: 300,
      font_size: 0.04,
      shadow: { color: "#000000BB", blur: 0.18, distance: 0.06, angle: 90 },
    },
  },
  {
    name: "访谈字幕条",
    group: "访谈",
    fields: { ...base, font_weight: 400, font_size: 0.04, box: { color: "#101010CC", padding: 0.35, radius: 0 } },
  },
  {
    name: "人文宋体",
    group: "访谈",
    fields: {
      ...base,
      font_family: "Songti SC",
      font_weight: 400,
      letter_spacing: 0.04,
      shadow: { color: "#000000CC", blur: 0.12, distance: 0.04, angle: 90 },
    },
  },
  {
    name: "卡拉OK黄",
    group: "逐字",
    fields: {
      ...base,
      outline: { color: "#101010", width: 0.08 },
      highlight: { color: "#FFE34D" },
      animation: { word: "fill" },
    },
  },
  {
    name: "绿字高亮",
    group: "逐字",
    fields: {
      ...base,
      outline: { color: "#101010", width: 0.08 },
      highlight: { color: "#80EF69" },
      animation: { word: "highlight" },
    },
  },
  {
    name: "逐字跳动",
    group: "逐字",
    fields: {
      ...base,
      font_weight: 700,
      outline: { color: "#101010", width: 0.08 },
      highlight: { color: "#FFB957" },
      animation: { word: "jump" },
    },
  },
  {
    name: "弹入强调",
    group: "动画",
    fields: {
      ...base,
      font_weight: 800,
      color: "#FFE34D",
      outline: { color: "#101010", width: 0.09 },
      animation: { in: { type: "pop", duration: "1/4s" }, out: { type: "pop", duration: "1/5s" } },
    },
  },
  {
    name: "打字机",
    group: "动画",
    fields: {
      ...base,
      outline: { color: "#101010", width: 0.06 },
      animation: { in: { type: "typewriter", duration: "4/5s" } },
    },
  },
  {
    name: "轻柔升起",
    group: "动画",
    fields: {
      ...base,
      font_weight: 400,
      shadow: { color: "#000000CC", blur: 0.15, distance: 0.08, angle: 90 },
      animation: { in: { type: "rise", duration: "2/5s" }, out: { type: "fade", duration: "3/10s" } },
    },
  },
];

// Clear optional effects before applying; identity, position and wrapping stay on the target style.
export function presetPatch(preset: SubtitlePreset): Partial<RenderStyle> {
  const optional = [
    "font_weight",
    "outline",
    "box",
    "line_spacing",
    "italic",
    "underline",
    "letter_spacing",
    "align",
    "outlines",
    "shadow",
    "glow",
    "highlight",
    "animation",
  ];
  return { ...Object.fromEntries(optional.map((key) => [key, undefined])), ...preset.fields };
}

export function renderPreset(
  ctx: SubtitleCanvas,
  style: RenderStyle,
  width: number,
  height: number,
  milliseconds = 1000,
) {
  const tile = width / 12;
  for (let y = 0; y < height; y += tile)
    for (let x = 0; x < width; x += tile) {
      ctx.fillStyle = (Math.round(x / tile) + Math.round(y / tile)) % 2 ? "#292B2F" : "#24262A";
      ctx.fillRect(x, y, tile, tile);
    }
  return renderSubtitle(
    ctx,
    "庄Sir剪辑助手",
    {
      ...style,
      font_size: style.font_size * 3.5,
      position: { anchor: "middle", margin_v: 0, max_width: 0.94 },
    },
    width,
    height,
    {
      t: rational(BigInt(milliseconds), 1000n),
      duration: rational(2n),
      words: ["庄Sir", "剪辑", "助手"].map((text, i) => ({
        text,
        start: rational(BigInt(i * 2), 3n),
        end: rational(BigInt((i + 1) * 2), 3n),
      })),
    },
  );
}
