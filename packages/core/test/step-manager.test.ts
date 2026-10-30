import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatch,
  type Envelope,
  openProject,
  parseProject,
  serializeProject,
  VERBS,
  validateCommand,
  validateEnvelope,
} from "../src/index.ts";
import { startPreviewJob } from "../src/jobs.ts";

vi.mock("../src/jobs.ts", async (original) => ({
  ...(await original<typeof import("../src/jobs.ts")>()),
  startPreviewJob: vi.fn(async () => "job_history"),
}));
let directory: string;
let project: string;
let key = 0;
const author = { kind: "agent" as const, name: "batch-test" };
const numbers = (from: number, to = 10) => Array.from({ length: to - from + 1 }, (_, i) => i + from);
const load = async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid test project");
  return parsed.project;
};
const input = (seq: number, extra: Record<string, unknown> = {}) => ({
  project,
  base_revision: "rev_fixture_1",
  idempotency_key: `batch-${seq}`,
  author,
  label: `Step ${seq}`,
  batch: { id: "bat_test", seq, count: 10 },
  ops: [{ op: "set_clip", clip_id: "clp_v1", label: `Step ${seq}` }],
  ...extra,
});
const send = async (seq: number, extra: Record<string, unknown> = {}) => {
  const output = await dispatch("edit", input(seq, extra));
  expect(validateEnvelope(output), JSON.stringify(output)).toMatchObject({ valid: true });
  return output;
};
const write = async (verb: "edit" | "undo" | "redo" | "restore", extra: Record<string, unknown>) =>
  dispatch(verb, {
    project,
    base_revision: (await load()).revision.id,
    idempotency_key: `write-${++key}`,
    author,
    label: "Manual step",
    ...extra,
  });
