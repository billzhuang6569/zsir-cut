import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffProjectEntities,
  openProject,
  type Project,
  parseProject,
  projectEntitySnapshots,
  serializeProject,
  validateEnvelope,
  type WriteRequest,
} from "../src/index.js";

let directory: string;
let path: string;
let original: string;
let counter: number;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing test fixture entity");
  return value;
};
const author = { kind: "agent" as const, name: "test" };
const read = async () => {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error("Invalid test project");
  return parsed.project;
};
const request = (
  base_revision = "rev_fixture_1",
  idempotency_key = "write-1",
  verb: WriteRequest["verb"] = "edit",
  target?: string,
): WriteRequest => ({
  base_revision,
  idempotency_key,
  author,
  label: "Test edit",
  verb,
  request_id: `req_${idempotency_key.replaceAll("-", "_")}`,
  ops: [{ op: "set_clip", clip_id: "clp_v1", label: "edited" }],
  ...(target ? { target } : {}),
});
const store = (extra: Partial<Parameters<typeof openProject>[0]> = {}) =>
  openProject({
    projectPath: path,
    clock: () => new Date("2026-10-26T12:00:00.000Z"),
    idGenerator: () => `rev_test_${++counter}`,
    lockWaitMs: 20,
    ...extra,
  });
