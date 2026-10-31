import type { Rational } from "../rational.ts";

export type Extension = Record<string, unknown>;

export interface Author {
  kind: "human" | "agent" | "system";
  name: string;
}

export interface Revision {
  seq: number;
  id: string;
  parent: string | null;
  created_at: string;
  author: Author;
}

export interface Fingerprint {
  algo: "sampled-sha256-v1";
  value: string;
}

export interface MediaVideo {
  rate: Rational;
  width: number;
  height: number;
  pixel_aspect?: Rational;
  vfr?: boolean;
}

export interface MediaAudio {
  sample_rate: Rational;
  channels: number;
}

export interface Proxy {
  path: string;
  size_bytes?: number;
  fingerprint: Fingerprint;
}

export interface MediaOrganize {
  tags?: string[];
  folders?: string[];
  rating?: number;
  note?: string;
  link?: string;
}

export interface Recognition {
  language?: string;
  reference_text?: string;
  terms?: string[];
  remove_fillers?: boolean;
  filler_words?: string[];
}

export interface Media {
  id: string;
  kind: "video" | "audio" | "image";
  name?: string;
  path: string;
  original_path?: string;
  size_bytes: number;
  fingerprint: Fingerprint;
  duration: Rational;
  start_timecode?: string;
  reel?: string;
  video?: MediaVideo;
  audio?: MediaAudio;
  proxy?: Proxy;
  organize?: MediaOrganize;
  ext?: Extension;
}

export interface TimeMapPoint {
  at: Rational;
  source: Rational;
  interp: "linear" | "smooth" | "hold";
}

export interface Crop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface Transform {
  scale?: number;
  rotation_deg?: number;
  position?: [number, number];
  crop?: Crop;
}

export interface Clip {
  id: string;
  occurrence_id: string;
  media_id: string;
  timeline_start: Rational;
  duration: Rational;
  source_start: Rational;
  time_map?: TimeMapPoint[];
  enabled?: boolean;
  sync_broken?: boolean;
  gain_db?: number;
  source_channels?: number[];
  transform?: Transform;
  label?: string;
  ext?: Extension;
}

export interface Transition {
  id: string;
  type: "cross_dissolve";
  from_clip: string;
  to_clip: string;
  duration: Rational;
  alignment: "center" | "start" | "end";
  ext?: Extension;
}

export interface MediaTrack {
  id: string;
  kind: "video" | "audio";
  name: string;
  enabled: boolean;
  clips: Clip[];
  transitions: Transition[];
  ext?: Extension;
}

export interface SubtitleOverride {
  occurrence_id: string;
  cue_id: string;
  hidden?: boolean;
  text?: string;
  style_id?: string;
}

export interface FreeCue {
  id: string;
  timeline_start: Rational;
  duration: Rational;
  text: string;
  style_id?: string;
  ext?: Extension;
}

export interface SubtitleTrack {
  id: string;
  kind: "subtitle";
  name: string;
  enabled: boolean;
  language: string;
  carrier_tracks: string[];
  default_style_id: string;
  overrides: SubtitleOverride[];
  free_cues: FreeCue[];
  ext?: Extension;
}

export type Track = MediaTrack | SubtitleTrack;

export interface Marker {
  id: string;
  at: Rational;
  duration: Rational;
  kind: "note" | "todo" | "chapter" | "review";
  level?: 1 | 2;
  text: string;
  ext?: Extension;
}

export interface TimelineFormat {
  width: number;
  height: number;
  pixel_aspect?: Rational;
}

export interface Timeline {
  id: string;
  name: string;
  edit_rate: Rational;
  drop_frame: boolean;
  start_timecode: string;
  audio_rate: Rational;
  format: TimelineFormat;
  tracks: Track[];
  markers: Marker[];
  ext?: Extension;
}

export interface Engine {
  name: string;
  model: string;
  version: string;
  weights_digest?: string;
}

export interface TimeRange {
  start: Rational;
  duration: Rational;
}

export interface RawToken {
  text: string;
  start: Rational;
  end: Rational;
  conf?: number;
}

export interface RawRun {
  id: string;
  kind: "asr" | "align";
  engine: Engine;
  created_at: string;
  range: TimeRange;
  tokens: RawToken[];
}

export interface TokenAlign {
  start: Rational;
  end: Rational;
  conf?: number;
  run: string;
}

export interface Token {
  id: string;
  text: string;
  heard?: string;
  state: "auto" | "edited" | "approved";
  align: TokenAlign;
  ext?: Extension;
}

export interface CueTiming {
  start?: Rational;
  end?: Rational;
  locked?: boolean;
}

export interface Cue {
  id: string;
  first_token: string;
  last_token: string;
  breaks?: string[];
  timing?: CueTiming;
  style_id?: string;
  state: "auto" | "edited" | "approved";
  ext?: Extension;
}

export interface Transcript {
  id: string;
  media_id: string;
  source_channels: number[];
  language: string;
  raw_runs: RawRun[];
  tokens: Token[];
  cues: Cue[];
  subtitle_rules?: TranscriptSubtitleRules;
  ext?: Extension;
}

export interface TranscriptSubtitleRules {
  profile: "zh-talk" | "en-talk";
  cpl?: number;
  max_lines?: number;
  cps?: number;
  min_duration?: Rational;
  max_duration?: Rational;
  hard_pause?: Rational;
  soft_pause?: Rational;
  min_gap?: Rational;
  strip_end_punct?: boolean;
}

export interface StyleOutline {
  color: string;
  width: number;
}

export interface SubtitleOverlay {
  id: string;
  name: string;
  timeline_id: string;
  subtitle_track_id: string;
  output_path: string;
  tail?: Rational;
  last_export: { revision_id: string; created_at: string; size_bytes: number } | null;
}

export interface StyleBox {
  color: string;
  padding?: number;
  radius?: number;
}

export interface StylePosition {
  anchor: "bottom" | "top" | "middle";
  margin_v: number;
  offset_x?: number;
  max_width?: number;
}

export interface StyleAnimation<T = Rational> {
  in?: { type: "fade" | "rise" | "pop" | "typewriter"; duration: T };
  out?: { type: "fade" | "sink" | "pop"; duration: T };
  word?: "none" | "highlight" | "fill" | "jump";
}

export interface SubtitleStyle {
  id: string;
  name: string;
  version: number;
  font_family: string;
  font_weight?: number;
  font_size: number;
  color: string;
  italic?: boolean;
  underline?: boolean;
  letter_spacing?: number;
  align?: "left" | "center" | "right";
  outlines?: StyleOutline[];
  shadow?: { color: string; blur: number; distance: number; angle: number };
  glow?: { color: string; blur: number };
  highlight?: { color: string };
  animation?: StyleAnimation;
  outline?: StyleOutline;
  box?: StyleBox;
  position?: StylePosition;
  max_lines?: number;
  line_spacing?: number;
  ext?: Extension;
}

export interface Project {
  schema: "zsir-cut/timeline";
  schema_version: "0.3";
  id: string;
  name: string;
  revision: Revision;
  recognition?: Recognition;
  subtitle_overlays?: SubtitleOverlay[];
  media: Media[];
  timelines: Timeline[];
  transcripts: Transcript[];
  subtitle_styles: SubtitleStyle[];
  ext?: Extension;
}
