import { serializeProject } from "./io.ts";
import type { Project } from "./types.ts";

export interface EntitySnapshot {
  entity:
    | "project"
    | "media"
    | "timeline"
    | "track"
    | "clip"
    | "transition"
    | "marker"
    | "transcript"
    | "token"
    | "cue"
    | "override"
    | "free_cue"
    | "style"
    | "run";
  parent: string | null;
  index: number | null;
  value: Record<string, unknown>;
}

export interface EntityChange {
  key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  before_parent: string | null;
  after_parent: string | null;
  before_index: number | null;
  after_index: number | null;
  entity: EntitySnapshot["entity"];
}

type Row = Record<string, unknown>;

function without(row: Row, fields: string[]): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
}

export function projectEntitySnapshots(project: Project): Map<string, EntitySnapshot> {
  const raw = JSON.parse(serializeProject(project)) as Row;
  const result = new Map<string, EntitySnapshot>();
  const add = (
    key: string,
    entity: EntitySnapshot["entity"],
    parent: string | null,
    value: Row,
    index: number | null = null,
  ) => {
    result.set(key, { entity, parent, index, value });
  };
  const rows = (value: unknown) => value as Row[];
  add("project", "project", null, without(raw, ["revision", "media", "timelines", "transcripts", "subtitle_styles"]));
  rows(raw.media).forEach((media, index) => {
    add(media.id as string, "media", "project", media, index);
  });
  for (const [timelineIndex, timeline] of rows(raw.timelines).entries()) {
    const timelineId = timeline.id as string;
    add(timelineId, "timeline", "project", without(timeline, ["tracks", "markers"]), timelineIndex);
    rows(timeline.tracks).forEach((track, index) => {
      const trackId = track.id as string;
      add(
        trackId,
        "track",
        timelineId,
        {
          ...without(track, ["clips", "transitions", "overrides", "free_cues"]),
          index,
        },
        index,
      );
      for (const clip of rows(track.clips ?? [])) add(clip.id as string, "clip", trackId, clip);
      rows(track.transitions ?? []).forEach((transition, position) => {
        add(transition.id as string, "transition", trackId, transition, position);
      });
      rows(track.overrides ?? []).forEach((override, position) => {
        add(
          `override:${trackId}:${override.occurrence_id}:${override.cue_id}`,
          "override",
          trackId,
          override,
          position,
        );
      });
      rows(track.free_cues ?? []).forEach((cue, position) => {
        add(cue.id as string, "free_cue", trackId, cue, position);
      });
    });
    for (const marker of rows(timeline.markers)) add(marker.id as string, "marker", timelineId, marker);
  }
  for (const [transcriptIndex, transcript] of rows(raw.transcripts).entries()) {
    const id = transcript.id as string;
    add(id, "transcript", "project", without(transcript, ["raw_runs", "tokens", "cues"]), transcriptIndex);
    rows(transcript.raw_runs).forEach((run, index) => {
      add(run.id as string, "run", id, run, index);
    });
    for (const token of rows(transcript.tokens)) add(token.id as string, "token", id, token);
    rows(transcript.cues).forEach((cue, index) => {
      add(cue.id as string, "cue", id, cue, index);
    });
  }
  rows(raw.subtitle_styles).forEach((style, index) => {
    add(style.id as string, "style", "project", style, index);
  });
  return result;
}

export function diffProjectEntities(before: Project, after: Project): EntityChange[] {
  const old = projectEntitySnapshots(before);
  const next = projectEntitySnapshots(after);
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((key) => {
    const a = old.get(key);
    const b = next.get(key);
    const source = b ?? a;
    if (!source) return [];
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    return [
      {
        key,
        before: a?.value ?? null,
        after: b?.value ?? null,
        before_parent: a?.parent ?? null,
        after_parent: b?.parent ?? null,
        before_index: a?.index ?? null,
        after_index: b?.index ?? null,
        entity: source.entity,
      },
    ];
  });
}