const label = (project: Project) => {
  const track = project.timelines[0]?.tracks[0];
  if (track?.kind !== "video") throw new Error("Missing video track");
  const clip = track.clips.find((item) => item.id === "clp_v1");
  if (!clip) throw new Error("Missing clip");
  clip.label = "edited";
};
const journal = async () =>
  (await readFile(join(directory, ".zcut", "prj_std_25", "journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const sameExceptRevision = (actual: string, expected: string) => {
  const left = parseProject(actual);
  const right = parseProject(expected);
  if (!left.ok || !right.ok) throw new Error("Invalid test project");
  expect(serializeProject(left.project)).toBe(actual);
  left.project.revision = right.project.revision;
  expect(serializeProject(left.project)).toBe(expected);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-store-"));
  path = join(directory, "std-25.zcut.json");
  await copyFile("fixtures/projects/std-25.zcut.json", path);
  original = await readFile(path, "utf8");
  counter = 0;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("project write store", () => {
  it("writes canonical bytes, complete journal and schema-valid envelope", async () => {
    const result = await store().commitWrite(request(), label, { clp_v1: "set_clip" });
    expect(result.status).toBe("applied");
    expect(result.changes).toEqual([{ op: "set_clip", entity: "clip", id: "clp_v1", action: "updated" }]);
    expect(validateEnvelope(result).valid).toBe(true);
    expect(await readFile(path, "utf8")).toBe(serializeProject(await read()));
    const [entry] = await journal();
    expect(entry).toMatchObject({
      kind: "write",
      revision: "rev_test_1",
      parent: "rev_fixture_1",
      seq: 2,
      at: "2026-10-26T12:00:00.000Z",
      author,
      verb: "edit",
      request_id: "req_write_1",
      idempotency_key: "write-1",
      ops: request().ops,
    });
    expect(entry?.changes).toMatchObject([
      { key: "clp_v1", before: { id: "clp_v1" }, after: { id: "clp_v1", label: "edited" } },
    ]);
    const records = (await readFile(join(directory, ".zcut", "prj_std_25", "idempotency.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ idempotency_key: "write-1", envelope: result });
    expect(records[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports changed entity keys on stale revision", async () => {
    await store().commitWrite(request(), label);
    const result = await store().commitWrite(request("rev_fixture_1", "write-2"), () => {
      throw new Error("must not run");
    });
    expect(result).toMatchObject({
      status: "conflict",
      error: { code: "E_CONFLICT" },
      result: { current_revision: "rev_test_1", changed_entity_keys: ["clp_v1"] },
    });
  });

  it("replays a matching key without mutation and rejects a changed request", async () => {
    const first = await store().commitWrite(request(), label);
    const replay = await store().commitWrite(request(), () => {
      throw new Error("must not run");
    });
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    const mismatch = await store().commitWrite({ ...request(), ops: [{ op: "other" }] }, label);
    expect(mismatch).toMatchObject({ status: "rejected", error: { code: "E_IDEMPOTENCY_MISMATCH" } });
  });

  it("records no-op requests so later retries stay no-op", async () => {
    const first = await store().commitWrite(request(), () => {});
    expect(first.status).toBe("no_op");
    const replay = await store().commitWrite(request(), label);
    expect(replay).toMatchObject({ status: "no_op", receipt: { replayed: true } });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("rejects an L1 semantic error without changing project bytes", async () => {
    const result = await store().commitWrite(request(), (project) => {
      const track = project.timelines[0]?.tracks[0];
      if (track?.kind === "video") required(track.clips[0]).media_id = "med_missing";
    });
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "E_VALIDATION" },
      verification: { level: "L1", passed: false },
    });
    expect(result.verification.issues.some((issue) => issue.code === "E_REF")).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports E_SCHEMA with the schema path when edited output fails structure validation", async () => {
    const invalid = (project: Project) => {
      const track = project.timelines[0]?.tracks[0];
      if (!track) throw new Error("Missing track");
      track.id = "bad";
    };
    const result = await store().commitWrite(request(), invalid);
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "E_VALIDATION" },
      verification: { level: "L0", passed: false },
    });
    expect(result.verification.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "E_SCHEMA",
          severity: "error",
          message: expect.stringContaining("/timelines/0/tracks/0/id"),
        }),
      ]),
    );
    expect(result.verification.issues.every((issue) => issue.code === "E_SCHEMA")).toBe(true);
    const preview = await store().previewWrite(request(), invalid);
    expect(preview.error?.code).toBe("E_VALIDATION");
    expect(preview.verification).toEqual(result.verification);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports E_SCHEMA when edited output cannot be serialized", async () => {
    const invalid = (project: Project) => {
      const timeline = project.timelines[0];
      if (!timeline) throw new Error("Missing timeline");
      timeline.edit_rate = { numerator: 25n, denominator: 0n };
    };
    const result = await store().commitWrite(request(), invalid);
    expect(result.error?.code).toBe("E_VALIDATION");
    expect(result.verification).toMatchObject({
      level: "L0",
      passed: false,
      issues: [{ code: "E_SCHEMA", severity: "error", message: expect.stringContaining("zero denominator") }],
    });
    const preview = await store().previewWrite(request(), invalid);
    expect(preview.error?.code).toBe("E_VALIDATION");
    expect(preview.verification).toEqual(result.verification);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("distinguishes failures before and after atomic replace, then recovers", async () => {
    const before = await store({
      projectPath: path,
      fault: (point) => {
        if (point === "before_step_7") throw new Error("injected");
      },
    }).commitWrite(request(), label);
    expect(before.status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe(original);
    const after = await store({
      projectPath: path,
      fault: (point) => {
        if (point === "after_step_7") throw new Error("injected");
      },
    }).commitWrite(request(), label);
    expect(after).toMatchObject({ status: "committed_unverified", receipt: { after: "rev_test_2" } });
    await store().commitWrite(request("rev_test_2", "write-2"), (project) => {
      const timeline = required(project.timelines[0]);
      timeline.markers = timeline.markers.filter((marker) => marker.id !== "mrk_ch2");
    });
    expect((await journal()).map((entry) => entry.kind)).toEqual(["recovered", "write"]);
    expect((await journal())[0]).toMatchObject({ revision: "rev_test_2", parent: "rev_fixture_1", seq: 2 });
    const recoveredUndo = await store().undo(request("rev_test_3", "undo-recovered", "undo", "rev_test_2"));
    expect(recoveredUndo).toMatchObject({ status: "rejected", error: { code: "E_UNDO_CONFLICT" } });
  });

  it("times out on a held lock and takes over a dead same-host lock", async () => {
    const lockDirectory = join(directory, ".zcut", "prj_std_25");
    await mkdir(lockDirectory, { recursive: true });
    const lock = join(lockDirectory, "lock");
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, hostname: hostname(), acquired_at: "now", request_id: "req_owner" }),
    );
    const busy = await store().commitWrite(request(), label);
    expect(busy).toMatchObject({
      status: "failed",
      error: { code: "E_IO", retryable: true, details: { reason: "busy" } },
    });
    await writeFile(
      lock,
      JSON.stringify({ pid: 99999999, hostname: hostname(), acquired_at: "then", request_id: "req_dead" }),
    );
    expect((await store().commitWrite(request(), label)).status).toBe("applied");
    const event = JSON.parse((await readFile(join(lockDirectory, "lock-events.jsonl"), "utf8")).trim()) as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      at: "2026-10-26T12:00:00.000Z",
      event: "stale_lock",
      owner: { pid: 99999999, hostname: hostname(), acquired_at: "then", request_id: "req_dead" },
      taker: { pid: process.pid, hostname: hostname(), request_id: "req_write_1" },
    });
  });

  it("undoes and redoes snapshots; reports conflicts and excludes recovered revisions", async () => {
    const first = await store().commitWrite(request(), label);
    const undo = await store().undo(request("rev_test_1", "undo-1", "undo"));
    expect(undo.status).toBe("applied");
    const restored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const initial = JSON.parse(original) as Record<string, unknown>;
    restored.revision = initial.revision;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(initial));
    const redo = await store().redo(request("rev_test_2", "redo-1", "redo"));
    expect(redo.status).toBe("applied");
    expect((await read()).timelines[0]?.tracks[0]).toMatchObject({
      clips: expect.arrayContaining([expect.objectContaining({ id: "clp_v1", label: "edited" })]),
    });
    await store().commitWrite(request("rev_test_3", "write-2"), (project) => {
      const track = project.timelines[0]?.tracks[0];
      if (track?.kind === "video") required(track.clips[0]).label = "later";
    });
    const conflict = await store().undo(request("rev_test_4", "undo-2", "undo", first.receipt?.after ?? ""));
    expect(conflict).toMatchObject({
      status: "rejected",
      error: { code: "E_UNDO_CONFLICT", details: { keys: ["clp_v1"] } },
    });
  });

  it("records a created marker snapshot", async () => {
    const result = await store().commitWrite(request(), (project) => {
      const timeline = required(project.timelines[0]);
      timeline.markers.push({ ...required(timeline.markers[0]), id: "mrk_new", text: "new marker" });
    });
    expect(result.changes).toEqual([{ op: "edit", entity: "marker", id: "mrk_new", action: "created" }]);
    expect((await journal())[0]?.changes).toMatchObject([{ key: "mrk_new", before: null, after: { id: "mrk_new" } }]);
  });

  it("reports recognition runs with the run envelope entity", async () => {
    const result = await store().commitWrite(request(), (project) => {
      const run = required(required(project.transcripts[0]).raw_runs[0]);
      run.engine.version = "revised";
    });
    expect(result.status).toBe("applied");
    expect(result.changes).toEqual([{ op: "edit", entity: "run", id: "run_truth_asr", action: "updated" }]);
    expect(validateEnvelope(result).valid).toBe(true);
  });

  it("restores a deleted marker to its timeline on undo", async () => {
    const result = await store().commitWrite(request(), (project) => {
      const timeline = required(project.timelines[0]);
      timeline.markers = timeline.markers.filter((marker) => marker.id !== "mrk_ch2");
    });
    expect(result.changes).toEqual([{ op: "edit", entity: "marker", id: "mrk_ch2", action: "removed" }]);
    expect((await store().undo(request("rev_test_1", "undo-marker", "undo"))).status).toBe("applied");
    const restored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const initial = JSON.parse(original) as Record<string, unknown>;
    restored.revision = initial.revision;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(initial));
  });

  it("diffs entities by sorted keys, including track positions", async () => {
    const before = await read();
    const snapshots = projectEntitySnapshots(before);
    expect(snapshots.get("project")?.value).not.toHaveProperty("revision");
    expect(snapshots.get("trs_A_zh")?.value).not.toHaveProperty("tokens");
    expect(snapshots.get("run_truth_asr")?.entity).toBe("run");
    expect(snapshots.get("override:trk_sub_zh:occ_2:cue_zh_08")?.entity).toBe("override");
    expect(snapshots.get("cue_title")?.entity).toBe("free_cue");
    expect(snapshots.get("trk_sub_zh")?.value).toHaveProperty("index");
    const after = structuredClone(before);
    const timeline = required(after.timelines[0]);
    timeline.markers = timeline.markers.filter((marker) => marker.id !== "mrk_ch2");
    timeline.tracks.reverse();
    const changes = diffProjectEntities(before, after);
    expect(changes.map((change) => change.key)).toEqual(changes.map((change) => change.key).toSorted());
    expect(changes.find((change) => change.key === "mrk_ch2")?.after).toBeNull();
    expect(changes.find((change) => change.key === "mrk_ch2")).toMatchObject({ before_index: null, after_index: null });
    expect(changes.some((change) => change.entity === "track" && change.before?.index !== change.after?.index)).toBe(
      true,
    );
  });
});

