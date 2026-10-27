// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by command validation and local range checks.
import { add, div, mul, parseRational, type Rational, rational, sub } from "../rational.js";
import { EditError } from "./edit.js";
import {
  cueBreaks,
  type SubtitleRules,
  segmentTokens,
  subtitleRules,
  textWidth,
  transcriptRules,
} from "./subtitle-rules.js";
import type {
  Cue,
  Project,
  SubtitleStyle,
  SubtitleTrack,
  Timeline,
  Token,
  Transcript,
  TranscriptSubtitleRules,
} from "./types.js";

type Op = Record<string, unknown> & { op: string };
const fail = (code: EditError["code"], message: string): never => {
  throw new EditError(code, message);
};
const find = <T extends { id: string }>(items: T[], id: unknown, label: string): T =>
  items.find((item) => item.id === id) ?? fail("E_NOT_FOUND", `${label} ${String(id)} not found`);
const transcript = (project: Project, value: unknown) => find(project.transcripts, value, "Transcript");
const cueOwner = (project: Project, value: unknown): { transcript: Transcript; cue: Cue } => {
  for (const item of project.transcripts) {
    const cue = item.cues.find((entry) => entry.id === value);
    if (cue) return { transcript: item, cue };
  }
  return fail("E_NOT_FOUND", `Cue ${String(value)} not found`);
};
const subtitleTrack = (timeline: Timeline, value: unknown): SubtitleTrack => {
  const track = find(timeline.tracks, value, "Track");
  if (track.kind !== "subtitle") fail("E_VALIDATION", "Track is not a subtitle track");
  return track as SubtitleTrack;
};
const span = (item: Transcript, first: unknown, last: unknown): [number, number] => {
  const a = item.tokens.findIndex((token) => token.id === first);
  const b = item.tokens.findIndex((token) => token.id === last);
  if (a < 0 || b < 0) fail("E_NOT_FOUND", "Token not found");
  if (a > b) fail("E_VALIDATION", "Token range is reversed");
  return [a, b];
};
const cueSpan = (item: Transcript, cue: Cue) => span(item, cue.first_token, cue.last_token);
const protect = (item: Transcript, first: number, last: number, force = false) => {
  if (force) return;
  if (item.tokens.slice(first, last + 1).some((token) => token.state === "approved"))
    fail("E_LOCKED", "Approved token cannot be edited");
  if (
    item.cues.some((cue) => {
      const [a, b] = cueSpan(item, cue);
      return a <= last && b >= first && (cue.timing?.locked || cue.state === "approved");
    })
  )
    fail("E_LOCKED", "Locked or approved cue cannot be edited");
};
const seconds = (value: unknown): Rational => {
  try {
    return parseRational(value as string, true);
  } catch {
    return fail("E_VALIDATION", `Invalid time ${String(value)}`);
  }
};
const setFields = (target: Record<string, unknown>, op: Op, fields: string[]) => {
  for (const field of fields)
    if (Object.hasOwn(op, field)) {
      if (op[field] === null) delete target[field];
      else target[field] = structuredClone(op[field]);
    }
};
const styleRules = (
  project: Project,
  timeline: Timeline,
  item: Transcript,
  first: number,
  last: number,
): SubtitleRules => {
  const rules = transcriptRules(item);
  const tracks = timeline.tracks.filter(
    (track): track is SubtitleTrack => track.kind === "subtitle" && track.language === item.language,
  );
  for (const track of tracks) {
    const style = project.subtitle_styles.find((entry) => entry.id === track.default_style_id);
    if (style?.max_lines) rules.max_lines = Math.min(rules.max_lines, style.max_lines);
  }
  for (const cue of item.cues) {
    const [a, b] = cueSpan(item, cue);
    if (a > last || b < first || !cue.style_id) continue;
    const style = project.subtitle_styles.find((entry) => entry.id === cue.style_id);
    if (style?.max_lines) rules.max_lines = Math.min(rules.max_lines, style.max_lines);
  }
  return rules;
};

