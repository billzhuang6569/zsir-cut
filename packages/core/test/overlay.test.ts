// biome-ignore-all lint/style/noNonNullAssertion: Fixture setup guards indexed entries.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dispatch, parseProject, serializeProject, validateProjectSemantics } from "../src/index.ts";
import type { Project } from "../src/project/types.ts";

let dir: string, path: string, project: Project;
let serial = 0;
const op = () => ({
  op: "add_overlay",
  name: "中文",
  timeline_id: "tl_std",
  subtitle_track_id: "trk_sub_zh",
  output_path: join(dir, "sub.mov"),
});
async function edit(ops: unknown[]) {
  const result = await dispatch("edit", {
    project: path,
    base_revision: project.revision.id,
    idempotency_key: `edit-${serial++}`,
    author: { kind: "human", name: "test" },
    ops,
  });
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  project = parsed.project;
  return result;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcut-overlay-edit-"));
  path = join(dir, "test.zcut.json");
  const source = await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8");
  const parsed = parseProject(source);
  if (!parsed.ok) throw new Error("Bad fixture");
  project = parsed.project;
  await writeFile(path, source);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("adds, updates and removes overlays through revisions, preserving the exported file and undo", async () => {
  const added = await edit([op()]);
  expect(added.status, JSON.stringify(added)).toBe("applied");
  const overlay = project.subtitle_overlays![0]!;
  expect(overlay.id).toMatch(/^ovl_/);
  expect(overlay.last_export).toBeNull();
  expect(overlay.tail).toBeUndefined();
  const id = overlay.id;
  expect((await edit([{ op: "update_overlay", overlay_id: id, name: "new", tail: "600s" }])).status).toBe("applied");
  expect(project.subtitle_overlays![0]!.name).toBe("new");
  await writeFile(overlay.output_path, "keep");
  expect((await edit([{ op: "remove_overlay", overlay_id: id }])).status).toBe("applied");
  expect(project.subtitle_overlays).toEqual([]);
  const undone = await dispatch("undo", {
    project: path,
    base_revision: project.revision.id,
    idempotency_key: "undo",
    author: { kind: "human", name: "test" },
  });
  expect(undone.status, JSON.stringify(undone)).toBe("applied");
  const restored = parseProject(await readFile(path, "utf8"));
  expect(restored.ok && restored.project.subtitle_overlays?.[0]?.name).toBe("new");
  expect(await readFile(overlay.output_path, "utf8")).toBe("keep");
});
it("rejects invalid references, duplicate destinations, paths, tail, protected export metadata and mixed domains atomically", async () => {
  for (const change of [
    { timeline_id: "tl_missing" },
    { subtitle_track_id: "trk_v1" },
    { output_path: "relative.mov" },
    { output_path: join(dir, "sub.mp4") },
    { output_path: join(dir, "missing", "sub.mov") },
    { tail: "601s" },
    { tail: "-1s" },
    { last_export: null },
  ]) {
    const result = await edit([{ ...op(), ...change }]);
    expect(result.status, JSON.stringify(result)).toBe("rejected");
    expect(project.subtitle_overlays).toBeUndefined();
  }
  const duplicate = await edit([
    { ...op(), id: "ovl_first" },
    { ...op(), id: "ovl_second" },
  ]);
  expect(duplicate.status).toBe("rejected");
  const mixed = await edit([op(), { op: "add_marker", at: "0s", duration: "0s", text: "mixed", kind: "note" }]);
  expect(mixed.error?.code).toBe("E_MIXED_DOMAIN");
  const zeroTail = await edit([{ ...op(), tail: "0s" }]);
  expect(zeroTail.status, JSON.stringify(zeroTail)).toBe("applied");
});
it("round trips 0.3 styles and overlays and migrates 0.1 and 0.2 without changing other fields", async () => {
  for (const version of ["0.1", "0.2"]) {
    const current = serializeProject(project);
    const legacy = current.replace('"schema_version": "0.3"', `"schema_version": "${version}"`);
    const parsed = parseProject(legacy);
    expect(parsed.ok && serializeProject(parsed.project)).toBe(current);
  }
  await edit([{ ...op(), tail: "1/2s" }]);
  const style = project.subtitle_styles[0]!;
  const result = await edit([
    {
      op: "update_style",
      style_id: style.id,
      box: { color: "#12345678", radius: 0.3, padding: 0.4 },
      position: { anchor: "middle", margin_v: 0, offset_x: -0.2, max_width: 0.6 },
      line_spacing: 1.4,
    },
  ]);
  expect(result.status, JSON.stringify(result)).toBe("applied");
  expect(project.subtitle_styles[0]!.line_spacing).toBe(1.4);
  expect(validateProjectSemantics(project).filter((i) => i.severity === "error")).toEqual([]);
  project.subtitle_overlays![0]!.subtitle_track_id = "trk_v1";
  expect(validateProjectSemantics(project)).toContainEqual(
    expect.objectContaining({ code: "E_REF", severity: "error" }),
  );
});