const deletions: {
  name: string;
  key: string;
  index: number;
  prepare?: (project: Project) => void;
  remove: (project: Project) => void;
}[] = [
  {
    name: "media",
    key: "med_extra_a",
    index: 1,
    prepare: (project) => {
      const source = required(project.media[0]);
      project.media.splice(
        1,
        0,
        { ...structuredClone(source), id: "med_extra_a" },
        { ...structuredClone(source), id: "med_extra_b" },
      );
    },
    remove: (project) => {
      project.media = project.media.filter((item) => item.id !== "med_extra_a");
    },
  },
  {
    name: "subtitle cue",
    key: "cue_zh_01",
    index: 1,
    remove: (project) => {
      const transcript = required(project.transcripts[0]);
      transcript.cues = transcript.cues.filter((item) => item.id !== "cue_zh_01");
    },
  },
  {
    name: "transition",
    key: "trn_1",
    index: 0,
    prepare: (project) => {
      const track = project.timelines
        .flatMap((timeline) => timeline.tracks)
        .find((item) => item.kind !== "subtitle" && item.transitions.some((transition) => transition.id === "trn_1"));
      if (!track || track.kind === "subtitle") throw new Error("Missing transition track");
      track.transitions.push({ ...required(track.transitions[0]), id: "trn_copy" });
    },
    remove: (project) => {
      for (const track of project.timelines.flatMap((timeline) => timeline.tracks))
        if (track.kind !== "subtitle") track.transitions = track.transitions.filter((item) => item.id !== "trn_1");
    },
  },
  {
    name: "override",
    key: "override:trk_sub_zh:occ_2:cue_zh_08",
    index: 0,
    prepare: (project) => {
      const track = project.timelines.flatMap((timeline) => timeline.tracks).find((item) => item.id === "trk_sub_zh");
      if (track?.kind !== "subtitle") throw new Error("Missing subtitle track");
      track.overrides.push({ occurrence_id: "occ_2", cue_id: "cue_zh_09", text: "second" });
    },
    remove: (project) => {
      const track = project.timelines.flatMap((timeline) => timeline.tracks).find((item) => item.id === "trk_sub_zh");
      if (track?.kind !== "subtitle") throw new Error("Missing subtitle track");
      track.overrides = track.overrides.filter((item) => item.cue_id !== "cue_zh_08");
    },
  },
];

