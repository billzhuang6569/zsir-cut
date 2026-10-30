// biome-ignore-all lint/style/noNonNullAssertion: Fixture setup establishes transcripts and tokens.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectProjectTerms,
  compareTermText,
  dispatch,
  editTermLibrary,
  type LibraryTerm,
  mergeHotwords,
  parseProject,
  readTermLibrary,
  serializeProject,
  termLibraryPath,
  validateEnvelope,
} from "../src/index.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcut-terms-"));
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const fixture = async () => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("Invalid fixture");
  return parsed.project;
};

it("validates all operations before writing, normalizes text and preserves first-entry metadata", async () => {
  expect(await readTermLibrary()).toEqual([]);
  const result = await dispatch("terms_edit", {
    ops: [
      { op: "add", text: " 飞书 " },
      { op: "block", text: "屏蔽" },
    ],
  });
  expect(result.status).toBe("applied");
  expect(result.changes).toHaveLength(2);
  expect(result.receipt).toBeNull();
  expect(validateEnvelope(result)).toEqual({ valid: true, errors: [] });
  const first = (await readTermLibrary()).find((term) => term.text === "飞书")!;
  await editTermLibrary([
    { op: "block", text: "飞书" },
    { op: "add", text: "飞书" },
  ]);
  expect((await readTermLibrary()).find((term) => term.text === "飞书")).toEqual(first);
  const bytes = await readFile(termLibraryPath(), "utf8");
  for (const op of [
    { op: "add", text: " " },
    { op: "unknown", text: "词" },
    { op: "add", text: "字".repeat(65) },
  ]) {
    const failed = await dispatch("terms_edit", { ops: [{ op: "remove", text: "飞书" }, op] });
    expect(failed).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
    expect(validateEnvelope(failed)).toEqual({ valid: true, errors: [] });
    expect(await readFile(termLibraryPath(), "utf8")).toBe(bytes);
  }
  for (const input of [{ project: "x" }, { base_revision: "rev_x" }, { state: "unknown" }])
    expect((await dispatch("terms_list", input)).ok).toBe(false);
  const listed = await dispatch("terms_list", { state: "blocked", query: "屏" });
  expect(validateEnvelope(listed)).toEqual({ valid: true, errors: [] });
  expect(listed.receipt).toBeNull();
  expect(listed.result).toMatchObject({
    terms: [{ text: "屏蔽" }],
  });
  const unchanged = await dispatch("terms_edit", { ops: [{ op: "unblock", text: "missing" }] });
  expect(unchanged.status).toBe("no_op");
  expect(validateEnvelope(unchanged)).toEqual({ valid: true, errors: [] });
  await editTermLibrary([
    { op: "unblock", text: "屏蔽" },
    { op: "remove", text: "飞书" },
  ]);
  expect(await readTermLibrary()).toMatchObject([{ text: "屏蔽", state: "active" }]);
});

it("counts non-overlapping visible text per transcript, only newly added terms, and retains blocked entries", async () => {
  const before = await fixture();
  before.recognition = { terms: ["旧词"] };
  const after = structuredClone(before);
  for (const transcript of after.transcripts) for (const token of transcript.tokens) token.text = "";
  const tokens = after.transcripts[0]!.tokens;
  tokens[0]!.text = "豆";
  tokens[1]!.text = "包豆包一次旧词旧词屏蔽屏蔽aaa";
  after.recognition = { terms: ["旧词", "豆包", "一次", "屏蔽", "aa"] };
  await editTermLibrary([{ op: "block", text: "屏蔽" }]);
  await collectProjectTerms(before, after);
  expect((await readTermLibrary()).map((term) => term.text)).toEqual(["屏蔽", "豆包"]);
  after.id = "prj_second";
  await collectProjectTerms(before, after);
  await collectProjectTerms(before, after);
  expect((await readTermLibrary()).find((term) => term.text === "豆包")?.projects).toEqual([before.id, "prj_second"]);
  expect((await readTermLibrary()).find((term) => term.text === "屏蔽")).toMatchObject({
    state: "blocked",
    projects: [],
  });
  for (let i = 0; i < 51; i++) {
    after.id = `prj_more_${i}`;
    await collectProjectTerms(before, after);
  }
  expect((await readTermLibrary()).find((term) => term.text === "豆包")?.projects).toHaveLength(50);
});

