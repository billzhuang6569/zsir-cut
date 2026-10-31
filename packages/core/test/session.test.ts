import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  diffProjectEntities,
  dispatch,
  parseProject,
  serializeProject,
  validateCommand,
  validateEnvelope,
} from "../src/index.js";

vi.mock("../src/jobs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs.ts")>()),
  startPreviewJob: vi.fn(async () => "job_review"),
}));

const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
const author = { kind: "agent", name: "test" };
let directory: string;
let project: string;
let serial: number;
const load = async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid project");
  return parsed.project;
};
const send = async (verb: Parameters<typeof dispatch>[0], data: Record<string, unknown>, base = "rev_fixture_1") => {
  const input = ["diff", "validate"].includes(verb)
    ? { project, ...data }
    : {
        project,
        base_revision: base,
        idempotency_key: `key-${++serial}`,
        author,
        ...(verb === "edit" ? { label: "Test edit" } : {}),
        ...data,
      };
  expect(validateCommand(verb, input).valid).toBe(true);
  const result = await dispatch(verb, input);
  expect(validateEnvelope(result)).toMatchObject({ valid: true });
  return result;
};
const begin = async (approval: "manual" | "auto" = "manual") => {
  const result = await send("session_begin", { approval, intent: "Edit interview" }, (await load()).revision.id);
  expect(result.status).toBe("no_op");
  return result.result?.session_id as string;
};
const label = (clip_id: string, value: string) => ({ op: "set_clip", clip_id, label: value });
const token = { op: "set_token_state", transcript_id: "trs_A_en", tokens: ["tok_en_00"], state: "edited" };
const noRevision = (value: Awaited<ReturnType<typeof load>>) => {
  const copy = structuredClone(value);
  copy.revision = {
    ...copy.revision,
    id: "rev_fixture_1",
    parent: null,
    seq: 1,
    created_at: "2026-10-26T00:00:00Z",
    author: { kind: "system", name: "fixtures" },
  };
  return serializeProject(copy);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-session-"));
  project = join(directory, "project.zcut.json");
  await copyFile(fixture, project);
  serial = 0;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("sessions and diff", () => {
  it("uses the target track domain for renames inside a draft", async () => {
    const bytes = await readFile(project, "utf8");
    const subtitle = (await load()).timelines[0]?.tracks.find((track) => track.kind === "subtitle");
    const session_id = await begin();
    const rename = { op: "rename_track", track_id: subtitle?.id, name: "字幕 A" };
    const mixed = await send("edit", { session_id, ops: [rename, label("clp_v1", "mixed")] });
    expect(mixed.error?.code).toBe("E_MIXED_DOMAIN");
    const edited = await send("edit", { session_id, ops: [rename, token] });
    expect(edited.status).toBe("drafted");
    expect(edited.changes).toContainEqual(
      expect.objectContaining({ entity: "track", id: subtitle?.id, op: "rename_track" }),
    );
    expect(await readFile(project, "utf8")).toBe(bytes);
  });

  it("reads the draft's placements, entities, history and diff without changing main", async () => {
    const bytes = await readFile(project, "utf8");
    const session_id = await begin();
    const placed = await send("edit", {
      session_id,
      ops: [
        {
          op: "place",
          media_id: "med_A",
          at: "end",
          mode: "insert",
          video_track: "trk_v1",
          audio_track: "trk_a1",
          tokens: { transcript_id: "trs_A_zh", from_token: "tok_010", to_token: "tok_017", pause: "2/5s" },
        },
      ],
    });
    expect(placed.status).toBe("drafted");
    const clipId = placed.changes.find((change) => change.entity === "clip")?.id;
    expect(clipId).toBeDefined();
    const read = (verb: Parameters<typeof dispatch>[0], input: Record<string, unknown>) =>
      dispatch(verb, { project, session_id, ...input });
    const entity = await read("inspect", { view: "entity", id: clipId });
    expect(entity.result).toMatchObject({ entity: { id: clipId, media_id: "med_A" } });
    const timeline = await read("inspect", { view: "timeline" });
    expect(JSON.stringify(timeline.result)).toContain(clipId);
    const history = await read("inspect", { view: "history" });
    expect(history.result?.entries).toEqual([expect.objectContaining({ revision: placed.receipt?.after })]);
    const brief = await read("inspect", { view: "brief" });
    expect(brief.result?.project).toMatchObject({ revision: { id: placed.receipt?.after } });
    expect(brief.result?.sessions).toEqual([expect.objectContaining({ id: session_id })]);
    const transcript = await read("read_transcript", { timeline_id: "tl_std" });
    expect(transcript.ok).toBe(true);
    expect(transcript.result?.text).toContain(`@${clipId} `);
    const source = await read("read_transcript", { transcript_id: "trs_A_zh" });
    expect(source.ok).toBe(true);
    const diff = await read("diff", { from: "rev_fixture_1" });
    expect(diff.result).toMatchObject({
      to: placed.receipt?.after,
      changes: expect.arrayContaining([expect.objectContaining({ key: clipId, before: null })]),
    });
    expect((await read("validate", {})).verification.passed).toBe(true);
    await send("session_reject", { session_id });
    expect((await read("inspect", { view: "entity", id: clipId })).ok).toBe(true);
    expect(await readFile(project, "utf8")).toBe(bytes);
    expect((await dispatch("inspect", { project, view: "entity", id: clipId })).error?.code).toBe("E_NOT_FOUND");
  });

  it.each(["inspect", "read_transcript", "validate", "diff", "render_preview", "view_timeline"] as const)(
    "returns E_NOT_FOUND for %s in a missing session",
    async (verb) => {
      const result = await dispatch(verb, {
        project,
        session_id: "ses_missing",
        ...(verb === "inspect" ? { view: "brief" } : {}),
        ...(verb === "read_transcript" ? { timeline_id: "tl_std" } : {}),
        ...(verb === "diff" ? { from: "rev_fixture_1" } : {}),
      });
      expect(result).toMatchObject({ status: "rejected", error: { code: "E_NOT_FOUND" } });
      expect(validateEnvelope(result).valid).toBe(true);
    },
  );

  it("retries begin and approve without creating duplicate sessions or revisions", async () => {
    const input = {
      project,
      base_revision: "rev_fixture_1",
      idempotency_key: "same-begin",
      author,
      approval: "manual",
      intent: "Retry",
    };
    const begun = await dispatch("session_begin", input);
    const repeated = await dispatch("session_begin", input);
    expect(repeated.result?.session_id).toBe(begun.result?.session_id);
    const session_id = begun.result?.session_id;
    const draft = await send("edit", { session_id, ops: [label("clp_v1", "once")] });
    await send("session_review", { session_id }, draft.receipt?.after ?? "");
    const approval = { project, base_revision: "rev_fixture_1", idempotency_key: "same-approve", author, session_id };
    const first = await dispatch("session_approve", approval);
    const bytes = await readFile(project, "utf8");
    const retry = await dispatch("session_approve", approval);
    expect(first.status).toBe("applied");
    expect(retry.receipt?.replayed).toBe(true);
    expect(await readFile(project, "utf8")).toBe(bytes);
    const sessionPath = join(directory, ".zcut", (await load()).id, "sessions", session_id as string, "session.json");
    const interrupted = JSON.parse(await readFile(sessionPath, "utf8"));
    interrupted.state = "in_review";
    delete interrupted.decision_key;
    delete interrupted.decision_envelope;
    await writeFile(sessionPath, JSON.stringify(interrupted));
    const recovered = await dispatch("session_approve", approval);
    expect(recovered.receipt?.replayed).toBe(true);
    expect(await readFile(project, "utf8")).toBe(bytes);
  });
  it("separates active timeline and subtitle changes in review", async () => {
    const session_id = await begin();
    const timeline = await send("edit", { session_id, ops: [label("clp_v1", "timeline")] });
    const subtitle = await send("edit", { session_id, ops: [token] }, timeline.receipt?.after ?? "");
    const review = await send("session_review", { session_id }, subtitle.receipt?.after ?? "");
    expect((review.result?.timeline_changes as { entity: string }[]).some((change) => change.entity === "clip")).toBe(
      true,
    );
    expect((review.result?.subtitle_changes as { entity: string }[]).some((change) => change.entity === "token")).toBe(
      true,
    );
    for (const verb of ["undo", "redo", "session_review"] as const)
      expect((await send(verb, { session_id }, subtitle.receipt?.after ?? "")).error?.code).toBe("E_SESSION_STATE");
    const continued = await send(
      "edit",
      { session_id, ops: [label("clp_v2", "continue")] },
      subtitle.receipt?.after ?? "",
    );
    expect(continued.status).toBe("drafted");
    expect((await send("session_review", { session_id }, continued.receipt?.after ?? "")).status).toBe("no_op");
  });
  it("reviews both domains, ignores an undone edit, approves as one undoable revision", async () => {
    const before = await load();
    const session_id = await begin();
    const one = await send("edit", { session_id, ops: [label("clp_v1", "draft label")] });
    expect(one.status).toBe("drafted");
    const two = await send("edit", { session_id, ops: [token] }, one.receipt?.after ?? "");
    expect(two.status).toBe("drafted");
    const undo = await send("undo", { session_id }, two.receipt?.after ?? "");
    expect(undo.status).toBe("drafted");
    const review = await send("session_review", { session_id }, undo.receipt?.after ?? "");
    expect(review.result?.timeline_changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "clp_v1" })]),
    );
    expect(review.result?.subtitle_changes).toEqual([]);
    expect(review.result?.ops).toEqual([label("clp_v1", "draft label"), token]);
    expect(review.result?.preview_job).toMatch(/^job_/);
    expect(review.verification.level).toBe("L1");
    expect(noRevision(await load())).toBe(noRevision(before));
    const approved = await send("session_approve", { session_id });
    expect(approved.status).toBe("applied");
    const directPath = join(directory, "direct.zcut.json");
    await copyFile(fixture, directPath);
    const direct = await dispatch("edit", {
      project: directPath,
      base_revision: "rev_fixture_1",
      idempotency_key: "direct",
      author,
      label: "Test edit",
      ops: [label("clp_v1", "draft label")],
    });
    expect(direct.status).toBe("applied");
    const directParsed = parseProject(await readFile(directPath, "utf8"));
    if (!directParsed.ok) throw new Error("Invalid direct project");
    expect(noRevision(await load())).toBe(noRevision(directParsed.project));
    const undone = await send("undo", {}, approved.receipt?.after ?? "");
    expect(undone.status).toBe("applied");
    expect(noRevision(await load())).toBe(noRevision(before));
  });

  it("rebases independent changes and keeps conflicts in review without changing main", async () => {
    const session_id = await begin();
    const draft = await send("edit", { session_id, ops: [label("clp_v1", "draft")] });
    await send("session_review", { session_id }, draft.receipt?.after ?? "");
    const other = await send("edit", { ops: [label("clp_v2", "other")] });
    const approved = await send("session_approve", { session_id }, other.receipt?.after ?? "");
    expect(approved.status).toBe("applied");
    expect((await load()).timelines[0]?.tracks[0]?.kind).toBe("video");
    const session2 = await begin();
    const original = await load();
    const base = original.revision.id;
    const deleted = await send("edit", { session_id: session2, ops: [{ op: "remove", clip_ids: ["clp_v1"] }] }, base);
    await send("session_review", { session_id: session2 }, deleted.receipt?.after ?? "");
    const mainRemove = await send("edit", { ops: [{ op: "remove", clip_ids: ["clp_v1"] }] }, base);
    const bytes = await readFile(project, "utf8");
    const conflict = await send("session_approve", { session_id: session2 }, mainRemove.receipt?.after ?? "");
    expect(conflict.status).toBe("conflict");
    expect(conflict.result?.failed_operations).toHaveLength(1);
    expect(await readFile(project, "utf8")).toBe(bytes);
    const state = JSON.parse(
      await readFile(join(directory, ".zcut", original.id, "sessions", session2, "session.json"), "utf8"),
    );
    expect(state.state).toBe("in_review");
  });

  it("auto approves, rejects, and enforces every state transition", async () => {
    const auto = await begin("auto");
    expect((await send("session_approve", { session_id: auto })).error?.code).toBe("E_SESSION_STATE");
    const edited = await send("edit", { session_id: auto, ops: [label("clp_v1", "auto")] });
    const reviewed = await send("session_review", { session_id: auto }, edited.receipt?.after ?? "");
    expect((reviewed.result?.approval as { status: string }).status).toBe("applied");
    expect(
      (await send("edit", { session_id: auto, ops: [label("clp_v2", "bad")] }, edited.receipt?.after ?? "")).error
        ?.code,
    ).toBe("E_SESSION_STATE");
    expect((await send("session_reject", { session_id: auto }, (await load()).revision.id)).error?.code).toBe(
      "E_SESSION_STATE",
    );
    const manual = await begin();
    const unchanged = await readFile(project, "utf8");
    const rejected = await send("session_reject", { session_id: manual }, (await load()).revision.id);
    expect(rejected.result?.state).toBe("rejected");
    expect(await readFile(project, "utf8")).toBe(unchanged);
    for (const verb of ["edit", "undo", "redo", "session_review", "session_approve", "session_reject"] as const)
      expect(
        (
          await send(
            verb,
            { session_id: manual, ...(verb === "edit" ? { ops: [label("clp_v2", "bad")] } : {}) },
            (
              await load()
            ).revision.id,
          )
        ).error?.code,
      ).toBe("E_SESSION_STATE");
    expect((await send("session_review", { session_id: auto }, edited.receipt?.after ?? "")).error?.code).toBe(
      "E_SESSION_STATE",
    );
    expect((await send("diff", { from: (await load()).revision.id, session_id: manual })).ok).toBe(true);
    expect((await send("validate", { session_id: manual })).ok).toBe(true);
    for (const verb of [
      "create_project",
      "import_media",
      "transcribe",
      "export",
      "record_handoff_check",
      "job_status",
    ] as const) {
      const result = await dispatch(verb, { project, session_id: manual });
      expect(validateEnvelope(result).valid).toBe(true);
      expect(result.error?.code).toBe("E_SESSION_STATE");
    }
  });

  it("allows force only in manual sessions and keeps undo/redo envelopes valid", async () => {
    const op = { op: "set_token_state", transcript_id: "trs_A_zh", tokens: ["tok_000"], state: "edited", force: true };
    expect((await send("edit", { ops: [op] })).error?.code).toBe("E_SESSION_STATE");
    const auto = await begin("auto");
    expect((await send("edit", { session_id: auto, ops: [op] })).error?.code).toBe("E_SESSION_STATE");
    const manual = await begin();
    const changed = await send("edit", { session_id: manual, ops: [op] });
    expect(changed.status).toBe("drafted");
    const undone = await send("undo", { session_id: manual }, changed.receipt?.after ?? "");
    expect(undone.status).toBe("drafted");
    const redone = await send("redo", { session_id: manual }, undone.receipt?.after ?? "");
    expect(redone.status).toBe("drafted");
  });

  it("diffs historical snapshots and rejects crossing recovered revisions", async () => {
    const first = await load();
    const one = await send("edit", { ops: [label("clp_v1", "first")] });
    const middle = await load();
    const two = await send("edit", { ops: [label("clp_v2", "second")] }, one.receipt?.after ?? "");
    const last = await load();
    const diff = await send("diff", { from: first.revision.id, to: last.revision.id });
    expect(diff.result?.changes).toEqual(diffProjectEntities(first, last));
    const reverse = await send("diff", { from: last.revision.id, to: middle.revision.id });
    expect(reverse.result?.changes).toEqual(diffProjectEntities(last, middle));
    expect((await send("diff", { from: "rev_unknown" })).error?.code).toBe("E_NOT_FOUND");
    const advanced = await load();
    advanced.revision = {
      ...advanced.revision,
      seq: advanced.revision.seq + 1,
      parent: two.receipt?.after ?? "",
      id: "rev_recovered_test",
    };
    await writeFile(project, serializeProject(advanced));
    const next = await send("edit", { ops: [label("clp_v3", "later")] }, "rev_recovered_test");
    expect(next.status).toBe("applied");
    expect((await send("diff", { from: first.revision.id })).error?.code).toBe("E_UNSUPPORTED");
  });
});

