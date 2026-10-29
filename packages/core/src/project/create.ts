import { resolve } from "node:path";
import { compare, parseRational, rational, sub } from "../rational.ts";
import { EditError } from "./edit.ts";
import { newId } from "./id.ts";
import { mediaFromProbe, type Probe } from "./probe.ts";
import { automaticTrackName } from "./track-name.ts";
import type { Author, Project, Track } from "./types.ts";

export interface CreateProjectRequest {
  project: string;
  name: string;
  timeline: {
    name?: string;
    edit_rate?: string;
    drop_frame?: boolean;
    start_timecode?: string;
    width?: number;
    height?: number;
    audio_tracks?: number;
  };
  match_media?: string;
  subtitles?: { language: string; name?: string };
  idempotency_key: string;
  author: Author;
}

const rates = ["24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"].map((value) =>
  parseRational(value),
);
const absolute = (value: ReturnType<typeof rational>) =>
  rational(value.numerator < 0n ? -value.numerator : value.numerator, value.denominator);

export async function buildProject(input: CreateProjectRequest, probe: Probe): Promise<Project> {
  const settings = input.timeline;
  let editRate = settings.edit_rate ? parseRational(settings.edit_rate) : undefined;
  let width = settings.width;
  let height = settings.height;
  if (input.match_media) {
    const path = resolve(input.match_media);
    let media: ReturnType<typeof mediaFromProbe>;
    try {
      media = mediaFromProbe(path, await probe(path));
    } catch (error) {
      throw Object.assign(new Error(String(error)), { code: "E_IO" });
    }
    if (media.kind !== "video" || !media.video) throw new EditError("E_VALIDATION", "match_media 必须是视频素材");
    const sourceRate = media.video.rate;
    editRate ??= rates.reduce((best, rate) =>
      compare(absolute(sub(rate, sourceRate)), absolute(sub(best, sourceRate))) <= 0 ? rate : best,
    );
    width ??= media.video.width;
    height ??= media.video.height;
  }
  if (!editRate || width === undefined || height === undefined)
    throw new EditError("E_VALIDATION", "timeline 和 match_media 缺少 edit_rate、width 或 height");
  const tracks: Track[] = [
    { id: "trk_v1", kind: "video", name: automaticTrackName([], "video"), enabled: true, clips: [], transitions: [] },
  ];
  for (let index = 1; index <= (settings.audio_tracks ?? 2); index++)
    tracks.push({
      id: `trk_a${index}`,
      kind: "audio",
      name: automaticTrackName(tracks, "audio"),
      enabled: true,
      clips: [],
      transitions: [],
    });
  if (input.subtitles)
    tracks.push({
      id: "trk_sub1",
      kind: "subtitle",
      name: input.subtitles.name ?? automaticTrackName(tracks, "subtitle"),
      enabled: true,
      language: input.subtitles.language,
      carrier_tracks: ["trk_a1"],
      default_style_id: "sty_default",
      overrides: [],
      free_cues: [],
    });
  return {
    schema: "zsir-cut/timeline",
    schema_version: "0.3",
    ...(input.subtitles ? { recognition: { language: input.subtitles.language } } : {}),
    id: newId("prj_"),
    name: input.name,
    revision: { seq: 1, id: newId("rev_"), parent: null, created_at: new Date().toISOString(), author: input.author },
    media: [],
    timelines: [
      {
        id: newId("tl_"),
        name: settings.name ?? "主时间线",
        edit_rate: editRate,
        drop_frame: settings.drop_frame ?? false,
        start_timecode: settings.start_timecode ?? (settings.drop_frame ? "00:00:00;00" : "00:00:00:00"),
        audio_rate: rational(48000n),
        format: { width, height, pixel_aspect: rational(1n) },
        tracks,
        markers: [],
      },
    ],
    transcripts: [],
    subtitle_styles: input.subtitles
      ? [
          {
            id: "sty_default",
            name: "默认",
            version: 1,
            font_family: "PingFang SC",
            font_size: 0.05,
            color: "#FFFFFF",
            outline: { color: "#000000", width: 0.06 },
            position: { anchor: "bottom", margin_v: 0.08 },
          },
        ]
      : [],
  };
}
