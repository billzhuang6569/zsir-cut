// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by the token range checks.
import { add, compare, div, mul, type Rational, rational, sub } from "../rational.ts";
import type { Cue, Token, Transcript } from "./types.ts";

export interface SubtitleRules {
  name: "zh-talk" | "en-talk";
  cpl: number;
  max_lines: number;
  cps: number;
  min_duration: Rational;
  max_duration: Rational;
  hard_pause: Rational;
  soft_pause: Rational;
  min_gap: Rational;
  strip_end_punct: boolean;
}

export const subtitleRules = (language: string, override: Partial<SubtitleRules> = {}): SubtitleRules => {
  const name = override.name ?? (language.startsWith("zh") ? "zh-talk" : "en-talk");
  return {
    name,
    cpl: name === "zh-talk" ? 16 : 42,
    max_lines: name === "zh-talk" ? 1 : 2,
    cps: name === "zh-talk" ? 9 : 20,
    min_duration: rational(1n),
    max_duration: rational(6n),
    hard_pause: rational(7n, 10n),
    soft_pause: rational(3n, 10n),
    min_gap: rational(2n, 25n),
    strip_end_punct: name === "zh-talk",
    ...override,
  };
};

export function transcriptRules(transcript: Transcript): SubtitleRules {
  const stored = transcript.subtitle_rules;
  return subtitleRules(transcript.language, stored ? { ...stored, name: stored.profile } : {});
}

export function rationalNumber(value: number): Rational {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(String(value));
  if (!match) throw new Error(`Invalid rule number: ${value}`);
  const decimals = match[2]?.length ?? 0;
  const exponent = Number(match[3] ?? 0) - decimals;
  const digits = BigInt(`${match[1]}${match[2] ?? ""}`);
  return exponent >= 0 ? rational(digits * 10n ** BigInt(exponent)) : rational(digits, 10n ** BigInt(-exponent));
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const sentenceEnd = /[。！？.!?]$/u;
const innerPunct = /[，、；：,;:]$/u;
const punctOnly = /^[。！？.!?，、；：,;:]+$/u;
const noBreakAfter = new Set(
  "的、地、得、和、与、跟、及、或、在、是、把、被、给、对、向、从、往、让、将、很、最、更、太、都、也、还、就、又、才、再、而、并、这、那、这个、那个、这些、那些、一个、一些、一种、一位、每、各、第".split(
    "、",
  ),
);
const noBreakBefore = new Set(
  "的、地、得、了、着、过、吗、呢、吧、啊、呀、嘛、啦、们、上、下、里、中、后、前、时、似的、一样".split("、"),
);
const stripPunctuation = (text: string) => text.replace(/^\p{P}+|\p{P}+$/gu, "");
const ascii = /[A-Za-z0-9]/;
const visible = (tokens: Token[]) => tokens.filter((token) => token.text !== "");
const joinSpace = (a: string, b: string) =>
  !punctOnly.test(b) &&
  ((/^[\x20-\x7E]+$/u.test(a) && /^[\x20-\x7E]+$/u.test(b)) || (ascii.test(a.at(-1) ?? "") && ascii.test(b[0] ?? "")))
    ? " "
    : "";

export function cueText(tokens: Token[], rules: SubtitleRules, breaks: string[] = []): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of visible(tokens)) {
    if (line) line += joinSpace(line, token.text);
    line += token.text;
    if (breaks.includes(token.id)) {
      lines.push(rules.strip_end_punct ? line.replace(/[。！？.!?，、；：,;:]+$/u, "") : line);
      line = "";
    }
  }
  if (line) lines.push(rules.strip_end_punct ? line.replace(/[。！？.!?，、；：,;:]+$/u, "") : line);
  return lines;
}

export function textWidth(tokens: Token[], rules: SubtitleRules): Rational {
  const entries = visible(tokens);
  let width = rational(0n);
  let previous = "";
  for (const token of entries) {
    const text = (previous ? joinSpace(previous, token.text) : "") + token.text;
    for (const character of text)
      width = add(width, rational(cjk.test(character) ? 2n : 1n, rules.name === "zh-talk" ? 2n : 1n));
    previous = token.text;
  }
  return width;
}

