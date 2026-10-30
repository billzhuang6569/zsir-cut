import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Project } from "./project/types.ts";

export interface LibraryTerm {
  text: string;
  state: "active" | "blocked";
  source: "auto" | "user";
  projects: string[];
  added_at: string;
}
export type TermOp = { op: "add" | "remove" | "block" | "unblock"; text: string };
export const termLibraryPath = () => join(homedir(), "Library/Application Support/zsir-cut/terms.json");
// Compare Unicode code points, including characters outside the BMP.
export function compareTermText(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return left.length - right.length;
}
const validText = (text: unknown): text is string =>
  typeof text === "string" && text === text.trim() && text.length > 0;

export async function readTermLibrary(): Promise<LibraryTerm[]> {
  let value: { schema?: string; version?: number; terms?: LibraryTerm[] };
  try {
    value = JSON.parse(await readFile(termLibraryPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (value?.schema !== "zsir-cut/terms" || value.version !== 1 || !Array.isArray(value.terms))
    throw new Error("Invalid terms library");
  const seen = new Set<string>();
  for (const term of value.terms) {
    if (
      !term ||
      !validText(term.text) ||
      seen.has(term.text) ||
      !["active", "blocked"].includes(term.state) ||
      !["auto", "user"].includes(term.source) ||
      !Array.isArray(term.projects) ||
      term.projects.length > 50 ||
      term.projects.some((id: unknown) => typeof id !== "string" || !id) ||
      new Set(term.projects).size !== term.projects.length ||
      typeof term.added_at !== "string" ||
      !Number.isFinite(Date.parse(term.added_at))
    )
      throw new Error("Invalid terms library entry");
    seen.add(term.text);
  }
  return value.terms
    .map((term: LibraryTerm) => ({
      text: term.text,
      state: term.state,
      source: term.source,
      projects: term.projects,
      added_at: term.added_at,
    }))
    .sort((a: LibraryTerm, b: LibraryTerm) => compareTermText(a.text, b.text));
}

async function updateLibrary<T>(update: (terms: LibraryTerm[]) => T): Promise<T> {
  const file = termLibraryPath();
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + 2000;
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      lock = await open(`${file}.lock`, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Terms library lock timed out after 2 seconds");
      await setTimeout(Math.min(25, deadline - Date.now()));
    }
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const terms = await readTermLibrary();
    const before = JSON.stringify(terms);
    const result = update(terms);
    terms.sort((a, b) => compareTermText(a.text, b.text));
    if (JSON.stringify(terms) !== before) {
      const handle = await open(temp, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ schema: "zsir-cut/terms", version: 1, terms }, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
    }
    return result;
  } finally {
    try {
      await rm(temp, { force: true });
    } finally {
      await lock.close();
      await rm(`${file}.lock`, { force: true });
    }
  }
}

export async function editTermLibrary(ops: TermOp[]) {
  const normalized = ops.map((op) => ({ ...op, text: op.text.trim() }));
  if (
    normalized.some(
      ({ op, text }) =>
        !validText(text) || Array.from(text).length > 64 || !["add", "remove", "block", "unblock"].includes(op),
    )
  )
    throw new TypeError("Invalid terms operation");
  return updateLibrary((terms) => {
    const changes: { op: string; entity: string; id: string; action: "created" | "updated" | "removed" }[] = [];
    for (const { op, text } of normalized) {
      const index = terms.findIndex((term) => term.text === text);
      const term = terms[index];
      if (op === "remove") {
        if (term) {
          terms.splice(index, 1);
          changes.push({ op, entity: "term", id: text, action: "removed" });
        }
      } else if (term) {
        const state = op === "block" ? "blocked" : "active";
        if (term.state !== state) {
          term.state = state;
          changes.push({ op, entity: "term", id: text, action: "updated" });
        }
      } else if (op !== "unblock") {
        terms.push({
          text,
          state: op === "block" ? "blocked" : "active",
          source: "user",
          projects: [],
          added_at: new Date().toISOString(),
        });
        changes.push({ op, entity: "term", id: text, action: "created" });
      }
    }
    return changes;
  });
}

export async function collectProjectTerms(before: Project, after: Project): Promise<void> {
  const added = (after.recognition?.terms ?? []).filter((term) => !before.recognition?.terms?.includes(term));
  const texts = after.transcripts.map((transcript) => transcript.tokens.map((token) => token.text).join(""));
  const eligible = added.filter((term) => texts.reduce((count, text) => count + text.split(term).length - 1, 0) >= 2);
  if (!eligible.length) return;
  await updateLibrary((terms) => {
    for (const text of eligible) {
      const term = terms.find((term) => term.text === text);
      if (term) {
        if (term.state === "active" && !term.projects.includes(after.id) && term.projects.length < 50)
          term.projects.push(after.id);
      } else {
        terms.push({ text, state: "active", source: "auto", projects: [after.id], added_at: new Date().toISOString() });
      }
    }
  });
}

export function mergeHotwords(project: string[], file: string[], library: LibraryTerm[]): string[] {
  const active = library
    .filter((term) => term.state === "active")
    .sort((a, b) => b.projects.length - a.projects.length || compareTermText(a.text, b.text));
  return [
    ...new Set([...project, ...file, ...active.map((term) => term.text)].map((text) => text.trim()).filter(Boolean)),
  ].slice(0, 300);
}
