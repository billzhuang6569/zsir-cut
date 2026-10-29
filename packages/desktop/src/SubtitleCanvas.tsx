import { useEffect, useRef } from "react";
import { renderSubtitle } from "../../exporters/src/subtitle-render.ts";
import { defaultStyle } from "./subtitles.js";
import type { CueView, StyleView } from "./timeline.js";

export { renderSubtitle };
export function SubtitleCanvas({
  cues,
  styles,
  format,
}: {
  cues: Pick<CueView, "text" | "style_id">[];
  styles: StyleView[];
  format?: { width: number; height: number } | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = format?.width ?? 1920,
    height = format?.height ?? 1080;
  useEffect(() => {
    if (!cues.length && canvas.current) {
      canvas.current.width = width;
      return;
    }
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    for (const cue of cues)
      renderSubtitle(ctx, cue.text, styles.find((s) => s.id === cue.style_id) ?? defaultStyle, width, height);
  }, [cues, styles, width, height]);
  return (
    <canvas
      className="zc-subtitle-canvas"
      ref={canvas}
      width={width}
      height={height}
      role="img"
      aria-label={cues.map((cue) => cue.text).join("\n")}
    />
  );
}