const widthLimit = (rules: SubtitleRules, lines = 1) => mul(rationalNumber(rules.cpl), rational(BigInt(lines)));
const validBoundary = (tokens: Token[], after: number) =>
  after < tokens.length - 1 && !punctOnly.test(tokens[after + 1]!.text);
export function cueBreaks(tokens: Token[], rules: SubtitleRules, ai = false): string[] {
  if ((!ai && rules.max_lines === 1) || compare(textWidth(tokens, rules), widthLimit(rules)) <= 0) return [];
  const candidates = tokens.slice(0, -1).flatMap((token, index) => {
    if (!validBoundary(tokens, index)) return [];
    const left = textWidth(tokens.slice(0, index + 1), rules);
    const right = textWidth(tokens.slice(index + 1), rules);
    if (compare(left, widthLimit(rules)) > 0 || compare(right, widthLimit(rules)) > 0) return [];
    return [{ id: token.id, index, punctuation: innerPunct.test(token.text), difference: sub(left, right) }];
  });
  candidates.sort((a, b) => {
    if (a.punctuation !== b.punctuation) return a.punctuation ? -1 : 1;
    const abs = (value: Rational) =>
      rational(value.numerator < 0n ? -value.numerator : value.numerator, value.denominator);
    return compare(abs(a.difference), abs(b.difference)) || a.index - b.index;
  });
  if (candidates[0]) return [candidates[0].id];
  if (ai) {
    const last = tokens
      .slice(0, -1)
      .findLast(
        (_, index) =>
          validBoundary(tokens, index) && compare(textWidth(tokens.slice(0, index + 1), rules), widthLimit(rules)) <= 0,
      );
    return last ? [last.id] : [];
  }
  return [];
}

export function badSubtitleBoundaries(
  tokens: Token[],
  terms: readonly string[] = [],
  excludeParticles = false,
): Set<string> {
  const entries = visible(tokens);
  const fold = (text: string) =>
    text.replace(/\p{Script=Latin}/gu, (letter) => {
      const lower = letter.toLowerCase();
      return lower.length === letter.length ? lower : letter;
    });
  const text = fold(entries.map((token) => token.text).join(""));
  const foldedTerms = terms.filter(Boolean).map(fold);
  const bad = new Set<string>();
  let offset = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const before = entries[i]!;
    const after = entries[i + 1]!;
    offset += before.text.length;
    const splitsTerm = foldedTerms.some((term) => {
      const begin = Math.max(0, offset - term.length + 1);
      const start = text.slice(begin, offset + term.length - 1).indexOf(term);
      return start >= 0 && begin + start < offset && begin + start + term.length > offset;
    });
    const beforeWord = stripPunctuation(before.text);
    const afterBad = noBreakAfter.has(beforeWord) && !(excludeParticles && ["的", "地", "得"].includes(beforeWord));
    const otherBad =
      noBreakBefore.has(stripPunctuation(after.text)) ||
      splitsTerm ||
      (/[0-9零一二三四五六七八九十百千万亿两几半]$/u.test(before.text) &&
        /^[0-9零一二三四五六七八九十百千万亿两几半个位家条年月日天号点分秒岁元块倍次小时%]/u.test(after.text));
    if (afterBad || otherBad) bad.add(before.id);
  }
  return bad;
}

