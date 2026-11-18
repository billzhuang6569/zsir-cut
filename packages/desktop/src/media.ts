import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "./connection.js";
import {
  add,
  div,
  floor,
  frameAt,
  frameTime,
  type MediaView,
  mul,
  parseRational,
  printRational,
  rational,
  sub,
} from "./timeline.js";

export const mediaDuration = (media: MediaView) => (media.kind === "image" ? "5s" : (media.duration ?? "0s"));
export const middle = (media: MediaView) =>
  media.kind === "image" ? "0s" : printRational(div(parseRational(media.duration ?? "0s", true), rational(2n)), true);
export function mediaRange(media: MediaView, state: UiState) {
  const selection = state.media?.id === media.id ? state.media : undefined;
  const start = media.kind === "image" ? "0s" : (selection?.in ?? "0s");
  const end = selection?.out ?? mediaDuration(media);
  return {
    source_start: start,
    duration: printRational(sub(parseRational(end, true), parseRational(start, true)), true),
  };
}
export type Placement = "av" | "video" | "audio";
export type MediaKind = "video" | "audio";
export type DropTarget = { track: string } | { index: number };
export type PlaceMode = "insert" | "overwrite";

export function placementKinds(media: MediaView, placement: Placement): MediaKind[] {
  if (media.kind === "audio") return ["audio"];
  return [
    ...(placement !== "audio" && (media.kind === "image" || media.video) ? ["video" as const] : []),
    ...(placement !== "video" && media.audio ? ["audio" as const] : []),
  ];
}

export function placementRange(project: ProjectView, media: MediaView, state: UiState) {
  const range = mediaRange(media, state);
  const frames =
    media.kind === "image"
      ? floor(add(mul(parseRational(range.duration, true), parseRational(project.edit_rate)), rational(1n, 2n)))
      : frameAt(range.duration, project.edit_rate);
  return { ...range, duration: frameTime(frames > 0n ? frames : 0n, project.edit_rate) };
}

export function placeMedia(
  project: ProjectView,
  media: MediaView,
  state: UiState,
  at: string,
  options: {
    target?: DropTarget;
    placement?: Placement;
    mode?: PlaceMode;
    trackId?: (kind: MediaKind) => string;
    pairs?: ReadonlyMap<string, string>;
  } = {},
) {
  const { target, placement = "av", mode = "insert", trackId = () => `trk_${crypto.randomUUID()}`, pairs } = options;
  const range = placementRange(project, media, state);
  const kinds = placementKinds(media, placement);
  const clicked = target && "track" in target ? project.tracks.find((track) => track.id === target.track) : undefined;
  const tracks = [...project.tracks];
  const added: { op: "add_track"; id: string; kind: MediaKind; index: number }[] = [];
  const byKind = (kind: MediaKind) => tracks.filter((track) => track.kind === kind);
  const create = (kind: MediaKind, index = tracks.length) => {
    const id = trackId(kind);
    added.push({ op: "add_track", id, kind, index });
    tracks.splice(index, 0, { id, kind, name: "", enabled: true, clips: [] });
    return id;
  };
  const primaryKind = clicked?.kind ?? kinds[0];
  if (!kinds.length)
    return { error: placement === "audio" ? "素材没有声音，请选择音画或仅画面" : "素材没有可放入的画面" } as const;
  if ((target && "track" in target && !clicked) || !primaryKind || primaryKind === "subtitle")
    return { error: "请选择视频轨或声音轨" } as const;
  if (!kinds.includes(primaryKind))
    return { error: kinds[0] === "audio" ? "请把声音放到声音轨" : "请把画面放到视频轨" } as const;
  if (range.duration === "0s") return { error: "素材范围不足一帧" } as const;

  const primary =
    clicked?.id ??
    (target && "index" in target
      ? create(primaryKind, target.index)
      : (byKind(primaryKind)[0]?.id ?? create(primaryKind)));
  const primaryTracks = byKind(primaryKind);
  const ordinal = primaryTracks.findIndex((track) => track.id === primary);
  const occurrences = new Set(primaryTracks[ordinal]?.clips.flatMap((clip) => clip.occurrence_id ?? []) ?? []);
  const destinations = kinds.map((kind) => {
    if (kind === primaryKind) return { kind, id: primary };
    const peers = byKind(kind);
    const paired =
      peers.find((track) => track.id === pairs?.get(primary)) ??
      peers.find((track) => track.clips.some((clip) => clip.occurrence_id && occurrences.has(clip.occurrence_id)));
    return { kind, id: paired?.id ?? peers[ordinal]?.id ?? create(kind) };
  });
  const video = destinations.find(({ kind }) => kind === "video");
  const audio = destinations.find(({ kind }) => kind === "audio");
  const op = {
    op: "place",
    media_id: media.id,
    ...range,
    at,
    mode,
    ...(video && { video_track: video.id }),
    ...(audio && { audio_track: audio.id }),
  };
  return { op, added, destinations, tracks };
}
export function sourceProject(project: ProjectView, media: MediaView): ProjectView {
  const duration = mediaDuration(media);
  return {
    ...project,
    name: media.name ?? "素材",
    duration: { t: duration },
    edit_rate: media.kind === "video" ? (media.video?.rate ?? "25") : "25",
    start_timecode: media.start_timecode ?? "00:00:00:00",
    drop_frame: Boolean(media.start_timecode?.includes(";")),
    cues: [],
    markers: [],
    tracks: [
      {
        id: "source",
        name: "素材",
        enabled: true,
        kind: media.kind === "audio" ? "audio" : "video",
        clips: [
          {
            id: media.id,
            media_id: media.id,
            label: media.name ?? "素材",
            enabled: true,
            speed: "1",
            timeline_in: { t: "0s" },
            timeline_out: { t: duration },
            source_in: { t: "0s" },
            source_out: { t: duration },
          },
        ],
      },
    ],
  };
}
