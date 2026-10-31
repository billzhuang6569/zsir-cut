// biome-ignore-all lint/style/noNonNullAssertion: Fixture IDs and indexes are checked by test setup.
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  add,
  compare,
  dispatch,
  displayRanges,
  mapClipTimeToSource,
  mul,
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
  label: "Test edit",
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

describe("subtitle edit operations", () => {
  it("rejects approved tokens and locked cues, and force outside a manual session", async () => {
    const before = await readFile(path, "utf8");
    const op = {
      op: "edit_text",
      transcript_id: "trs_A_zh",
      from_token: "tok_005",
      to_token: "tok_006",
      text: "今天 聊",
    };
    expect((await edit([op])).error?.code).toBe("E_LOCKED");
    expect((await edit([{ ...op, force: true }])).error?.code).toBe("E_SESSION_STATE");
    expect((await edit([{ ...op, from_token: "tok_000", to_token: "tok_001" }])).error?.code).toBe("E_LOCKED");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("replaces two tokens with three, preserves heard, interpolates, updates cue endpoints and projection", async () => {
    const before = await read();
    const result = await edit([
      {
        op: "edit_text",
        transcript_id: "trs_A_zh",
        from_token: "tok_018",
        to_token: "tok_019",
        text: "新 的 文字",
        new_ids: ["tok_new_a", "tok_new_b", "tok_new_c"],
      },
    ]);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = await read();
    const transcript = after.transcripts.find((item) => item.id === "trs_A_zh")!;
    const tokens = transcript.tokens.filter((token) => token.id.startsWith("tok_new_"));
    expect(tokens.map((token) => [token.text, token.heard, token.state])).toEqual([
      ["新", "Agent先", "edited"],
      ["的", "", "edited"],
      ["文字", "", "edited"],
    ]);
    expect(new Set(tokens.map((token) => token.align.run)).size).toBe(1);
    expect(tokens.every((token) => token.align.conf === undefined)).toBe(true);
    expect(transcript.raw_runs.find((run) => run.id === tokens[0]!.align.run)).toMatchObject({
      kind: "align",
      engine: { name: "interpolate" },
    });
    expect(transcript.cues.find((cue) => cue.id === "cue_zh_03")?.first_token).toBe("tok_new_a");
    expect(
      projectSubtitles(after, "tl_std").cues.some((cue) => cue.cue_id === "cue_zh_03" && cue.text.includes("新的文字")),
    ).toBe(true);
    await validateAndUndo(before);
  });
  it("resegments around approved and locked cues while keeping matching cue IDs", async () => {
    const before = await read();
    const result = await edit([
      {
        op: "resegment",
        transcript_id: "trs_A_zh",
        range: { from_token: "tok_000", to_token: "tok_024" },
        rules: { cpl: 4 },
      },
    ]);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = await read();
    const old = before.transcripts.find((item) => item.id === "trs_A_zh")!;
    const next = after.transcripts.find((item) => item.id === "trs_A_zh")!;
    expect(next.cues.find((cue) => cue.id === "cue_zh_00")).toEqual(old.cues.find((cue) => cue.id === "cue_zh_00"));
    expect(next.cues.find((cue) => cue.id === "cue_zh_01")).toEqual(old.cues.find((cue) => cue.id === "cue_zh_01"));
    expect(
      next.cues.some((cue) => cue.id === "cue_zh_03" && cue.first_token === "tok_018" && cue.last_token === "tok_024"),
    ).toBe(false);
    await validateAndUndo(before);
  });
  it("persists cpl 10 rules for display and warnings, then undo removes them", async () => {
    const before = await read();
    const result = await edit([
      {
        op: "resegment",
        transcript_id: "trs_A_en",
        range: { from_token: "tok_en_00", to_token: "tok_en_00" },
        rules: { cpl: 10, min_duration: "3s", cps: 1 },
      },
    ]);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = await read();
    const transcript = after.transcripts.find((item) => item.id === "trs_A_en")!;
    expect(transcript.subtitle_rules).toEqual({ profile: "en-talk", cpl: 10, min_duration: rational(3n), cps: 1 });
    const displayed = displayRanges(transcript).find((item) => item.cue.id === "cue_en_00")!;
    expect(printRational(displayed.end, true)).toBe("271/50s");
    expect(displayed.warnings).toEqual(["W_SUB_TOO_WIDE", "W_SUB_CPS"]);
    const issues = validateProjectSemantics(after).filter((item) => item.ids.includes("cue_en_00"));
    expect(new Set(issues.map((item) => item.code))).toEqual(new Set(["W_SUB_TOO_WIDE", "W_SUB_CPS"]));
    await validateAndUndo(before);
    expect((await read()).transcripts.find((item) => item.id === "trs_A_en")?.subtitle_rules).toBeUndefined();
  });
  it("uses saved rules for a later resegment without rules", async () => {
    const before = await read();
    const saved = await edit([
      {
        op: "resegment",
        transcript_id: "trs_A_zh",
        range: { from_token: "tok_018", to_token: "tok_024" },
        rules: { profile: "zh-talk", cpl: 10, max_lines: 1 },
      },
    ]);
    expect(saved.status, JSON.stringify(saved)).toBe("applied");
    const first = await read();
    expect(first.transcripts.find((item) => item.id === "trs_A_zh")?.subtitle_rules).toEqual({
      profile: "zh-talk",
      cpl: 10,
      max_lines: 1,
    });
    const next = await edit([
      { op: "resegment", transcript_id: "trs_A_zh", range: { from_token: "tok_010", to_token: "tok_017" } },
    ]);
    expect(next.status, JSON.stringify(next)).toBe("applied");
    const changed = (await read()).transcripts.find((item) => item.id === "trs_A_zh")!;
    expect(changed.subtitle_rules).toEqual({ profile: "zh-talk", cpl: 10, max_lines: 1 });
    expect(
      changed.cues.some(
        (cue) => cue.id === "cue_zh_02" && cue.first_token === "tok_010" && cue.last_token === "tok_017",
      ),
    ).toBe(false);
    await validateAndUndo(first);
    await validateAndUndo(before);
  });
  it("splits manual timing at the boundary and merges only the outer edges", async () => {
    const before = await read();
    const output = await edit([
      { op: "set_cue", cue_id: "cue_zh_03", timing: { start: "15s", end: "18s" } },
      { op: "split_cue", cue_id: "cue_zh_03", after_token: "tok_020", new_id: "cue_manual_right" },
    ]);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const after = await read();
    const cues = after.transcripts.find((item) => item.id === "trs_A_zh")!.cues;
    expect(cues.find((cue) => cue.id === "cue_zh_03")?.timing).toEqual({ start: rational(15n) });
    expect(cues.find((cue) => cue.id === "cue_manual_right")?.timing).toEqual({ end: rational(18n) });
    await validateAndUndo(before);

    const merged = await edit([
      { op: "set_cue", cue_id: "cue_zh_03", timing: { start: "15s", end: "18s" } },
      { op: "set_cue", cue_id: "cue_zh_04", timing: { start: "20s", end: "23s" } },
      { op: "merge_cues", cue_ids: ["cue_zh_03", "cue_zh_04"] },
    ]);
    expect(merged.status, JSON.stringify(merged)).toBe("applied");
    const combined = (await read()).transcripts
      .find((item) => item.id === "trs_A_zh")!
      .cues.find((cue) => cue.id === "cue_zh_03");
    expect(combined?.timing).toEqual({ start: rational(15n), end: rational(23n) });
    await validateAndUndo(before);
  });
  const ops: Record<string, unknown>[] = [
    { op: "hide_tokens", transcript_id: "trs_A_zh", tokens: ["tok_019"] },
    { op: "set_token_state", transcript_id: "trs_A_zh", tokens: ["tok_019"], state: "edited" },
    {
      op: "resegment",
      transcript_id: "trs_A_zh",
      range: { from_token: "tok_018", to_token: "tok_024" },
      rules: { profile: "zh-talk", cpl: 6 },
    },
    { op: "set_cue", cue_id: "cue_zh_03", breaks: ["tok_020"], state: "edited" },
    { op: "split_cue", cue_id: "cue_zh_03", after_token: "tok_020", new_id: "cue_split_test" },
    { op: "merge_cues", cue_ids: ["cue_zh_03", "cue_zh_04"] },
    { op: "set_override", track_id: "trk_sub_zh", occurrence_id: "occ_1", cue_id: "cue_zh_03", text: "替换" },
    { op: "remove_override", track_id: "trk_sub_zh", occurrence_id: "occ_2", cue_id: "cue_zh_08" },
    {
      op: "add_free_cue",
      track_id: "trk_sub_zh",
      id: "cue_free_test",
      timeline_start: "70s",
      duration: "2s",
      text: "独立字幕",
    },
    { op: "add_style", id: "sty_test", name: "Test", font_family: "Arial", font_size: 0.05, color: "#ffffff" },
    { op: "update_style", style_id: "sty_zh", name: "Updated" },
    {
      op: "add_subtitle_track",
      id: "trk_sub_test",
      name: "Test",
      language: "zh-Hans",
      carrier_tracks: ["trk_a1"],
      default_style_id: "sty_zh",
    },
  ];
  for (const op of ops)
    it(`${op.op} validates and undoes`, async () => {
      await successAndUndo(op);
    });
  it("removes a free cue and undoes", async () => {
    const project = await read();
    const track = project.timelines[0]!.tracks.find((item) => item.id === "trk_sub_zh");
    if (!track || track.kind !== "subtitle") throw new Error("Missing subtitle track");
    await successAndUndo({ op: "remove_free_cue", track_id: track.id, id: track.free_cues[0]!.id });
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
    expect((await edit([subtitle])).error?.code).toBe("E_LOCKED");
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
      { op: "split", clip_id: "clp_v1", at: "2/100s" },
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

describe("place tokens and request times", () => {
  beforeEach(async () => {
    await copyFile(new URL("../../../fixtures/regressions/place-tokens.zcut.json", import.meta.url), path);
  });
  const place = (tokens: Record<string, unknown>, extra = {}) => ({
    op: "place",
    media_id: "med_A",
    tokens: { transcript_id: "trs_A_zh", ...tokens },
    at: "end",
    mode: "insert",
    video_track: "trk_v1",
    audio_track: "trk_a1",
    ...extra,
  });
  const save = async (project: Project) => writeFile(path, serializeProject(project));

  it("appends sentence 3, 1, 2 with hand-calculated silence and rounding, identically in dry run", async () => {
    // pause/2 = 1/5s. Sentence 3: [10.5-.2, 13.46+.2] = [10.3,13.66].
    // floor(10.3*25)/25 = 257/25; ceil((13.66-10.28)*25)/25 = 17/5.
    // Sentence 1: [.5-.2,2.09+.2] = [.3,2.29]; floor start = 7/25;
    // ceil((2.29-.28)*25)/25 = 51/25. No predecessor: p = 0.
    // Sentence 2: [5.5-.2,7.58+.2] = [5.3,7.78]; floor start = 132/25;
    // ceil((7.78-5.28)*25)/25 = 63/25. Sequence starts: 0, 17/5, 136/25.
    const input = request([
      place({ from_token: "tok_010", to_token: "tok_017", pause: "2/5s" }),
      place({ from_token: "tok_000", to_token: "tok_004", pause: "2/5s" }),
      place({ from_token: "tok_005", to_token: "tok_009", pause: "2/5s" }),
    ]);
    const bytes = await readFile(path, "utf8");
    const preview = await dispatch("edit", { ...input, dry_run: true });
    expect(preview.status, JSON.stringify(preview)).toBe("dry_run");
    expect(await readFile(path, "utf8")).toBe(bytes);
    await expect(stat(join(directory, ".zcut"))).rejects.toMatchObject({ code: "ENOENT" });
    const output = await dispatch("edit", input);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    expect(output.changes).toEqual(preview.changes);
    const after = await read();
    for (const trackId of ["trk_v1", "trk_a1"]) {
      const placed = clips(after, trackId);
      expect(
        placed.map((clip) =>
          [clip.source_start, clip.duration, clip.timeline_start].map((t) => printRational(t, true)),
        ),
      ).toEqual([
        ["257/25s", "17/5s", "0s"],
        ["7/25s", "51/25s", "17/5s"],
        ["132/25s", "63/25s", "136/25s"],
      ]);
      for (const clip of placed)
        expect(output.changes.find((change) => change.id === clip.id)?.detail).toEqual({
          occurrence_id: clip.occurrence_id,
          source_start: printRational(clip.source_start, true),
          duration: printRational(clip.duration, true),
        });
      expect(add(placed[0]!.timeline_start, placed[0]!.duration)).toEqual(placed[1]!.timeline_start);
      expect(add(placed[1]!.timeline_start, placed[1]!.duration)).toEqual(placed[2]!.timeline_start);
    }
    const original = parseProject(bytes);
    if (!original.ok) throw new Error("Invalid fixture");
    await validateAndUndo(original.project);
  });

  it("uses media boundaries without neighboring visible words, and skips hidden tokens", async () => {
    const p = await read();
    const transcript = p.transcripts[0]!;
    transcript.tokens[1]!.text = "";
    transcript.tokens[18]!.text = "";
    await save(p);
    const output = await dispatch(
      "edit",
      request([
        place({ from_token: "tok_000", to_token: "tok_000", pause: "20s" }),
        place({ from_token: "tok_010", to_token: "tok_017", pause: "240s" }),
      ]),
    );
    expect(output.status, JSON.stringify(output)).toBe("applied");
    // Hidden tok_001 is skipped: next start = tok_002.start = 29/25;
    // p=0, so [0,29/25] is already on-grid. Last visible word has n=120.
    expect(clips(await read(), "trk_v1").map((c) => [c.source_start, c.duration])).toEqual([
      [rational(0n), rational(29n, 25n)],
      [rational(189n, 25n), rational(2811n, 25n)],
    ]);
  });

  it.each([undefined, "0s"])("keeps word edges before rounding with pause %s", async (pause) => {
    const output = await dispatch(
      "edit",
      request([place({ from_token: "tok_000", to_token: "tok_004", ...(pause ? { pause } : {}) })]),
    );
    expect(output.status, JSON.stringify(output)).toBe("applied");
    // floor(.5*25)=12 frames; ceil((2.09-.48)*25)=41 frames.
    expect(clips(await read(), "trk_v1")[0]).toMatchObject({
      source_start: rational(12n, 25n),
      duration: rational(41n, 25n),
    });
  });

  it("uses the source video grid for start and timeline grid for duration", async () => {
    const p = await read();
    p.media[0]!.video!.rate = rational(30n);
    await save(p);
    const output = await dispatch(
      "edit",
      request([place({ from_token: "tok_000", to_token: "tok_004", pause: "2/5s" })]),
    );
    expect(output.status, JSON.stringify(output)).toBe("applied");
    // floor(.3*30)/30=.3; ceil((2.29-.3)*25)/25=2.
    expect(clips(await read(), "trk_v1")[0]).toMatchObject({ source_start: rational(3n, 10n), duration: rational(2n) });
  });

  it("uses the timeline grid for pure audio and caps duration inside a non-grid media end", async () => {
    const p = await read();
    const source = p.media[0]!;
    source.kind = "audio";
    delete source.video;
    source.duration = rational(4181n, 2000n); // 2.0905s, tail is between timeline frames.
    const transcript = p.transcripts[0]!;
    transcript.tokens = transcript.tokens.slice(0, 5);
    transcript.cues = transcript.cues.slice(0, 1);
    await save(p);
    const output = await dispatch(
      "edit",
      request([place({ from_token: "tok_000", to_token: "tok_004", pause: "2/5s" }, { video_track: undefined })]),
    );
    expect(output.status, JSON.stringify(output)).toBe("applied");
    // start=.28; ceil((2.0905-.28)*25)=46, but only floor(1.8105*25)=45 frames fit.
    expect(clips(await read(), "trk_a1")[0]).toMatchObject({
      source_start: rational(7n, 25n),
      duration: rational(9n, 5n),
    });
  });

  it("finds end across all media tracks, including disabled tracks, ignoring markers", async () => {
    const p = await read();
    p.timelines[0]!.tracks.push({
      id: "trk_later",
      kind: "audio",
      name: "Later",
      enabled: false,
      transitions: [],
      clips: [
        {
          id: "clp_later",
          occurrence_id: "occ_later",
          media_id: "med_A",
          source_start: rational(0n),
          timeline_start: rational(10n),
          duration: rational(2n),
          enabled: false,
        },
      ],
    });
    p.timelines[0]!.markers.push({
      id: "mrk_later",
      at: rational(100n),
      duration: rational(1n),
      kind: "note",
      text: "Ignore",
    });
    await save(p);
    const output = await dispatch("edit", request([place({ from_token: "tok_000", to_token: "tok_004" })]));
    expect(output.status, JSON.stringify(output)).toBe("applied");
    expect(clips(await read(), "trk_v1")[0]?.timeline_start).toEqual(rational(12n));
  });

  it.each([
    ["E_VALIDATION", { from_token: "tok_010", to_token: "tok_000" }, {}],
    ["E_VALIDATION", { from_token: "tok_000", to_token: "tok_004" }, { media_id: "med_other" }],
    ["E_NOT_FOUND", { from_token: "tok_missing", to_token: "tok_004" }, {}],
    ["E_NOT_FOUND", { transcript_id: "trs_missing", from_token: "tok_000", to_token: "tok_004" }, {}],
  ])("rejects %s atomically for %j", async (code, tokens, extra) => {
    const p = await read();
    p.media.push({ ...p.media[0]!, id: "med_other" });
    await save(p);
    const bytes = await readFile(path, "utf8");
    const input = request([place({ from_token: "tok_000", to_token: "tok_004" }), place(tokens, extra)]);
    for (const dry_run of [true, false]) {
      const output = await dispatch("edit", { ...input, dry_run });
      expect(output).toMatchObject({ status: "rejected", error: { code } });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
  });

  it("reduces nested request times, preserves text, and replays an equivalent canonical request", async () => {
    const input = request([
      {
        op: "place",
        media_id: "med_A",
        source_start: "0/25s",
        duration: "50/25s",
        at: "0/25s",
        mode: "insert",
        video_track: "trk_v1",
        video_clip_id: "clp_reduced",
      },
      {
        op: "set_clip",
        clip_id: "clp_reduced",
        label: "50/25s",
        time_map: [
          { at: "0/25s", source: "0/25s", interp: "linear" },
          { at: "50/25s", source: "50/25s", interp: "linear" },
        ],
      },
      { op: "add_marker", at: "50/25s", duration: "0/25s", kind: "note", text: "50/25s" },
    ]);
    const preview = await dispatch("edit", { ...input, dry_run: true });
    const output = await dispatch("edit", input);
    expect(output.status, JSON.stringify(output)).toBe("applied");
    expect(preview.changes).toEqual(output.changes);
    expect(clips(await read(), "trk_v1")[0]).toMatchObject({ duration: rational(2n), label: "50/25s" });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.timelines[0].tracks[0].clips[0].time_map[1]).toMatchObject({ at: "2s", source: "2s" });
    expect(raw.timelines[0].markers[0]).toMatchObject({ at: "2s", duration: "0s", text: "50/25s" });
    const replay = await dispatch("edit", {
      ...input,
      ops: [{ ...input.ops[0], source_start: "0s", duration: "2s", at: "0s" }, ...input.ops.slice(1)],
    });
    expect(replay.receipt?.replayed).toBe(true);
  });

  it("still reports E_TIME_FORM in project files", async () => {
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.media[0].duration = "50/25s";
    await writeFile(path, JSON.stringify(raw));
    const output = await dispatch("validate", { project: path });
    expect(output.verification.passed).toBe(false);
    expect(output.verification.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "E_TIME_FORM" })]),
    );
  });
});

describe("format 0.2 operations", () => {
  it("updates only organize, deduplicates tags in order, and restores content bytes on undo", async () => {
    const before = await read();
    const output = await edit([
      {
        op: "update_media",
        media_id: "med_A",
        tags: ["二", "一", "二"],
        folders: ["客户/素材"],
        rating: 5,
        note: "备注",
        link: "https://example.com",
      },
    ]);
    expect(output.status).toBe("applied");
    expect(output.changes).toEqual([expect.objectContaining({ entity: "media", id: "med_A", op: "update_media" })]);
    const after = await read();
    expect(after.media[0]!.organize).toEqual({
      tags: ["二", "一"],
      folders: ["客户/素材"],
      rating: 5,
      note: "备注",
      link: "https://example.com",
    });
    const withoutOrganize = structuredClone(after);
    delete withoutOrganize.media[0]!.organize;
    expect(withoutRevision(withoutOrganize)).toBe(withoutRevision(before));
    await validateAndUndo(before);
    const restored = await read();
    restored.revision = before.revision;
    expect(serializeProject(restored)).toBe(serializeProject(before));
  });

  it("replaces supplied organize fields and keeps unspecified fields", async () => {
    await edit([{ op: "update_media", media_id: "med_A", tags: ["old"], note: "keep" }]);
    expect((await edit([{ op: "update_media", media_id: "med_A", tags: [] }])).status).toBe("applied");
    expect((await read()).media[0]!.organize).toEqual({ tags: [], note: "keep" });
    for (const fields of [{ path: "other" }, { rating: -1 }, { rating: 6 }, { rating: 0.5 }, {}])
      expect((await edit([{ op: "update_media", media_id: "med_A", ...fields }])).error?.code).toBe("E_VALIDATION");
  });

  it("names tracks after the highest existing same-kind name, including Z to AA", async () => {
    expect(
      (
        await edit([
          { op: "rename_track", track_id: "trk_v1", name: "视频 Z" },
          { op: "add_track", id: "trk_new", kind: "video" },
          { op: "add_track", kind: "video" },
        ])
      ).status,
    ).toBe("applied");
    expect((await read()).timelines[0]!.tracks.slice(-2).map((track) => track.name)).toEqual(["视频 AA", "视频 AB"]);
    expect(
      (
        await edit([
          {
            op: "add_subtitle_track",
            id: "trk_sub_new",
            language: "zh",
            carrier_tracks: ["trk_a1"],
            default_style_id: "sty_zh",
          },
        ])
      ).status,
    ).toBe("applied");
    expect((await read()).timelines[0]!.tracks.at(-1)!.name).toBe("字幕 A");
  });

  it("assigns rename_track to its target domain and rejects mixed batches atomically", async () => {
    const subtitle = (await read()).timelines[0]!.tracks.find((track) => track.kind === "subtitle")!;
    expect(
      (
        await edit([
          { op: "rename_track", track_id: subtitle.id, name: "字幕 Z" },
          {
            op: "add_subtitle_track",
            id: "trk_sub_new",
            language: "zh",
            carrier_tracks: ["trk_a1"],
            default_style_id: subtitle.kind === "subtitle" ? subtitle.default_style_id : "",
          },
          { op: "rename_track", track_id: "trk_sub_new", name: "新字幕" },
        ])
      ).status,
    ).toBe("applied");
    const bytes = await readFile(path, "utf8");
    expect(
      (
        await edit([
          { op: "rename_track", track_id: subtitle.id, name: "混合" },
          { op: "update_media", media_id: "med_A", note: "no" },
        ])
      ).error?.code,
    ).toBe("E_MIXED_DOMAIN");
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await edit([{ op: "rename_track", track_id: "trk_missing", name: "no" }])).error?.code).toBe("E_NOT_FOUND");
  });

  it("round trips chapter levels, updates them, and rejects levels on other markers at L1", async () => {
    expect(
      (
        await edit([
          { op: "add_marker", id: "mrk_level", at: "0s", duration: "0s", kind: "chapter", text: "章", level: 1 },
        ])
      ).status,
    ).toBe("applied");
    expect((await edit([{ op: "update_marker", marker_id: "mrk_level", level: 2 }])).status).toBe("applied");
    expect((await read()).timelines[0]!.markers.find((marker) => marker.id === "mrk_level")?.level).toBe(2);
    for (const kind of ["note", "todo", "review"]) {
      const result = await edit([{ op: "add_marker", at: "0s", duration: "0s", kind, text: "bad", level: 1 }]);
      expect(result.error?.code).toBe("E_VALIDATION");
      expect(result.verification).toMatchObject({
        level: "L1",
        passed: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: "E_VALIDATION" })]),
      });
    }
    expect((await edit([{ op: "update_marker", marker_id: "mrk_level", kind: "note" }])).error?.code).toBe(
      "E_VALIDATION",
    );
  });
});