it("collects only after a successful project commit and warns on failure without losing the revision", async () => {
  const project = await fixture();
  project.transcripts[0]!.tokens[0]!.text = "豆包豆包另词另词";
  const path = join(home, "project.zcut.json");
  await writeFile(path, serializeProject(project));
  const input = {
    project: path,
    author: { kind: "agent", name: "test" },
    base_revision: project.revision.id,
    idempotency_key: "collect",
    label: "Collect terms",
    ops: [{ op: "set_recognition", terms: ["豆包"] }],
  };
  expect((await dispatch("edit", { ...input, dry_run: true })).status).toBe("dry_run");
  expect(await readTermLibrary()).toEqual([]);
  const applied = await dispatch("edit", input);
  expect(applied.status).toBe("applied");
  expect(await readTermLibrary()).toMatchObject([{ text: "豆包", source: "auto", projects: [project.id] }]);
  await editTermLibrary([{ op: "remove", text: "豆包" }]);
  expect((await dispatch("edit", input)).receipt?.replayed).toBe(true);
  expect(await readTermLibrary()).toEqual([]);
  await writeFile(`${termLibraryPath()}.lock`, "busy");
  const failedLibrary = await dispatch("edit", {
    ...input,
    base_revision: applied.receipt?.after,
    idempotency_key: "warning",
    ops: [{ op: "set_recognition", terms: ["豆包", "另词"] }],
  });
  expect(failedLibrary).toMatchObject({ status: "applied", result: { warnings: [{ code: "W_TERMS_LIBRARY" }] } });
  const saved = parseProject(await readFile(path, "utf8"));
  expect(saved.ok && saved.project.revision.id).toBe(failedLibrary.receipt?.after);
  const replay = await dispatch("edit", {
    ...input,
    base_revision: applied.receipt?.after,
    idempotency_key: "warning",
    ops: [{ op: "set_recognition", terms: ["豆包", "另词"] }],
  });
  expect(replay.result).toEqual(failedLibrary.result);
}, 10000);

it("returns retryable E_IO after two seconds and never overwrites a corrupt library", async () => {
  await mkdir(dirname(termLibraryPath()), { recursive: true });
  await writeFile(`${termLibraryPath()}.lock`, "busy");
  const start = Date.now();
  expect(await dispatch("terms_edit", { ops: [{ op: "add", text: "飞书" }] })).toMatchObject({
    status: "failed",
    error: { code: "E_IO", retryable: true },
  });
  expect(Date.now() - start).toBeGreaterThanOrEqual(1950);
  await rm(`${termLibraryPath()}.lock`);
  await writeFile(termLibraryPath(), '{"schema":"wrong"}');
  expect((await dispatch("terms_edit", { ops: [{ op: "add", text: "飞书" }] })).status).toBe("failed");
  expect(await readFile(termLibraryPath(), "utf8")).toBe('{"schema":"wrong"}');
  expect((await dispatch("terms_list", {})).status).toBe("failed");
}, 10000);

