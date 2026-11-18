import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type Envelope, openProject, parseProject, type Verb } from "../src/index.ts";

const initial = "rev_fixture_1";
const turn = { id: "turn_first" };
const agent = { kind: "agent", name: "助手" };
const human = { kind: "human", name: "剪辑师" };
const clipLabel = (label: string, clip_id = "clp_v1") => ({ op: "set_clip", clip_id, label });
const choice = (id: string, label: string, ...ops: unknown[]) => ({ id, label, ...(ops.length ? { ops } : {}) });
const decision = {
  id: "dec_focus",
  question: "要保留哪一版？",
  options: [
    choice("first", "第一版", clipLabel("第一版")),
    choice("second", "第二版", clipLabel("第二版")),
    choice("keep", "保留现状"),
  ],
  refs: [
    { kind: "entity", id: "clp_v1" },
    { kind: "source", occurrence_id: "occ_1", media_id: "med_A", source_start: "18s", duration: "1s" },
  ],
};

let directory: string;
let project: string;
let serial: number;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-decisions-"));
  project = join(directory, "project.zcut.json");
  serial = 0;
  await copyFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), project);
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

const journal = () => openProject({ projectPath: project }).journal();
async function revision() {
  const read = parseProject(await readFile(project, "utf8"));
  if (!read.ok) throw new Error("Invalid fixture");
  return read.project.revision.id;
}
async function write(verb: Verb, params: Record<string, unknown>) {
  return dispatch(verb, {
    project,
    author: human,
    base_revision: await revision(),
    idempotency_key: `key_${++serial}`,
    ...params,
  });
}
const ask = (params: Record<string, unknown> = {}) =>
  write("ask", { author: agent, turn, decisions: [decision], ...params });
const answer = (params: Record<string, unknown>) => write("answer", { decision_id: decision.id, ...params });
const edit = (ops: unknown[], params: Record<string, unknown> = {}) => write("edit", { ops, ...params });
const inspect = (view: string, all = false) => dispatch("inspect", { project, view, ...(all ? { all } : {}) });
const entity = (id: string) => dispatch("inspect", { project, view: "entity", id });
const execution = (reply: Envelope) => (reply.result?.decision as { execution?: unknown } | undefined)?.execution;

