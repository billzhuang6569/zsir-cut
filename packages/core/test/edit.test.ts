import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  add,
  compare,
  dispatch,
  mapClipTimeToSource,
  type Project,
  parseProject,
  printRational,
  projectSubtitles,
  rational,
  serializeProject,
  sub,
  validateProjectSemantics,
} from "../src/index.js";

const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
let directory: string,
  path: string,
  counter = 0;
const author = { kind: "agent" as const, name: "edit-test" };
const read = async (): Promise<Project> => {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error("Invalid project");
  return parsed.project;
};
const request = (ops: Record<string, unknown>[], revision = "rev_fixture_1", extra = {}) => ({
  project: path,
  base_revision: revision,
  idempotency_key: `edit-${++counter}`,
  author,
  ops,
  ...extra,
});
const edit = async (ops: Record<string, unknown>[], extra = {}) =>
  dispatch("edit", request(ops, (await read()).revision.id, extra));
const clips = (project: Project, trackId: string) => {
  const track = project.timelines[0]?.tracks.find((item) => item.id === trackId);
  if (!track || track.kind === "subtitle") throw new Error("Missing media track");
  return track.clips;
};
const overrides = (project: Project, trackId: string) => {
  const track = project.timelines[0]?.tracks.find((item) => item.id === trackId);
  if (!track || track.kind !== "subtitle") throw new Error("Missing subtitle track");
  return track.overrides;
};
const withoutRevision = (project: Project) => {
  const raw = JSON.parse(serializeProject(project));
  delete raw.revision;
  return JSON.stringify(raw);
};
async function successAndUndo(op: Record<string, unknown>) {
  const before = await read();
  const input = request([op], before.revision.id);
  const bytes = await readFile(path, "utf8");
  const preview = await dispatch("edit", { ...input, dry_run: true });
  expect(preview.status, JSON.stringify(preview)).toBe("dry_run");
  expect(await readFile(path, "utf8")).toBe(bytes);
  await expect(stat(join(directory, ".zcut"))).rejects.toMatchObject({ code: "ENOENT" });
  const output = await dispatch("edit", input);
  expect(output.status, JSON.stringify(output)).toBe("applied");
  expect(output.changes).toEqual(preview.changes);
  expect(output.changes.length).toBeGreaterThan(0);
  expect(output.changes.every((change) => change.op === op.op)).toBe(true);
  await validateAndUndo(before);
  return output;
}
async function validateAndUndo(before: Project): Promise<void> {
  const after = await read();
  expect(validateProjectSemantics(after).filter((issue) => issue.severity === "error")).toEqual([]);
  const undo = await dispatch("undo", {
    project: path,
    base_revision: after.revision.id,
    idempotency_key: `undo-${++counter}`,
    author,
  });
  expect(undo.status).toBe("applied");
  expect(withoutRevision(await read())).toBe(withoutRevision(before));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-edit-"));
  path = join(directory, "project.zcut.json");
  await copyFile(fixture, path);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("edit examples", () => {
  it("removes tokens 先把 across V1 V2 A1 A3 and keeps subtitles in sync", async () => {
    const before = await read();
    const output = await edit([
      {
        op: "remove_span",
        tokens: { transcript_id: "trs_A_zh", from_token: "tok_019", to_token: "tok_020", clip_id: "clp_a1" },
      },
    ]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    for (const id of ["trk_v1", "trk_v2", "trk_a1", "trk_a3"]) {
      const previous = clips(before, id).find(
        (item) =>
          compare(item.timeline_start, rational(117n, 25n)) < 0 &&
          compare(add(item.timeline_start, item.duration), rational(129n, 25n)) > 0,
      );
      expect(previous).toBeDefined();
      const parts = clips(after, id).filter(
        (item) =>
          item.occurrence_id === previous?.occurrence_id && compare(item.timeline_start, rational(129n, 25n)) <= 0,
      );
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.some((item) => compare(add(item.timeline_start, item.duration), rational(117n, 25n)) === 0)).toBe(
        true,
      );
      expect(parts.some((item) => compare(item.timeline_start, rational(117n, 25n)) === 0)).toBe(true);
    }
    for (const oldTrack of before.timelines[0]?.tracks ?? []) {
      if (oldTrack.kind === "subtitle") continue;
      for (const oldClip of oldTrack.clips.filter((item) => compare(item.timeline_start, rational(129n, 25n)) >= 0)) {
        const shifted = clips(after, oldTrack.id).find((item) => item.id === oldClip.id);
        if (!shifted) throw new Error(`Missing shifted clip ${oldClip.id}`);
        expect(compare(shifted.timeline_start, sub(oldClip.timeline_start, rational(12n, 25n)))).toBe(0);
      }
    }
    expect(printRational(rational(12n, 25n), true)).toBe("12/25s");
    expect(output.verification.issues.some((issue) => issue.code === "W_SYNC")).toBe(false);
    const projected = projectSubtitles(after, "tl_std").cues.filter((cue) => cue.cue_id === "cue_zh_03");
    expect(projected).toHaveLength(1);
    expect(projected[0]?.text).toBe("Agent粗剪和字幕做完");
    expect(projected[0]?.clip_ids).toHaveLength(2);
    await validateAndUndo(before);
  });
  it("splits linked clp_v2 and clp_a2; transition points to right clip", async () => {
    const before = await read();
    const output = await edit([{ op: "split", clip_id: "clp_v2", at: "15s", new_id: "clp_v2_right" }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const project = await read();
    expect(clips(project, "trk_v1").find((item) => item.id === "clp_v2_right")?.occurrence_id).toBe("occ_2");
    expect(clips(project, "trk_a1").filter((item) => item.occurrence_id === "occ_2")).toHaveLength(2);
    expect(
      project.timelines[0]?.tracks.find(
        (item) =>
          item.id === "trk_v1" &&
          item.kind === "video" &&
          item.transitions.some((transition) => transition.id === "trn_1" && transition.from_clip === "clp_v2_right"),
      ),
    ).toBeDefined();
    await validateAndUndo(before);
  });
  it("trims J/L cut video without moving audio edge", async () => {
    const beforeProject = await read();
    const before = clips(beforeProject, "trk_a1").find((item) => item.id === "clp_a1");
    const output = await edit([{ op: "trim", clip_id: "clp_v1", edge: "out", to: "9s" }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    expect(clips(await read(), "trk_a1").find((item) => item.id === "clp_a1")).toEqual(before);
    await validateAndUndo(beforeProject);
  });
});

describe("edit operations", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      "place",
      {
        op: "place",
        media_id: "med_A",
        source_start: "0s",
        duration: "1s",
        at: "70s",
        video_track: "trk_v1",
        audio_track: "trk_a1",
        mode: "insert",
      },
      {
        op: "place",
        media_id: "med_missing",
        source_start: "0s",
        duration: "1s",
        at: "70s",
        video_track: "trk_v1",
        mode: "insert",
      },
    ],
    ["remove", { op: "remove", clip_ids: ["clp_v9"] }, { op: "remove", clip_ids: ["clp_missing"] }],
    [
      "remove_span",
      { op: "remove_span", range: { start: "4s", duration: "1s" } },
      { op: "remove_span", range: { start: "65s", duration: "0s" } },
    ],
    [
      "trim",
      { op: "trim", clip_id: "clp_v1", edge: "out", to: "9s" },
      { op: "trim", clip_id: "clp_v6", edge: "out", to: "49s" },
    ],
    ["split", { op: "split", clip_id: "clp_v2", at: "15s" }, { op: "split", clip_id: "clp_v2", at: "10s" }],
    [
      "move",
      { op: "move", clip_ids: ["clp_v9"], to: "70s" },
      { op: "move", clip_ids: ["clp_v2"], to: "0s", linked: false },
    ],
    [
      "set_clip",
      { op: "set_clip", clip_id: "clp_v9", label: "edited" },
      { op: "set_clip", clip_id: "clp_missing", label: "edited" },
    ],
    [
      "add_transition",
      {
        op: "add_transition",
        id: "trn_test",
        from_clip: "clp_v1",
        to_clip: "clp_v2",
        duration: "1/25s",
        alignment: "start",
      },
      { op: "add_transition", from_clip: "clp_v1", to_clip: "clp_v9", duration: "1/25s", alignment: "start" },
    ],
    [
      "remove_transition",
      { op: "remove_transition", transition_id: "trn_1" },
      { op: "remove_transition", transition_id: "trn_missing" },
    ],
    [
      "add_marker",
      { op: "add_marker", id: "mrk_test", at: "70s", duration: "0s", kind: "note", text: "test" },
      { op: "add_marker", id: "mrk_test", at: "70s", duration: "0s", kind: "bad", text: "test" },
    ],
    [
      "update_marker",
      { op: "update_marker", marker_id: "mrk_ch2", text: "edited" },
      { op: "update_marker", marker_id: "mrk_missing", text: "edited" },
    ],
    ["remove_marker", { op: "remove_marker", marker_id: "mrk_ch2" }, { op: "remove_marker", marker_id: "mrk_missing" }],
    [
      "add_track",
      { op: "add_track", id: "trk_new", kind: "video", name: "New" },
      { op: "add_track", kind: "video", name: "New", index: 999 },
    ],
    ["remove_track", { op: "remove_track", track_id: "trk_sub_en" }, { op: "remove_track", track_id: "trk_v1" }],
  ];
  for (const [name, good, bad] of cases) {
    it(`${name} applies, validates and undoes`, async () => {
      await successAndUndo(good);
    });
    it(`${name} rejects an invalid request without changing bytes`, async () => {
      const before = await readFile(path, "utf8");
      const output = await edit([bad]);
      expect(output.status).toBe("rejected");
      expect(await readFile(path, "utf8")).toBe(before);
    });
  }
});

describe("clip deletion cascade", () => {
  it("removes linked clp_v2, its transition and the last occ_2 override; undo restores them", async () => {
    const before = await read();
    const originalOverride = structuredClone(overrides(before, "trk_sub_zh"));
    const output = await edit([{ op: "remove", clip_ids: ["clp_v2"], linked: true }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").some((clip) => clip.id === "clp_v2")).toBe(false);
    expect(clips(after, "trk_a1").some((clip) => clip.id === "clp_a2")).toBe(false);
    expect(overrides(after, "trk_sub_zh").some((override) => override.occurrence_id === "occ_2")).toBe(false);
    expect(output.changes).toContainEqual(
      expect.objectContaining({
        op: "remove",
        entity: "override",
        id: "override:trk_sub_zh:occ_2:cue_zh_08",
        action: "removed",
      }),
    );
    expect(output.changes).toContainEqual(
      expect.objectContaining({ op: "remove", entity: "transition", id: "trn_1", action: "removed" }),
    );
    await validateAndUndo(before);
    expect(overrides(await read(), "trk_sub_zh")).toEqual(originalOverride);
  });

  it("keeps the occurrence override when only clp_v2 is removed", async () => {
    const before = await read();
    const originalOverride = structuredClone(overrides(before, "trk_sub_zh"));
    const output = await edit([{ op: "remove", clip_ids: ["clp_v2"], linked: false }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_a1").some((clip) => clip.id === "clp_a2")).toBe(true);
    expect(overrides(after, "trk_sub_zh")).toEqual(originalOverride);
    expect(output.changes.some((change) => change.entity === "override" && change.action === "removed")).toBe(false);
    await validateAndUndo(before);
  });

  it("removes occurrence overrides when remove_span deletes its last clips", async () => {
    const before = await read();
    const output = await edit([{ op: "remove_span", range: { start: "48/5s", duration: "62/5s" } }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").some((clip) => clip.occurrence_id === "occ_2")).toBe(false);
    expect(clips(after, "trk_a1").some((clip) => clip.occurrence_id === "occ_2")).toBe(false);
    expect(overrides(after, "trk_sub_zh").some((override) => override.occurrence_id === "occ_2")).toBe(false);
    expect(output.changes).toContainEqual(
      expect.objectContaining({
        op: "remove_span",
        entity: "override",
        id: "override:trk_sub_zh:occ_2:cue_zh_08",
        action: "removed",
      }),
    );
    await validateAndUndo(before);
  });

  it("cleans overrides on every subtitle track after place overwrite deletes the last clip", async () => {
    const before = await read();
    overrides(before, "trk_sub_zh").push({ occurrence_id: "occ_10", cue_id: "cue_zh_08", text: "覆盖" });
    overrides(before, "trk_sub_en").push({ occurrence_id: "occ_10", cue_id: "cue_en_08", text: "override" });
    await writeFile(path, serializeProject(before));
    const output = await edit([
      {
        op: "place",
        media_id: "med_B",
        source_start: "0s",
        duration: "4s",
        at: "60s",
        video_track: "trk_v1",
        mode: "overwrite",
      },
    ]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").some((clip) => clip.id === "clp_v9")).toBe(false);
    for (const trackId of ["trk_sub_zh", "trk_sub_en"]) {
      expect(overrides(after, trackId).some((override) => override.occurrence_id === "occ_10")).toBe(false);
      expect(output.changes).toContainEqual(
        expect.objectContaining({
          op: "place",
          entity: "override",
          action: "removed",
          id: expect.stringContaining(trackId),
        }),
      );
    }
    await validateAndUndo(before);
  });
});

describe("image source start", () => {
  it("keeps both still-image pieces at 0s after split", async () => {
    const before = await read();
    const output = await edit([{ op: "split", clip_id: "clp_still", at: "437/25s", new_id: "clp_still_right" }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const parts = clips(await read(), "trk_v2").filter((clip) => clip.occurrence_id === "occ_11");
    expect(parts.map((clip) => clip.id).sort()).toEqual(["clp_still", "clp_still_right"]);
    expect(parts.map((clip) => printRational(clip.source_start, true))).toEqual(["0s", "0s"]);
    await validateAndUndo(before);
  });

  it("keeps a still image at 0s when trimming its in point", async () => {
    const before = await read();
    const output = await edit([{ op: "trim", clip_id: "clp_still", edge: "in", to: "17s" }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const still = clips(await read(), "trk_v2").find((clip) => clip.id === "clp_still");
    expect(still?.timeline_start).toEqual(rational(17n));
    expect(still?.source_start).toEqual(rational(0n));
    await validateAndUndo(before);
  });

  it("keeps both still-image pieces at 0s after remove_span", async () => {
    const before = await read();
    const output = await edit([
      { op: "remove_span", range: { start: "17s", duration: "1s" }, tracks: ["trk_v2"], ripple: false },
    ]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const parts = clips(await read(), "trk_v2").filter((clip) => clip.occurrence_id === "occ_11");
    expect(parts).toHaveLength(2);
    expect(parts.map((clip) => printRational(clip.source_start, true))).toEqual(["0s", "0s"]);
    await validateAndUndo(before);
  });

  it("keeps still-image remnants at 0s after place overwrite", async () => {
    const before = await read();
    const output = await edit([
      {
        op: "place",
        media_id: "med_B",
        source_start: "0s",
        duration: "1s",
        at: "17s",
        video_track: "trk_v2",
        mode: "overwrite",
      },
    ]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const parts = clips(await read(), "trk_v2").filter((clip) => clip.occurrence_id === "occ_11");
    expect(parts).toHaveLength(2);
    expect(parts.map((clip) => printRational(clip.source_start, true))).toEqual(["0s", "0s"]);
    await validateAndUndo(before);
    const bytes = await readFile(path, "utf8");
    const invalid = await edit([
      {
        op: "place",
        media_id: "med_STILL",
        source_start: "1s",
        duration: "1s",
        at: "70s",
        video_track: "trk_v2",
        mode: "insert",
      },
    ]);
    expect(invalid.error?.code).toBe("E_VALIDATION");
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});

describe("trim duration", () => {
  it.each([
    ["in", "19s"],
    ["out", "16s"],
  ])("rejects a zero-duration %s trim at the operation layer", async (edge, to) => {
    const bytes = await readFile(path, "utf8");
    const output = await edit([{ op: "trim", clip_id: "clp_still", edge, to }]);
    expect(output.status).toBe("rejected");
    expect(output.error?.code).toBe("E_VALIDATION");
    expect(output.verification.issues).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});

describe("edit boundaries and transaction", () => {
  it("insert splits every crossing media track and shifts the right pieces", async () => {
    const before = await read();
    const output = await edit([
      {
        op: "place",
        media_id: "med_STILL",
        source_start: "0s",
        duration: "1s",
        at: "5s",
        video_track: "trk_v1",
        mode: "insert",
      },
    ]);
    expect(output.status).toBe("applied");
    expect(
      output.changes.some(
        (change) =>
          change.op === "place" &&
          change.entity === "clip" &&
          change.action === "created" &&
          typeof change.detail?.occurrence_id === "string",
      ),
    ).toBe(true);
    const after = await read();
    for (const trackId of ["trk_v1", "trk_v2", "trk_a1", "trk_a3"]) {
      const old = clips(before, trackId).find(
        (item) =>
          compare(item.timeline_start, rational(5n)) < 0 &&
          compare(add(item.timeline_start, item.duration), rational(5n)) > 0,
      );
      expect(old).toBeDefined();
      expect(
        clips(after, trackId).some(
          (item) => item.id === old?.id && compare(add(item.timeline_start, item.duration), rational(5n)) === 0,
        ),
      ).toBe(true);
      expect(
        clips(after, trackId).some(
          (item) =>
            item.id !== old?.id &&
            item.occurrence_id === old?.occurrence_id &&
            compare(item.timeline_start, rational(6n)) === 0,
        ),
      ).toBe(true);
    }
    await validateAndUndo(before);
  });
  it("overwrite touches its target track only", async () => {
    const before = await read();
    const output = await edit([
      {
        op: "place",
        media_id: "med_STILL",
        source_start: "0s",
        duration: "1s",
        at: "5s",
        video_track: "trk_v1",
        mode: "overwrite",
      },
    ]);
    expect(output.status).toBe("applied");
    const after = await read();
    for (const id of ["trk_v2", "trk_a1", "trk_a3"]) expect(clips(after, id)).toEqual(clips(before, id));
    expect(after.timelines[0]?.markers).toEqual(before.timelines[0]?.markers);
    await validateAndUndo(before);
  });
  it("split preserves every integer-frame time-map value", async () => {
    const beforeProject = await read();
    const before = clips(beforeProject, "trk_v1").find((item) => item.id === "clp_v8");
    const output = await edit([{ op: "split", clip_id: "clp_v8", at: "113/2s", new_id: "clp_v8_right" }]);
    expect(output.status).toBe("rejected");
    expect(output.error?.code).toBe("E_VALIDATION");
    const good = await edit([{ op: "split", clip_id: "clp_v8", at: "57s", new_id: "clp_v8_right" }]);
    expect(good.status).toBe("applied");
    const after = await read();
    const left = clips(after, "trk_v1").find((item) => item.id === "clp_v8");
    const right = clips(after, "trk_v1").find((item) => item.id === "clp_v8_right");
    if (!before || !left || !right) throw new Error("Missing split clip");
    for (let frame = 0; frame <= 150; frame++) {
      const at = rational(BigInt(frame), 25n);
      const part = frame <= 75 ? left : right;
      const local = frame <= 75 ? at : rational(BigInt(frame - 75), 25n);
      expect(mapClipTimeToSource(part, local)).toEqual(mapClipTimeToSource(before, at));
    }
    await validateAndUndo(beforeProject);
  });
  it("rolls back a later failing operation and labels changes by their source operation", async () => {
    const beforeProject = await read();
    const before = await readFile(path, "utf8");
    const failed = await edit([
      { op: "add_marker", id: "mrk_test", at: "70s", duration: "0s", kind: "note", text: "test" },
      { op: "remove", clip_ids: ["clp_missing"] },
    ]);
    expect(failed.status).toBe("rejected");
    expect(failed.error?.code).toBe("E_NOT_FOUND");
    expect(await readFile(path, "utf8")).toBe(before);
    const success = await edit([
      { op: "add_marker", id: "mrk_test", at: "70s", duration: "0s", kind: "note", text: "test" },
      { op: "set_clip", clip_id: "clp_v9", label: "new" },
    ]);
    expect(success.status).toBe("applied");
    expect(success.changes.find((change) => change.id === "mrk_test")?.op).toBe("add_marker");
    expect(success.changes.find((change) => change.id === "clp_v9")?.op).toBe("set_clip");
    await validateAndUndo(beforeProject);
  });
  it("keeps subtitle-only and mixed-domain requests separate", async () => {
    const before = await readFile(path, "utf8");
    const subtitle = {
      op: "edit_text",
      transcript_id: "trs_A_zh",
      from_token: "tok_000",
      to_token: "tok_001",
      text: "a",
    };
    expect((await edit([subtitle])).error?.code).toBe("E_UNSUPPORTED");
    expect((await edit([subtitle, { op: "remove", clip_ids: ["clp_v9"] }])).error?.code).toBe("E_MIXED_DOMAIN");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("requires timeline_id for multiple timelines and edits only the selected timeline", async () => {
    const before = await read();
    const first = before.timelines[0];
    if (!first) throw new Error("Missing first timeline");
    before.timelines.push({ ...structuredClone(first), id: "tl_second", name: "Second", tracks: [], markers: [] });
    await writeFile(path, serializeProject(before));
    const bytes = await readFile(path, "utf8");
    const op = { op: "add_marker", id: "mrk_second", at: "70s", duration: "0s", kind: "note", text: "second" };
    const missing = await edit([op]);
    expect(missing.status).toBe("rejected");
    expect(missing.error?.code).toBe("E_VALIDATION");
    const unknown = await edit([op], { timeline_id: "tl_missing" });
    expect(unknown.error?.code).toBe("E_NOT_FOUND");
    expect(await readFile(path, "utf8")).toBe(bytes);
    const input = request([op], before.revision.id, { timeline_id: "tl_second" });
    const applied = await dispatch("edit", input);
    expect(applied.status).toBe("applied");
    const reused = await dispatch("edit", { ...input, timeline_id: "tl_std" });
    expect(reused.error?.code).toBe("E_IDEMPOTENCY_MISMATCH");
    const after = await read();
    expect(after.timelines[0]).toEqual(before.timelines[0]);
    expect(after.timelines[1]?.markers.map((marker) => marker.id)).toEqual(["mrk_second"]);
    await validateAndUndo(before);
  });
});

describe("remove_span and frame-grid details", () => {
  it.each([
    ["out", 117, 129],
    ["in", 118, 128],
    ["nearest", 118, 129],
  ] as const)("snaps %s to frame interval %i..%i", async (snap, first, last) => {
    const before = await read();
    const output = await edit([{ op: "remove_span", range: { start: "47/10s", duration: "11/25s" }, snap }]);
    expect(output.status).toBe("applied");
    const project = await read();
    const v1 = clips(project, "trk_v1");
    expect(
      v1.some(
        (item) =>
          item.id === "clp_v1" && compare(add(item.timeline_start, item.duration), rational(BigInt(first), 25n)) === 0,
      ),
    ).toBe(true);
    expect(
      v1.some(
        (item) =>
          item.id !== "clp_v1" &&
          item.occurrence_id === "occ_1" &&
          compare(item.timeline_start, rational(BigInt(first), 25n)) === 0,
      ),
    ).toBe(true);
    const right = v1.find((item) => item.id !== "clp_v1" && item.occurrence_id === "occ_1");
    if (!right) throw new Error("Missing right clip");
    expect(compare(right.source_start, add(rational(278n, 25n), rational(BigInt(last), 25n)))).toBe(0);
    await validateAndUndo(before);
  });
  it("limits partial ripple to selected tracks and reports sync warning", async () => {
    const before = await read();
    const output = await edit([{ op: "remove_span", range: { start: "4s", duration: "1s" }, tracks: ["trk_v1"] }]);
    expect(output.status).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_a1")).toEqual(clips(before, "trk_a1"));
    expect(output.verification.issues.some((issue) => issue.code === "W_SYNC")).toBe(true);
    await validateAndUndo(before);
  });
  it("rejects off-grid video boundaries without changing the project", async () => {
    const bytes = await readFile(path, "utf8");
    for (const op of [
      {
        op: "place",
        media_id: "med_A",
        source_start: "0s",
        duration: "1s",
        at: "1/50s",
        video_track: "trk_v1",
        mode: "insert",
      },
      { op: "trim", clip_id: "clp_v1", edge: "out", to: "199/50s" },
      { op: "split", clip_id: "clp_v1", at: "1/50s" },
      { op: "move", clip_ids: ["clp_v9"], to: "3001/50s" },
      { op: "split", clip_id: "clp_v1", at: "2/2s" },
    ]) {
      const output = await edit([op]);
      expect(output.status).toBe("rejected");
      expect(output.error?.code).toBe("E_VALIDATION");
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
  });
  it("keeps marker and free-cue content on both sides of a removed interval", async () => {
    const project = await read();
    const timeline = project.timelines[0];
    if (!timeline) throw new Error("Missing timeline");
    const subtitle = timeline.tracks.find((item) => item.id === "trk_sub_zh");
    if (!subtitle || subtitle.kind !== "subtitle") throw new Error("Missing subtitle track");
    subtitle.free_cues.push({ id: "cue_span", timeline_start: rational(4n), duration: rational(2n), text: "span" });
    timeline.markers.push({ id: "mrk_span", at: rational(4n), duration: rational(2n), kind: "note", text: "span" });
    await writeFile(path, serializeProject(project));
    const before = await read();
    const output = await edit([{ op: "remove_span", range: { start: "9/2s", duration: "1s" } }]);
    expect(output.status).toBe("applied");
    const markers = (await read()).timelines[0]?.markers.filter((item) => item.text === "span") ?? [];
    expect(markers).toHaveLength(2);
    expect(markers.map((item) => printRational(item.duration, true)).sort()).toEqual(["12/25s", "12/25s"]);
    const after = await read();
    const subtitleAfter = after.timelines[0]?.tracks.find((item) => item.id === "trk_sub_zh");
    if (!subtitleAfter || subtitleAfter.kind !== "subtitle") throw new Error("Missing subtitle track");
    expect(
      subtitleAfter.free_cues
        .filter((cue) => cue.text === "span")
        .map((cue) => printRational(cue.duration, true))
        .sort(),
    ).toEqual(["12/25s", "12/25s"]);
    await validateAndUndo(before);
  });
});

describe("linked move destination", () => {
  it("moves one video to another video track while moving its linked audio in place", async () => {
    const before = await read();
    const output = await edit([{ op: "move", clip_ids: ["clp_v1"], to: "70s", track_id: "trk_v2" }]);
    expect(output.status).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").some((item) => item.id === "clp_v1")).toBe(false);
    expect(clips(after, "trk_v2").find((item) => item.id === "clp_v1")?.timeline_start).toEqual(rational(70n));
    expect(clips(after, "trk_a1").find((item) => item.id === "clp_a1")?.timeline_start).toEqual(rational(70n));
    await validateAndUndo(before);
  });
});

describe("time-map removal", () => {
  it("retains the mapped source time of a surviving right fragment", async () => {
    const beforeProject = await read();
    const before = clips(beforeProject, "trk_v1").find((item) => item.id === "clp_v8");
    if (!before) throw new Error("Missing mapped clip");
    const output = await edit([{ op: "remove_span", range: { start: "57s", duration: "1s" } }]);
    expect(output.status).toBe("applied");
    const after = await read();
    const right = clips(after, "trk_v1").find(
      (item) => item.occurrence_id === before.occurrence_id && compare(item.timeline_start, rational(57n)) === 0,
    );
    if (!right) throw new Error("Missing right mapped fragment");
    for (let frame = 0; frame <= 50; frame++) {
      const local = rational(BigInt(frame), 25n);
      expect(mapClipTimeToSource(right, local)).toEqual(mapClipTimeToSource(before, add(rational(4n), local)));
    }
    await validateAndUndo(beforeProject);
  });
});

describe("ripple trim", () => {
  it("trims an in edge at sequence zero without moving the clip start below zero", async () => {
    const before = await read();
    const output = await edit([{ op: "trim", clip_id: "clp_v1", edge: "in", to: "1s", ripple: true }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").find((item) => item.id === "clp_v1")?.timeline_start).toEqual(rational(0n));
    expect(clips(after, "trk_v1").find((item) => item.id === "clp_v2")?.timeline_start).toEqual(rational(9n));
    const oldMarker = before.timelines[0]?.markers.find((item) => item.id === "mrk_rv_sub");
    if (!oldMarker) throw new Error("Missing marker");
    expect(after.timelines[0]?.markers.find((item) => item.id === "mrk_rv_sub")?.at).toEqual(
      sub(oldMarker.at, rational(1n)),
    );
    await validateAndUndo(before);
  });
});

describe("ripple out trim", () => {
  it.each(["9s", "11s"])("moves following content for out edge %s", async (to) => {
    const before = await read();
    const output = await edit([{ op: "trim", clip_id: "clp_v1", edge: "out", to, ripple: true }]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    expect(clips(after, "trk_v1").find((item) => item.id === "clp_v2")?.timeline_start).toEqual(
      rational(BigInt(to.slice(0, -1))),
    );
    await validateAndUndo(before);
  });
});
