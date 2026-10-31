// biome-ignore-all lint/style/noNonNullAssertion: Diff and token indices are bounded by the source arrays.
import type { Transcript } from "../../core/dist/index.js";

const { cueText, transcriptRules }: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

export interface ProofreadLine {
  transcript_id: string;
  id: string;
  text: string;
  locked: boolean;
}
export interface ProofreadFix extends ProofreadLine {
  replacement: string;
}
const compact = (text: string) => Array.from(text.replace(/\s/gu, ""));

export function proofreadLines(
  transcript: Transcript,
  range?: { from_token: string; to_token: string },
): ProofreadLine[] {
  const first = range ? transcript.tokens.findIndex((t) => t.id === range.from_token) : 0;
  const last = range ? transcript.tokens.findIndex((t) => t.id === range.to_token) : transcript.tokens.length - 1;
  if (first < 0 || last < first) throw new Error("字幕范围的字词已变化，请重新选择字幕后重试");
  const indexes = new Map(transcript.tokens.map((t, i) => [t.id, i]));
  return transcript.cues.flatMap((cue) => {
    const a = indexes.get(cue.first_token) ?? -1;
    const b = indexes.get(cue.last_token) ?? -1;
    if (a < first || b > last || a < 0 || b < a) return [];
    const tokens = transcript.tokens.slice(a, b + 1);
    return [
      {
        transcript_id: transcript.id,
        id: cue.id,
        text: cueText(tokens, transcriptRules(transcript), cue.breaks).join("\n"),
        locked: !!cue.timing?.locked || cue.state === "approved" || tokens.some((t) => t.state === "approved"),
      },
    ];
  });
}

function distances(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) table[i]![0] = i;
  for (let j = 0; j <= b.length; j++) table[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      table[i]![j] = Math.min(
        table[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        table[i - 1]![j]! + 1,
        table[i]![j - 1]! + 1,
      );
  return table;
}

export function proofreadProblem(line: ProofreadLine, text: string, terms: string[]): string | undefined {
  const a = compact(line.text),
    b = compact(text);
  if (!b.length) return `第 ${line.id} 条改后文字为空`;
  for (const mark of text.match(/[。！？.!?，、；：,;:]/gu) ?? [])
    if (text.split(mark).length > line.text.split(mark).length) return `第 ${line.id} 条加了标点，不要加标点`;
  const distance = distances(a, b)[a.length]![b.length]!;
  if (distance > Math.max(1, Math.ceil(a.length * 0.3)))
    return `第 ${line.id} 条改了 ${distance} 个字，只能改错字，不要改写`;
  for (const term of terms)
    if (line.text.includes(term) && !text.includes(term)) return `第 ${line.id} 条丢了名词「${term}」`;
  return undefined;
}

export function proofreadOps(transcript: Transcript, fix: ProofreadFix): Record<string, unknown>[] | null {
  const cue = transcript.cues.find((cue) => cue.id === fix.id);
  if (!cue) return [];
  const first = transcript.tokens.findIndex((t) => t.id === cue.first_token);
  const last = transcript.tokens.findIndex((t) => t.id === cue.last_token);
  const tokens = transcript.tokens.slice(first, last + 1);
  const a = Array.from(fix.text),
    b = Array.from(fix.replacement);

  const table = distances(a, b);
  const steps: { a: number; b: number; changed: boolean }[] = [];
  let i = a.length,
    j = b.length;
  while (i || j) {
    if (i && j && table[i]![j] === table[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      steps.push({ a: 1, b: 1, changed: a[--i] !== b[--j] });
    } else if (i && table[i]![j] === table[i - 1]![j]! + 1) {
      i--;
      steps.push({ a: 1, b: 0, changed: true });
    } else {
      j--;
      steps.push({ a: 0, b: 1, changed: true });
    }
  }
  const spans: { token: number; start: number; end: number }[] = [];
  let offset = 0;
  tokens.forEach((token, index) => {
    const length = compact(token.text).length;
    if (length) spans.push({ token: index, start: offset, end: offset + length });
    offset += length;
  });
  if (!spans.length) return [];
  // Display rules can strip punctuation at cue/line ends; keep offsets into the original tokens.
  const raw = compact(tokens.map((t) => t.text).join(""));
  const visible = compact(fix.text);
  const rawOwners: number[] = [];
  for (let at = 0, shown = 0; at < raw.length; at++) {
    if (raw[at] === visible[shown]) {
      rawOwners.push(at);
      shown++;
    } else if (!/[。！？.!?，、；：,;:]/u.test(raw[at]!)) return null;
  }
  if (rawOwners.length !== visible.length) return null;
  let shown = 0;
  const owners = a.map((char) => (/\s/u.test(char) ? undefined : rawOwners[shown++]));
  type Region = { start: number; end: number; from: number; to: number };
  const regions: Region[] = [];
  i = 0;
  j = 0;
  let region: Region | undefined;
  for (const step of steps.reverse()) {
    if (step.changed) {
      if (!region) region = { start: i, end: i, from: j, to: j };
      region.end += step.a;
      region.to += step.b;
    } else if (region) {
      regions.push(region);
      region = undefined;
    }
    i += step.a;
    j += step.b;
  }
  if (region) regions.push(region);
  const groups: { first: number; last: number; edits: Region[] }[] = [];
  for (const change of regions) {
    if (!a.slice(change.start, change.end).join("").trim() && !b.slice(change.from, change.to).join("").trim())
      continue;
    const covered = owners.slice(change.start, change.end).filter((at): at is number => at !== undefined);
    const start = covered[0] ?? owners.slice(change.start).find((at) => at !== undefined) ?? rawOwners.at(-1)! + 1;
    const end = covered.length ? covered.at(-1)! + 1 : start;
    const left = spans.find((span) => span.end > start) ?? spans.at(-1)!;
    const right = end > start ? spans.find((span) => span.end >= end)! : left;
    const edit = { ...change, start, end };
    const previous = groups.at(-1);
    if (previous && left.token <= previous.last) {
      previous.last = right.token;
      previous.edits.push(edit);
    } else groups.push({ first: left.token, last: right.token, edits: [edit] });
  }
  const ops: Record<string, unknown>[] = [];
  for (const group of groups) {
    const changed = tokens.slice(group.first, group.last + 1);
    if (changed.some((t) => !t.text)) return null;
    const text = Array.from(cueText(changed, { ...transcriptRules(transcript), strip_end_punct: false }).join(""));
    const sourcePositions = text.flatMap((char, index) => (/\s/u.test(char) ? [] : [index]));
    const offset = spans.find((span) => span.token === group.first)!.start;
    for (const edit of group.edits.toReversed()) {
      const start = sourcePositions[edit.start - offset] ?? text.length;
      const end = edit.end > edit.start ? sourcePositions[edit.end - offset - 1]! + 1 : start;
      const insert = b.slice(edit.from, edit.to);
      text.splice(start, end - start, ...insert);
    }
    ops.push({
      op: "edit_text",
      transcript_id: transcript.id,
      from_token: tokens[group.first]!.id,
      to_token: tokens[group.last]!.id,
      text: text.join(""),
    });
  }
  return ops;
}