describe("decisions", () => {
  const question = (n: number, allow_other = true) => ({
    id: `dec_${n}`,
    question: `Question ${n}`,
    options: [{ id: `option_${n}`, label: "Keep", recommended: true }],
    allow_other,
  });
  const view = (session_id: string) => dispatch("inspect", { project, session_id, view: "session" });

  it("persists three decisions, answers/skips/re-answers, reviews and approves with pending", async () => {
    const session_id = await begin();
    const bytes = await readFile(project, "utf8");
    const asked = await send("session_ask", { session_id, decisions: [question(1), question(2), question(3, false)] });
    expect(asked.result?.decision_ids).toEqual(["dec_1", "dec_2", "dec_3"]);
    await send("session_answer", { session_id, decision_id: "dec_1", option_id: "option_1" });
    await send("session_answer", { session_id, decision_id: "dec_2", skip: true });
    expect((await send("session_answer", { session_id, decision_id: "dec_3", text: "Other" })).error?.code).toBe(
      "E_VALIDATION",
    );
    await send("session_answer", { session_id, decision_id: "dec_1", text: "New answer" });
    const read = await view(session_id);
    expect(read.result).toMatchObject({ pending_count: 1, draft_revision: "rev_fixture_1" });
    const review = await send("session_review", { session_id });
    expect(review.result?.decisions).toEqual(read.result?.decisions);
    expect(review.result?.pending_count).toBe(1);
    const brief = await dispatch("inspect", { project, view: "brief" });
    expect(brief.result?.sessions).toEqual([expect.objectContaining({ id: session_id, pending_count: 1 })]);
    const path = join(directory, ".zcut", (await load()).id, "sessions", session_id);
    const stored = JSON.parse(await readFile(join(path, "session.json"), "utf8"));
    expect(stored.log.at(-1).before[0].answer).toMatchObject({ option_id: "option_1", author });
    expect(stored.log.at(-1).after[0].answer.text).toBe("New answer");
    const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
    const reopened = spawnSync(process.execPath, [cli, "inspect", project], {
      input: JSON.stringify({ view: "session", session_id }),
      encoding: "utf8",
    });
    expect(reopened.status).toBe(0);
    expect(JSON.parse(reopened.stdout).result.decisions).toEqual(read.result?.decisions);
    const approval = { session_id, idempotency_key: "approve-decisions" };
    const approved = await send("session_approve", approval);
    expect(await send("session_approve", approval)).toEqual({
      ...approved,
      receipt: { ...approved.receipt, replayed: true },
    });
    expect(approved.status).toBe("no_op");
    expect(approved).not.toHaveProperty("warnings");
    expect(approved.result?.warnings).toEqual([expect.objectContaining({ code: "W_DECISIONS_PENDING", count: 1 })]);
    expect(await readFile(project, "utf8")).toBe(bytes);
    expect((await view(session_id)).result?.state).toBe("approved");
    for (const [verb, data] of [
      ["session_ask", { decisions: [question(4)] }],
      ["session_answer", { decision_id: "dec_1", skip: true }],
    ] as const)
      expect((await send(verb, { session_id, ...data })).error?.code).toBe("E_SESSION_STATE");
  });

  it("enforces option bounds, recommendation order, unique IDs and exclusive answers", async () => {
    const session_id = await begin();
    const base = { project, session_id, base_revision: "rev_fixture_1", author, idempotency_key: "invalid" };
    for (const options of [
      [],
      Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, label: "Option" })),
      [
        { id: "a", label: "A" },
        { id: "b", label: "B", recommended: true },
      ],
      [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: true },
      ],
      [
        { id: "a", label: "A" },
        { id: "a", label: "A" },
      ],
    ]) {
      expect((await dispatch("session_ask", { ...base, decisions: [{ ...question(1), options }] })).error?.code).toBe(
        "E_VALIDATION",
      );
    }
    await send("session_ask", { session_id, decisions: [question(1)] });
    for (const decision of [question(1), { ...question(1), id: "dec_2" }])
      expect((await send("session_ask", { session_id, decisions: [decision] })).error?.code).toBe("E_VALIDATION");
    for (const fields of [{}, { text: "Other", skip: true }, { option_id: "option_1", text: "Other" }, { skip: false }])
      expect((await dispatch("session_answer", { ...base, decision_id: "dec_1", ...fields })).error?.code).toBe(
        "E_VALIDATION",
      );
    expect((await send("session_answer", { session_id, decision_id: "dec_missing", skip: true })).error?.code).toBe(
      "E_NOT_FOUND",
    );
    expect((await send("session_answer", { session_id, decision_id: "dec_1", option_id: "missing" })).error?.code).toBe(
      "E_NOT_FOUND",
    );
    expect((await dispatch("inspect", { project, view: "session" })).error?.code).toBe("E_VALIDATION");
    expect((await view(session_id)).result?.pending_count).toBe(1);
  });

  it("limits sessions to 50 entries, keeps batches atomic and supports generated IDs/defaults", async () => {
    const session_id = await begin();
    const { id: _, allow_other: __, ...generated } = question(0);
    const asked = await send("session_ask", { session_id, decisions: [generated] });
    expect((asked.result?.decision_ids as string[])[0]).toMatch(/^dec_/);
    await send("session_ask", { session_id, decisions: Array.from({ length: 49 }, (_, i) => question(i + 1)) });
    expect((await send("session_ask", { session_id, decisions: [question(50)] })).error?.code).toBe("E_VALIDATION");
    const decisions = (await view(session_id)).result?.decisions as { seq: number; allow_other: boolean }[];
    expect(decisions.map((decision) => decision.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(decisions[0]?.allow_other).toBe(true);
  });

  it("checks revisions, dry run, retries, review transitions and missing refs", async () => {
    const session_id = await begin();
    const request = {
      project,
      session_id,
      base_revision: "rev_fixture_1",
      author,
      idempotency_key: "ask",
      decisions: [
        {
          ...question(1),
          refs: [
            { kind: "entity", id: "clp_v1" },
            { kind: "time", at: "1s" },
          ],
        },
      ],
    };
    expect((await dispatch("session_ask", { ...request, dry_run: true })).status).toBe("dry_run");
    expect((await view(session_id)).result?.pending_count).toBe(0);
    const asked = await dispatch("session_ask", request);
    expect(await dispatch("session_ask", request)).toEqual(asked);
    expect((await dispatch("session_ask", { ...request, decisions: [question(2)] })).error?.code).toBe(
      "E_IDEMPOTENCY_MISMATCH",
    );
    const edit = await send("edit", { session_id, ops: [{ op: "remove", clip_ids: ["clp_v1"] }] });
    const revision = edit.receipt?.after ?? "";
    expect((await send("session_answer", { session_id, decision_id: "dec_1", skip: true })).status).toBe("conflict");
    const read = await view(session_id);
    expect((read.result?.decisions as { refs: unknown[] }[])[0]?.refs).toEqual([
      { kind: "entity", id: "clp_v1", missing: true },
      { kind: "time", at: { t: "1s", tc: "01:00:01:00" } },
    ]);
    await send("session_review", { session_id }, revision);
    await send("session_answer", { session_id, decision_id: "dec_1", skip: true }, revision);
    expect((await view(session_id)).result?.state).toBe("in_review");
    await send("session_answer", { session_id, decision_id: "dec_1", option_id: "option_1" }, revision);
    await send("session_ask", { session_id, decisions: [question(2)] }, revision);
    expect((await view(session_id)).result?.state).toBe("open");
    await send("session_review", { session_id }, revision);
    const approved = await send("session_approve", { session_id });
    expect(approved.status).toBe("applied");
    expect(approved).not.toHaveProperty("warnings");
    expect(approved.result?.warnings).toEqual([expect.objectContaining({ code: "W_DECISIONS_PENDING", count: 1 })]);
  });
});