it("normalizes recognition settings in the subtitle domain and supports undo", async () => {
  await copyFile(new URL("../../../fixtures/regressions/recognition-undo.zcut.json", import.meta.url), path);
  const before = await read();
  const output = await edit([
    {
      op: "set_recognition",
      language: "zh",
      reference_text: "  原样  ",
      terms: [" 飞书 ", "", "飞书", " 豆包 "],
      remove_fillers: true,
    },
  ]);
  expect(output.status).toBe("applied");
  expect((await read()).recognition).toEqual({
    language: "zh",
    reference_text: "  原样  ",
    terms: ["飞书", "豆包"],
    remove_fillers: true,
  });
  expect((await edit([{ op: "set_recognition", terms: ["飞书", "豆包"] }])).status).toBe("no_op");
  expect(
    (
      await edit([
        { op: "set_recognition", language: "en" },
        { op: "rename_track", track_id: "trk_v1", name: "X" },
      ])
    ).error?.code,
  ).toBe("E_MIXED_DOMAIN");
  await validateAndUndo(before);
});

async function replacementFixture() {
  const value = await read();
  const item = value.transcripts[0]!;
  for (const cue of item.cues) {
    cue.state = "auto";
    delete cue.timing;
    delete cue.breaks;
  }
  for (const token of item.tokens) token.state = "auto";
  const cue = item.cues[0]!;
  const first = item.tokens.findIndex((token) => token.id === cue.first_token);
  item.tokens[first]!.text = "飞 ";
  item.tokens[first + 1]!.text = "";
  item.tokens[first + 1]!.heard = "嗯";
  item.tokens[first + 2]!.text = "书";
  cue.last_token = item.tokens[first + 2]!.id;
  const locked = item.cues[1]!;
  locked.timing = { locked: true };
  const lockedFirst = item.tokens.findIndex((token) => token.id === locked.first_token);
  item.tokens[lockedFirst]!.text = "飞 书";
  await writeFile(path, serializeProject(value));
  return { item, cue, locked, first };
}

