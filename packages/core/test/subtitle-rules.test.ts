// biome-ignore-all lint/style/noNonNullAssertion: Fixture indexes are fixed by each case.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  compare,
  cueBreaks,
  cueText,
  displayRanges,
  type Project,
  parseProject,
  printRational,
  rational,
  segmentTokens,
  serializeProject,
  subtitleRules,
  type Token,
  textWidth,
  transcriptRules,
} from "../src/index.js";

const s = (n: bigint, d = 1n) => rational(n, d);
const make = (
  texts: string[],
  durations: bigint[] = texts.map(() => 1n),
  gaps: bigint[] = [],
  denominator = 10n,
): Token[] => {
  let at = 0n;
  return texts.map((text, i) => {
    at += gaps[i] ?? 0n;
    const token: Token = {
      id: `tok_${i}`,
      text,
      state: "auto",
      align: { start: s(at, denominator), end: s(at + durations[i]!, denominator), run: "run_test" },
    };
    at += durations[i]!;
    return token;
  });
};
const zh = subtitleRules("zh-Hans");
const width = (tokens: Token[]) => printRational(textWidth(tokens, zh));
const ranges = (
  tokens: Token[],
  cues: { first: number; last: number; timing?: { start?: ReturnType<typeof s>; end?: ReturnType<typeof s> } }[],
) => {
  const project = { transcripts: [] } as unknown as Project;
  const transcript = {
    id: "trs_test",
    language: "zh-Hans",
    tokens,
    cues: cues.map((cue, i) => ({
      id: `cue_${i}`,
      first_token: tokens[cue.first]!.id,
      last_token: tokens[cue.last]!.id,
      state: "auto" as const,
      ...(cue.timing ? { timing: cue.timing } : {}),
    })),
  } as Project["transcripts"][number];
  project.transcripts.push(transcript);
  return displayRanges(transcript);
};

