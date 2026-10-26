import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newId, parseProject, serializeProject } from "../src/index.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const standard = read("fixtures/projects/std-25.zcut.json");

function parsed(text: string) {
  const result = parseProject(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

describe("project IO", () => {
  for (const directory of ["examples", "fixtures/projects"]) {
    for (const name of readdirSync(new URL(directory, root)).filter((entry) => entry.endsWith(".zcut.json"))) {
      it(`round trips ${directory}/${name} byte for byte`, () => {
        const source = read(`${directory}/${name}`);
        const result = parsed(source);
        expect(result.issues).toEqual([]);
        expect(serializeProject(result.project)).toBe(source);
      });
    }
  }

  it("restores schema key order and clip order after shuffling", () => {
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const shuffleEntries = <T>(items: T[]): T[] => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [result[index], result[other]] = [result[other] as T, result[index] as T];
      }
      return result;
    };
    const shuffle = (value: unknown, key = ""): unknown => {
      if (Array.isArray(value)) {
        const items = value.map((item) => shuffle(item));
        return key === "clips" ? shuffleEntries(items) : items;
      }
      if (value && typeof value === "object" && key !== "ext") {
        return Object.fromEntries(
          shuffleEntries(Object.entries(value)).map(([entryKey, item]) => [entryKey, shuffle(item, entryKey)]),
        );
      }
      return value;
    };
    const shuffled = JSON.stringify(shuffle(JSON.parse(standard)));
    expect(serializeProject(parsed(shuffled).project)).toBe(standard);
  });

  it("preserves unknown extension namespaces and internal key order", () => {
    const source = JSON.parse(read("examples/minimal.zcut.json"));
    source.ext = { "zsir.unrecognized": { zebra: 1, alpha: { last: 2, first: 1 } } };
    const canonical = `${JSON.stringify(source, null, 2)}\n`;
    expect(serializeProject(parsed(canonical).project)).toBe(canonical);
    const numericKeys = read("examples/minimal.zcut.json").replace(
      /\n}\n$/,
      ',\n  "ext": {\n    "zsir.unrecognized": {\n      "10": "ten",\n      "2": "two"\n    }\n  }\n}\n',
    );
    expect(serializeProject(parsed(numericKeys).project)).toBe(numericKeys);
  });

  it("accepts a non-reduced time, reports its location, and writes canonical time", () => {
    const source = standard.replace('"timeline_start": "0s"', '"timeline_start": "2/2s"');
    expect(source).not.toBe(standard);
    const result = parsed(source);
    expect(result.issues).toContainEqual({
      code: "E_TIME_FORM",
      severity: "error",
      location: "/timelines/0/tracks/0/clips/0/timeline_start",
    });
    expect(serializeProject(result.project)).toContain('"timeline_start": "1s"');
  });

  it("returns Ajv errors for invalid projects and a failure for invalid JSON", () => {
    const invalid = JSON.parse(standard);
    invalid.name = "";
    const result = parseProject(JSON.stringify(invalid));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.keyword).toBe("minLength");
    expect(parseProject("{")).toMatchObject({ ok: false, errors: [{ keyword: "parse" }] });
  });

  it("prompts an upgrade for an unrecognized project version", () => {
    for (const version of ["0.2", "1.0"]) {
      const source = JSON.parse(standard);
      source.schema_version = version;
      const result = parseProject(JSON.stringify(source));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          keyword: "const",
          instancePath: "/schema_version",
          message: expect.stringMatching(/unrecognized zsir-cut project version.*upgrade zsir-cut/i),
        }),
      );
    }
  });

  it("keeps all time and rate values as rational bigint values", () => {
    const project = parsed(read("examples/interview.zcut.json")).project;
    expect(project.timelines[0]?.edit_rate).toEqual({ numerator: 30000n, denominator: 1001n });
    expect(project.timelines[0]?.audio_rate).toEqual({ numerator: 48000n, denominator: 1n });
    expect(typeof project.timelines[0]?.tracks[0]?.kind).toBe("string");
    expect(project.transcripts[0]?.tokens[0]?.align.start.numerator).toBeTypeOf("bigint");
  });

  it("sorts edited tokens by alignment and keeps ties in input order", () => {
    const project = parsed(read("examples/interview.zcut.json")).project;
    const transcript = project.transcripts[0];
    if (!transcript) throw new Error("Missing interview transcript");
    const tokens = transcript.tokens;
    const expected = tokens.map((token) => token.id);
    tokens.reverse();
    const output = JSON.parse(serializeProject(project));
    expect(output.transcripts[0].tokens.map((token: { id: string }) => token.id)).toEqual(expected);
    const first = tokens.at(-1);
    if (!first) throw new Error("Missing interview token");
    tokens.unshift({ ...first, id: "tok_tie" });
    const tied = JSON.parse(serializeProject(project));
    expect(tied.transcripts[0].tokens.slice(0, 2).map((token: { id: string }) => token.id)).toEqual([
      "tok_tie",
      first.id,
    ]);
  });
});

describe("newId", () => {
  it("accepts only entity prefixes and emits deterministic UUIDv7 bits", () => {
    const sources = { now: () => 0, randomBytes: () => Uint8Array.from({ length: 10 }, (_, index) => index) };
    for (const prefix of [
      "prj_",
      "tl_",
      "trk_",
      "med_",
      "occ_",
      "clp_",
      "trn_",
      "mrk_",
      "trs_",
      "run_",
      "tok_",
      "cue_",
      "sty_",
      "rev_",
    ]) {
      expect(newId(prefix, sources)).toBe(`${prefix}00000000-0000-7001-8203-040506070809`);
    }
    expect(() => newId("bad_", sources)).toThrow(RangeError);
    expect(() => newId("PRJ_", sources)).toThrow(RangeError);
  });
});
