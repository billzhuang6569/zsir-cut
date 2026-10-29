import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RecentProjects } from "../src/recent.js";

it("keeps ten distinct recent paths in opening order and marks missing files without persisting content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcut315-recent-"));
  try {
    const recent = new RecentProjects(dir);
    expect(await recent.list()).toEqual([]);
    for (let index = 0; index < 12; index++) await recent.add(join(dir, `${index}.zcut.json`), `工程 ${index}`);
    await recent.add(join(dir, "5.zcut.json"), "再次打开");
    await writeFile(join(dir, "5.zcut.json"), "工程内容不得保存进最近列表");
    const rows = await recent.list();
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.path)).size).toBe(10);
    expect(rows[0]).toMatchObject({ name: "再次打开", exists: true });
    expect(rows[1]).toMatchObject({ name: "工程 11", exists: false });
    expect(rows.map((row) => row.openedAt)).toEqual(
      rows
        .map((row) => row.openedAt)
        .sort()
        .reverse(),
    );
    const stored = JSON.parse(await readFile(join(dir, "recent.json"), "utf8"));
    expect(Object.keys(stored[0]).sort()).toEqual(["name", "openedAt", "path"]);
    await recent.remove(rows[0]?.path ?? "");
    expect(await recent.list()).toHaveLength(9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
