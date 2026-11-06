import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { dispatch, printRational, projectSubtitles, serializeProject } from "../../core/src/index.ts";
import { readPreviewProject } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
it("reads current and historical draft projections without changing the main project, draft or session state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-draft-preview-"));
  directories.push(directory);
  const path = join(directory, "project.zcut.json");
  await copyFile(new URL("../../../examples/interview.zcut.json", import.meta.url), path);
  const main = await readPreviewProject(path, {});
  const begun = await dispatch("session_begin", {
    project: path,
    base_revision: main.revision.id,
    idempotency_key: "preview-begin",
    author: { kind: "human", name: "test" },
    approval: "manual",
    intent: "校对字幕",
  });
  expect(begun.ok).toBe(true);
  const session_id = begun.result?.session_id as string;
  const written = await dispatch("edit", {
    project: path,
    session_id,
    base_revision: main.revision.id,
    idempotency_key: "preview-edit",
    author: { kind: "human", name: "test" },
    ops: [
      {
        op: "set_override",
        track_id: "trk_sub_zh",
        occurrence_id: "occ_1",
        cue_id: "cue_1",
        text: "草稿字幕",
        force: true,
      },
    ],
  });
  expect(written.status, JSON.stringify(written)).toBe("drafted");
  const sessionRoot = join(directory, ".zcut", main.id, "sessions", session_id);
  const files = [path, join(sessionRoot, "draft.zcut.json"), join(sessionRoot, "session.json")];
  const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const base = await readPreviewProject(path, { session_id, at_revision: main.revision.id });
  const draft = await readPreviewProject(path, { session_id });
  const exactDraft = await readPreviewProject(path, { session_id, at_revision: written.receipt?.after });
  const cues = (project: typeof draft) => projectSubtitles(project, project.timelines[0]?.id ?? "").cues;
  const originalCue = cues(main).find((cue) => cue.cue_id === "cue_1");
  const draftCue = cues(draft).find((cue) => cue.cue_id === "cue_1");
  expect(draftCue).toMatchObject({
    text: "草稿字幕",
    track_id: "trk_sub_zh",
    start: originalCue?.start,
    end: originalCue?.end,
  });
  if (!draftCue) throw new Error("Missing projected cue");
  expect(printRational(draftCue.start, true)).toMatch(/s$/);
  expect(printRational(draftCue.end, true)).toMatch(/s$/);
  expect(cues(base).find((cue) => cue.cue_id === "cue_1")?.text).toBe(originalCue?.text);
  expect(serializeProject(exactDraft)).toBe(serializeProject(draft));
  expect(serializeProject(await readPreviewProject(path, {}))).toBe(serializeProject(main));
  expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(before);
  expect(JSON.parse(before[2] ?? "{}").state).toBe("open");
  for (const session_id of ["ses_missing", "../outside", null])
    await expect(readPreviewProject(path, { session_id })).rejects.toThrow();
});
