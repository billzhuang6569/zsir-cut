import { useCallback, useEffect, useRef, useState } from "react";
import { renderSubtitle } from "../../exporters/src/subtitle-render.ts";
import { defaultStyle } from "./subtitles.js";
import type { CueView, StyleView } from "./timeline.js";

export { renderSubtitle };
type Bounds = { x: number; y: number; width: number; height: number };
export function SubtitleCanvas({
  cues,
  styles,
  format,
  selected = [],
  select,
  edit,
  change,
  dragging,
  preview,
}: {
  cues: (Pick<CueView, "text" | "style_id"> & Partial<CueView>)[];
  styles: StyleView[];
  preview?: { fields: Partial<StyleView>; cue_ids?: string[] | undefined } | undefined;
  format?: { width: number; height: number } | undefined;
  selected?: string[];
  select?: ((cue: CueView) => void) | undefined;
  edit?: (cue: CueView) => void;
  change?: ((cue: CueView, patch: Partial<StyleView>, commit: boolean) => void) | undefined;
  dragging?: React.MutableRefObject<boolean>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const measuringCanvas = useRef<HTMLCanvasElement | null>(null);
  const [bounds, setBounds] = useState<Bounds[]>([]);
  const [guide, setGuide] = useState(false);
  const gesture = useRef<{
    cue: CueView;
    style: StyleView;
    bounds: Bounds;
    x: number;
    y: number;
    scale: boolean;
    rect: DOMRect;
    patch?: Partial<StyleView>;
  } | null>(null);
  const styleFor = useCallback(
    (cue: Partial<CueView>) => ({
      ...(styles.find((s) => s.id === cue.style_id) ?? defaultStyle),
      ...(preview && (!preview.cue_ids || preview.cue_ids.includes(cue.cue_id ?? "")) ? preview.fields : {}),
    }),
    [styles, preview],
  );
  const width = format?.width ?? 1920,
    height = format?.height ?? 1080;
  useEffect(() => {
    if (!cues.length && canvas.current) {
      canvas.current.width = width;
      setBounds((previous) => (previous.length ? [] : previous));
      return;
    }
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const next = cues.map((cue) => renderSubtitle(ctx, cue.text, styleFor(cue), width, height).bounds);
    setBounds((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
  }, [cues, styleFor, width, height]);
  useEffect(
    () => () => {
      if (dragging) dragging.current = false;
    },
    [dragging],
  );
  return (
    <div
      className="zc-subtitle-stage"
      style={{ width: `min(100%, ${(100 * width) / height}cqh)`, height: `min(100%, ${(100 * height) / width}cqw)` }}
    >
      <canvas
        className="zc-subtitle-canvas"
        ref={canvas}
        width={width}
        height={height}
        role="img"
        aria-label={cues.map((cue) => cue.text).join("\n")}
      />
      {select &&
        cues.map((cue, index) => {
          const box = bounds[index];
          if (!box || !cue.cue_id) return null;
          const active = selected.includes(cue.cue_id);
          return (
            <button
              key={`${cue.cue_id}:${cue.piece}`}
              type="button"
              aria-label={`预览字幕：${cue.text}`}
              aria-pressed={active}
              className={`zc-subtitle-hit${active ? " is-selected" : ""}`}
              style={{
                left: `${(box.x / width) * 100}%`,
                top: `${(box.y / height) * 100}%`,
                width: `${(box.width / width) * 100}%`,
                height: `${(box.height / height) * 100}%`,
              }}
              onClick={() => select(cue as CueView)}
              onDoubleClick={() => edit?.(cue as CueView)}
              onKeyDown={(e) => {
                if (e.key === "Enter") edit?.(cue as CueView);
                if (e.key === " ") {
                  e.preventDefault();
                  select(cue as CueView);
                }
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                select(cue as CueView);
                if (!change) return;
                const rect = canvas.current?.getBoundingClientRect();
                if (!rect?.width || !rect.height) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = {
                  cue: cue as CueView,
                  style: styleFor(cue),
                  bounds: box,
                  x: e.clientX,
                  y: e.clientY,
                  scale: (e.target as HTMLElement).hasAttribute("data-subtitle-corner"),
                  rect,
                };
                if (dragging) dragging.current = true;
              }}
              onPointerMove={(e) => {
                const start = gesture.current;
                if (!start || !change) return;
                const dx = ((e.clientX - start.x) * width) / start.rect.width;
                const dy = ((e.clientY - start.y) * height) / start.rect.height;
                const centreX = start.bounds.x + start.bounds.width / 2,
                  centreY = start.bounds.y + start.bounds.height / 2;
                const position = start.style.position ?? { anchor: "bottom", margin_v: 0.08 };
                let patch: Partial<StyleView>;
                if (start.scale) {
                  const originX = ((start.x - start.rect.left) * width) / start.rect.width - centreX;
                  const originY = ((start.y - start.rect.top) * height) / start.rect.height - centreY;
                  const ratio = Math.max(
                    0.01 / start.style.font_size,
                    Math.min(
                      Math.hypot(originX + dx, originY + dy) / Math.max(1, Math.hypot(originX, originY)),
                      0.2 / start.style.font_size,
                      (2 * Math.min(centreX, width - centreX)) / Math.max(1, start.bounds.width),
                      (2 * Math.min(centreY, height - centreY)) / Math.max(1, start.bounds.height),
                    ),
                  );
                  const fontSize = start.style.font_size * ratio;
                  measuringCanvas.current ??= document.createElement("canvas");
                  const measure = measuringCanvas.current.getContext("2d");
                  const measured = measure
                    ? renderSubtitle(measure, start.cue.text, { ...start.style, font_size: fontSize }, width, height)
                        .bounds
                    : null;
                  const boxHeight = measured?.height ?? start.bounds.height * ratio;
                  patch = {
                    font_size: fontSize,
                    position: {
                      ...position,
                      margin_v:
                        position.anchor === "top"
                          ? (centreY - boxHeight / 2) / height
                          : position.anchor === "bottom"
                            ? (height - centreY - boxHeight / 2) / height
                            : position.margin_v,
                    },
                  };
                } else {
                  let x = Math.max(start.bounds.width / 2, Math.min(width - start.bounds.width / 2, centreX + dx));
                  const snap = Math.abs(x - width / 2) <= (6 * width) / start.rect.width;
                  if (snap) x = width / 2;
                  setGuide(snap);
                  // shortcut: legacy middle anchors ignore margin_v; enable vertical movement once its contract is defined.
                  const top = Math.max(0, Math.min(height - start.bounds.height, start.bounds.y + dy));
                  patch = {
                    position: {
                      ...position,
                      offset_x: x / width - 0.5,
                      margin_v:
                        position.anchor === "top"
                          ? top / height
                          : position.anchor === "bottom"
                            ? (height - top - start.bounds.height) / height
                            : position.margin_v,
                    },
                  };
                }
                start.patch = patch;
                change(start.cue, patch, false);
              }}
              onPointerUp={() => {
                const start = gesture.current;
                gesture.current = null;
                setGuide(false);
                if (dragging) dragging.current = false;
                if (start?.patch) change?.(start.cue, start.patch, true);
              }}
              onPointerCancel={() => {
                const start = gesture.current;
                gesture.current = null;
                setGuide(false);
                if (dragging) dragging.current = false;
                if (start)
                  change?.(
                    start.cue,
                    {
                      font_size: start.style.font_size,
                      position: start.style.position ?? { anchor: "bottom", margin_v: 0.08 },
                    },
                    false,
                  );
              }}
            >
              {active &&
                ["nw", "ne", "sw", "se"].map((corner) => (
                  <span key={corner} data-subtitle-corner={corner} className={`zc-subtitle-corner ${corner}`} />
                ))}
            </button>
          );
        })}
      {guide && <div className="zc-subtitle-guide" />}
    </div>
  );
}
