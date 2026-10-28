// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by schema or test setup.
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fingerprint } from "../fingerprint.ts";
import type { ValidationIssue } from "./semantics.ts";
import type { Media, Project } from "./types.ts";

const fullPath = (projectDir: string, path: string) => resolve(projectDir, path);
const sameFingerprint = (a: Media["fingerprint"], b: Media["fingerprint"]) => a.algo === b.algo && a.value === b.value;

async function matches(
  path: string,
  size: number | undefined,
  expected: Media["fingerprint"],
): Promise<"missing" | "mismatch" | "match"> {
  let actualSize: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return "missing";
    actualSize = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (size !== undefined && actualSize !== size) return "mismatch";
  return sameFingerprint(await fingerprint(path), expected) ? "match" : "mismatch";
}

export async function validateProjectMedia(project: Project, projectDir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const media of project.media) {
    const status = await matches(fullPath(projectDir, media.path), media.size_bytes, media.fingerprint);
    if (status !== "match")
      issues.push({
        code: status === "missing" ? "E_MEDIA_MISSING" : "E_MEDIA_MISMATCH",
        severity: "error",
        message: `Media ${status}: ${media.path}`,
        ids: [media.id],
      });
    if (
      media.proxy &&
      (await matches(fullPath(projectDir, media.proxy.path), media.proxy.size_bytes, media.proxy.fingerprint)) !==
        "match"
    )
      issues.push({
        code: "W_PROXY_MISSING",
        severity: "warning",
        message: `Proxy missing or mismatched: ${media.proxy.path}`,
        ids: [media.id],
      });
  }
  return issues;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

export interface RelinkResult {
  project: Project;
  relinked: { media_id: string; old_path: string; new_path: string; other_candidates: string[] }[];
  not_found: { media_id: string }[];
  skipped: { media_id: string }[];
}

export async function relinkMedia(
  project: Project,
  projectDir: string,
  searchRoots: string[],
  mediaIds?: string[],
): Promise<RelinkResult> {
  const selected = mediaIds ? new Set(mediaIds) : null;
  const result: RelinkResult = {
    project: { ...project, media: [...project.media] },
    relinked: [],
    not_found: [],
    skipped: [],
  };
  let candidates: string[] | undefined;
  for (const [index, media] of project.media.entries()) {
    if (selected && !selected.has(media.id)) continue;
    if ((await matches(fullPath(projectDir, media.path), media.size_bytes, media.fingerprint)) === "match") {
      result.skipped.push({ media_id: media.id });
      continue;
    }
    candidates ??= (await Promise.all(searchRoots.map((root) => filesUnder(resolve(projectDir, root)))))
      .flat()
      .filter((path, position, all) => all.indexOf(path) === position)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const found: string[] = [];
    for (const path of candidates) {
      if ((await stat(path)).size !== media.size_bytes) continue;
      if (sameFingerprint(await fingerprint(path), media.fingerprint)) found.push(path);
    }
    if (!found.length) {
      result.not_found.push({ media_id: media.id });
      continue;
    }
    const asProjectPath = (path: string) => relative(projectDir, path).split("\\").join("/");
    const newPath = asProjectPath(found[0]!);
    result.project.media[index] = { ...media, path: newPath };
    result.relinked.push({
      media_id: media.id,
      old_path: media.path,
      new_path: newPath,
      other_candidates: found.slice(1).map(asProjectPath),
    });
  }
  return result;
}
