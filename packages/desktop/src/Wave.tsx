/*
 * Adapted from katspaugh/wavesurfer.js src/renderer.ts and src/renderer-utils.ts
 * commit cdef4ac6c2744b3e376cae4e5a727e375137fb9d, BSD-3-Clause.
 * Copyright (c) 2012-2023, katspaugh and contributors. All rights reserved.
 * Also adapted from OpenCut-app/opencut-classic:
 * apps/web/src/timeline/components/audio-waveform.tsx and
 * apps/web/src/services/waveform-cache/service.ts
 * commit cf5e79e919144200294fb9fed22a222592a0aeea, MIT.
 * Copyright 2025-2026 OpenCut. Full licenses: THIRD_PARTY_NOTICES.md.
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  add,
  type ClipView,
  ceil,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  rational,
  sourceAt,
} from "./timeline.js";

type Config = { port: number; token: string };
const caches = new WeakMap<Config, Map<string, Promise<number[]>>>();
function loadPeaks(config: Config, id: string): Promise<number[]> {
  let cache = caches.get(config);
  if (!cache) {
    cache = new Map();
    caches.set(config, cache);
  }
  const existing = cache.get(id);
  if (existing) return existing;
  const query = new URLSearchParams({ token: config.token, media_id: id });
  const pending = fetch(`http://127.0.0.1:${config.port}/peaks?${query}`, {})
    .then(async (response) => {
      if (!response.ok) return [];
      const data: unknown = await response.json();
      return Array.isArray(data) && data.every((value) => typeof value === "number" && Number.isFinite(value))
        ? (data as number[])
        : [];
    })
    .catch(() => []);
  cache.set(id, pending);
  return pending;
}

// Canvas slots are aligned to the 3px bar grid and never grow with clip duration.
export function waveChunks(width: number, left: number, right: number) {
  const chunks: { left: number; width: number }[] = [];
  const end = Math.min(width, Math.ceil(right / 3) * 3);
  for (let x = Math.max(0, Math.floor(left / 3) * 3); x < end; x += 768)
    chunks.push({ left: x, width: Math.min(768, end - x) });
  return chunks;
}

export function wavePeak(
  clip: ClipView,
  peaks: number[],
  x: number,
  endX: number,
  scale: number | ReturnType<typeof rational>,
) {
  const rate = typeof scale === "number" ? rational(BigInt(scale)) : scale;
  const start = parseRational(clip.timeline_in.t, true);
  const end = parseRational(clip.timeline_out.t, true);
  const atPixel = (pixel: number) => {
    const at = add(start, div(rational(BigInt(Math.round(pixel * 1000)), 1000n), rate));
    return compare(at, end) > 0 ? end : at;
  };
  const first = atPixel(x);
  const last = atPixel(endX);
  const boundaries = [
    first,
    ...(clip.time_map ?? [])
      .map((point) => parseRational(point.at.t, true))
      .filter((at) => compare(at, first) > 0 && compare(at, last) < 0),
    last,
  ];
  let maximum = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const a = boundaries[i - 1];
    const b = boundaries[i];
    if (!a || !b || compare(a, b) >= 0) continue;
    const midpoint = div(add(a, b), rational(2n));
    const segment = clip.time_map?.findLast((point) => compare(parseRational(point.at.t, true), midpoint) <= 0);
    const from = sourceAt(clip, printRational(segment?.interp === "hold" ? midpoint : a, true));
    const to = segment?.interp === "hold" ? from : sourceAt(clip, printRational(b, true));
    const low = compare(from, to) <= 0 ? from : to;
    const high = compare(from, to) <= 0 ? to : from;
    const lo = Math.max(0, Number(floor(mul(low, rational(100n)))));
    const hi = Math.min(peaks.length, compare(low, high) === 0 ? lo + 1 : Number(ceil(mul(high, rational(100n)))));
    for (let sample = lo; sample < hi; sample++) maximum = Math.max(maximum, Math.abs(peaks[sample] ?? 0));
  }
  return maximum;
}

export const Wave = memo(function Wave({
  clip,
  width,
  scale,
  config,
  hasAudio = true,
}: {
  clip: ClipView;
  width: number;
  scale: number | ReturnType<typeof rational>;
  config: Config | undefined;
  hasAudio?: boolean;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    let active = true;
    setPeaks([]);
    if (config && hasAudio)
      void loadPeaks(config, clip.media_id).then((data) => {
        if (active) setPeaks(data);
      });
    return () => {
      active = false;
    };
  }, [config, clip.media_id, hasAudio]);
  // Primitive dependencies also survive fresh project snapshots and rational scale objects.
  const mapping = JSON.stringify([clip.timeline_in, clip.timeline_out, clip.source_in, clip.source_out, clip.time_map]);
  const scaleKey = typeof scale === "number" ? `${scale}` : printRational(scale);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Value keys cover all mapping/scale inputs without playback object identity.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const scroller = element.closest(".zc-timeline, .zc-media-library");
    let signature = "";
    const draw = () => {
      const rect = element.getBoundingClientRect();
      const viewport = scroller?.getBoundingClientRect();
      const labelRight = scroller?.querySelector(".zc-track-name")?.getBoundingClientRect().right;
      const left = Math.max(0, (labelRight ?? viewport?.left ?? 0) - rect.left);
      const right = Math.min(width, (viewport?.right ?? window.innerWidth) - rect.left);
      const dpr = window.devicePixelRatio || 1;
      const visible = rect.bottom > (viewport?.top ?? 0) && rect.top < (viewport?.bottom ?? window.innerHeight);
      const slots = visible && right > left && peaks.length ? waveChunks(width, left, right) : [];
      const next = JSON.stringify([slots, dpr]);
      if (signature === next) return;
      signature = next;
      element.replaceChildren();
      for (const slot of slots) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(slot.width * dpr);
        canvas.height = Math.ceil(48 * dpr);
        Object.assign(canvas.style, {
          position: "absolute",
          left: `${slot.left}px`,
          width: `${slot.width}px`,
          height: "48px",
        });
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.scale(dpr, dpr);
        context.fillStyle = getComputedStyle(element).color;
        for (let x = slot.left; x < slot.left + slot.width; x += 3) {
          const height = Math.max(1, wavePeak(clip, peaks, x, Math.min(x + 3, width), scale) * 26);
          context.fillRect(x - slot.left, 30 - height / 2, Math.min(2, width - x), height);
        }
        element.append(canvas);
      }
    };
    draw();
    scroller?.addEventListener("scroll", draw, { passive: true });
    window.addEventListener("resize", draw);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    observer?.observe(element);
    if (scroller) observer?.observe(scroller);
    return () => {
      observer?.disconnect();
      scroller?.removeEventListener("scroll", draw);
      window.removeEventListener("resize", draw);
      element.replaceChildren();
    };
  }, [peaks, mapping, scaleKey, width]);
  return <span ref={container} className="zc-wave" style={{ width, height: 48 }} aria-hidden="true" />;
});
