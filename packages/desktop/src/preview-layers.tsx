import { type CSSProperties, useEffect, useRef } from "react";
import type { ProjectView } from "./connection.js";
import { type ClipView, contains, type MediaView, numberOf, parseRational, sourceAt, sourceSpeed } from "./timeline.js";

export function visibleVideoLayers(project: ProjectView | null, at: string) {
  return (
    project?.tracks.flatMap((track) => {
      if (track.kind !== "video" || !track.enabled) return [];
      const clip = track.clips.find((clip) => clip.enabled && contains(clip.timeline_in.t, clip.timeline_out.t, at));
      const media = clip && project.media.find((media) => media.id === clip.media_id);
      return clip && media && (media.kind === "video" || media.kind === "image") ? [{ track, clip, media }] : [];
    }) ?? []
  );
}

export function layerStyle(
  project: ProjectView | null,
  clip: ClipView | undefined,
  media: MediaView | undefined,
): CSSProperties {
  const t = clip && (project?.clipProperties?.[clip.id]?.transform ?? clip.transform);
  const [x, y] = t?.position ?? [0, 0];
  const crop = t?.crop;
  const aspect = media?.video
    ? (media.video.width * (media.video.pixel_aspect ? numberOf(parseRational(media.video.pixel_aspect)) : 1)) /
      media.video.height
    : undefined;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    ...(aspect && { width: `min(100cqw, 100cqh * ${aspect})`, height: `min(100cqh, 100cqw / ${aspect})` }),
    background: "transparent",
    transform: `translate(-50%, -50%) translate(${x * 100}cqw, ${-y * 100}cqh) rotate(${-(t?.rotation_deg ?? 0)}deg) scale(${t?.scale ?? 1})`,
    ...(crop && {
      clipPath: `inset(${(crop.top ?? 0) * 100}% ${(crop.right ?? 0) * 100}% ${(crop.bottom ?? 0) * 100}% ${(crop.left ?? 0) * 100}%)`,
      visibility:
        (crop.left ?? 0) + (crop.right ?? 0) >= 1 || (crop.top ?? 0) + (crop.bottom ?? 0) >= 1 ? "hidden" : undefined,
    }),
  };
}

export function PreviewLayer({
  clip,
  media,
  project,
  src,
  at,
  playback,
  playing,
  direction,
}: {
  clip: ClipView;
  media: MediaView;
  project: ProjectView | null;
  src: string;
  at: string;
  playback: React.RefObject<string | null>;
  playing: boolean;
  direction: bigint;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const latestAt = useRef(at);
  latestAt.current = at;
  const pausedAt = playing ? undefined : at;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let animation = 0;
    const sync = () => {
      const time = pausedAt ?? playback.current ?? latestAt.current;
      if (!contains(clip.timeline_in.t, clip.timeline_out.t, time)) return;
      const source = numberOf(sourceAt(clip, time));
      const rate = sourceSpeed(clip, time) * Number(direction);
      const native = playing && rate >= 0.0625 && rate <= 16;
      if (!element.seeking && Math.abs(element.currentTime - source) > (native ? 0.08 * rate : 0.001))
        element.currentTime = source;
      if (native) {
        if (element.playbackRate !== rate) element.playbackRate = rate;
        if (element.paused) void element.play().catch(() => {});
      } else element.pause();
    };
    const tick = () => {
      if (element.readyState >= 1) sync();
      animation = requestAnimationFrame(tick);
    };
    element.addEventListener("loadedmetadata", sync);
    if (playing) tick();
    else if (element.readyState >= 1) sync();
    return () => {
      cancelAnimationFrame(animation);
      element.removeEventListener("loadedmetadata", sync);
      element.pause();
    };
  }, [pausedAt, clip, direction, playback, playing]);
  const style = { ...layerStyle(project, clip, media), zIndex: 1 };
  return media.kind === "image" ? (
    <img src={src} alt="" aria-hidden style={style} />
  ) : (
    <video ref={video} src={src} muted playsInline preload="auto" aria-hidden style={style} />
  );
}
