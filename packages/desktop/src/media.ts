import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "./connection.js";
import { div, type MediaView, parseRational, printRational, rational, sub } from "./timeline.js";

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
export function placeMedia(project: ProjectView, media: MediaView, state: UiState, at: string, track?: string) {
  const target = project.tracks.find((item) => item.id === track);
  const video = target?.kind === "video" ? target : project.tracks.find((item) => item.kind === "video");
  const audio = target?.kind === "audio" ? target : project.tracks.find((item) => item.kind === "audio");
  return {
    op: "place",
    media_id: media.id,
    ...mediaRange(media, state),
    at,
    mode: track ? "overwrite" : "insert",
    ...(media.kind !== "audio" && video && target?.kind !== "audio" ? { video_track: video.id } : {}),
    ...((media.audio || media.kind === "audio") && audio && target?.kind !== "video" ? { audio_track: audio.id } : {}),
  };
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