it("serializes by Unicode code point with stable keys and supports independent concurrent processes", async () => {
  const execute = promisify(execFile);
  const module = new URL("../src/term-library.ts", import.meta.url).href;
  await Promise.all(
    ["a", "b"].map((prefix) =>
      execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {editTermLibrary} from ${JSON.stringify(module)};
     for (let i=0;i<12;i++) await editTermLibrary([{op:'add',text:${JSON.stringify(prefix)}+i}]);`,
        ],
        { env: { ...process.env, HOME: home } },
      ),
    ),
  );
  expect(await readTermLibrary()).toHaveLength(24);
  await editTermLibrary([
    { op: "add", text: "𐀀" },
    { op: "add", text: "\uE000" },
  ]);
  expect(compareTermText("𐀀", "\uE000")).toBeGreaterThan(0);
  const before = await readFile(termLibraryPath(), "utf8");
  expect((await dispatch("terms_edit", { ops: [{ op: "add", text: "a0" }] })).status).toBe("no_op");
  expect(await readFile(termLibraryPath(), "utf8")).toBe(before);
  const terms = await readTermLibrary();
  const reordered = terms.toReversed().map((term) => ({
    added_at: term.added_at,
    projects: term.projects,
    source: term.source,
    state: term.state,
    text: term.text,
  }));
  await writeFile(termLibraryPath(), JSON.stringify({ schema: "zsir-cut/terms", version: 1, terms: reordered }));
  await editTermLibrary([
    { op: "add", text: "temporary" },
    { op: "remove", text: "temporary" },
  ]);
  // Force a real write, then restore identical content to check canonical serialization.
  await editTermLibrary([{ op: "block", text: "a0" }]);
  await editTermLibrary([{ op: "unblock", text: "a0" }]);
  expect(await readFile(termLibraryPath(), "utf8")).toBe(before);
});

it("merges by source priority, deduplicates before capping, and ranks library terms by project count then code point", () => {
  const term = (text: string, count = 0, state: LibraryTerm["state"] = "active"): LibraryTerm => ({
    text,
    projects: Array.from({ length: count }, (_, i) => `prj_${i}`),
    state,
    source: "auto",
    added_at: "2026-10-30T00:00:00.000Z",
  });
  const project = Array.from({ length: 297 }, (_, i) => `project${i}`);
  const library = [term("B", 2), term("A", 2), term("C", 3), term("blocked", 50, "blocked"), term("file", 40)];
  expect(mergeHotwords(project, [" project0 ", "file", ""], library)).toEqual([...project, "file", "C", "A"]);
  expect(mergeHotwords([], [], library)).toEqual(["file", "C", "A", "B"]);
  expect(mergeHotwords([...project, "x", "y", "z", "overflow"], [], library)).toHaveLength(300);
});

it.each([
  { locked: false, rebase: false },
  { locked: true, rebase: false },
  { locked: false, rebase: true },
])(
  "collects only after session approval ($locked locked, $rebase rebase)",
  async ({ locked, rebase }) => {
    const project = await fixture();
    project.recognition = { terms: ["旧词"] };
    for (const transcript of project.transcripts) for (const token of transcript.tokens) token.text = "";
    project.transcripts[0]!.tokens[0]!.text = "豆包豆包一次屏蔽屏蔽旧词旧词";
    await editTermLibrary([{ op: "block", text: "屏蔽" }]);
    const initial = await readFile(termLibraryPath(), "utf8");
    const path = join(home, "session.zcut.json");
    await writeFile(path, serializeProject(project));
    const common = { project: path, author: { kind: "agent", name: "test" }, base_revision: project.revision.id };
    const begun = await dispatch("session_begin", {
      ...common,
      idempotency_key: "begin",
      approval: "manual",
      intent: "Terms",
    });
    const session_id = begun.result?.session_id;
    const draft = await dispatch("edit", {
      ...common,
      session_id,
      idempotency_key: "draft",
      label: "Terms",
      ops: [{ op: "set_recognition", terms: ["旧词", "豆包", "一次", "屏蔽"] }],
    });
    expect(draft.status).toBe("drafted");
    expect(await readFile(termLibraryPath(), "utf8")).toBe(initial);
    const reviewed = await dispatch("session_review", {
      ...common,
      session_id,
      idempotency_key: "review",
      base_revision: draft.receipt?.after,
    });
    expect(reviewed.ok).toBe(true);
    expect(await readFile(termLibraryPath(), "utf8")).toBe(initial);
    if (rebase) {
      const other = await dispatch("edit", {
        ...common,
        idempotency_key: "main-edit",
        label: "Rename track",
        ops: [{ op: "rename_track", track_id: project.timelines[0]!.tracks[0]!.id, name: "Changed" }],
      });
      expect(other.status).toBe("applied");
      common.base_revision = other.receipt!.after!;
    }
    if (locked) await writeFile(`${termLibraryPath()}.lock`, "busy");
    const approved = await dispatch("session_approve", { ...common, session_id, idempotency_key: "approve" });
    expect(approved.status).toBe("applied");
    expect(validateEnvelope(approved)).toEqual({ valid: true, errors: [] });
    const saved = parseProject(await readFile(path, "utf8"));
    expect(saved.ok && saved.project.recognition?.terms).toEqual(["旧词", "豆包", "一次", "屏蔽"]);
    if (rebase) expect(saved.ok && saved.project.timelines[0]!.tracks[0]!.name).toBe("Changed");
    if (locked) {
      expect(approved.result).toMatchObject({ warnings: [{ code: "W_TERMS_LIBRARY" }] });
      expect(await readFile(termLibraryPath(), "utf8")).toBe(initial);
      await rm(`${termLibraryPath()}.lock`);
    } else {
      expect(await readTermLibrary()).toMatchObject([
        { text: "屏蔽", state: "blocked", projects: [] },
        { text: "豆包", source: "auto", projects: [project.id] },
      ]);
      await editTermLibrary([{ op: "remove", text: "豆包" }]);
    }
    const replay = await dispatch("session_approve", { ...common, session_id, idempotency_key: "approve" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.result).toEqual(approved.result);
    expect(await readFile(termLibraryPath(), "utf8")).toBe(initial);
  },
  10000,
);
