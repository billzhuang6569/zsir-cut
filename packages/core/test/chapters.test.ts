// biome-ignore-all lint/style/noNonNullAssertion: Fixture entities are required by setup.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, parseProject, rational, serializeProject, validateProjectSemantics } from "../src/index.ts";

let directory: string;
let project: string;
let counter: number;
const agent = { kind: "agent", name: "chapters-test" };
const human = { kind: "human", name: "editor" };
const read = async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid fixture");
  return parsed.project;
};
const edit = async (ops: Record<string, unknown>[], extra = {}) =>
  dispatch("edit", {
    project,
    base_revision: (await read()).revision.id,
    idempotency_key: `chapters-${++counter}`,
    author: agent,
    label: "Edit chapter",
    ops,
    ...extra,
  });
type Time = { t: string; tc: string };
type Row = {
  id: string | null;
  level: number;
  start: Time;
  end: Time;
  duration: Time;
  title: string | null;
  description: string | null;
  user_edited: boolean;
  hue: number;
  sections: Row[];
};
const chapters = async (extra = {}) => {
  const result = await dispatch("inspect", { project, view: "chapters", ...extra });
  expect(result.status, JSON.stringify(result)).toBe("no_op");
  return result.result as { chapters: Row[]; total: Time };
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-chapters-"));
  project = join(directory, "project.zcut.json");
  counter = 0;
  await copyFile("fixtures/regressions/chapter-level.zcut.json", project);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("chapters", () => {
  it("matches hand-computed 3 chapters, 7 sections and orphan group", async () => {
    const view = await chapters({ timeline_id: "tl_main" });
    expect(view.total).toEqual({ t: "10s", tc: "00:00:10:00" });
    expect(view.chapters.map((row) => [row.id, row.start.t, row.end.t, row.duration.t, row.hue])).toEqual([
      [null, "0s", "1s", "1s", 0],
      ["mrk_parent", "1s", "4s", "3s", 1],
      ["mrk_default", "4s", "7s", "3s", 2],
      ["mrk_third", "7s", "10s", "3s", 3],
    ]);
    expect(
      view.chapters.flatMap((row) =>
        row.sections.map((section) => [section.id, section.start.t, section.end.t, section.duration.t, section.hue]),
      ),
    ).toEqual([
      ["mrk_orphan", "0s", "1s", "1s", 0],
      ["mrk_child", "3/2s", "5/2s", "1s", 1],
      ["mrk_s2", "5/2s", "4s", "3/2s", 1],
      ["mrk_s3", "9/2s", "5s", "1/2s", 2],
      ["mrk_s4", "5s", "7s", "2s", 2],
      ["mrk_s5", "15/2s", "17/2s", "1s", 3],
      ["mrk_s6", "17/2s", "10s", "3/2s", 3],
    ]);
  });
  it("returns exact fields, sequence clocks, duration clocks, and inherited hue", async () => {
    const p = await read();
    p.timelines[0]!.start_timecode = "01:00:00:00";
    p.timelines[0]!.markers[1]!.ext = { "zsir.user_edited": true };
    await writeFile(project, serializeProject(p));
    const view = await chapters();
    expect(view.chapters[0]).toMatchObject({ id: null, title: null, level: 1, description: null, user_edited: false });
    expect(view.chapters[1]).toEqual({
      id: "mrk_parent",
      level: 1,
      title: "第一章",
      description: "起因 & 背景",
      user_edited: true,
      hue: 1,
      start: { t: "1s", tc: "01:00:01:00" },
      end: { t: "4s", tc: "01:00:04:00" },
      duration: { t: "3s", tc: "00:00:03:00" },
      sections: view.chapters[1]!.sections,
    });
    for (const row of view.chapters)
      for (const section of row.sections) {
        expect(section.hue).toBe(row.hue);
        expect(section.level).toBe(2);
        expect(section).not.toHaveProperty("sections");
      }
  });

  it("sorts equal timestamps by ID, keeps zero durations, and starts hue at zero without orphans", async () => {
    const p = await read();
    const timeline = p.timelines[0]!;
    timeline.markers = [
      { id: "mrk_c", kind: "chapter", text: "C", at: rational(2n), duration: rational(0n), level: 2 },
      { id: "mrk_b", kind: "chapter", text: "B", at: rational(2n), duration: rational(0n) },
      { id: "mrk_a", kind: "chapter", text: "A", at: rational(2n), duration: rational(0n) },
    ];
    await writeFile(project, serializeProject(p));
    const view = await chapters();
    expect(view.chapters.map((row) => [row.id, row.duration.t, row.hue])).toEqual([
      ["mrk_a", "0s", 0],
      ["mrk_b", "8s", 1],
    ]);
    expect(view.chapters[1]!.sections[0]).toMatchObject({ id: "mrk_c", description: null, user_edited: false, hue: 1 });
    timeline.markers = [];
    await writeFile(project, serializeProject(p));
    expect(await chapters()).toEqual({ chapters: [], total: { t: "10s", tc: "00:00:10:00" } });
    expect((await dispatch("inspect", { project, view: "chapters", timeline_id: "tl_missing" })).error).toMatchObject({
      code: "E_NOT_FOUND",
    });
  });

  it("uses the last audio/video out point, including disabled clips, excluding free subtitles and markers", async () => {
    const p = await read();
    const timeline = p.timelines[0]!;
    const audio = timeline.tracks[1]!;
    if (audio.kind === "subtitle") throw new Error("Missing audio");
    audio.enabled = false;
    audio.clips[0]!.duration = rational(12n);
    audio.clips[0]!.enabled = false;
    timeline.markers.push({ id: "mrk_far", kind: "note", text: "far", at: rational(99n), duration: rational(0n) });
    timeline.tracks.push({
      id: "trk_sub",
      kind: "subtitle",
      name: "字幕",
      enabled: true,
      language: "zh",
      carrier_tracks: ["trk_v1"],
      default_style_id: "sty_missing",
      overrides: [],
      free_cues: [{ id: "cue_far", text: "far", timeline_start: rational(90n), duration: rational(1n) }],
    });
    await writeFile(project, serializeProject(p));
    const view = await chapters();
    expect(view.total.t).toBe("12s");
    expect(view.chapters.at(-1)!.end.t).toBe("12s");
  });

  it("rejects description on every other kind at L1 and enforces 500 Unicode characters", async () => {
    for (const kind of ["note", "todo", "review"]) {
      const result = await edit([{ op: "add_marker", at: "0s", duration: "0s", text: "bad", kind, description: "" }]);
      expect(result.error?.code).toBe("E_VALIDATION");
      expect(result.verification).toMatchObject({ level: "L1", passed: false });
      const p = await read();
      const marker = p.timelines[0]!.markers[0]!;
      marker.kind = kind as "note";
      delete marker.level;
      expect(validateProjectSemantics(p)).toContainEqual(expect.objectContaining({ code: "E_VALIDATION" }));
    }
    expect((await edit([{ op: "update_marker", marker_id: "mrk_note", description: "bad" }])).error?.code).toBe(
      "E_VALIDATION",
    );
    expect((await edit([{ op: "update_marker", marker_id: "mrk_child", kind: "note" }])).error?.code).toBe(
      "E_VALIDATION",
    );
    expect(
      (await edit([{ op: "update_marker", marker_id: "mrk_default", description: "😀".repeat(500) }])).status,
    ).toBe("applied");
    expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_default")!.description).toBe(
      "😀".repeat(500),
    );
    expect(
      (await edit([{ op: "update_marker", marker_id: "mrk_default", description: "字".repeat(501) }])).error?.code,
    ).toBe("E_VALIDATION");
    expect(
      (
        await edit([
          { op: "add_marker", kind: "chapter", at: "0s", duration: "0s", text: "bad", description: "字".repeat(501) },
        ])
      ).error?.code,
    ).toBe("E_VALIDATION");
  });

  it("writes user_edited only for human chapter creation or actual title/description changes and preserves extensions", async () => {
    for (const author of [agent, human, { kind: "system", name: "system" }]) {
      const id = `mrk_${author.kind}`;
      expect(
        (
          await edit(
            [{ op: "add_marker", id, at: "0s", duration: "0s", kind: "chapter", text: "new", description: "desc" }],
            { author },
          )
        ).status,
      ).toBe("applied");
      expect((await read()).timelines[0]!.markers.find((m) => m.id === id)!.ext?.["zsir.user_edited"]).toBe(
        author.kind === "human" ? true : undefined,
      );
    }
    for (const fields of [{ at: "2s" }, { text: "第一节" }, { description: "问题 <起点>" }]) {
      await edit([{ op: "update_marker", marker_id: "mrk_child", ...fields }], { author: human });
      expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_child")!.ext).toBeUndefined();
    }
    for (const fields of [{ text: "agent title" }, { description: "agent description" }]) {
      await edit([{ op: "update_marker", marker_id: "mrk_child", ...fields }]);
      expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_child")!.ext).toBeUndefined();
    }
    const p = await read();
    p.timelines[0]!.markers.find((m) => m.id === "mrk_child")!.ext = { "other.keep": 42 };
    await writeFile(project, serializeProject(p));
    await edit([{ op: "update_marker", marker_id: "mrk_child", text: "human title" }], { author: human });
    expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_child")!.ext).toEqual({
      "other.keep": 42,
      "zsir.user_edited": true,
    });
    await edit([{ op: "update_marker", marker_id: "mrk_s2", description: "human description" }], { author: human });
    expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_s2")!.ext?.["zsir.user_edited"]).toBe(true);
    await edit([{ op: "update_marker", marker_id: "mrk_child", text: "agent again", description: "" }]);
    expect((await read()).timelines[0]!.markers.find((m) => m.id === "mrk_child")!.ext).toEqual({
      "other.keep": 42,
      "zsir.user_edited": true,
    });
    expect(
      (await edit([{ op: "update_marker", marker_id: "mrk_child", ext: { "zsir.user_edited": false } }])).error?.code,
    ).toBe("E_VALIDATION");
    expect(
      (
        await edit([
          {
            op: "add_marker",
            at: "0s",
            duration: "0s",
            kind: "chapter",
            text: "bad",
            ext: { "zsir.user_edited": true },
          },
        ])
      ).error?.code,
    ).toBe("E_VALIDATION");
  });

  it("reads chapters at a revision and in a session draft without changing the main project", async () => {
    const begun = await dispatch("session_begin", {
      project,
      base_revision: "rev_example_1",
      idempotency_key: "begin",
      author: agent,
      approval: "manual",
      intent: "Chapters",
    });
    const session_id = (begun.result as { session_id: string }).session_id;
    const changed = await edit(
      [{ op: "update_marker", marker_id: "mrk_child", text: "Draft title", description: "Draft description" }],
      { author: human, session_id },
    );
    expect(changed.status).toBe("drafted");
    const draft = await chapters({ session_id });
    expect(draft.chapters[1]!.sections[0]).toMatchObject({
      title: "Draft title",
      description: "Draft description",
      user_edited: true,
    });
    expect((await chapters()).chapters[1]!.sections[0]!.title).toBe("第一节");
    expect((await chapters({ session_id, at_revision: "rev_example_1" })).chapters[1]!.sections[0]!.title).toBe(
      "第一节",
    );
    const mainEdit = await edit([{ op: "update_marker", marker_id: "mrk_default", text: "Main title" }]);
    expect(mainEdit.status).toBe("applied");
    expect((await chapters({ at_revision: "rev_example_1" })).chapters[2]!.title).toBe("第二章");
    expect((await chapters()).chapters[2]!.title).toBe("Main title");
  });
});
