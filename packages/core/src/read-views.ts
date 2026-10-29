// biome-ignore-all lint/style/noNonNullAssertion: Token and time-map indexes are checked before use.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectSubtitles } from "./project/projection.ts";
import { validateProjectSemantics } from "./project/semantics.ts";
import type { Session } from "./project/session.ts";
import { openProject } from "./project/store.ts";
import { displayRanges } from "./project/subtitle-rules.ts";
import { clipTimeMap } from "./project/time-map.ts";
import type { Clip, Media, Project, Timeline, Token, Transcript } from "./project/types.ts";
import {
  add,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  type Rational,
  rational,
  sub,
} from "./rational.ts";
import { frameToTimecode } from "./timecode.ts";

type Input = Record<string, unknown>;
type Range = { start: Rational; duration: Rational };
const zero = rational(0n);
const max = (a: Rational, b: Rational) => (compare(a, b) > 0 ? a : b);
const time = (value: Rational, rate: Rational, start?: string) => ({
  t: printRational(value, true),
  ...(start ? { tc: frameToTimecode(floor(mul(value, rate)), printRational(rate), start.includes(";"), start) } : {}),
});
const sequenceTime = (value: Rational, timeline: Timeline) => time(value, timeline.edit_rate, timeline.start_timecode);
const sourceTime = (value: Rational, media?: Media) =>
  time(value, media?.video?.rate ?? rational(25n), media?.start_timecode);
const sourceClock = (value: Rational) => {
  const ms = floor(add(mul(value, rational(1000n)), rational(1n, 2n)));
  const pad = (part: bigint, length = 2) => part.toString().padStart(length, "0");
  return `${pad(ms / 3600000n)}:${pad((ms / 60000n) % 60n)}:${pad((ms / 1000n) % 60n)}.${pad(ms % 1000n, 3)}`;
};
const durationTime = (value: Rational, rate: Rational, startTimecode?: string) =>
  time(value, rate, startTimecode ? `00:00:00${startTimecode.includes(";") ? ";" : ":"}00` : undefined);
const within = (start: Rational, end: Rational, range?: Range) =>
  !range ||
  (compare(start, add(range.start, range.duration)) < 0 &&
    (compare(end, start) === 0 ? compare(start, range.start) >= 0 : compare(end, range.start) > 0));
const requestedRange = (input: Input): Range | undefined => {
  const value = input.range as { start: string; duration: string } | undefined;
  return value ? { start: parseRational(value.start, true), duration: parseRational(value.duration, true) } : undefined;
};

function timelineEnd(timeline: Timeline): Rational {
  let end = zero;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitle") {
      for (const cue of track.free_cues) end = max(end, add(cue.timeline_start, cue.duration));
    } else for (const clip of track.clips) end = max(end, add(clip.timeline_start, clip.duration));
  }
  return end;
}

function entity(project: Project, id: string): Record<string, unknown> | undefined {
  if (id === project.id) return { parent_id: null, entity: project };
  for (const collection of [project.media, project.timelines, project.transcripts, project.subtitle_styles]) {
    const found = collection.find((item) => item.id === id);
    if (found) return { parent_id: project.id, entity: found };
  }
  for (const timeline of project.timelines) {
    const marker = timeline.markers.find((item) => item.id === id);
    if (marker) return { parent_id: timeline.id, entity: marker };
    for (const track of timeline.tracks) {
      if (track.id === id) return { parent_id: timeline.id, entity: track };
      const found =
        track.kind === "subtitle"
          ? track.free_cues.find((item) => item.id === id)
          : [...track.clips, ...track.transitions].find((item) => item.id === id);
      if (found) return { parent_id: track.id, entity: found };
    }
  }
  for (const transcript of project.transcripts) {
    for (const collection of [transcript.raw_runs, transcript.tokens, transcript.cues]) {
      const found = collection.find((item) => item.id === id);
      if (found) return { parent_id: transcript.id, entity: found };
    }
  }
  return undefined;
}