it("replaces across visible and hidden tokens, preserves heard, skips locks and undoes", async () => {
  const { cue, locked, first } = await replacementFixture();
  const before = await read();
  const output = await edit([{ op: "replace_text", find: "飞 书", replace: "飞书" }]);
  expect(output.status, JSON.stringify(output)).toBe("applied");
  expect(output.result?.warnings).toEqual([{ code: "W_REPLACE_SKIPPED_LOCKED", cue_ids: [locked.id] }]);
  const item = (await read()).transcripts[0]!;
  expect(item.tokens[first]).toMatchObject({ text: "飞书", heard: "飞 嗯书", state: "edited" });
  expect(item.cues.find((entry) => entry.id === cue.id)).toMatchObject({
    first_token: item.tokens[first]!.id,
    last_token: item.tokens[first]!.id,
  });
  expect((await edit([{ op: "replace_text", find: "不存在", replace: "" }])).status).toBe("no_op");
  expect((await edit([{ op: "replace_text", find: "飞 书", replace: "飞书", force: true }])).error?.code).toBe(
    "E_SESSION_STATE",
  );
  await validateAndUndo(before);
});

it("handles non-overlapping repeated matches, partial tokens, empty replacement and filters", async () => {
  const { item, cue, first } = await replacementFixture();
  const value = await read();
  value.transcripts[0]!.tokens[first]!.text = "aAaA尾";
  await writeFile(path, serializeProject(value));
  expect(
    (await edit([{ op: "replace_text", find: "aa", replace: "X", match_case: true, cue_ids: [cue.id] }])).status,
  ).toBe("no_op");
  expect(
    (await edit([{ op: "replace_text", find: "aa", replace: "B", transcript_ids: [item.id], cue_ids: [cue.id] }]))
      .status,
  ).toBe("applied");
  expect((await read()).transcripts[0]!.tokens[first]!.text).toBe("BB");
  const result = await edit([{ op: "replace_text", find: "BB", replace: "", cue_ids: [cue.id] }]);
  expect(result.status, JSON.stringify(result)).toBe("applied");
  expect((await read()).transcripts[0]!.tokens[first]).toMatchObject({ text: "", state: "edited", heard: "aAaA尾" });
  expect((await edit([{ op: "replace_text", find: "尾", replace: "X", transcript_ids: [] }])).status).toBe("no_op");
  expect((await edit([{ op: "replace_text", find: "尾", replace: "X", cue_ids: ["cue_missing"] }])).error?.code).toBe(
    "E_NOT_FOUND",
  );
});

