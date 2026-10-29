import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const preferences = z.partialRecord(
  z.enum(["fcp", "resolve", "premiere", "direct"]),
  z.string().min(1).refine(isAbsolute),
);
export async function exportPreferences(project: string, projectId: string, value?: unknown) {
  const path = join(dirname(resolve(project)), ".zcut", projectId, "export-preferences.json");
  if (value !== undefined) {
    const parsed = preferences.parse(value);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`);
    await rename(temporary, path);
    return parsed;
  }
  try {
    return preferences.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
