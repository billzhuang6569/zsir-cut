import { expect, it } from "vitest";
import { summarizeToolResult, TOOL_DOCS, VERBS, validateCommand } from "../src/index.ts";

it.each([...new Set([...VERBS, "ask", "answer"])])("documents %s with a schema-valid request", (verb) => {
  const description = TOOL_DOCS[verb] ?? "";
  expect(description.length).toBeLessThanOrEqual(4000);
  expect(description.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(6);
  const example = JSON.parse(description.split("\n").at(-2) ?? "");
  const check = validateCommand(verb, example);
  // TODO(C3): Remove the exception once both decision schemas are available on this branch.
  if (["ask", "answer"].includes(verb) && check.errors[0]?.keyword === "verb") return;
  expect(check.errors).toEqual([]);
  expect(check.valid).toBe(true);
});

const base = {
  status: "applied" as const,
  verb: "edit",
  receipt: { before: "rev_41", after: "rev_42", idempotency_key: "edit-1", replayed: false },
  changes: [],
  verification: { level: "L1" as const, passed: true, issues: [] },
  result: null,
  error: null,
};

it("summarizes changes per entity, the label and both warning sources", () => {
  expect(
    summarizeToolResult(
      {
        ...base,
        changes: [
          { entity: "clip", id: "clp_a", action: "updated", op: "remove_span" },
          { entity: "clip", id: "clp_b", action: "created", op: "remove_span" },
          { entity: "cue", id: "cue_a", action: "removed", op: "remove_span" },
        ],
        verification: {
          ...base.verification,
          issues: [{ code: "W_SUB_UNPROJECTED", severity: "warning", message: "字幕未投影。", ids: ["cue_b"] }],
        },
        result: { warnings: [{ code: "W_RIPPLE_SKIPPED" }, "W_ASR_EMPTY"] },
      },
      { label: "删除重复介绍" },
    ),
  ).toBe(
    [
      "applied edit rev_42",
      "label 删除重复介绍",
      "clip 新增 1，删除 0，修改 1",
      "cue 新增 0，删除 1，修改 0",
      "W_SUB_UNPROJECTED 字幕未投影。",
      "W_RIPPLE_SKIPPED 有片段挡住合拢，保留了空隙。",
      "W_ASR_EMPTY 没有识别到字词。",
    ].join("\n"),
  );
});

it("shows a rejection and an accepted job without a receipt", () => {
  expect(
    summarizeToolResult({
      ...base,
      status: "rejected",
      receipt: null,
      error: { code: "E_LOCKED", message: "轨道已锁定" },
    }),
  ).toBe("rejected edit —\nE_LOCKED 轨道已锁定");
  expect(
    summarizeToolResult({
      ...base,
      status: "accepted",
      verb: "transcribe",
      receipt: null,
      result: { job_id: "job_test" },
    }),
  ).toBe("accepted transcribe —\njob_id job_test");
});

it("caps line and character counts even with multi-line messages", () => {
  const many = summarizeToolResult({
    ...base,
    result: {
      warnings: Array.from({ length: 25 }, (_, index) => ({ code: `W_${index}`, message: "第 1 行\n第 2 行" })),
    },
  });
  expect(many.split("\n")).toHaveLength(21);
  expect(many).toContain("W_0 第 1 行 第 2 行");
  const long = summarizeToolResult({ ...base, error: { code: "E_IO", message: "🎬".repeat(2000) } });
  expect(long.length).toBeLessThanOrEqual(2000);
  expect(long).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(long.endsWith("…")).toBe(true);
});