export function decisionSummary(project: Project, session: Pick<Session, "decisions">) {
  const decisions = (session.decisions ?? []).map((decision) => ({
    ...decision,
    ...(decision.refs
      ? {
          refs: decision.refs.map((ref) =>
            ref.kind === "entity"
              ? { ...ref, ...(!entity(project, ref.id) ? { missing: true } : {}) }
              : {
                  ...ref,
                  at: project.timelines[0]
                    ? sequenceTime(parseRational(ref.at, true), project.timelines[0])
                    : { t: ref.at },
                },
          ),
        }
      : {}),
  }));
  return { decisions, pending_count: decisions.filter((decision) => decision.state === "pending").length };
}

async function sessions(projectPath: string, project: Project): Promise<Record<string, unknown>[]> {
  const root = join(dirname(resolve(projectPath)), ".zcut", project.id, "sessions");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const active: Record<string, unknown>[] = [];
  for (const name of names.sort()) {
    const item = JSON.parse(await readFile(join(root, name, "session.json"), "utf8")) as Session;
    if (item.state === "open" || item.state === "in_review")
      active.push({
        id: item.session_id,
        state: item.state,
        approval: item.approval,
        intent: item.intent,
        pending_count: (item.decisions ?? []).filter((decision) => decision.state === "pending").length,
      });
  }
  return active;
}

export async function inspect(
  project: Project,
  projectPath: string,
  input: Input,
  mainProjectPath = projectPath,
): Promise<Record<string, unknown>> {
  if (input.view === "session") {
    const session = JSON.parse(await readFile(join(dirname(projectPath), "session.json"), "utf8")) as Session;
    return {
      session_id: session.session_id,
      state: session.state,
      approval: session.approval,
      intent: session.intent,
      base_revision: session.base_revision,
      draft_revision: project.revision.id,
      ...decisionSummary(project, session),
    };
  }
  if (input.view === "entity") {
    const raw = JSON.parse(await readFile(projectPath, "utf8")) as Project;
    const found = entity(raw, input.id as string);
    if (!found) throw new Error(`E_NOT_FOUND: ${input.id}`);
    return found;
  }
  const journal =
    input.view === "history" || input.view === "brief" ? await openProject({ projectPath }).journal() : [];
  if (input.view === "history") {
    let before = journal.length;
    if (input.before) {
      before = journal.findIndex((item) => item.revision === input.before);
      if (
        before < 0 &&
        (journal[0]?.parent === input.before || (!journal.length && project.revision.id === input.before))
      )
        before = 0;
    }
    if (before < 0) throw new Error(`E_NOT_FOUND: ${input.before}`);
    return {
      entries: journal
        .slice(0, before)
        .reverse()
        .slice(0, (input.limit as number | undefined) ?? 20),
    };
  }
  if (input.view === "timeline") {
    const timeline = project.timelines.find((item) => item.id === (input.timeline_id ?? project.timelines[0]?.id));
    if (!timeline) throw new Error(`E_NOT_FOUND: ${input.timeline_id}`);
    const range = requestedRange(input);
    const media = new Map(project.media.map((item) => [item.id, item]));
    return {
      id: timeline.id,
      name: timeline.name,
      edit_rate: printRational(timeline.edit_rate),
      drop_frame: timeline.drop_frame,
      start_timecode: timeline.start_timecode,
      duration: durationTime(timelineEnd(timeline), timeline.edit_rate, timeline.start_timecode),
      tracks: timeline.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        enabled: track.enabled,
        ...(track.kind === "subtitle"
          ? { clips: [], transitions: [] }
          : {
              clips: track.clips
                .filter((clip) => within(clip.timeline_start, add(clip.timeline_start, clip.duration), range))
                .map((clip) => clipView(clip, timeline, media.get(clip.media_id))),
              transitions: track.transitions
                .filter((transition) => {
                  const from = track.clips.find((clip) => clip.id === transition.from_clip);
                  if (!from) return false;
                  const cut = add(from.timeline_start, from.duration);
                  const outgoing =
                    transition.alignment === "end"
                      ? zero
                      : transition.alignment === "center"
                        ? div(transition.duration, rational(2n))
                        : transition.duration;
                  const start = sub(cut, outgoing);
                  return within(start, add(start, transition.duration), range);
                })
                .map((transition) => ({
                  ...transition,
                  duration: durationTime(transition.duration, timeline.edit_rate, timeline.start_timecode),
                })),
            }),
      })),
      markers: timeline.markers
        .filter((marker) => within(marker.at, add(marker.at, marker.duration), range))
        .map((marker) => ({
          ...marker,
          at: sequenceTime(marker.at, timeline),
          duration: durationTime(marker.duration, timeline.edit_rate, timeline.start_timecode),
        })),
    };
  }
  const issues = validateProjectSemantics(project);
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  const media = project.media.slice(0, 50).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    duration: durationTime(item.duration, item.video?.rate ?? rational(25n), item.start_timecode),
  }));
  const timelines = project.timelines.map((timeline) => {
    const reviews = timeline.markers.filter((item) => item.kind === "review");
    return {
      id: timeline.id,
      name: timeline.name,
      edit_rate: printRational(timeline.edit_rate),
      drop_frame: timeline.drop_frame,
      start_timecode: timeline.start_timecode,
      duration: durationTime(timelineEnd(timeline), timeline.edit_rate, timeline.start_timecode),
      tracks: timeline.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        enabled: track.enabled,
        clip_count: track.kind === "subtitle" ? 0 : track.clips.length,
      })),
      review_markers: reviews.slice(0, 50).map((marker) => ({
        id: marker.id,
        at: sequenceTime(marker.at, timeline),
        duration: durationTime(marker.duration, timeline.edit_rate, timeline.start_timecode),
        text: marker.text,
      })),
      review_markers_truncated: reviews.length > 50,
      tracks_truncated: false,
    };
  });
  const transcripts = project.transcripts.map((item) =>
    transcriptSummary(
      item,
      project.media.find((media) => media.id === item.media_id),
    ),
  );
  const recent = journal
    .slice(-5)
    .reverse()
    .map((item) => ({
      seq: item.seq,
      revision: item.revision,
      author: item.author,
      verb: item.verb,
      at: item.at,
      op_count: item.ops?.length ?? 0,
    }));
  return {
    project: {
      id: project.id,
      name: project.name,
      version: project.schema_version,
      revision: { seq: project.revision.seq, id: project.revision.id },
    },
    media,
    media_truncated: project.media.length > media.length,
    timelines,
    timelines_truncated: false,
    transcripts,
    transcripts_truncated: false,
    recent_revisions: recent,
    sessions: await sessions(mainProjectPath, project),
    sessions_truncated: false,
    issues: counts,
  };
}

