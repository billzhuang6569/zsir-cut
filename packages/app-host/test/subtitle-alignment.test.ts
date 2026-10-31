import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rational, type Token } from "../../core/src/index.ts";
import { alignSubtitleLines, SUBTITLE_PASS_PROMPT } from "../src/subtitle-pass.js";

const tokens = (words: string[]): Token[] =>
  words.map((text, i) => ({
    id: `tok_${i}`,
    text,
    state: "auto",
    align: { start: rational(BigInt(i)), end: rational(BigInt(i + 1)), run: "run_test" },
  }));

describe("subtitle line alignment", () => {
  it.each([
    [["甲", "乙", "丙"], ["甲乙", "丙"], [], ["tok_1", "tok_2"]],
    [["甲", "呃", "乙"], ["甲乙"], ["tok_1"], ["tok_2"]],
    [["甲", "乙", "丙"], ["甲", "乙"], ["tok_2"], ["tok_0", "tok_1"]],
    [["甲", "甲", "乙"], ["甲乙"], ["tok_0"], ["tok_2"]],
    [["你", "好"], ["你， / 好！"], [], ["tok_1"]],
    [["甲", "，", "乙"], ["甲", "乙"], [], ["tok_1", "tok_2"]],
  ])("aligns %j", (words, lines, hide, cuts) => {
    expect(alignSubtitleLines(tokens(words), lines)).toMatchObject({ hide, cuts });
  });
  it.each([
    [["甲", "乙"], ["甲丙"]],
    [["甲", "乙"], ["甲乙丙"]],
    [["甲", "乙"], ["乙甲"]],
    [["豆包"], ["豆", "包"]],
    [["甲"], []],
    [["a-b"], ["ab"]],
  ])("rejects invalid output %j", (words, lines) => {
    expect(() => alignSubtitleLines(tokens(words), lines)).toThrow();
  });
  it("aligns a full 600-token block with repeated words", () => {
    const result = alignSubtitleLines(tokens(Array(600).fill("字")), ["字".repeat(600)]);
    expect(result.hide).toEqual([]);
    expect(result.cuts).toEqual(["tok_599"]);
  });
  it("matches the quoted Skill prompt exactly", async () => {
    const skill = await readFile("skills/zsir-cut/references/subtitles.md", "utf8");
    const section = skill.split("### 断句要求")[1]?.split("\n\n看完 `verification.issues`")[0] ?? "";
    const prompt = section
      .split("\n")
      .filter((line) => line.startsWith(">"))
      .map((line) => (line.startsWith("> ") ? line.slice(2) : ""))
      .join("\n");
    expect(SUBTITLE_PASS_PROMPT).toBe(prompt);
  });
});