export function applySubtitleEdit(
  project: Project,
  timeline: Timeline,
  op: Op,
  generate: (prefix: string) => string,
  allowForce = false,
): void {
  if (op.force === true && !allowForce) fail("E_SESSION_STATE", "force requires a manual approval session");
  const force = op.force === true && allowForce;
  switch (op.op) {
    case "edit_text": {
      const item = transcript(project, op.transcript_id);
      const [first, last] = span(item, op.from_token, op.to_token);
      protect(item, first, last, force);
      const old = item.tokens.slice(first, last + 1);
      const pieces = (op.text as string).includes(" ")
        ? (op.text as string).trim().split(/\s+/u)
        : ((op.text as string).match(
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9]+|[^\s]/gu,
          ) ?? []);
      if (!pieces.length) fail("E_VALIDATION", "Replacement text is empty");
      const ids = op.new_ids as string[] | undefined;
      if (ids && ids.length !== pieces.length) fail("E_VALIDATION", "new_ids length differs from token count");
      const start = old[0]!.align.start;
      const end = old.at(-1)!.align.end;
      const runId = generate("run_");
      const rules = transcriptRules(item);
      const displayTokens = pieces.map((text) => ({ ...old[0]!, text }));
      const widths = pieces.map((_, index) =>
        sub(textWidth(displayTokens.slice(0, index + 1), rules), textWidth(displayTokens.slice(0, index), rules)),
      );
      const total = widths.reduce(add, rational(0n));
      let at = start;
      const next: Token[] = pieces.map((text, index) => {
        const stop = index === pieces.length - 1 ? end : add(at, mul(sub(end, start), div(widths[index]!, total)));
        const token: Token = {
          id: ids?.[index] ?? generate("tok_"),
          text,
          state: "edited",
          heard: index === 0 ? old.map((entry) => entry.heard ?? entry.text).join("") : "",
          align: { start: at, end: stop, run: runId },
        };
        at = stop;
        return token;
      });
      item.raw_runs.push({
        id: runId,
        kind: "align",
        engine: { name: "interpolate", model: "interpolate", version: "1" },
        created_at: project.revision.created_at,
        range: { start, duration: sub(end, start) },
        tokens: next.map((entry) => ({ text: entry.text, start: entry.align.start, end: entry.align.end })),
      });
      const oldIds = new Set(old.map((token) => token.id));
      for (const cue of item.cues) {
        if (oldIds.has(cue.first_token)) cue.first_token = next[0]!.id;
        if (oldIds.has(cue.last_token)) cue.last_token = next.at(-1)!.id;
        if (cue.breaks) cue.breaks = cue.breaks.map((id) => (oldIds.has(id) ? next.at(-1)!.id : id));
      }
      item.tokens.splice(first, old.length, ...next);
      break;
    }
    case "hide_tokens":
    case "set_token_state": {
      const item = transcript(project, op.transcript_id);
      for (const tokenId of op.tokens as string[]) {
        const index = item.tokens.findIndex((entry) => entry.id === tokenId);
        if (index < 0) fail("E_NOT_FOUND", `Token ${tokenId} not found`);
        protect(item, index, index, force);
        const token = item.tokens[index]!;
        if (op.op === "hide_tokens") {
          token.heard ??= token.text;
          token.text = "";
        } else token.state = op.state as Token["state"];
      }
      break;
    }
    case "resegment": {
      const item = transcript(project, op.transcript_id);
      const [first, last] = op.range
        ? span(item, (op.range as Record<string, unknown>).from_token, (op.range as Record<string, unknown>).to_token)
        : [0, item.tokens.length - 1];
      if (op.rules !== undefined) {
        const raw = op.rules as Record<string, unknown>;
        const stored: TranscriptSubtitleRules = {
          profile:
            (raw.profile as TranscriptSubtitleRules["profile"] | undefined) ??
            item.subtitle_rules?.profile ??
            subtitleRules(item.language).name,
        };
        for (const key of ["min_duration", "max_duration", "hard_pause", "soft_pause", "min_gap"] as const)
          if (raw[key] !== undefined) stored[key] = seconds(raw[key]);
        for (const key of ["cpl", "max_lines", "cps", "strip_end_punct"] as const)
          if (raw[key] !== undefined) (stored as unknown as Record<string, unknown>)[key] = raw[key];
        item.subtitle_rules = stored;
      }
      const rules = styleRules(project, timeline, item, first, last);
      const protectedCues = force
        ? []
        : item.cues.filter((cue) => {
            const [a, b] = cueSpan(item, cue);
            return (
              cue.timing?.locked ||
              cue.state === "approved" ||
              item.tokens.slice(a, b + 1).some((token) => token.state === "approved")
            );
          });
      const blocked = new Set<number>();
      item.tokens.forEach((token, index) => {
        if (force) return;
        if (token.state === "approved") blocked.add(index);
      });
      for (const cue of protectedCues) {
        const [a, b] = cueSpan(item, cue);
        for (let i = a; i <= b; i++) blocked.add(i);
      }
      const old = item.cues;
      const next: Cue[] = [];
      let cursor = first;
      while (cursor <= last) {
        if (blocked.has(cursor)) {
          cursor++;
          continue;
        }
        let stop = cursor;
        while (stop < last && !blocked.has(stop + 1)) stop++;
        for (const group of segmentTokens(item.tokens.slice(cursor, stop + 1), rules)) {
          const firstId = group[0]!.id,
            lastId = group.at(-1)!.id;
          const previous = old.find((cue) => cue.first_token === firstId && cue.last_token === lastId);
          next.push(
            previous
              ? { ...previous, breaks: cueBreaks(group, rules) }
              : {
                  id: generate("cue_"),
                  first_token: firstId,
                  last_token: lastId,
                  breaks: cueBreaks(group, rules),
                  state: "auto",
                },
          );
        }
        cursor = stop + 1;
      }
      const retained = old.flatMap((cue) => {
        const [a, b] = cueSpan(item, cue);
        if (b < first || a > last || protectedCues.includes(cue)) return [cue];
        const parts: Cue[] = [];
        if (a < first)
          parts.push({
            ...cue,
            last_token: item.tokens[first - 1]!.id,
            breaks: cue.breaks?.filter((id) => item.tokens.findIndex((token) => token.id === id) < first) ?? [],
          });
        if (b > last)
          parts.push({
            ...cue,
            id: parts.length ? generate("cue_") : cue.id,
            first_token: item.tokens[last + 1]!.id,
            breaks: cue.breaks?.filter((id) => item.tokens.findIndex((token) => token.id === id) > last) ?? [],
          });
        return parts;
      });
      item.cues = [...retained, ...next].sort((a, b) => cueSpan(item, a)[0] - cueSpan(item, b)[0]);
      const live = new Set(item.cues.map((cue) => cue.id));
      for (const entry of project.timelines)
        for (const track of entry.tracks)
          if (track.kind === "subtitle")
            track.overrides = track.overrides.filter(
              (override) => live.has(override.cue_id) || !old.some((cue) => cue.id === override.cue_id),
            );
      break;
    }
    case "set_cue": {
      const { transcript: item, cue } = cueOwner(project, op.cue_id);
      const [a, b] = cueSpan(item, cue);
      protect(item, a, b, force);
      const fields = ["breaks", "timing", "style_id", "state"];
      setFields(cue as unknown as Record<string, unknown>, op, fields);
      if (cue.timing && typeof cue.timing === "object") {
        const timing = cue.timing as unknown as Record<string, unknown>;
        for (const key of ["start", "end"]) if (timing[key] !== undefined) timing[key] = seconds(timing[key]);
      }
      break;
    }
    case "split_cue": {
      const { transcript: item, cue } = cueOwner(project, op.cue_id);
      const [a, b] = cueSpan(item, cue);
      protect(item, a, b, force);
      const at = item.tokens.findIndex((token) => token.id === op.after_token);
      if (at < a || at >= b) fail("E_VALIDATION", "Split point is outside cue");
      const right: Cue = {
        ...structuredClone(cue),
        id: (op.new_id as string | undefined) ?? generate("cue_"),
        first_token: item.tokens[at + 1]!.id,
        state: "edited",
      };
      if (right.breaks)
        right.breaks = right.breaks.filter((id) => item.tokens.findIndex((token) => token.id === id) > at);
      if (cue.timing) {
        if (cue.timing.end) right.timing = { end: cue.timing.end };
        else delete right.timing;
        if (cue.timing.start) cue.timing = { start: cue.timing.start };
        else delete cue.timing;
      }
      cue.last_token = item.tokens[at]!.id;
      if (cue.breaks) cue.breaks = cue.breaks.filter((id) => item.tokens.findIndex((token) => token.id === id) <= at);
      const index = item.cues.indexOf(cue);
      item.cues.splice(index + 1, 0, right);
      break;
    }
    case "merge_cues": {
      const ids = op.cue_ids as string[];
      const { transcript: item, cue } = cueOwner(project, ids[0]);
      const at = item.cues.indexOf(cue);
      const selected = ids.map((id, index) => {
        const current = item.cues[at + index];
        if (!current || current.id !== id) fail("E_VALIDATION", "Cues must be adjacent in order");
        const [a, b] = cueSpan(item, current as Cue);
        protect(item, a, b, force);
        return current as Cue;
      });
      for (let i = 1; i < selected.length; i++)
        if (cueSpan(item, selected[i - 1]!)[1] + 1 !== cueSpan(item, selected[i]!)[0])
          fail("E_VALIDATION", "Cues must cover adjacent tokens");
      cue.last_token = selected.at(-1)!.last_token;
      cue.breaks = selected.flatMap((entry) => entry.breaks ?? []);
      if (selected.some((entry) => entry.timing)) {
        const timing = {
          ...(selected[0]!.timing?.start ? { start: selected[0]!.timing.start } : {}),
          ...(selected.at(-1)!.timing?.end ? { end: selected.at(-1)!.timing!.end } : {}),
        };
        if (Object.keys(timing).length) cue.timing = timing;
        else delete cue.timing;
      }
      item.cues.splice(at + 1, ids.length - 1);
      for (const entry of project.timelines)
        for (const track of entry.tracks)
          if (track.kind === "subtitle")
            track.overrides = track.overrides.filter((entry) => !ids.slice(1).includes(entry.cue_id));
      break;
    }
    case "set_override":
    case "remove_override": {
      const track = subtitleTrack(timeline, op.track_id);
      const { transcript: item, cue } = cueOwner(project, op.cue_id);
      const [a, b] = cueSpan(item, cue);
      protect(item, a, b, force);
      const occurrence = timeline.tracks.some(
        (entry) => entry.kind !== "subtitle" && entry.clips.some((clip) => clip.occurrence_id === op.occurrence_id),
      );
      if (!occurrence) fail("E_NOT_FOUND", "Occurrence not found");
      const index = track.overrides.findIndex(
        (entry) => entry.occurrence_id === op.occurrence_id && entry.cue_id === op.cue_id,
      );
      if (op.op === "remove_override") {
        if (index < 0) fail("E_NOT_FOUND", "Override not found");
        track.overrides.splice(index, 1);
      } else {
        const value = {
          ...(index >= 0 ? track.overrides[index] : {}),
          occurrence_id: op.occurrence_id as string,
          cue_id: op.cue_id as string,
          ...(op.hidden !== undefined ? { hidden: op.hidden as boolean } : {}),
          ...(op.text !== undefined ? { text: op.text as string } : {}),
          ...(op.style_id !== undefined ? { style_id: op.style_id as string } : {}),
        };
        if (index < 0) track.overrides.push(value);
        else track.overrides[index] = value;
      }
      break;
    }
    case "add_free_cue": {
      const track = subtitleTrack(timeline, op.track_id);
      track.free_cues.push({
        id: (op.id as string | undefined) ?? generate("cue_"),
        timeline_start: seconds(op.timeline_start),
        duration: seconds(op.duration),
        text: op.text as string,
        ...(op.style_id ? { style_id: op.style_id as string } : {}),
      });
      break;
    }
    case "remove_free_cue": {
      const track = subtitleTrack(timeline, op.track_id);
      const cue = find(track.free_cues, op.id, "Free cue");
      track.free_cues.splice(track.free_cues.indexOf(cue), 1);
      break;
    }
    case "add_style": {
      const style = { ...op } as Record<string, unknown>;
      delete style.op;
      delete style.force;
      style.id ??= generate("sty_");
      style.version = 1;
      project.subtitle_styles.push(style as unknown as SubtitleStyle);
      break;
    }
    case "update_style": {
      const style = find(project.subtitle_styles, op.style_id, "Style");
      setFields(style as unknown as Record<string, unknown>, op, [
        "name",
        "font_family",
        "font_weight",
        "font_size",
        "color",
        "outline",
        "box",
        "position",
        "max_lines",
      ]);
      style.version++;
      break;
    }
    case "add_subtitle_track":
      timeline.tracks.push({
        id: (op.id as string | undefined) ?? generate("trk_"),
        kind: "subtitle",
        name: op.name as string,
        enabled: true,
        language: op.language as string,
        carrier_tracks: op.carrier_tracks as string[],
        default_style_id: op.default_style_id as string,
        overrides: [],
        free_cues: [],
      });
      break;
    default:
      fail("E_UNSUPPORTED", `Operation ${op.op} is not implemented`);
  }
}