function clipView(clip: Clip, timeline: Timeline, media?: Media) {
  const points = clipTimeMap(clip);
  return {
    id: clip.id,
    occurrence_id: clip.occurrence_id,
    media_id: clip.media_id,
    label: clip.label ?? null,
    enabled: clip.enabled !== false,
    timeline_in: sequenceTime(clip.timeline_start, timeline),
    timeline_out: sequenceTime(add(clip.timeline_start, clip.duration), timeline),
    source_in: sourceTime(points[0]!.source, media),
    source_out: sourceTime(points.at(-1)!.source, media),
    speed: clip.time_map ? "map" : "1",
    ...(clip.time_map
      ? {
          time_map: points.map((point) => ({
            at: sequenceTime(add(clip.timeline_start, point.at), timeline),
            source: sourceTime(point.source, media),
            interp: point.interp,
          })),
        }
      : {}),
    gain_db: clip.gain_db ?? null,
  };
}

function transcriptSummary(item: Transcript, media?: Media) {
  const states = { auto: 0, edited: 0, approved: 0 };
  let start: Rational | undefined;
  let end: Rational | undefined;
  for (const token of item.tokens) {
    states[token.state]++;
    start = start === undefined || compare(token.align.start, start) < 0 ? token.align.start : start;
    end = end === undefined || compare(token.align.end, end) > 0 ? token.align.end : end;
  }
  return {
    id: item.id,
    media_id: item.media_id,
    language: item.language,
    word_count: item.tokens.length,
    cue_count: item.cues.length,
    states,
    source_range: start && end ? { start: sourceTime(start, media), end: sourceTime(end, media) } : null,
  };
}