const status = async () => (await dispatch("batch_status", { project, batch_id: "bat_test" })).result;
const sameBytes = (actual: string, expected: string) => {
  const parsed = parseProject(actual);
  const baseline = parseProject(expected);
  if (!parsed.ok || !baseline.ok) throw new Error("Invalid project");
  expect(serializeProject(parsed.project)).toBe(actual);
  parsed.project.revision = baseline.project.revision;
  expect(serializeProject(parsed.project)).toBe(expected);
};
const processStep = (seq: number, extra: Record<string, unknown> = {}) =>
  new Promise<Envelope>((done, reject) => {
    const child = spawn(process.execPath, [resolve("packages/cli/src/index.ts"), "edit", project], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        expect(code, stderr || stdout).toBe(0);
        const envelope = JSON.parse(stdout) as Envelope;
        expect(validateEnvelope(envelope).valid).toBe(true);
        done(envelope);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input(seq, extra)));
  });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-steps-"));
  project = join(directory, "project.zcut.json");
  await copyFile("fixtures/projects/std-25.zcut.json", project);
  key = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("step manager acceptance", () => {
  it.each([false, true])(
    "orders ten shuffled processes (omit later base_revision: %s)",
    async (omit) => {
      const step = (seq: number) => processStep(seq, omit && seq > 1 ? { base_revision: undefined } : {});
      expect((await Promise.all([8, 6, 10, 7, 9].map(step))).map((item) => item.status)).toEqual(
        Array(5).fill("queued"),
      );
      const outputs = await Promise.all([4, 2, 5, 3, 1].map(step));
      expect(outputs.every((item) => item.ok)).toBe(true);
      const entries = await openProject({ projectPath: project }).journal();
      expect(entries.map((item) => item.batch?.seq)).toEqual(numbers(1));
      expect(entries.map((item) => item.seq)).toEqual(numbers(2, 11));
      expect(entries.map((item) => item.label)).toEqual(numbers(1).map((n) => `Step ${n}`));
      expect(new Set(entries.map((item) => item.request_id)).size).toBe(10);
      expect(await status()).toMatchObject({
        state: "complete",
        count: 10,
        applied: numbers(1),
        waiting: [],
        missing: [],
      });
      for (const entry of entries)
        expect((await openProject({ projectPath: project }).snapshotAt(entry.revision)).revision.id).toBe(
          entry.revision,
        );
    },
    30000,
  );

  it("requires base_revision for step 1 and edits outside a batch", async () => {
    for (const extra of [{}, { batch: undefined }]) {
      const { base_revision: _base, ...request } = input(1, extra);
      expect(await dispatch("edit", request)).toMatchObject({
        status: "rejected",
        error: { code: "E_VALIDATION" },
      });
    }
    expect(await openProject({ projectPath: project }).journal()).toEqual([]);
  });

  it("queues a gap, drains 4-10 in the request supplying 4, then undoes the whole batch byte-identically", async () => {
    const before = await readFile(project, "utf8");
    for (const seq of numbers(1, 3)) expect((await send(seq)).status).toBe("applied");
    for (const seq of numbers(5)) expect((await send(seq)).status).toBe("queued");
    expect(await status()).toMatchObject({ state: "open", applied: [1, 2, 3], waiting: numbers(5), missing: [4] });
    const blocked = await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v1", label: "outside" }] });
    expect(blocked).toMatchObject({
      status: "failed",
      error: { code: "E_BATCH_OPEN", retryable: true, details: { batch_id: "bat_test", missing: [4] } },
    });
    const fourth = await send(4);
    expect(fourth).toMatchObject({ status: "applied", result: { batch: { state: "complete", executed: numbers(4) } } });
    expect((await send(4)).receipt?.replayed).toBe(true);
    const after = await readFile(project, "utf8");
    const undo = await write("undo", { batch_id: "bat_test", label: "Undo all" });
    expect(undo.status, JSON.stringify(undo)).toBe("applied");
    sameBytes(await readFile(project, "utf8"), before);
    expect((await openProject({ projectPath: project }).journal()).at(-1)).toMatchObject({
      kind: "undo",
      label: "Undo all",
      batch_id: "bat_test",
    });
    const redo = await write("redo", {});
    expect(redo.status, JSON.stringify(redo)).toBe("applied");
    sameBytes(await readFile(project, "utf8"), after);
  });

  it("keeps steps 1-2 and voids 4-10 when step 3 fails validation", async () => {
    for (const seq of numbers(4)) expect((await send(seq)).status).toBe("queued");
    await send(1);
    await send(2);
    const beforeFailure = await readFile(project, "utf8");
    const failed = await send(3, { ops: [{ op: "split", clip_id: "clp_v1", at: "1/100s" }] });
    expect(failed).toMatchObject({
      status: "rejected",
      error: { code: "E_VALIDATION" },
      result: { batch: { failed_seq: 3, state: "failed" } },
    });
    expect(await readFile(project, "utf8")).toBe(beforeFailure);
    expect(await status()).toMatchObject({ state: "failed", applied: [1, 2], waiting: [], failed_seq: 3 });
    expect((await send(3, { idempotency_key: "replacement" })).error?.code).toBe("E_BATCH_SEQ_TAKEN");
    expect((await send(10, { idempotency_key: "later" })).error?.code).toBe("E_BATCH_SEQ_TAKEN");
    expect((await openProject({ projectPath: project }).journal()).map((item) => item.batch?.seq)).toEqual([1, 2]);
  });

  it("expires lazily at batch_status or any write lock and rejects later steps", async () => {
    await send(1, { batch: { id: "bat_test", seq: 1, count: 10, timeout_s: 5 } });
    await send(6);
    const before = await readFile(project, "utf8");
    const store = openProject({ projectPath: project, clock: () => new Date(Date.now() + 6000) });
    expect(await store.batchStatus("bat_test")).toMatchObject({
      state: "expired",
      applied: [1],
      waiting: [],
      missing: [2, 3, 4, 5, 7, 8, 9, 10],
    });
    expect((await send(2)).error?.code).toBe("E_BATCH_CLOSED");
    expect(await readFile(project, "utf8")).toBe(before);
    expect((await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v1", label: "released" }] })).status).toBe(
      "applied",
    );
  });

  it("restore round trips three revisions back; historical views and previews leave the main file unchanged", async () => {
    const snapshots = [await readFile(project, "utf8")];
    const revisions = ["rev_fixture_1"];
    for (const seq of numbers(1, 4)) {
      const result = await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v1", label: `Change ${seq}` }] });
      expect(result.status).toBe("applied");
      revisions.push(result.receipt?.after as string);
      snapshots.push(await readFile(project, "utf8"));
    }
    const first = revisions[1] as string;
    const latest = revisions[4] as string;
    const entity = await dispatch("inspect", { project, view: "entity", id: "clp_v1", at_revision: first });
    expect(entity.result).toMatchObject({ entity: { label: "Change 1" } });
    const timeline = await dispatch("inspect", { project, view: "timeline", at_revision: first });
    expect(JSON.stringify(timeline.result)).toContain("Change 1");
    const timelineId = (await load()).timelines[0]?.id;
    for (const verb of ["render_preview", "view_timeline"] as const) {
      expect(
        (await dispatch(verb, { project, timeline_id: timelineId, output: directory, at_revision: first })).status,
      ).toBe("accepted");
      const rendered = vi.mocked(startPreviewJob).mock.calls.at(-1)?.[2];
      expect(rendered?.revision.id).toBe(first);
      expect(
        serializeProject(rendered as NonNullable<typeof rendered>).replace(/"revision": \{[\s\S]*?\n {2}\},/, ""),
      ).toContain('"label": "Change 1"');
    }
    expect(await readFile(project, "utf8")).toBe(snapshots[4]);
    expect((await write("restore", { target: first })).status).toBe("applied");
    sameBytes(await readFile(project, "utf8"), snapshots[1] as string);
    expect((await write("restore", { target: latest })).status).toBe("applied");
    sameBytes(await readFile(project, "utf8"), snapshots[4] as string);
    expect((await write("restore", { target: (await load()).revision.id })).status).toBe("no_op");
    const history = await dispatch("inspect", { project, view: "history" });
    expect((history.result?.entries as Record<string, unknown>[])[0]).toMatchObject({
      kind: "restore",
      label: "Manual step",
      batch: null,
    });
    expect((await write("restore", { target: "rev_absent" })).error?.code).toBe("E_NOT_FOUND");
  });
});

it("validates labels, batch bounds and mutually exclusive undo targets", async () => {
  expect(VERBS).toHaveLength(31);
  const { label: _label, ...missing } = input(1);
  expect((await dispatch("edit", missing)).error?.code).toBe("E_VALIDATION");
  expect((await dispatch("edit", { ...missing, author: { kind: "human", name: "CLI" } })).status).toBe("applied");
  for (const batch of [
    { id: "../escape", seq: 1, count: 1 },
    { id: "bat_bad", seq: 0, count: 1 },
    { id: "bat_bad", seq: 1, count: 201 },
    { id: "bat_bad", seq: 1, count: 1, timeout_s: 4 },
  ])
    expect(validateCommand("edit", input(1, { batch })).valid).toBe(false);
  expect((await send(1, { label: "长".repeat(81) })).error?.code).toBe("E_VALIDATION");
  expect(
    validateCommand("undo", {
      ...missing,
      target: "rev_fixture_1",
      batch_id: "bat_test",
      ops: undefined,
      batch: undefined,
    }).valid,
  ).toBe(false);
  expect(
    (
      await dispatch("restore", {
        project,
        session_id: "ses_test",
        base_revision: "rev_fixture_1",
        idempotency_key: "restore",
        author,
        target: "rev_fixture_1",
      })
    ).error?.code,
  ).toBe("E_SESSION_STATE");
});

it("checks count, target, duplicates, first-step revision and whole-batch undo conflicts", async () => {
  await send(6);
  expect((await send(6, { ops: [{ op: "set_clip", clip_id: "clp_v1", label: "different" }] })).error?.code).toBe(
    "E_IDEMPOTENCY_MISMATCH",
  );
  expect((await send(6, { idempotency_key: "different" })).error?.code).toBe("E_BATCH_SEQ_TAKEN");
  expect((await send(2, { batch: { id: "bat_test", seq: 2, count: 9 } })).error?.code).toBe("E_VALIDATION");
  expect((await send(1, { base_revision: "rev_stale" })).status).toBe("rejected");
  expect(await status()).toMatchObject({ state: "failed", failed_seq: 1, applied: [] });
  expect((await send(2)).error?.code).toBe("E_BATCH_CLOSED");
  for (const seq of [1, 2])
    await send(seq, { idempotency_key: `other-${seq}`, batch: { id: "bat_other", seq, count: 2 } });
  await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v1", label: "Intervening change" }] });
  expect((await write("undo", { batch_id: "bat_other" })).error?.code).toBe("E_UNDO_CONFLICT");
});

it("isolates draft batches from main writes and rejects reuse on another target", async () => {
  const begun = await dispatch("session_begin", {
    project,
    base_revision: "rev_fixture_1",
    idempotency_key: "begin",
    author,
    approval: "manual",
    intent: "Draft batch",
  });
  const session_id = begun.result?.session_id as string;
  expect((await send(6, { session_id })).status).toBe("queued");
  expect((await send(1)).error?.code).toBe("E_VALIDATION");
  const main = await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v2", label: "Main stays editable" }] });
  expect(main.status).toBe("applied");
  const mainBytes = await readFile(project, "utf8");
  for (const seq of [1, 2, 3, 4, 5, 7, 8, 9, 10]) expect((await send(seq, { session_id })).status).toBe("drafted");
  expect(await readFile(project, "utf8")).toBe(mainBytes);
  const view = await dispatch("inspect", { project, session_id, view: "brief" });
  const revision = (view.result?.project as { revision: { id: string } }).revision.id;
  const undone = await dispatch("undo", {
    project,
    session_id,
    base_revision: revision,
    idempotency_key: "undo-draft",
    author,
    batch_id: "bat_test",
  });
  expect(undone.status).toBe("drafted");
  expect(await status()).toMatchObject({ state: "complete", applied: numbers(1) });
});

it("blocks restores across recovered revisions", async () => {
  await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v1", label: "first" }] });
  const state = await load();
  state.revision = { ...state.revision, seq: state.revision.seq + 1, id: "rev_recovered", parent: state.revision.id };
  await writeFile(project, serializeProject(state));
  const bytes = await readFile(project, "utf8");
  expect((await write("restore", { target: "rev_fixture_1" })).error?.code).toBe("E_UNSUPPORTED");
  expect(await readFile(project, "utf8")).toBe(bytes);
});

it("records and replays a rejection when the triggering request had already executed before a later step failed", async () => {
  await send(3, { ops: [{ op: "split", clip_id: "clp_v1", at: "1/100s" }] });
  await send(2);
  const first = await send(1);
  expect(first).toMatchObject({ status: "rejected", result: { batch: { applied: [1, 2], failed_seq: 3 } } });
  const bytes = await readFile(project, "utf8");
  expect(await send(1)).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
  expect(await readFile(project, "utf8")).toBe(bytes);
});

it("expires at an unrelated write lock and accepts the write without a timer", async () => {
  await send(6);
  const current = await load();
  const store = openProject({ projectPath: project, clock: () => new Date(Date.now() + 31000) });
  const result = await store.commitWrite(
    {
      verb: "edit",
      base_revision: current.revision.id,
      idempotency_key: "after-timeout",
      request_id: "req_timeout",
      author,
      label: "After timeout",
      ops: [],
    },
    (candidate) => {
      candidate.name = "After timeout";
    },
  );
  expect(result.status).toBe("applied");
  expect(await status()).toMatchObject({ state: "expired", applied: [], waiting: [] });
  expect((await send(1)).error?.code).toBe("E_BATCH_CLOSED");
});

it("preserves conflict checks for a batch whose edits cancel out and writes an undo revision", async () => {
  const baseline = await load();
  const before = await readFile(project, "utf8");
  const oldLabel = baseline.timelines
    .flatMap((item) => item.tracks)
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .find((clip) => clip.id === "clp_v1")?.label;
  for (const seq of [1, 2])
    expect(
      (
        await send(seq, {
          batch: { id: "bat_test", seq, count: 2 },
          ops: [{ op: "set_clip", clip_id: "clp_v1", label: seq === 1 ? "temporary" : (oldLabel ?? null) }],
        })
      ).status,
    ).toBe("applied");
  sameBytes(await readFile(project, "utf8"), before);
  expect((await write("undo", { batch_id: "bat_test" })).status).toBe("applied");
  sameBytes(await readFile(project, "utf8"), before);
  expect((await load()).revision.seq).toBe(4);
  expect((await write("restore", { target: "rev_fixture_1" })).status).toBe("applied");
  expect((await load()).revision.seq).toBe(5);
});

it("keeps dry runs outside the on-disk queue and logs omitted human labels as null", async () => {
  const bytes = await readFile(project, "utf8");
  expect((await send(1, { dry_run: true })).status).toBe("dry_run");
  expect(await readFile(project, "utf8")).toBe(bytes);
  expect((await dispatch("batch_status", { project, batch_id: "bat_test" })).error?.code).toBe("E_NOT_FOUND");
  const { label: _label, ...human } = input(1, {
    author: { kind: "human", name: "CLI" },
    batch: { id: "bat_test", seq: 1, count: 1 },
  });
  expect((await dispatch("edit", human)).status).toBe("applied");
  expect((await openProject({ projectPath: project }).journal()).at(-1)).toMatchObject({
    label: null,
    batch: { id: "bat_test", seq: 1, count: 1 },
  });
});

it.each(["recovered", "journal-without-receipt"])(
  "does not repeat an already committed queued step after %s",
  async (mode) => {
    await send(2, { batch: { id: "bat_test", seq: 2, count: 3 } });
    const second = input(2, { batch: { id: "bat_test", seq: 2, count: 3 } });
    await send(1, { batch: { id: "bat_test", seq: 1, count: 3 } });
    const statePath = join(directory, ".zcut", "prj_std_25", "batches", "bat_test", "state.json");
    const journalPath = join(directory, ".zcut", "prj_std_25", "journal.jsonl");
    const receiptsPath = join(directory, ".zcut", "prj_std_25", "idempotency.jsonl");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { revisions: Record<string, string> };
    delete state.revisions["2"];
    await writeFile(statePath, JSON.stringify(state));
    const receipts = (await readFile(receiptsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { idempotency_key: string; execution?: boolean });
    await writeFile(
      receiptsPath,
      `${receipts
        .filter((row) => !(row.idempotency_key === second.idempotency_key && row.execution))
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    if (mode === "recovered") {
      const rows = (await readFile(journalPath, "utf8")).trim().split("\n");
      await writeFile(journalPath, `${rows.slice(0, -1).join("\n")}\n`);
    }
    const bytes = await readFile(project, "utf8");
    const output = await send(3, { batch: { id: "bat_test", seq: 3, count: 3 } });
    expect(output.status).toBe(mode === "recovered" ? "rejected" : "committed_unverified");
    expect(await readFile(project, "utf8")).toBe(bytes);
    expect(await status()).toMatchObject({ state: "failed", failed_seq: 2 });
  },
);

it("reconciles an execution receipt after a state-file interruption without repeating the step", async () => {
  await send(2, { batch: { id: "bat_test", seq: 2, count: 3 } });
  await send(1, { batch: { id: "bat_test", seq: 1, count: 3 } });
  const statePath = join(directory, ".zcut", "prj_std_25", "batches", "bat_test", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as { revisions: Record<string, string> };
  delete state.revisions["2"];
  await writeFile(statePath, JSON.stringify(state));
  expect((await send(3, { batch: { id: "bat_test", seq: 3, count: 3 } })).status).toBe("applied");
  expect((await openProject({ projectPath: project }).journal()).map((entry) => entry.batch?.seq)).toEqual([1, 2, 3]);
  expect(await status()).toMatchObject({ state: "complete", applied: [1, 2, 3] });
});

it("keeps history dry runs free of project, journal, queue and idempotency writes", async () => {
  await send(1, { batch: { id: "bat_test", seq: 1, count: 1 } });
  const bytes = await readFile(project, "utf8");
  const root = join(directory, ".zcut", "prj_std_25");
  const journal = await readFile(join(root, "journal.jsonl"), "utf8");
  const receipts = await readFile(join(root, "idempotency.jsonl"), "utf8");
  for (const verb of ["undo", "restore"] as const) {
    const result = await write(verb, {
      dry_run: true,
      ...(verb === "undo" ? { batch_id: "bat_test" } : { target: "rev_fixture_1" }),
    });
    expect(result.status).toBe("dry_run");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(await readFile(project, "utf8")).toBe(bytes);
    expect(await readFile(join(root, "journal.jsonl"), "utf8")).toBe(journal);
    expect(await readFile(join(root, "idempotency.jsonl"), "utf8")).toBe(receipts);
  }
});

it("does not replay an undone draft batch when approval rebases onto later main edits", async () => {
  const before = await readFile(project, "utf8");
  const begun = await dispatch("session_begin", {
    project,
    base_revision: "rev_fixture_1",
    idempotency_key: "begin",
    author,
    approval: "manual",
    intent: "Batch undo replay",
  });
  const session_id = begun.result?.session_id as string;
  const first = await send(1, { session_id, batch: { id: "bat_test", seq: 1, count: 2 } });
  const blocked = await dispatch("session_review", {
    project,
    session_id,
    base_revision: first.receipt?.after,
    idempotency_key: "blocked-review",
    author,
  });
  expect(blocked.error?.code).toBe("E_BATCH_OPEN");
  const second = await send(2, { session_id, batch: { id: "bat_test", seq: 2, count: 2 } });
  const undo = await dispatch("undo", {
    project,
    session_id,
    base_revision: second.receipt?.after,
    idempotency_key: "undo",
    author,
    batch_id: "bat_test",
  });
  expect(undo.status).toBe("drafted");
  const review = await dispatch("session_review", {
    project,
    session_id,
    base_revision: undo.receipt?.after,
    idempotency_key: "review",
    author,
  });
  expect(review.ok).toBe(true);
  await write("edit", { ops: [{ op: "set_clip", clip_id: "clp_v2", label: "Main change" }] });
  const mainBytes = await readFile(project, "utf8");
  const approved = await dispatch("session_approve", {
    project,
    session_id,
    base_revision: (await load()).revision.id,
    idempotency_key: "approve",
    author,
    label: "Approve unchanged draft",
  });
  expect(approved.status).toBe("no_op");
  expect(await readFile(project, "utf8")).toBe(mainBytes);
  expect(mainBytes).not.toBe(before);
});

it("blocks long-running transcribe admission while a batch is open", async () => {
  await send(6);
  const result = await dispatch("transcribe", {
    project,
    base_revision: "rev_fixture_1",
    idempotency_key: "asr",
    author,
    media_id: "med_A",
  });
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "E_BATCH_OPEN", retryable: true, details: { batch_id: "bat_test" } },
  });
});

it("reports the same history errors during dry run and execution", async () => {
  for (const dry_run of [true, false]) {
    expect((await write("restore", { target: "rev_absent", dry_run })).error?.code).toBe("E_NOT_FOUND");
    expect((await write("undo", { batch_id: "bat_absent", dry_run })).error?.code).toBe("E_UNDO_CONFLICT");
  }
});