describe("subtitle rules", () => {
  it.each([
    [["甲甲甲", "豆包", "工作", "乙乙"], ["豆包工作"], "甲甲甲", 5],
    [["甲甲", "二", "十几家", "乙乙"], [], "甲甲", 4],
    [["甲甲", "三", "小时", "乙乙"], [], "甲甲", 4],
    [["甲甲", "aB", "Cd", "乙乙"], ["ABCD"], "甲甲", 4],
    [["甲甲甲", "豆包", "", "工作", "乙乙"], ["豆包工作"], "甲甲甲", 5],
  ])("avoids splitting terms and numbers during rule segmentation", (words, terms, expected, cpl) => {
    const tokens = make(words);
    expect(
      segmentTokens(tokens, { ...zh, cpl }, undefined, terms)[0]!
        .map((token) => token.text)
        .join(""),
    ).toBe(expected);
  });

  it.each([
    [["甲", "是", "豆包", "工作", "乙"], ["豆包工作"], 1, 0],
    [["甲", "二", "十几家", "的", "乙"], [], 2, 0],
    [["甲", "是", "aB", "", "Cd", "乙"], ["ABCD"], 1, 0],
  ])("does not move AI cuts into terms or numbers", (words, terms, cut, expected) => {
    const tokens = make(words);
    const groups = segmentTokens(tokens, zh, new Set([tokens[cut]!.id]), terms);
    expect(tokens.indexOf(groups[0]!.at(-1)!)).toBe(expected);
  });

  it.each([
    [["甲", "豆", "包", "工作", "乙"], ["豆包工作"], 2, 3],
    [["甲", "二", "十几家", "乙"], [], 1, 2],
    [["甲", "三", "", "小时", "乙"], [], 1, 3],
  ])("corrects cuts already inside a term or number", (words, terms, cut, expected) => {
    const tokens = make(words);
    const groups = segmentTokens(tokens, zh, new Set([tokens[cut]!.id]), terms);
    expect(tokens.indexOf(groups[0]!.at(-1)!)).toBe(expected);
  });

  it.each([
    ["move forward", ["甲", "的", "是", "乙", "丙"], [2], [3]],
    ["move backward", ["甲", "乙", "是", "的", "丙"], [2], [1]],
    ["prefer later on a tie", ["甲", "是", "乙", "丙"], [1], [2]],
    ["drop without a nearby good boundary", ["是", "是", "的", "和", "是", "把", "是", "乙"], [3], []],
    ["process corrections sequentially", ["甲", "是", "乙", "是", "丙", "丁"], [1, 3], [2, 4]],
    ["ignore hidden tokens as boundaries", ["甲", "是", "", "乙", "丙"], [1, 2], [3]],
  ])("corrects AI cuts: %s", (_name, words, cuts, expected) => {
    const tokens = make(words as string[]);
    const groups = segmentTokens(tokens, zh, new Set((cuts as number[]).map((i) => tokens[i]!.id)));
    expect(groups.slice(0, -1).map((group) => tokens.indexOf(group.at(-1)!))).toEqual(expected);
  });

  it("keeps a bad cut when moving and merging exceed the duration limit", () => {
    const tokens = make(["甲", "是", "乙", "丙"], [4n, 4n, 4n, 4n]);
    const groups = segmentTokens(tokens, { ...zh, max_duration: s(8n, 10n) }, new Set([tokens[1]!.id]));
    expect(groups.map((group) => group.map((token) => token.text))).toEqual([
      ["甲", "是"],
      ["乙", "丙"],
    ]);
  });

  it("keeps a bad cut when moving and merging exceed the width limit", () => {
    const tokens = make(["甲甲", "是", "乙乙", "丙丙"]);
    const groups = segmentTokens(tokens, { ...zh, cpl: 4 }, new Set([tokens[1]!.id]));
    expect(groups.map((group) => group.map((token) => token.text))).toEqual([
      ["甲甲", "是"],
      ["乙乙", "丙丙"],
    ]);
  });

  it("leaves English AI cuts unchanged", () => {
    const tokens = make(["甲", "是", "乙", "丙"]);
    const groups = segmentTokens(tokens, subtitleRules("en"), new Set([tokens[1]!.id]));
    expect(groups[0]!.at(-1)!.text).toBe("是");
  });

  it("corrects real-case AI boundaries in the regression project", async () => {
    const parsed = parseProject(await readFile("fixtures/regressions/subtitle-boundary-correction.zcut.json", "utf8"));
    if (!parsed.ok) throw new Error("Invalid regression fixture");
    const tokens = parsed.project.transcripts[0]!.tokens;
    const groups = segmentTokens(tokens, zh, new Set([tokens[7]!.id, tokens[19]!.id]));
    expect(groups.map((group) => group.map((token) => token.text).join(""))).toEqual([
      "运营老师现在只需要非常专注的我",
      "做好我脚本的打磨",
      "我是目前所在的是凯迪仕",
      "智能锁",
    ]);
  });
  it.each(["的", "是", "和", "「是」，"])("avoids a width split after the whole token %s", (word) => {
    const tokens = make(["甲甲甲甲", "乙", "丙", "丁", word, "戊戊"]);
    const rules = { ...zh, cpl: 7 + Number(textWidth([tokens[4]!], zh).numerator) };
    expect(segmentTokens(tokens, rules)[0]!.at(-1)!.text).not.toBe(word);
  });
  it.each(["了", "吗", "呢", "「了」，"])("avoids a width split before the whole token %s", (word) => {
    expect(segmentTokens(make(["甲", "乙", "丙", "丁", word, "戊"]), { ...zh, cpl: 4 })[0]!.at(-1)!.text).toBe("丙");
  });
  it("matches whole tokens only and limits bad boundaries to zh-talk", () => {
    for (const word of ["目的", "是的", "和好"])
      expect(segmentTokens(make(["甲甲", "乙乙", word, "丙丙"]), { ...zh, cpl: 6 })[0]!.at(-1)!.text).toBe(word);
    expect(
      segmentTokens(make(["甲", "乙", "丙", "丁", "了"]), subtitleRules("en", { cpl: 8, max_lines: 1 }))[0]!.at(-1)!
        .text,
    ).toBe("丁");
  });
  it("ranks a normal boundary before bad soft-pause and punctuation boundaries", () => {
    const tokens = make(["甲甲", "乙乙", "是，", "丙丙"], undefined, [0n, 0n, 0n, 3n]);
    expect(segmentTokens(tokens, { ...zh, cpl: 6 })[0]!.at(-1)!.text).toBe("乙乙");
  });
  it("keeps soft-pause, punctuation and latest priority when every candidate is bad", () => {
    const words = ["甲甲", "的，", "和", "是", "把", "丁丁"];
    for (const [gaps, end] of [
      [[], "的，"],
      [[0n, 0n, 0n, 3n], "和"],
      [[0n, 0n, 3n, 3n], "和"],
    ] as const)
      expect(segmentTokens(make(words, undefined, [...gaps]), { ...zh, cpl: 7 })[0]!.at(-1)!.text).toBe(end);
    expect(segmentTokens(make(["甲甲", "的", "和", "是", "把", "丁丁"]), { ...zh, cpl: 6 })[0]!.at(-1)!.text).toBe(
      "把",
    );
  });
  it("does not weaken sentence punctuation or hard pauses at bad boundaries", () => {
    expect(
      segmentTokens(make(["是。", "了", "的", "吗"], undefined, [0n, 0n, 0n, 7n]), zh).map((group) =>
        group.map((token) => token.text),
      ),
    ).toEqual([["是。"], ["了", "的"], ["吗"]]);
  });
  it("rechecks width and duration after an earlier preferred boundary", () => {
    const tokens = make(["甲甲", "乙乙", "丙", "丁丁丁丁丁丁"], undefined, [0n, 0n, 3n]);
    const rules = { ...zh, cpl: 6 };
    const groups = segmentTokens(tokens, rules, new Set());
    expect(groups.map((group) => group.map((token) => token.text))).toEqual([
      ["甲甲", "乙乙"],
      ["丙"],
      ["丁丁丁丁丁丁"],
    ]);
    for (const group of groups) expect(compare(textWidth(group, rules), s(6n))).toBeLessThanOrEqual(0);
  });
  it("defaults Chinese to one line and preserves persisted two-line rules against golden", async () => {
    const parsed = parseProject(await readFile("fixtures/regressions/zh-talk-single-line.zcut.json", "utf8"));
    if (!parsed.ok) throw new Error("Invalid regression fixture");
    const before = serializeProject(parsed.project);
    const transcript = parsed.project.transcripts[0]!;
    expect(zh.max_lines).toBe(1);
    expect(subtitleRules("en").max_lines).toBe(2);
    const persisted = transcriptRules(transcript);
    expect(persisted.max_lines).toBe(2);
    const lines = (rules: typeof zh) =>
      segmentTokens(transcript.tokens, rules).map((tokens) => cueText(tokens, rules, cueBreaks(tokens, rules)));
    expect({ default: lines(zh), persisted: lines(persisted) }).toEqual(
      JSON.parse(await readFile("fixtures/golden/zh-talk-single-line.json", "utf8")),
    );
    expect(cueBreaks(transcript.tokens, zh)).toEqual([]);
    expect(serializeProject(parsed.project)).toBe(before);
  });
  it("matches example one: one line, 15 wide, 0–3.30 and no warning", () => {
    const tokens = make(
      ["一条", "三", "分钟", "的", "采访", "大概", "要", "剪", "两", "小时"],
      [44n, 22n, 44n, 22n, 44n, 44n, 22n, 22n, 22n, 44n],
      [],
      100n,
    );
    expect(width(tokens)).toBe("15");
    expect(segmentTokens(tokens, zh)).toHaveLength(1);
    expect(cueBreaks(tokens, zh)).toEqual([]);
    const row = ranges(tokens, [{ first: 0, last: 9 }])[0]!;
    expect([printRational(row.start, true), printRational(row.end, true), row.warnings]).toEqual(["0s", "33/10s", []]);
  });
  it("keeps the two-line example when explicitly requested", () => {
    const zh = subtitleRules("zh-Hans", { max_lines: 2 });
    const tokens = make(
      ["剪辑师", "拿到", "的", "工程", "还能", "继续", "改，", "这", "才", "叫", "真正", "的", "交接"],
      undefined,
      [],
    );
    expect(width(tokens)).toBe("22");
    expect(segmentTokens(tokens, zh)).toHaveLength(1);
    expect(cueBreaks(tokens, zh)).toEqual(["tok_6"]);
    expect(width(tokens.slice(0, 7))).toBe("14");
    expect(width(tokens.slice(7))).toBe("8");
    expect(cueText(tokens, zh, ["tok_6"])).toEqual(["剪辑师拿到的工程还能继续改", "这才叫真正的交接"]);
  });
  it("uses English defaults, counts mixed ASCII boundaries and joins standalone punctuation", () => {
    const en = subtitleRules("en-US");
    expect([en.name, en.cpl, en.cps, en.strip_end_punct]).toEqual(["en-talk", 42, 20, false]);
    const words = make(["every", "cut", ",", "works"]);
    expect(cueText(words, en)).toEqual(["every cut, works"]);
    expect(printRational(textWidth(words, en))).toBe("16");
    expect(cueText(make(["Agent", "先把"]), zh)).toEqual(["Agent先把"]);
  });
  it("splits sentences on final punctuation and hard pause, keeping standalone punctuation with the previous token", () => {
    const tokens = make(
      ["你好", "。", "继续", "说", "结束！", "再来"],
      [2n, 1n, 2n, 2n, 2n, 2n],
      [0n, 0n, 0n, 0n, 0n, 7n],
    );
    expect(segmentTokens(tokens, zh).map((group) => group.map((token) => token.text))).toEqual([
      ["你好", "。"],
      ["继续", "说", "结束！"],
      ["再来"],
    ]);
  });
  it("chooses soft pause before punctuation before the latest boundary", () => {
    const tokens = make(
      ["甲甲甲甲", "乙乙乙乙，", "丙丙丙丙", "丁丁丁丁", "戊戊戊戊"],
      [1n, 1n, 1n, 1n, 1n],
      [0n, 0n, 3n, 0n, 0n],
    );
    expect(segmentTokens(tokens, { ...zh, cpl: 8, max_lines: 2 })[0]!.map((token) => token.text)).toEqual([
      "甲甲甲甲",
      "乙乙乙乙，",
    ]);
    const noPause = make(["甲甲甲甲", "乙乙乙乙，", "丙丙丙丙", "丁丁丁丁", "戊戊戊戊"]);
    expect(segmentTokens(noPause, { ...zh, cpl: 8, max_lines: 2 })[0]!.at(-1)!.text).toBe("乙乙乙乙，");
    const plain = make(["甲甲甲甲", "乙乙乙乙", "丙丙丙丙", "丁丁丁丁", "戊戊戊丁"]);
    expect(segmentTokens(plain, { ...zh, cpl: 8, max_lines: 2 })[0]!.at(-1)!.text).toBe("丁丁丁丁");
  });
  it("chooses punctuation, then balanced width, then earlier boundary for explicit two-line breaks", () => {
    const zh = subtitleRules("zh-Hans", { max_lines: 2 });
    const punct = make(["甲甲甲甲", "乙乙乙乙，", "丙丙丙丙", "丁丁丁丁"]);
    expect(cueBreaks(punct, zh)).toEqual(["tok_1"]);
    const balanced = make(["甲甲甲甲", "乙乙乙乙", "丙丙丙丙", "丁丁丁丁"]);
    expect(cueBreaks(balanced, { ...zh, cpl: 10 })).toEqual(["tok_1"]);
    const tie = make(["甲甲甲甲甲甲甲", "乙乙", "丙丙", "丁丁丁丁丁丁甲"]);
    expect(cueBreaks(tie, { ...zh, cpl: 11 })).toEqual(["tok_1"]);
  });
  it("extends for minimum duration, then CPS, clamps for gap, and honors manual timing", () => {
    const tokens = make(["甲", "乙乙乙乙乙乙乙乙乙乙", "丙"], [2n, 2n, 2n], [0n, 0n, 1n]);
    const rows = ranges(tokens, [
      { first: 0, last: 0 },
      { first: 1, last: 1 },
      { first: 2, last: 2 },
    ]);
    expect(printRational(rows[0]!.end, true)).toBe("3/25s");
    expect(rows[0]!.warnings).toContain("W_SUB_SHORT");
    expect(rows[1]!.warnings).toContain("W_SUB_CPS");
    const manual = ranges(tokens, [
      { first: 0, last: 0, timing: { start: s(0n), end: s(1n, 10n) } },
      { first: 1, last: 1 },
    ]);
    expect(printRational(manual[0]!.end, true)).toBe("1/10s");
    expect(manual[0]!.warnings).toEqual([]);
    expect(compare(rows[0]!.end, rows[1]!.start)).toBeLessThan(0);
  });

  it("uses visible endpoints with hidden words and still extends for CPS and respects the next gap", () => {
    const tokens = make(["", "甲乙丙丁戊己庚辛壬癸", "", "后"], [1n, 2n, 1n, 2n], [0n, 0n, 0n, 8n]);
    const extended = ranges(tokens, [{ first: 0, last: 2 }])[0]!;
    expect([extended.start, extended.end]).toEqual([s(1n, 10n), s(109n, 90n)]);
    const clamped = ranges(tokens, [
      { first: 0, last: 2 },
      { first: 3, last: 3 },
    ])[0]!;
    expect([clamped.start, clamped.end]).toEqual([s(1n, 10n), s(28n, 25n)]);
    expect(clamped.warnings).toEqual(["W_SUB_CPS"]);
  });
});