describe("project decisions", () => {
  it("opens old projects and exposes pending decisions, source anchors, and a bounded brief without creating a revision", async () => {
    expect((await inspect("decisions")).result).toEqual({ decisions: [], pending_count: 0 });
    const request = { base_revision: initial, idempotency_key: "ask-key" };
    expect(await ask({ ...request, dry_run: true })).toMatchObject({ ok: true, status: "dry_run" });
    const asked = await ask(request);
    expect(asked).toMatchObject({
      status: "no_op",
      receipt: { after: null },
      result: { decision_ids: [decision.id], pending: 1 },
    });
    expect(await ask(request)).toEqual({ ...asked, receipt: { ...asked.receipt, replayed: true } });
    expect(await ask({ ...request, decisions: [{ ...decision, question: "不同的问题" }] })).toMatchObject({
      error: { code: "E_IDEMPOTENCY_MISMATCH" },
    });
    expect((await inspect("decisions")).result).toMatchObject({
      decisions: [
        {
          ...decision,
          refs: [decision.refs[0], { ...decision.refs[1], source_start: { t: "18s" }, duration: { t: "1s" } }],
          seq: 1,
          state: "pending",
          allow_other: true,
          created_by: agent,
          asked_at_revision: initial,
          turn,
        },
      ],
    });
    expect((await inspect("brief")).result?.decisions).toEqual({
      pending_count: 1,
      items: [{ id: decision.id, question: decision.question }],
    });
    expect(await journal()).toEqual([]);
    const file = JSON.parse(await readFile(join(directory, ".zcut/prj_std_25/decisions.json"), "utf8"));
    expect(file).toMatchObject({ schema: "zsir-cut/decisions", version: 1, decisions: [{ id: decision.id }] });
  });

  it("rejects invalid turns, sessions, IDs, choices, domains, and outdated writes", async () => {
    expect(await ask({ turn: { id: "other" } })).toMatchObject({ error: { code: "E_VALIDATION" } });
    expect(await ask({ session_id: "ses_demo" })).toMatchObject({ error: { code: "E_SESSION_STATE" } });
    expect(await answer({ option_id: "first", session_id: "ses_demo" })).toMatchObject({
      error: { code: "E_SESSION_STATE" },
    });
    expect(await ask({ base_revision: "rev_old" })).toMatchObject({ status: "conflict" });
    expect(
      await ask({
        decisions: [
          {
            ...decision,
            options: [
              choice("mixed", "混用", clipLabel("草稿"), { op: "mark_proofread", transcript_id: "trs_example" }),
            ],
          },
        ],
      }),
    ).toMatchObject({ error: { code: "E_MIXED_DOMAIN" } });
    expect(
      await ask({
        decisions: [
          { ...decision, options: [choice("first", "第一版"), { ...choice("second", "第二版"), recommended: true }] },
        ],
      }),
    ).toMatchObject({ error: { code: "E_VALIDATION" } });
    expect(await ask({ decisions: [{ ...decision, refs: [{ ...decision.refs[1], duration: "0s" }] }] })).toMatchObject({
      error: { code: "E_VALIDATION" },
    });
    await ask({ decisions: [{ ...decision, allow_other: false }] });
    expect(await ask()).toMatchObject({ error: { code: "E_VALIDATION" } });
    expect(await answer({ option_id: "unknown" })).toMatchObject({ error: { code: "E_NOT_FOUND" } });
    expect(await answer({ text: "说明" })).toMatchObject({ error: { code: "E_VALIDATION" } });
    expect(await answer({ skip: true, option_id: "keep" })).toMatchObject({ error: { code: "E_VALIDATION" } });
    expect(await answer({ skip: true })).toMatchObject({
      status: "no_op",
      result: { decision: { state: "skipped", execution: { state: "none" } } },
    });
  });

  it("executes with the answer author and original turn, replays, and replaces a prior execution", async () => {
    await ask({
      decisions: [
        { ...decision, options: [{ ...decision.options[0], label_after: "采用第一版" }, ...decision.options.slice(1)] },
      ],
    });
    const input = {
      base_revision: initial,
      idempotency_key: "answer-key",
      option_id: "first",
      turn: { id: "turn_answer" },
    };
    const applied = await answer(input);
    expect(applied).toMatchObject({
      verb: "answer",
      status: "applied",
      result: {
        pending: 0,
        decision: {
          state: "answered",
          answer: { author: human },
          execution: { state: "applied", revision: applied.receipt?.after },
        },
      },
    });
    expect((await journal())[0]).toMatchObject({ verb: "edit", label: "采用第一版", turn, author: human });
    expect(await answer(input)).toEqual({ ...applied, receipt: { ...applied.receipt, replayed: true } });
    expect(await answer({ ...input, option_id: "keep" })).toMatchObject({ error: { code: "E_IDEMPOTENCY_MISMATCH" } });
    const beforePreview = await readFile(project, "utf8");
    const preview = await answer({ option_id: "second", dry_run: true });
    expect(preview).toMatchObject({ status: "dry_run", changes: [{ id: "clp_v1" }, { id: "clp_v1" }] });
    expect(await readFile(project, "utf8")).toBe(beforePreview);
    const changed = await answer({ option_id: "second" });
    expect(changed).toMatchObject({ status: "applied", result: { decision: { answer: { option_id: "second" } } } });
    expect(await journal()).toMatchObject([
      { verb: "edit" },
      { verb: "undo", target: applied.receipt?.after },
      { verb: "edit", turn, label: "按你的选择：第二版" },
    ]);
    expect(await write("undo", { turn_id: turn.id })).toMatchObject({ status: "applied" });
    expect((await entity("clp_v1")).result).toMatchObject({ entity: { label: "A 第一次使用" } });
    expect(await write("redo", {})).toMatchObject({ status: "applied" });
    expect((await entity("clp_v1")).result).toMatchObject({ entity: { label: "第二版" } });
    const free = await answer({ text: "我另有想法" });
    expect(free).toMatchObject({
      status: "no_op",
      result: { decision: { answer: { text: "我另有想法" }, execution: { state: "none" } } },
    });
    expect((await entity("clp_v1")).result).toMatchObject({ entity: { label: "A 第一次使用" } });
    expect((await inspect("decisions")).result).toEqual({ decisions: [], pending_count: 0 });
    expect((await inspect("decisions", true)).result).toMatchObject({ decisions: [{ state: "answered" }] });
  });

  it("keeps the old answer when its edit cannot be undone", async () => {
    await ask();
    await answer({ option_id: "first" });
    await edit([clipLabel("用户重命名")]);
    const before = (await inspect("decisions", true)).result;
    expect(await answer({ option_id: "second" })).toMatchObject({
      error: { code: "E_UNDO_CONFLICT", details: { keys: ["clp_v1"] } },
    });
    expect((await inspect("decisions", true)).result).toEqual(before);
    expect(await journal()).toHaveLength(2);
  });

  it("detects stale by journal keys, keeps source anchors through a split, and ignores unrelated changes", async () => {
    await ask();
    await ask({
      decisions: [
        {
          id: "dec_unrelated",
          question: "第二段？",
          options: [choice("unrelated", "修改第二段", clipLabel("改好", "clp_v2"))],
        },
      ],
    });
    const split = await edit([{ op: "split", clip_id: "clp_v1", at: "5s" }]);
    expect(split.status, JSON.stringify(split)).toBe("applied");
    const stale = await answer({ option_id: "first" });
    expect(stale).toMatchObject({
      status: "no_op",
      result: { decision: { execution: { state: "stale" }, refs: [{ moved: true }, { kind: "source", moved: true }] } },
    });
    expect((await answer({ decision_id: "dec_unrelated", option_id: "unrelated" })).status).toBe("applied");
    expect((await inspect("decisions", true)).result).toMatchObject({ pending_count: 0 });
  });

  it.each([false, true])("handles a macro decision after a scoped clip change: %s", async (changed) => {
    await copyFile(new URL("../../../fixtures/regressions/c2-macros.zcut.json", import.meta.url), project);
    const op = { op: "tighten_pauses", max_pause: "1s", scope: { clip_ids: ["clp_a1"] } };
    expect(
      await ask({
        decisions: [{ id: decision.id, question: "缩短停顿？", options: [choice("first", "缩短", op)] }],
      }),
    ).toMatchObject({ ok: true });
    if (changed) expect(await edit([clipLabel("新标签", "clp_a1")])).toMatchObject({ status: "applied" });
    const answered = await answer({ option_id: "first" });
    if (changed) {
      expect(execution(answered)).toMatchObject({ state: "stale" });
    } else {
      expect(answered).toMatchObject({ status: "applied" });
      expect(await journal()).toMatchObject([
        { turn, ops: [op], expanded_ops: [{ op: "remove_span" }, { op: "remove_span" }] },
      ]);
    }
  });

  it("marks deleted entities missing and returns the underlying edit rejection for invalid operations", async () => {
    await ask();
    const removed = await edit([{ op: "remove", clip_ids: ["clp_v1"], ripple: false, linked: true }]);
    expect(removed.status, JSON.stringify(removed)).toBe("applied");
    expect(await answer({ option_id: "first" })).toMatchObject({
      result: { decision: { execution: { state: "stale" }, refs: [{ missing: true }, { missing: true }] } },
    });
    await ask({
      decisions: [
        { id: "dec_bad", question: "找不到？", options: [choice("bad", "修改", clipLabel("缺失", "clp_nonexistent"))] },
      ],
    });
    const failed = await answer({ decision_id: "dec_bad", option_id: "bad" });
    expect(failed).toMatchObject({ status: "rejected", error: { code: "E_NOT_FOUND" } });
    expect(execution(failed)).toMatchObject({ state: "failed", error: { code: "E_NOT_FOUND" } });
  });

  it.each(["before_step_7", "after_step_7"])("recovers an interrupted answer %s on the next write", async (point) => {
    await ask();
    const input = {
      project,
      author: human,
      base_revision: initial,
      idempotency_key: "crash-answer",
      decision_id: decision.id,
      option_id: "first",
    };
    const request = {
      project,
      author: human,
      base_revision: initial,
      idempotency_key: "crash-answer",
      request_id: "req_crash",
      verb: "answer",
      ops: [],
    };
    const source = new URL("../src/project/store.ts", import.meta.url).href;
    const crashed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { openProject } from ${JSON.stringify(source)};
      await openProject({ projectPath: ${JSON.stringify(project)}, fault(point) {
        if (point === ${JSON.stringify(point)}) process.exit(91);
      }}).decide(${JSON.stringify(request)}, ${JSON.stringify(input)});
    `,
      ],
      { encoding: "utf8" },
    );
    expect(crashed.status, crashed.stderr).toBe(91);
    const following = await edit([clipLabel("和回答无关", "clp_v2")]);
    expect(following.status).toBe(point === "after_step_7" ? "applied" : "conflict");
    const replayed = await dispatch("answer", input);
    expect(replayed).toMatchObject({ status: "applied", receipt: { replayed: true } });
    expect(await journal()).toMatchObject([
      { kind: "write", verb: "edit", turn },
      ...(point === "after_step_7" ? [{ kind: "write", verb: "edit" }] : []),
    ]);
    expect((await journal()).filter(({ turn: entryTurn }) => entryTurn?.id === turn.id)).toHaveLength(1);
  });

  it("limits pending decisions to 50 and retains the latest 200 finished decisions", async () => {
    const row = (index: number) => ({
      id: `dec_${index}`,
      question: "保留？",
      options: [choice(`choice_${index}`, "保留")],
    });
    for (let start = 0; start < 201; start += 50) {
      const decisions = Array.from({ length: Math.min(50, 201 - start) }, (_, index) => row(start + index));
      expect(await ask({ decisions })).toMatchObject({ ok: true });
      if (!start) {
        expect(await ask({ decisions: [row(1000)] })).toMatchObject({ error: { code: "E_VALIDATION" } });
        expect((await inspect("brief")).result?.decisions).toMatchObject({
          pending_count: 50,
          items: expect.any(Array),
        });
        expect(((await inspect("brief")).result?.decisions as { items: unknown[] }).items).toHaveLength(5);
      }
      for (const { id } of decisions) expect(await answer({ decision_id: id, skip: true })).toMatchObject({ ok: true });
    }
    const rows = (await inspect("decisions", true)).result?.decisions as { id: string; seq: number }[];
    expect(rows).toHaveLength(200);
    expect(rows[0]).toMatchObject({ id: "dec_1", seq: 2 });
    expect(rows.at(-1)).toMatchObject({ id: "dec_200", seq: 201 });
  }, 45_000);
});

describe("turn undo", () => {
  it("restores all writes in one revision, keeps intervening unrelated writes, and supports redo", async () => {
    const first = await edit([clipLabel("初剪")], { turn });
    const unrelated = await edit([clipLabel("人工标注", "clp_v2")]);
    const last = await edit([clipLabel("精剪"), clipLabel("第三段", "clp_v3")], { turn });
    expect((await inspect("history")).result).toMatchObject({ entries: [{ turn }, { turn: null }, { turn }] });
    const undo = await write("undo", { turn_id: turn.id });
    expect(undo).toMatchObject({ status: "applied" });
    expect((await journal()).at(-1)).toMatchObject({
      label: "撤回 AI 这一轮",
      target_revisions: [first.receipt?.after, last.receipt?.after],
    });
    expect((await entity("clp_v1")).result).toMatchObject({ entity: { label: "A 第一次使用" } });
    expect((await journal())[1]?.revision).toBe(unrelated.receipt?.after);
    expect(await write("redo", {})).toMatchObject({ status: "applied" });
    expect((await entity("clp_v1")).result).toMatchObject({ entity: { label: "精剪" } });
    expect(await write("undo", { turn_id: "turn_empty" })).toMatchObject({ status: "no_op", receipt: { after: null } });
  });

  it("reports changed entity keys and preserves the project if a grouped write conflicts", async () => {
    await edit([clipLabel("AI 1"), clipLabel("AI 2", "clp_v2")], { turn });
    await edit([clipLabel("人工改过"), clipLabel("人工说明", "clp_v2")]);
    const before = await revision();
    expect(await write("undo", { turn_id: turn.id })).toMatchObject({
      status: "rejected",
      error: { code: "E_UNDO_CONFLICT", details: { keys: ["clp_v1", "clp_v2"] } },
    });
    expect(await revision()).toBe(before);
    expect(await write("undo", { turn_id: turn.id, target: initial })).toMatchObject({
      error: { code: "E_VALIDATION" },
    });
  });
});