export function segmentTokens(
  tokens: Token[],
  rules: SubtitleRules,
  cutAfter?: ReadonlySet<string>,
  terms: readonly string[] = [],
): Token[][] {
  if (cutAfter !== undefined) {
    const result: Token[][] = [];
    let group: Token[] = [];
    for (const token of tokens) {
      group.push(token);
      if (token.text !== "" && cutAfter.has(token.id)) {
        result.push(group);
        group = [];
      }
    }
    if (group.length) result.push(group);
    return result;
  }
  const bad = badSubtitleBoundaries(tokens, terms);
  const isBad = (before: Token) => bad.has(before.id);
  const result: Token[][] = [];
  let sentence: Token[] = [];
  const splitSentence = () => {
    let current: Token[] = [];
    for (const token of sentence) {
      while (
        current.length &&
        !punctOnly.test(token.text) &&
        (compare(textWidth([...current, token], rules), widthLimit(rules, rules.max_lines)) > 0 ||
          compare(sub(token.align.end, current[0]!.align.start), rules.max_duration) > 0)
      ) {
        const half = div(textWidth(current, rules), rational(2n));
        const choices = current.flatMap((entry, index) => {
          const following = current[index + 1] ?? token;
          if (punctOnly.test(following.text) || compare(textWidth(current.slice(0, index + 1), rules), half) <= 0)
            return [];
          const pause = sub(following.align.start, entry.align.end);
          const priority = compare(pause, rules.soft_pause) >= 0 ? 0 : innerPunct.test(entry.text) ? 1 : 2;
          const preceding = [...current.slice(0, index + 1)].reverse().find((item) => item.text !== "");
          const isBadChoice = rules.name === "zh-talk" && preceding !== undefined && isBad(preceding);
          return [{ index, priority, bad: isBadChoice }];
        });
        choices.sort((a, b) => Number(a.bad) - Number(b.bad) || a.priority - b.priority || b.index - a.index);
        const cut = choices[0]?.index ?? current.length - 1;
        result.push(current.slice(0, cut + 1));
        current = current.slice(cut + 1);
      }
      current.push(token);
    }
    if (current.length) result.push(current);
    sentence = [];
  };
  for (const [index, token] of tokens.entries()) {
    sentence.push(token);
    const next = tokens[index + 1];
    if (
      sentenceEnd.test(token.text) ||
      (next && !punctOnly.test(next.text) && compare(sub(next.align.start, token.align.end), rules.hard_pause) >= 0)
    )
      splitSentence();
  }
  if (sentence.length) splitSentence();
  return result;
}

export interface CueDisplay {
  cue: Cue;
  start: Rational;
  end: Rational;
  warnings: ("W_SUB_TOO_WIDE" | "W_SUB_SHORT" | "W_SUB_CPS")[];
}

export function displayRanges(transcript: Transcript): CueDisplay[] {
  const rules = transcriptRules(transcript);
  const indexes = new Map(transcript.tokens.map((token, index) => [token.id, index]));
  const rows = transcript.cues.flatMap((cue) => {
    const first = indexes.get(cue.first_token);
    const last = indexes.get(cue.last_token);
    if (first === undefined || last === undefined || first > last) return [];
    const tokens = visible(transcript.tokens.slice(first, last + 1));
    if (!tokens.length) return [];
    const start = cue.timing?.start ?? tokens[0]!.align.start;
    return [{ cue, tokens, start, end: cue.timing?.end ?? tokens.at(-1)!.align.end }];
  });
  rows.sort((a, b) => compare(a.start, b.start));
  return rows.map((row, index) => {
    const warnings: CueDisplay["warnings"] = [];
    const next = rows[index + 1];
    const maximum = next ? sub(next.start, rules.min_gap) : undefined;
    const maxEnd = (value: Rational) => (maximum && compare(value, maximum) > 0 ? maximum : value);
    const width = textWidth(row.tokens, rules);
    if (
      compare(width, widthLimit(rules, rules.max_lines)) > 0 ||
      compare(sub(row.end, row.start), rules.max_duration) > 0 ||
      row.tokens.some((token) => compare(textWidth([token], rules), widthLimit(rules)) > 0)
    )
      warnings.push("W_SUB_TOO_WIDE");
    let end = row.end;
    if (!row.cue.timing) {
      if (compare(sub(end, row.start), rules.min_duration) < 0) end = maxEnd(add(row.start, rules.min_duration));
      const cpsEnd = add(row.start, div(width, rationalNumber(rules.cps)));
      if (compare(end, cpsEnd) < 0) end = maxEnd(cpsEnd);
      end = maxEnd(end);
      if (compare(sub(end, row.start), rules.min_duration) < 0) warnings.push("W_SUB_SHORT");
      if (compare(end, cpsEnd) < 0) warnings.push("W_SUB_CPS");
    }
    return { cue: row.cue, start: row.start, end, warnings };
  });
}
