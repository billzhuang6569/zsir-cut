import { useEffect, useRef, useState } from "react";
import { rational } from "../../core/src/rational.ts";
import { type RenderStyle, renderSubtitle } from "../../exporters/src/subtitle-render.ts";

export function SubtitleAnimationCell({
  label,
  style,
  selected,
  choose,
}: {
  label: string;
  style: RenderStyle;
  selected: boolean;
  choose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    let animation = 0;
    const started = performance.now();
    const draw = (now: number) => {
      ctx.clearRect(0, 0, 160, 90);
      // The browser clock is converted at the boundary; all renderer times remain rational.
      const t = hover ? rational(BigInt(Math.round(now - started) % 2000), 1000n) : rational(1n);
      renderSubtitle(
        ctx,
        "庄Sir剪辑助手",
        { ...style, font_size: 0.18, position: { anchor: "middle", margin_v: 0 } },
        160,
        90,
        {
          t,
          duration: rational(2n),
          words: ["庄Sir", "剪辑", "助手"].map((text, i) => ({
            text,
            start: rational(BigInt(i * 2), 3n),
            end: rational(BigInt((i + 1) * 2), 3n),
          })),
        },
      );
      if (hover) animation = requestAnimationFrame(draw);
    };
    draw(started);
    return () => {
      if (animation) cancelAnimationFrame(animation);
    };
  }, [style, hover]);
  return (
    <button
      type="button"
      className="zc-sub-animation-cell"
      aria-label={label}
      aria-pressed={selected}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={choose}
    >
      <canvas ref={canvas} width={160} height={90} />
      <span>{label.split("：")[1]}</span>
    </button>
  );
}