describe("move insert", () => {
  beforeEach(async () => {
    await copyFile(new URL("../../../fixtures/regressions/move-insert.zcut.json", import.meta.url), path);
  });
  const move = (to: string, extra = {}) => edit([{ op: "move", clip_ids: ["clp_v2"], to, mode: "insert", ...extra }]);
  const starts = async () =>
    clips(await read(), "trk_v1").map((clip) => [clip.id, printRational(clip.timeline_start, true)]);

  it("swaps the second and third linked groups in one revision, shifts metadata and restores bytes on undo", async () => {
    const before = await read();
    const result = await move("6s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(await starts()).toEqual([
      ["clp_v1", "0s"],
      ["clp_v3", "2s"],
      ["clp_v2", "4s"],
    ]);
    const after = await read();
    expect(after.revision.seq).toBe(before.revision.seq + 1);
    expect(clips(after, "trk_a1").map((clip) => printRational(clip.timeline_start, true))).toEqual(["0s", "2s", "4s"]);
    expect(printRational(after.timelines[0]!.markers[0]!.at, true)).toBe("2s");
    expect(result.changes.filter((change) => change.id === "clp_v3")).toHaveLength(1);
    await validateAndUndo(before);
  });

  it("inserts before the first group and pushes all media tracks", async () => {
    const result = await move("0s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(await starts()).toEqual([
      ["clp_v2", "0s"],
      ["clp_v1", "2s"],
      ["clp_v3", "4s"],
    ]);
  });

  it.each(["2s", "3s", "4s"])(
    "treats a destination within the original interval as the original position: %s",
    async (to) => {
      const before = await read();
      const result = await move(to);
      expect(["applied", "no_op"]).toContain(result.status);
      expect(withoutRevision(await read())).toBe(withoutRevision(before));
    },
  );

  it("keeps the gap when a different track occupies the original interval", async () => {
    const project = await read();
    const audio = project.timelines[0]!.tracks.find((track) => track.id === "trk_a1")!;
    if (audio.kind === "subtitle") throw new Error("fixture");
    audio.clips[1]!.occurrence_id = "occ_other";
    await writeFile(path, serializeProject(project));
    const result = await move("6s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(await starts()).toEqual([
      ["clp_v1", "0s"],
      ["clp_v3", "4s"],
      ["clp_v2", "6s"],
    ]);
    expect(printRational(clips(await read(), "trk_a1")[1]!.timeline_start, true)).toBe("2s");
  });

  it("splits every crossing track with new IDs and source offsets, with reversible change records", async () => {
    const before = await read();
    const result = await move("5s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = await read();
    for (const id of ["trk_v1", "trk_a1"]) {
      const pieces = clips(after, id).filter((clip) => clip.occurrence_id === "occ_3");
      expect(
        pieces.map((clip) => [
          printRational(clip.timeline_start, true),
          printRational(clip.duration, true),
          printRational(clip.source_start, true),
        ]),
      ).toEqual([
        ["2s", "1s", "4s"],
        ["5s", "1s", "5s"],
      ]);
      expect(pieces[0]!.id).not.toBe(pieces[1]!.id);
      expect(result.changes.some((change) => change.id === pieces[1]!.id)).toBe(true);
    }
    await validateAndUndo(before);
  });

  it("rejects multiple occurrences atomically, including unlinked requests", async () => {
    const before = await readFile(path, "utf8");
    for (const linked of [true, false]) {
      const result = await move("0s", { clip_ids: ["clp_v1", "clp_v2"], linked });
      expect(result.error?.code).toBe("E_VALIDATION");
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("shifts and splits markers and independent subtitles across insertion, preserving metadata in the original interval", async () => {
    const project = await read();
    const standard = parseProject(await readFile(fixture, "utf8"));
    if (!standard.ok) throw new Error("fixture");
    project.subtitle_styles = standard.project.subtitle_styles;
    const subtitle = structuredClone(standard.project.timelines[0]!.tracks.find((track) => track.kind === "subtitle")!);
    if (subtitle.kind !== "subtitle") throw new Error("fixture");
    subtitle.overrides = [];
    subtitle.carrier_tracks = ["trk_a1"];
    subtitle.free_cues = [{ id: "cue_cross", timeline_start: rational(4n), duration: rational(2n), text: "Crossing" }];
    const timeline = project.timelines[0]!;
    timeline.tracks.push(subtitle);
    timeline.markers = [
      { id: "mrk_inside", at: rational(3n), duration: rational(0n), kind: "note", text: "Retained" },
      { id: "mrk_cross", at: rational(4n), duration: rational(2n), kind: "note", text: "Crossing" },
    ];
    await writeFile(path, serializeProject(project));
    const result = await move("5s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = await read();
    const track = after.timelines[0]!.tracks.find((item) => item.id === subtitle.id)!;
    if (track.kind !== "subtitle") throw new Error("fixture");
    expect(
      track.free_cues.map((cue) => [printRational(cue.timeline_start, true), printRational(cue.duration, true)]),
    ).toEqual([
      ["2s", "1s"],
      ["5s", "1s"],
    ]);
    expect(
      after.timelines[0]!.markers.map((marker) => [
        printRational(marker.at, true),
        printRational(marker.duration, true),
      ]),
    ).toEqual([
      ["2s", "1s"],
      ["5s", "0s"],
      ["5s", "1s"],
    ]);
    await validateAndUndo(project);
  });

  it("preserves rational frame boundaries at 30000/1001", async () => {
    const project = await read();
    const timeline = project.timelines[0]!;
    timeline.edit_rate = rational(30000n, 1001n);
    project.media[0]!.video!.rate = timeline.edit_rate;
    for (const track of timeline.tracks)
      if (track.kind !== "subtitle")
        for (const clip of track.clips) {
          clip.timeline_start = mul(clip.timeline_start, rational(1001n, 1000n));
          clip.duration = mul(clip.duration, rational(1001n, 1000n));
        }
    timeline.markers = [];
    await writeFile(path, serializeProject(project));
    const result = await move("1001/200s");
    expect(result.status, JSON.stringify(result)).toBe("applied");
    for (const clip of clips(await read(), "trk_v1")) {
      expect(mul(clip.timeline_start, timeline.edit_rate).denominator).toBe(1n);
      expect(mul(clip.duration, timeline.edit_rate).denominator).toBe(1n);
    }
  });
});

it("keeps projected subtitles attached and cleans separated transitions after insert move", async () => {
  const before = await read();
  const timeline = before.timelines[0]!;
  const moving = timeline.tracks
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .filter((clip) => clip.occurrence_id === "occ_2");
  const earliest = moving.reduce(
    (start, clip) => (compare(start, clip.timeline_start) < 0 ? start : clip.timeline_start),
    moving[0]!.timeline_start,
  );
  const cues = projectSubtitles(before, timeline.id).cues.filter((cue) => cue.occurrence_id === "occ_2");
  expect(cues.length).toBeGreaterThan(0);
  const result = await edit([{ op: "move", clip_ids: ["clp_v2"], to: "0s", mode: "insert" }]);
  expect(result.status, JSON.stringify(result)).toBe("applied");
  const after = await read();
  const projected = projectSubtitles(after, timeline.id).cues.filter((cue) => cue.occurrence_id === "occ_2");
  expect(projected.map((cue) => [cue.text, printRational(cue.start, true), printRational(cue.end, true)])).toEqual(
    cues.map((cue) => [
      cue.text,
      printRational(sub(cue.start, earliest), true),
      printRational(sub(cue.end, earliest), true),
    ]),
  );
  expect(
    after.timelines[0]!.tracks.flatMap((track) => (track.kind === "subtitle" ? [] : track.transitions)).some(
      (transition) => transition.id === "trn_1",
    ),
  ).toBe(false);
  expect(result.changes.some((change) => change.id === "trn_1" && change.op === "move")).toBe(true);
  await validateAndUndo(before);
});

describe("semantic subtitle resegment", () => {
  beforeEach(async () => {
    await copyFile(new URL("../../../fixtures/regressions/subtitle-cut-after.zcut.json", import.meta.url), path);
  });
  const resegment = (fields: Record<string, unknown> = {}) =>
    edit([{ op: "resegment", transcript_id: "trs_semantic", ...fields }]);
  const texts = (item: Project["transcripts"][number]) =>
    item.cues.map((cue) =>
      item.tokens
        .slice(
          item.tokens.findIndex((token) => token.id === cue.first_token),
          item.tokens.findIndex((token) => token.id === cue.last_token) + 1,
        )
        .map((token) => token.text)
        .join(""),
    );

  it("preserves noun and number boundaries from cut_after", async () => {
    await copyFile(
      new URL("../../../fixtures/regressions/subtitle-term-number-boundary.zcut.json", import.meta.url),
      path,
    );
    const result = await resegment({ cut_after: ["tok_boundary_2", "tok_boundary_7"] });
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect((await read()).transcripts[0]!.cues.slice(0, 2).map((cue) => cue.last_token)).toEqual([
      "tok_boundary_2",
      "tok_boundary_7",
    ]);
  });

  it("§10.1 ignores punctuation and hard pauses with cut_after", async () => {
    const value = await read();
    const item = value.transcripts[0]!;
    item.tokens[0]!.text += "。";
    for (const token of item.tokens.slice(4)) {
      token.align.start = add(token.align.start, rational(7n, 10n));
      token.align.end = add(token.align.end, rational(7n, 10n));
    }
    await writeFile(path, serializeProject(value));
    expect((await resegment({ cut_after: [], rules: { cpl: 100, max_duration: "20s" } })).status).toBe("applied");
    expect(texts((await read()).transcripts[0]!)).toEqual([
      "所有。的点位加起来可能有两万多个很多的脏活全部让豆包工作去做了是你要真正去使用之后你才能够去感受到",
    ]);
  });

  it("§10.2 cuts at listed visible tokens and ignores hidden, unknown and out-of-range IDs", async () => {
    const before = await read();
    const item = before.transcripts[0]!;
    const result = await edit([
      { op: "hide_tokens", transcript_id: item.id, tokens: [item.tokens[2]!.id] },
      {
        op: "resegment",
        transcript_id: item.id,
        range: { from_token: item.tokens[1]!.id, to_token: item.tokens[7]!.id },
        cut_after: [item.tokens[0]!.id, item.tokens[2]!.id, item.tokens[4]!.id, item.tokens[8]!.id, "tok_unknown"],
      },
    ]);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const after = (await read()).transcripts[0]!;
    expect(texts(after)).toEqual([
      "所有",
      "的加起来",
      "可能有两万多个",
      "很多的脏活全部让豆包工作去做了是你要真正去使用之后你才能够去感受到",
    ]);
    expect(after.ext).toEqual(item.ext);
    await validateAndUndo(before);
  });

  it("§10.2 keeps oversized segments whole", async () => {
    const before = await read();
    const item = before.transcripts[0]!;
    expect((await resegment({ cut_after: [item.tokens[7]!.id, item.tokens[17]!.id] })).status).toBe("applied");
    expect(texts((await read()).transcripts[0]!)).toEqual([
      "所有的点位加起来可能有两万多个",
      "很多的脏活全部让豆包工作去做了",
      "是你要真正去使用之后你才能够去感受到",
    ]);
    // A wide budget isolates the duration limit, with no pause or punctuation to split on.
    expect((await resegment({ cut_after: [], rules: { cpl: 100, max_duration: "1s" } })).status).toBe("applied");
    const timed = (await read()).transcripts[0]!;
    expect(timed.cues).toHaveLength(1);
    expect((await dispatch("validate", { project: path })).verification.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "W_SUB_TOO_WIDE", ids: expect.arrayContaining([timed.cues[0]!.id]) }),
      ]),
    );
  });

  it("§10.4 never merges short AI segments and retains display extension and warnings", async () => {
    expect((await resegment({ cut_after: ["tok_mantic_2", "tok_mantic_3", "tok_mantic_t"] })).status).toBe("applied");
    const item = (await read()).transcripts[0]!;
    expect(texts(item).slice(0, 2)).toEqual(["所有的点位", "加"]);
    const ranges = displayRanges(item);
    expect(ranges[0]!.warnings).toContain("W_SUB_SHORT");
    expect(compare(ranges.at(-1)!.end, item.tokens.at(-1)!.align.end)).toBeGreaterThan(0);
  });

  it("§10.5 skips locked cues, approved cues and cues containing approved tokens, reusing matching IDs", async () => {
    const value = await read();
    const item = value.transcripts[0]!;
    item.cues = [0, 2, 4, 6].map((first, index) => ({
      id: `cue_mantic_${index}`,
      first_token: item.tokens[first]!.id,
      last_token: item.tokens[index === 3 ? item.tokens.length - 1 : first + 1]!.id,
      state: index === 1 ? "approved" : "auto",
      ...(index === 0 ? { timing: { locked: true } } : {}),
    }));
    item.tokens[4]!.state = "approved";
    await writeFile(path, serializeProject(value));
    expect((await resegment({ cut_after: item.tokens.map((token) => token.id) })).status).toBe("applied");
    const after = (await read()).transcripts[0]!;
    expect(after.cues.slice(0, 3)).toEqual(item.cues.slice(0, 3));
    expect(after.cues.slice(3)).toHaveLength(item.tokens.length - 6);
    expect((await resegment({ cut_after: item.tokens.map((token) => token.id) })).status).toBe("no_op");
    await validateAndUndo(value);
  });

  it("regresses unpunctuated Chinese rule-only boundaries and honors explicit AI boundaries", async () => {
    expect((await resegment()).status).toBe("applied");
    const item = (await read()).transcripts[0]!;
    for (const cue of item.cues.slice(0, -1))
      expect(["的", "是"]).not.toContain(item.tokens.find((token) => token.id === cue.last_token)!.text);
    for (const cue of item.cues.slice(1))
      expect(item.tokens.find((token) => token.id === cue.first_token)!.text).not.toBe("了");
    expect(texts(item).join("")).toBe(item.tokens.map((token) => token.text).join(""));
    expect((await resegment({ cut_after: ["tok_mantic_7", "tok_mantic_h", "tok_mantic_i"] })).status).toBe("applied");
    expect(texts((await read()).transcripts[0]!).slice(0, 3)).toEqual([
      "所有的点位加起来可能有两万多个",
      "很多的脏活全部让豆包工作去做了",
      "是",
    ]);
  });

  it("writes the requesting author, preserves other ext keys, replays idempotently and undoes the mark", async () => {
    const before = await read();
    const input = request([{ op: "resegment", transcript_id: "trs_semantic", cut_after: [] }], before.revision.id);
    const preview = await dispatch("edit", { ...input, dry_run: true });
    expect(preview.status).toBe("dry_run");
    expect(withoutRevision(await read())).toBe(withoutRevision(before));
    const result = await dispatch("edit", input);
    expect(result.status).toBe("applied");
    expect(result.changes).toEqual(preview.changes);
    expect((await read()).transcripts[0]!.ext).toEqual({
      ...before.transcripts[0]!.ext,
      "zsir.subtitle_pass": { by: author.name },
    });
    expect((await dispatch("edit", input)).receipt?.replayed).toBe(true);
    await validateAndUndo(before);
  });

  it.each([false, true])(
    "clears the mark for rule-only whole-transcript resegment (explicit range: %s)",
    async (explicitRange) => {
      await resegment({ cut_after: [] });
      const before = await read();
      const tokens = before.transcripts[0]!.tokens;
      expect(
        (await resegment(explicitRange ? { range: { from_token: tokens[0]!.id, to_token: tokens.at(-1)!.id } } : {}))
          .status,
      ).toBe("applied");
      expect((await read()).transcripts[0]!.ext).toEqual({
        zsir: { id_tag: "mantic" },
        "fixture.keep": { value: "untouched" },
      });
      await validateAndUndo(before);
    },
  );

  it("leaves the mark unchanged on partial operations and does not mark an explicit full-range AI pass", async () => {
    const item = (await read()).transcripts[0]!;
    const full = { from_token: item.tokens[0]!.id, to_token: item.tokens.at(-1)!.id };
    await resegment({ range: full, cut_after: [] });
    expect((await read()).transcripts[0]!.ext?.["zsir.subtitle_pass"]).toBeUndefined();
    await resegment({ cut_after: [] });
    for (const fields of [{}, { cut_after: [] }]) {
      await resegment({ range: { from_token: item.tokens[0]!.id, to_token: item.tokens[7]!.id }, ...fields });
      expect((await read()).transcripts[0]!.ext?.["zsir.subtitle_pass"]).toEqual({ by: author.name });
    }
  });

  it.each(
    [["tok_mantic_0", "tok_mantic_0"], ["cue_mantic_0"], ["tok_"], [123], null].map((cut_after) => ({ cut_after })),
  )("rejects invalid cut_after atomically: %j", async ({ cut_after }) => {
    const before = await readFile(path, "utf8");
    expect((await resegment({ cut_after })).error?.code).toBe("E_VALIDATION");
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