const tokenSeconds = (value: Rational) => {
  const hundredths = floor(add(mul(value, rational(100n)), rational(1n, 2n)));
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
};
const timedWords = (tokens: Token[]) =>
  tokens
    .map(
      (token, index) =>
        `${index && /[A-Za-z0-9]$/u.test(tokens[index - 1]!.text) && /^[A-Za-z0-9]/u.test(token.text) ? " " : ""}${token.text}[${tokenSeconds(token.align.start)}-${tokenSeconds(token.align.end)}]`,
    )
    .join("");

export function readTranscript(project: Project, input: Input): { text: string; lines: number; truncated: boolean } {
  const range = requestedRange(input);
  const rows: string[] = [];
  if (input.transcript_id) {
    const transcript = project.transcripts.find((item) => item.id === input.transcript_id);
    if (!transcript) throw new Error(`E_NOT_FOUND: ${input.transcript_id}`);
    const media = project.media.find((item) => item.id === transcript.media_id);
    const indexes = new Map(transcript.tokens.map((token, index) => [token.id, index]));
    for (const item of displayRanges(transcript)) {
      if (!within(item.start, item.end, range)) continue;
      const first = indexes.get(item.cue.first_token)!;
      const last = indexes.get(item.cue.last_token)!;
      const tokens = transcript.tokens.slice(first, last + 1).filter((token) => token.text);
      if (!tokens.length) continue;
      const ids = `${tokens[0]!.id}..${tokens.at(-1)!.id}`;
      rows.push(
        `[${item.cue.id} ${ids}]${item.cue.state === "auto" ? "" : ` !${item.cue.state}`} ${media?.start_timecode ? sourceTime(item.start, media).tc : sourceClock(item.start)} ${input.with_times ? timedWords(tokens) : joinWords(tokens.map((token) => token.text))}`,
      );
    }
  } else {
    const timeline = project.timelines.find((item) => item.id === input.timeline_id);
    if (!timeline) throw new Error(`E_NOT_FOUND: ${input.timeline_id}`);
    const tokens = new Map(
      project.transcripts.flatMap((item) => item.tokens.map((token) => [token.id, token] as const)),
    );
    let previousClip: string | null = null;
    const clips = timeline.tracks.flatMap((track) => (track.kind === "subtitle" ? [] : track.clips));
    for (const cue of projectSubtitles(project, timeline.id).cues.sort((a, b) => compare(a.start, b.start))) {
      if (!cue.token_ids.length || !within(cue.start, cue.end, range)) continue;
      const state = project.transcripts.flatMap((item) => item.cues).find((item) => item.id === cue.cue_id)?.state;
      const ids = `${cue.token_ids[0]}..${cue.token_ids.at(-1)}`;
      if (cue.clip_id && previousClip !== cue.clip_id) {
        const clip = clips.find((item) => item.id === cue.clip_id)!;
        rows.push(`@${clip.id} ${sequenceTime(clip.timeline_start, timeline).tc}`);
        previousClip = cue.clip_id;
      }
      rows.push(
        `[${cue.cue_id} ${ids}]${state === "auto" || !state ? "" : ` !${state}`} ${sequenceTime(cue.start, timeline).tc} ${input.with_times ? timedWords(cue.token_ids.map((id) => tokens.get(id)!).filter((token) => token.text)) : cue.text.replaceAll("\n", " ")}`,
      );
    }
  }
  const kept: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const next = Buffer.byteLength(row, "utf8") + (kept.length ? 1 : 0);
    if (bytes + next > 256 * 1024) break;
    kept.push(row);
    bytes += next;
  }
  return { text: kept.join("\n"), lines: kept.length, truncated: kept.length < rows.length };
}

function joinWords(words: string[]): string {
  return words.reduce(
    (text, word) => text + (text && /[A-Za-z0-9]$/u.test(text) && /^[A-Za-z0-9]/u.test(word) ? " " : "") + word,
    "",
  );
}
