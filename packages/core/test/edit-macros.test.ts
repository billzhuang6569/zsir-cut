import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdit } from "../src/project/edit.ts";
import { parseProject, serializeProject } from "../src/project/io.ts";

const bytes = readFileSync(new URL("../../../fixtures/regressions/c2-macros.zcut.json", import.meta.url), "utf8");
const fixture = () => {
  const parsed = parseProject(bytes);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.project;
};

const span = (start: string, duration: string, snap = "nearest", tracks: string | string[] = "all") => ({
  op: "remove_span",
  range: { start, duration },
  tracks,
  ripple: true,
  snap,
});
const keep = [
  { from_token: "tok_pause_0", to_token: "tok_pause_0" },
  { from_token: "tok_pause_3", to_token: "tok_pause_3" },
];
const filler = {
  op: "remove_span",
  tokens: {
    transcript_id: "trs_pause",
    from_token: "tok_pause_1",
    to_token: "tok_pause_2",
    clip_id: "clp_a1",
    pause: "1/5s",
  },
  ripple: true,
};
const scopes = [undefined, { range: { start: "5s", duration: "10s" } }, { clip_ids: ["clp_a1"] }];
const linked = ["trk_v1", "trk_a1"];
const run = (ops: Parameters<typeof applyEdit>[1], project = fixture()) => {
  const result: Record<string, unknown> = {};
  applyEdit(project, ops, {}, "macro-test", undefined, false, undefined, result);
  return { bytes: serializeProject(project), expanded: result.expanded_ops };
};

describe("C2 macros", () => {
  it.each(scopes.map((scope) => ({ scope })))("matches manual cuts for token macros with scope $scope", ({ scope }) => {
    const cases = [
      {
        macro: { op: "tighten_pauses", max_pause: "1s", scope },
        manual: [span("21/2s", "1s"), span("15/2s", "1s")],
      },
      { macro: { op: "remove_fillers", scope }, manual: [filler] },
      {
        macro: { op: "keep_tokens", clip_id: "clp_v1", keep, pause: "2/5s", scope },
        manual: [
          span("66/5s", "9/5s", "in", linked),
          span("36/5s", "23/5s", "in", linked),
          span("5s", "4/5s", "in", linked),
        ],
      },
    ];
    for (const { macro, manual } of cases) {
      const actual = run([macro]);
      expect(actual.expanded).toEqual(manual);
      expect(actual.bytes).toBe(run(manual).bytes);
    }
  });

  it.each([
    { scope: undefined, manual: [span("3s", "2s", "out"), span("0s", "1s", "out")] },
    { scope: { range: { start: "1s", duration: "6s" } }, manual: [span("3s", "2s", "out")] },
    { scope: { clip_ids: ["clp_lead", "clp_a1"] }, manual: [] },
  ])("closes only gaps on all tracks with scope $scope", ({ scope, manual }) => {
    const actual = run([{ op: "close_gaps", scope }]);
    expect(actual.expanded).toEqual(manual);
    expect(actual.bytes).toBe(run(manual).bytes);
  });

  it("uses the timeline after an earlier macro and preserves exact-threshold gaps", () => {
    const actual = run([{ op: "close_gaps" }, { op: "tighten_pauses", max_pause: "2s" }]);
    const manual = [span("3s", "2s", "out"), span("0s", "1s", "out")];
    expect(actual.expanded).toEqual(manual);
    expect(actual.bytes).toBe(run(manual).bytes);
    expect(run([{ op: "tighten_pauses", max_pause: "1s", min_gap: "2s" }]).expanded).toEqual([]);
  });

  it("shifts token-based cuts after a preceding macro", () => {
    const actual = run([{ op: "close_gaps" }, { op: "remove_fillers" }]);
    const manual = [span("3s", "2s", "out"), span("0s", "1s", "out"), filler];
    expect(actual.expanded).toEqual(manual);
    expect(actual.bytes).toBe(run(manual).bytes);
  });

  it.each([keep.toReversed(), [keep[0], { ...keep[1], from_token: "tok_pause_0" }]])(
    "rejects reversed or overlapping keep ranges",
    (...selection) => {
      expect(() => run([{ op: "keep_tokens", clip_id: "clp_a1", keep: selection }])).toThrow(
        expect.objectContaining({ code: "E_VALIDATION" }),
      );
    },
  );

  it.each([
    { op: "tighten_pauses", max_pause: "1s" },
    { op: "remove_fillers" },
    { op: "keep_tokens", clip_id: "clp_a1", keep },
    { op: "close_gaps" },
  ])("rejects a locked track for $op", (op) => {
    const project = fixture();
    const track = project.timelines[0]?.tracks[0];
    if (!track) throw new Error("Missing fixture track");
    track.locked = true;
    expect(() => run([op], project)).toThrow(expect.objectContaining({ code: "E_LOCKED" }));
  });

  it("applies approved-token protection to plain and expanded remove_span", () => {
    const project = fixture();
    const token = project.transcripts[0]?.tokens[1];
    if (!token) throw new Error("Missing fixture token");
    token.state = "approved";
    for (const op of [filler, { op: "remove_fillers" }])
      expect(() => run([op], structuredClone(project))).toThrow(expect.objectContaining({ code: "E_LOCKED" }));
  });
});