it("reviews recognition as subtitles and carries replace lock warnings into manual drafts", async () => {
  const session_id = await begin();
  const settings = await send("edit", { session_id, ops: [{ op: "set_recognition", terms: [" 飞书 "] }] });
  expect(settings.status).toBe("drafted");
  const reviewed = await send("session_review", { session_id }, settings.receipt?.after ?? "");
  expect(reviewed.result?.timeline_changes).toEqual([]);
  expect(reviewed.result?.subtitle_changes).toEqual([expect.objectContaining({ entity: "project" })]);
  const op = { op: "replace_text", find: "今天", replace: "现在", cue_ids: ["cue_zh_01"] };
  const skipped = await send("edit", { session_id, ops: [op] }, settings.receipt?.after ?? "");
  expect(skipped.status).toBe("no_op");
  expect(skipped.result?.warnings).toEqual([{ code: "W_REPLACE_SKIPPED_LOCKED", cue_ids: ["cue_zh_01"] }]);
  const forced = await send("edit", { session_id, ops: [{ ...op, force: true }] }, settings.receipt?.after ?? "");
  expect(forced.status, JSON.stringify(forced)).toBe("drafted");
  expect(forced.result?.warnings).toBeUndefined();
  expect((await load()).recognition).toBeUndefined();
});

it.each([false, true])("preserves the subtitle pass author through session approval (rebase: %s)", async (rebase) => {
  const session_id = await begin();
  const passAuthor = { kind: "agent", name: "字幕整理" };
  const draft = await send("edit", {
    session_id,
    author: passAuthor,
    ops: [{ op: "resegment", transcript_id: "trs_A_zh", cut_after: ["tok_020"] }],
  });
  expect(draft.status).toBe("drafted");
  await send("session_review", { session_id }, draft.receipt?.after ?? "");
  if (rebase) expect((await send("edit", { ops: [label("clp_v1", "independent")] })).status).toBe("applied");
  const approved = await send("session_approve", { session_id }, (await load()).revision.id);
  expect(approved.status).toBe("applied");
  expect((await load()).transcripts.find((item) => item.id === "trs_A_zh")?.ext?.["zsir.subtitle_pass"]).toEqual({
    by: passAuthor.name,
  });
});
