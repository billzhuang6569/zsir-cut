import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dispatch } from "../../core/src/index.ts";
import { validateProject } from "../../core/src/schema.ts";
import { presetGroups, presetPatch, subtitlePresets } from "../src/subtitle-presets.ts";

it("ships distinct, schema-valid macOS presets in all five groups", () => {
  expect(subtitlePresets.length).toBeGreaterThanOrEqual(12);
  expect(new Set(subtitlePresets.map((preset) => preset.name)).size).toBe(subtitlePresets.length);
  expect(presetGroups).toEqual(["基础", "综艺", "访谈", "逐字", "动画"]);
  expect(new Set(subtitlePresets.map((preset) => preset.group))).toEqual(new Set(presetGroups));
  const fixture = JSON.parse(readFileSync("fixtures/projects/std-25.zcut.json", "utf8"));
  for (const preset of subtitlePresets) {
    expect(["PingFang SC", "Songti SC"]).toContain(preset.fields.font_family);
    fixture.subtitle_styles = [
      {
        ...fixture.subtitle_styles[0],
        ...presetPatch(preset),
        id: "sty_default",
        name: preset.name,
        version: 1,
      },
    ];
    expect(validateProject(JSON.parse(JSON.stringify(fixture))), preset.name).toEqual({ valid: true, errors: [] });
  }
});

it("persists a preset in one undoable core edit with its history label and original placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-preset-"));
  const path = join(directory, "preset.zcut.json");
  try {
    const fixture = JSON.parse(readFileSync("fixtures/projects/std-25.zcut.json", "utf8"));
    const original = fixture.subtitle_styles[0];
    original.italic = true;
    original.glow = { color: "#FF0000", blur: 0.2 };
    await writeFile(path, JSON.stringify(fixture));
    const preset = subtitlePresets.find((preset) => preset.name === "白底黑字");
    if (!preset) throw new Error("preset");
    const fields = Object.fromEntries(Object.entries(presetPatch(preset)).map(([key, value]) => [key, value ?? null]));
    const edit = await dispatch("edit", {
      project: path,
      base_revision: fixture.revision.id,
      idempotency_key: "preset-test",
      author: { kind: "human", name: "test" },
      label: `套用样式：${preset.name}`,
      ops: [{ op: "update_style", style_id: original.id, ...fields }],
    });
    expect(edit.status, JSON.stringify(edit)).toBe("applied");
    const after = JSON.parse(await readFile(path, "utf8"));
    const style = after.subtitle_styles[0];
    for (const key of ["id", "name", "position", "max_lines"]) expect(style[key]).toEqual(original[key]);
    // update_style owns version increments; presets never supply a version.
    expect(style.version).toBe(original.version + 1);
    expect(style).not.toHaveProperty("italic");
    expect(style).not.toHaveProperty("glow");
    expect(style.box).toEqual(preset.fields.box);
    const history = await dispatch("inspect", { project: path, view: "history" });
    expect(history.result?.entries).toMatchObject([{ label: "套用样式：白底黑字" }]);
    const undo = await dispatch("undo", {
      project: path,
      base_revision: after.revision.id,
      idempotency_key: "undo-preset",
      author: { kind: "human", name: "test" },
    });
    expect(undo.status).toBe("applied");
    expect(JSON.parse(await readFile(path, "utf8")).subtitle_styles[0]).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