describe.each(deletions)("indexed $name restoration", ({ key, index, prepare, remove }) => {
  it("undoes and redoes at the original array position", async () => {
    if (prepare) {
      const project = await read();
      prepare(project);
      await writeFile(path, serializeProject(project));
    }
    const baseline = await readFile(path, "utf8");
    const deleted = await store().commitWrite(request(), remove);
    expect(deleted.status).toBe("applied");
    expect(validateEnvelope(deleted).valid).toBe(true);
    const postDelete = await readFile(path, "utf8");
    const changes = (await journal())[0]?.changes as {
      key: string;
      before_index: number | null;
      after_index: number | null;
    }[];
    expect(changes.find((change) => change.key === key)).toMatchObject({ before_index: index, after_index: null });
    const undone = await store().undo(request("rev_test_1", "undo-index", "undo"));
    expect(undone.status).toBe("applied");
    expect(validateEnvelope(undone).valid).toBe(true);
    sameExceptRevision(await readFile(path, "utf8"), baseline);
    const redone = await store().redo(request("rev_test_2", "redo-index", "redo"));
    expect(redone.status).toBe("applied");
    expect(validateEnvelope(redone).valid).toBe(true);
    sameExceptRevision(await readFile(path, "utf8"), postDelete);
  });
});

describe("multiple indexed deletions", () => {
  it("restores non-adjacent cues in one revision and redoes byte-identically", async () => {
    const baseline = await readFile(path, "utf8");
    const deleted = await store().commitWrite(request(), (project) => {
      const transcript = required(project.transcripts[0]);
      transcript.cues = transcript.cues.filter((cue) => cue.id !== "cue_zh_01" && cue.id !== "cue_zh_04");
    });
    expect(deleted.status).toBe("applied");
    expect(validateEnvelope(deleted).valid).toBe(true);
    const postDelete = await readFile(path, "utf8");
    const changes = (await journal())[0]?.changes as {
      key: string;
      before_index: number | null;
      after_index: number | null;
    }[];
    expect(changes.find((change) => change.key === "cue_zh_01")).toMatchObject({ before_index: 1, after_index: null });
    expect(changes.find((change) => change.key === "cue_zh_04")).toMatchObject({ before_index: 4, after_index: null });
    const undone = await store().undo(request("rev_test_1", "undo-two", "undo"));
    expect(undone.status).toBe("applied");
    expect(validateEnvelope(undone).valid).toBe(true);
    sameExceptRevision(await readFile(path, "utf8"), baseline);
    const redone = await store().redo(request("rev_test_2", "redo-two", "redo"));
    expect(redone.status).toBe("applied");
    expect(validateEnvelope(redone).valid).toBe(true);
    sameExceptRevision(await readFile(path, "utf8"), postDelete);
  });
});
