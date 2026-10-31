// biome-ignore-all lint/style/noNonNullAssertion: Fixture setup guarantees indexed entities.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { directFiles, runDirectExport } from "../src/direct-export.ts";
import { dispatch, parseProject, rational, serializeProject, validateProjectSemantics } from "../src/index.ts";
import type { Project } from "../src/project/types.ts";

let dir: string, path: string, project: Project;
let serial = 0;
async function edit(ops: unknown[]) {
  const result = await dispatch("edit", {
    project: path,
    base_revision: project.revision.id,
    idempotency_key: `style-${serial++}`,
    author: { kind: "human", name: "test" },
    label: "修改字幕样式",
    ops,
  });
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  project = parsed.project;
  return result;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcut-style-"));
  path = join(dir, "test.zcut.json");
  const source = await readFile(
    new URL("../../../fixtures/regressions/subtitle-overlay-boundaries.zcut.json", import.meta.url),
    "utf8",
  );
  const parsed = parseProject(source);
  if (!parsed.ok) throw new Error("fixture");
  project = parsed.project;
  await writeFile(path, source);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const fields = {
  italic: true,
  underline: true,
  letter_spacing: -0.2,
  align: "left",
  outlines: [
    { color: "#12345678", width: 0.1 },
    { color: "#ABCDEF", width: 0.2 },
    { color: "#000000", width: 0 },
  ],
  shadow: { color: "#00000080", blur: 0.2, distance: 0.3, angle: 359 },
  glow: { color: "#FFFFFF", blur: 0.1 },
  highlight: { color: "#FF0000" },
  animation: { in: { type: "rise", duration: "2/4s" }, out: { type: "sink", duration: "1/4s" }, word: "jump" },
};
it("accepts all new fields through add/update, normalizes exact durations, clears optionals, and undoes atomically", async () => {
  const added = await edit([
    { op: "add_style", id: "sty_new", name: "New", font_family: "Arial", font_size: 0.05, color: "#FFFFFF", ...fields },
  ]);
  expect(added.status, JSON.stringify(added)).toBe("applied");
  const style = () => project.subtitle_styles.find((style) => style.id === "sty_new")!;
  expect(style().animation?.in?.duration).toEqual(rational(1n, 2n));
  expect(style().outlines).toEqual(fields.outlines);
  const initial = serializeProject(project);
  expect(
    (
      await edit([
        { op: "update_style", style_id: "sty_new", ...fields, letter_spacing: 1, animation: { word: "fill" } },
      ])
    ).status,
  ).toBe("applied");
  expect(style()).toMatchObject({
    italic: true,
    underline: true,
    letter_spacing: 1,
    animation: { word: "fill" },
    version: 2,
  });
  const cleared = Object.fromEntries(Object.keys(fields).map((key) => [key, null]));
  expect((await edit([{ op: "update_style", style_id: "sty_new", ...cleared }])).status).toBe("applied");
  for (const key of Object.keys(fields)) expect(style()).not.toHaveProperty(key);
  const undone = await dispatch("undo", {
    project: path,
    base_revision: project.revision.id,
    idempotency_key: "undo-style",
    author: { kind: "human", name: "test" },
  });
  expect(undone.status, JSON.stringify(undone)).toBe("applied");
  expect(parseProject(initial).ok).toBe(true);
});
it.each(["highlight", "fill", "jump"])(
  "rejects %s without highlight at L1 and does not publish a revision",
  async (word) => {
    const before = await readFile(path, "utf8");
    const result = await edit([{ op: "update_style", style_id: project.subtitle_styles[0]!.id, animation: { word } }]);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("E_VALIDATION");
    expect(result.verification.level).toBe("L1");
    expect(await readFile(path, "utf8")).toBe(before);
    project.subtitle_styles[0]!.animation = { word: word as "jump" };
    expect(validateProjectSemantics(project)).toContainEqual(
      expect.objectContaining({ code: "E_VALIDATION", ids: [project.subtitle_styles[0]!.id] }),
    );
  },
);
it.each([
  { italic: "yes" },
  { underline: 1 },
  { letter_spacing: -0.21 },
  { letter_spacing: 1.01 },
  { align: "justify" },
  { outlines: [] },
  { outlines: Array(4).fill({ color: "#FFFFFF", width: 0.1 }) },
  { outlines: [{ color: "red", width: 0.1 }] },
  { shadow: { color: "#000000", blur: -1, distance: 1, angle: 0 } },
  { shadow: { color: "#000000", blur: 0, distance: 0, angle: 360 } },
  { glow: { color: "#FFFFFF", blur: -1 } },
  { animation: { in: { type: "sink", duration: "1s" } } },
  { animation: { out: { type: "rise", duration: "1s" } } },
  { animation: { in: { type: "fade", duration: "0s" } } },
])("validates malformed fields at the command boundary: %j", async (patch) => {
  const before = serializeProject(project);
  expect((await edit([{ op: "update_style", style_id: project.subtitle_styles[0]!.id, ...patch }])).status).toBe(
    "rejected",
  );
  expect(serializeProject(project)).toBe(before);
});
it("copies a selected free cue style without replacing cue text, exact timing or extension data", async () => {
  const track = project.timelines[0]!.tracks.find((track) => track.kind === "subtitle")!;
  if (track.kind !== "subtitle") throw new Error("track");
  track.free_cues[0]!.ext = { "test.note": { keep: true } };
  await writeFile(path, serializeProject(project));
  const before = structuredClone(track.free_cues[0]!);
  const { id: _id, version: _version, ...style } = project.subtitle_styles[0]!;
  expect(
    (
      await edit([
        { op: "add_style", ...style, id: "sty_copy", italic: true },
        { op: "set_cue", cue_id: before.id, style_id: "sty_copy" },
      ])
    ).status,
  ).toBe("applied");
  const after = project.timelines[0]!.tracks.find((track) => track.kind === "subtitle")!;
  if (after.kind !== "subtitle") throw new Error("track");
  expect(after.free_cues[0]).toEqual({ ...before, style_id: "sty_copy" });
});
it("reports each new style field once for direct SRT", async () => {
  const style = project.subtitle_styles[0]!;
  Object.assign(style, { italic: true, underline: true, highlight: { color: "#FF0000" }, animation: { word: "jump" } });
  const timeline = project.timelines[0]!;
  const result = await runDirectExport(
    project,
    timeline,
    path,
    join(dir, "out"),
    "direct-srt",
    directFiles(project, timeline, "direct-srt"),
  );
  expect(result.losses).toHaveLength(1);
  expect(result.losses?.[0]).toMatchObject({ entity_id: style.id, reason_code: "R_STYLE_NOT_REPRESENTABLE" });
  for (const key of ["italic", "underline", "highlight", "animation"])
    expect(result.losses?.[0]?.consequence).toContain(key);
  await writeFile(path, serializeProject(project));
  const dry = await dispatch("export", {
    project: path,
    base_revision: project.revision.id,
    idempotency_key: "style-dry-srt",
    author: { kind: "human", name: "test" },
    profile: "direct-srt",
    dry_run: true,
    output: join(dir, "dry"),
  });
  expect(dry.status).toBe("dry_run");
  expect((dry.result as { losses: unknown[] }).losses).toEqual(result.losses);
});
