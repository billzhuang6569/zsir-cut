import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { EditError } from "./edit.ts";
import { diffProjectEntities, type EntityChange, type EntitySnapshot, projectEntitySnapshots } from "./entities.ts";
import { newId } from "./id.ts";
import { parseProject, serializeProject } from "./io.ts";
import { type ValidationIssue, validateProjectSemantics } from "./semantics.ts";
import type { Author, Project } from "./types.ts";

export type WriteVerb = "edit" | "import_media" | "transcribe" | "undo" | "redo" | "session_approve";
export interface WriteRequest {
  base_revision: string;
  idempotency_key: string;
  author: Author;
  verb: WriteVerb;
  request_id: string;
  ops: unknown[];
  timeline_id?: string;
  target?: string;
}

export interface OpenProjectOptions {
  projectPath: string;
  clock?: () => Date;
  idGenerator?: () => string;
  lockWaitMs?: number;
  fault?: (point: "before_step_7" | "after_step_7") => void;
}

type EnvelopeStatus = "applied" | "dry_run" | "no_op" | "rejected" | "conflict" | "failed" | "committed_unverified";
type ErrorCode =
  | "E_CONFLICT"
  | "E_IDEMPOTENCY_MISMATCH"
  | "E_VALIDATION"
  | "E_UNDO_CONFLICT"
  | "E_UNSUPPORTED"
  | "E_NOT_FOUND"
  | "E_MIXED_DOMAIN"
  | "E_LOCKED"
  | "E_SESSION_STATE"
  | "E_IO"
  | "E_INTERNAL";
export interface WriteEnvelope {
  ok: boolean;
  status: EnvelopeStatus;
  verb: WriteVerb;
  request_id: string;
  receipt: { before: string; after: string | null; idempotency_key: string; replayed: boolean } | null;
  changes: {
    op: string;
    entity: string;
    id: string;
    action: "created" | "updated" | "removed";
    detail?: Record<string, unknown>;
  }[];
  verification: { level: "none" | "L0" | "L1"; passed: boolean; issues: ValidationIssue[] };
  result: Record<string, unknown> | null;
  error: { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } | null;
}

export interface JournalEntry {
  kind: "write" | "undo" | "redo" | "recovered";
  revision: string;
  parent: string | null;
  seq: number;
  at: string;
  author?: Author;
  verb?: WriteVerb;
  request_id?: string;
  idempotency_key?: string;
  ops?: unknown[];
  timeline_id?: string;
  changes?: EntityChange[];
  target?: string;
}

interface IdempotencyEntry {
  idempotency_key: string;
  request_hash: string;
  at: string;
  envelope: WriteEnvelope;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonLines = <T>(text: string): T[] =>
  text.trim()
    ? text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as T)
    : [];
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const schemaIssues = (errors: { instancePath: string; message?: string }[]): ValidationIssue[] =>
  errors.map((error) => ({
    code: "E_SCHEMA",
    severity: "error",
    message: `${error.instancePath || "/"}: ${error.message ?? "Invalid project"}`,
    ids: [],
  }));
const describeChange = (change: EntityChange, entityOps: Record<string, string>, verb: WriteVerb) => ({
  op: entityOps[change.key] ?? verb,
  entity: change.entity,
  id: change.key,
  action: (change.before === null ? "created" : change.after === null ? "removed" : "updated") as
    | "created"
    | "updated"
    | "removed",
  ...(change.entity === "clip" && change.before === null && typeof change.after?.occurrence_id === "string"
    ? {
        detail: {
          occurrence_id: change.after.occurrence_id,
          ...(entityOps[change.key] === "place"
            ? { source_start: change.after.source_start, duration: change.after.duration }
            : {}),
        },
      }
    : {}),
});

async function appendSynced(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLines<T>(path: string): Promise<T[]> {
  try {
    return jsonLines<T>(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const requestHash = (request: WriteRequest) => {
  const { request_id: _requestId, ...hashInput } = request;
  return createHash("sha256").update(canonical(hashInput)).digest("hex");
};

export async function findIdempotentWrite(
  projectPath: string,
  projectId: string,
  request: WriteRequest,
): Promise<WriteEnvelope | "mismatch" | null> {
  const records = await readLines<IdempotencyEntry>(
    join(dirname(projectPath), ".zcut", projectId, "idempotency.jsonl"),
  );
  const prior = records.findLast((record) => record.idempotency_key === request.idempotency_key);
  if (!prior) return null;
  if (prior.request_hash !== requestHash(request)) return "mismatch";
  return {
    ...prior.envelope,
    receipt: prior.envelope.receipt ? { ...prior.envelope.receipt, replayed: true } : null,
  };
}

function restoreEntities(project: Project, changes: EntityChange[], side: "before" | "after"): Project {
  const snapshots = projectEntitySnapshots(project);
  const group = (item: EntitySnapshot) => `${item.parent}\0${item.entity}`;
  const order = new Map<string, string[]>();
  for (const [key, item] of snapshots) {
    if (item.index === null) continue;
    const name = group(item);
    const keys = order.get(name) ?? [];
    keys.push(key);
    order.set(name, keys);
  }
  const insertions: { key: string; snapshot: EntitySnapshot }[] = [];
  for (const change of changes) {
    const previous = snapshots.get(change.key);
    if (previous && previous.index !== null) {
      const keys = order.get(group(previous));
      if (keys)
        order.set(
          group(previous),
          keys.filter((key) => key !== change.key),
        );
    }
    const value = change[side];
    if (value === null) snapshots.delete(change.key);
    else {
      const snapshot = {
        entity: change.entity,
        parent: change[`${side}_parent`],
        index: change[`${side}_index`],
        value,
      };
      snapshots.set(change.key, snapshot);
      if (snapshot.index !== null) insertions.push({ key: change.key, snapshot });
    }
  }
  for (const { key, snapshot } of insertions.sort((a, b) => (a.snapshot.index ?? 0) - (b.snapshot.index ?? 0))) {
    const name = group(snapshot);
    const keys = order.get(name) ?? [];
    keys.splice(snapshot.index ?? keys.length, 0, key);
    order.set(name, keys);
  }
  const root = {
    ...snapshots.get("project")?.value,
    revision: JSON.parse(serializeProject(project)).revision,
  } as Record<string, unknown>;
  const byParent = (parent: string, entity: EntitySnapshot["entity"]) => {
    const keys = order.get(`${parent}\0${entity}`);
    return keys
      ? keys.map((key) => ({ ...snapshots.get(key)?.value }))
      : [...snapshots.values()]
          .filter((item) => item.parent === parent && item.entity === entity)
          .map((item) => ({ ...item.value }));
  };
  root.media = byParent("project", "media");
  root.subtitle_styles = byParent("project", "style");
  root.transcripts = byParent("project", "transcript").map((transcript) => {
    const id = transcript.id as string;
    return { ...transcript, raw_runs: byParent(id, "run"), tokens: byParent(id, "token"), cues: byParent(id, "cue") };
  });
  root.timelines = byParent("project", "timeline").map((timeline) => {
    const id = timeline.id as string;
    const tracks = byParent(id, "track");
    return {
      ...timeline,
      tracks: tracks.map(({ index: _index, ...track }) => {
        const trackId = track.id as string;
        return track.kind === "subtitle"
          ? { ...track, overrides: byParent(trackId, "override"), free_cues: byParent(trackId, "free_cue") }
          : { ...track, clips: byParent(trackId, "clip"), transitions: byParent(trackId, "transition") };
      }),
      markers: byParent(id, "marker"),
    };
  });
  const parsed = parseProject(JSON.stringify(root));
  if (!parsed.ok) throw new Error("Restored project is invalid");
  return parsed.project;
}

export function openProject(options: OpenProjectOptions) {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => newId("rev_"));
  const lockWaitMs = options.lockWaitMs ?? 10_000;
  const projectPath = options.projectPath;

  async function write(
    request: WriteRequest,
    mutator: (project: Project) => void,
    kind: "write" | "undo" | "redo",
    target?: string,
    entityOps: Record<string, string> = {},
    result: Record<string, unknown> | null = null,
  ): Promise<WriteEnvelope> {
    const envelope = (status: EnvelopeStatus, before: string, after: string | null = null): WriteEnvelope => ({
      ok: status === "applied" || status === "dry_run" || status === "no_op",
      status,
      verb: request.verb,
      request_id: request.request_id,
      receipt: { before, after, idempotency_key: request.idempotency_key, replayed: false },
      changes: [],
      verification: { level: "none", passed: false, issues: [] },
      result: null,
      error: null,
    });
    const fail = (
      status: "rejected" | "conflict" | "failed",
      before: string,
      code: ErrorCode,
      message: string,
      details?: Record<string, unknown>,
      retryable = false,
    ) => {
      const output = envelope(status, before);
      output.error = { code, message, retryable, ...(details ? { details } : {}) };
      return output;
    };
    let before = request.base_revision;
    let lockPath = "";
    let locked = false;
    let committedRevision: string | null = null;
    try {
      const initial = parseProject(await readFile(projectPath, "utf8"));
      if (!initial.ok) throw new Error("Project file is invalid");
      const directory = join(dirname(projectPath), ".zcut", initial.project.id);
      await mkdir(directory, { recursive: true });
      lockPath = join(directory, "lock");
      const deadline = Date.now() + lockWaitMs;
      for (;;) {
        try {
          const handle = await open(lockPath, "wx");
          try {
            await handle.writeFile(
              JSON.stringify({
                pid: process.pid,
                hostname: hostname(),
                acquired_at: clock().toISOString(),
                request_id: request.request_id,
              }),
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
          locked = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; hostname?: string };
            if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid && owner.pid > 0) {
              let stale = false;
              try {
                process.kill(owner.pid, 0);
              } catch (check) {
                stale = (check as NodeJS.ErrnoException).code === "ESRCH";
              }
              if (stale) {
                await rm(lockPath, { force: true });
                await appendSynced(join(directory, "lock-events.jsonl"), {
                  at: clock().toISOString(),
                  event: "stale_lock",
                  owner,
                  taker: { pid: process.pid, hostname: hostname(), request_id: request.request_id },
                });
                continue;
              }
            }
          } catch (check) {
            if ((check as NodeJS.ErrnoException).code !== "ENOENT" && !(check instanceof SyntaxError)) throw check;
          }
          if (Date.now() >= deadline)
            return fail("failed", before, "E_IO", "Project lock is busy", { reason: "busy" }, true);
          await pause(Math.min(100, Math.max(1, deadline - Date.now())));
        }
      }
      const parsed = parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      const current = parsed.project;
      before = current.revision.id;
      const journalPath = join(directory, "journal.jsonl");
      const idempotencyPath = join(directory, "idempotency.jsonl");
      const journal = await readLines<JournalEntry>(journalPath);
      if (current.revision.seq > (journal.at(-1)?.seq ?? 1)) {
        const recovered: JournalEntry = {
          kind: "recovered",
          revision: before,
          parent: current.revision.parent,
          seq: current.revision.seq,
          at: current.revision.created_at,
        };
        await appendSynced(journalPath, recovered);
        journal.push(recovered);
      }
      const records = await readLines<IdempotencyEntry>(idempotencyPath);
      const hash = requestHash(request);
      const prior = records.findLast((record) => record.idempotency_key === request.idempotency_key);
      if (prior) {
        if (prior.request_hash !== hash)
          return fail("rejected", before, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another request");
        return {
          ...prior.envelope,
          receipt: prior.envelope.receipt ? { ...prior.envelope.receipt, replayed: true } : null,
        };
      }
      if (request.base_revision !== before) {
        const newer = journal.filter(
          (entry) => entry.seq > (journal.find((entry) => entry.revision === request.base_revision)?.seq ?? -1),
        );
        const changed_entity_keys = [
          ...new Set(newer.flatMap((entry) => entry.changes?.map((change) => change.key) ?? [])),
        ].sort();
        const output = fail("conflict", before, "E_CONFLICT", "Base revision differs from current revision");
        output.result = { current_revision: before, changed_entity_keys };
        return output;
      }
      const candidate = structuredClone(current);
      try {
        mutator(candidate);
      } catch (error) {
        if (error instanceof UndoConflict)
          return fail("rejected", before, "E_UNDO_CONFLICT", error.message, { keys: error.keys });
        if (error instanceof EditError) return fail("rejected", before, error.code, error.message);
        throw error;
      }
      let serialized: string;
      try {
        serialized = serializeProject(candidate);
      } catch (error) {
        const output = fail("rejected", before, "E_VALIDATION", "Project failed L0 validation");
        output.verification = {
          level: "L0",
          passed: false,
          issues: schemaIssues([{ instancePath: "", message: String(error) }]),
        };
        return output;
      }
      const check = parseProject(serialized);
      if (!check.ok) {
        const output = fail("rejected", before, "E_VALIDATION", "Project failed L0 validation");
        output.verification = { level: "L0", passed: false, issues: schemaIssues(check.errors) };
        return output;
      }
      const issues = validateProjectSemantics(check.project, check.issues);
      if (issues.some((issue) => issue.severity === "error")) {
        const output = fail("rejected", before, "E_VALIDATION", "Project failed L1 validation");
        output.verification = { level: "L1", passed: false, issues };
        return output;
      }
      const changes = diffProjectEntities(current, check.project);
      if (changes.length === 0) {
        const output = envelope("no_op", before);
        output.result = result;
        output.verification = { level: "L1", passed: true, issues };
        await appendSynced(idempotencyPath, {
          idempotency_key: request.idempotency_key,
          request_hash: hash,
          at: clock().toISOString(),
          envelope: output,
        });
        return output;
      }
      candidate.revision = {
        seq: current.revision.seq + 1,
        id: idGenerator(),
        parent: before,
        created_at: clock().toISOString(),
        author: request.author,
      };
      const bytes = serializeProject(candidate);
      const output = envelope("applied", before, candidate.revision.id);
      output.result = result;
      output.verification = { level: "L1", passed: true, issues };
      output.changes = changes.map((change) => describeChange(change, entityOps, request.verb));
      options.fault?.("before_step_7");
      const temp = join(dirname(projectPath), `.${initial.project.id}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, projectPath);
        committedRevision = candidate.revision.id;
        const dirHandle = await open(dirname(projectPath), "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } finally {
        await rm(temp, { force: true });
      }
      options.fault?.("after_step_7");
      const entry: JournalEntry = {
        kind,
        revision: candidate.revision.id,
        parent: before,
        seq: candidate.revision.seq,
        at: candidate.revision.created_at,
        author: request.author,
        verb: request.verb,
        request_id: request.request_id,
        idempotency_key: request.idempotency_key,
        ops: request.ops,
        ...(request.timeline_id ? { timeline_id: request.timeline_id } : {}),
        changes,
        ...(target ? { target } : {}),
      };
      await appendSynced(journalPath, entry);
      const now = clock().getTime();
      const retained = records.filter(
        (record, index) => index >= records.length - 999 || now - Date.parse(record.at) <= 7 * 24 * 60 * 60 * 1000,
      );
      const record = {
        idempotency_key: request.idempotency_key,
        request_hash: hash,
        at: clock().toISOString(),
        envelope: output,
      };
      await appendSynced(idempotencyPath, record);
      if (retained.length !== records.length) {
        const tempRecords = `${idempotencyPath}.${randomUUID()}.tmp`;
        try {
          const handle = await open(tempRecords, "wx");
          try {
            await handle.writeFile(`${[...retained, record].map((item) => JSON.stringify(item)).join("\n")}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tempRecords, idempotencyPath);
          const dirHandle = await open(directory, "r");
          try {
            await dirHandle.sync();
          } finally {
            await dirHandle.close();
          }
        } finally {
          await rm(tempRecords, { force: true });
        }
      }
      return output;
    } catch (error) {
      if (committedRevision) {
        const output = envelope("committed_unverified", before, committedRevision);
        output.error = { code: "E_IO", message: String(error), retryable: false };
        return output;
      }
      return fail(
        "failed",
        before,
        (error as NodeJS.ErrnoException).code ? "E_IO" : "E_INTERNAL",
        String(error),
        undefined,
        true,
      );
    } finally {
      if (locked) await rm(lockPath, { force: true });
    }
  }

  async function history(request: WriteRequest, direction: "undo" | "redo"): Promise<WriteEnvelope> {
    const parsed = parseProject(await readFile(projectPath, "utf8"));
    if (!parsed.ok) throw new Error("Project file is invalid");
    const path = join(dirname(projectPath), ".zcut", parsed.project.id, "journal.jsonl");
    const entries = await readLines<JournalEntry>(path);
    const undone = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "undo" && entry.target) undone.add(entry.target);
      if (entry.kind === "redo" && entry.target) undone.delete(entry.target);
    }
    const target =
      request.target ??
      (direction === "undo"
        ? entries.findLast((entry) => entry.kind === "write" && !undone.has(entry.revision))?.revision
        : entries.findLast((entry) => entry.kind === "undo" && entry.target && undone.has(entry.target))?.target);
    const targetEntry = entries.find((entry) => entry.revision === target);
    const mutator = (project: Project) => {
      if (
        !targetEntry ||
        targetEntry.kind !== "write" ||
        !targetEntry.changes ||
        (direction === "undo" ? undone.has(targetEntry.revision) : !undone.has(targetEntry.revision))
      )
        throw new UndoConflict(target ? [target] : [], "No undoable target revision");
      const current = projectEntitySnapshots(project);
      const side = direction === "undo" ? "after" : "before";
      const conflicts = targetEntry.changes
        .filter(
          (change) =>
            JSON.stringify(current.get(change.key)?.value ?? null) !== JSON.stringify(change[side]) ||
            (current.get(change.key)?.parent ?? null) !== change[`${side}_parent`] ||
            (current.get(change.key)?.index ?? null) !== change[`${side}_index`],
        )
        .map((change) => change.key);
      if (conflicts.length) throw new UndoConflict(conflicts, "Entity changed after target revision");
      Object.assign(project, restoreEntities(project, targetEntry.changes, direction === "undo" ? "before" : "after"));
    };
    return write(request, mutator, direction, target);
  }

  return {
    commitWrite: (
      request: WriteRequest,
      mutator: (project: Project) => void,
      entityOps?: Record<string, string>,
      result?: Record<string, unknown>,
    ) => write(request, mutator, "write", undefined, entityOps, result),
    previewWrite: async (
      request: WriteRequest,
      mutator: (project: Project) => void,
      entityOps: Record<string, string> = {},
    ): Promise<WriteEnvelope> => {
      const parsed = parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      const before = parsed.project;
      const output: WriteEnvelope = {
        ok: true,
        status: "dry_run",
        verb: request.verb,
        request_id: request.request_id,
        receipt: { before: before.revision.id, after: null, idempotency_key: request.idempotency_key, replayed: false },
        changes: [],
        verification: { level: "none", passed: false, issues: [] },
        result: {},
        error: null,
      };
      const reject = (code: ErrorCode, message: string) => {
        output.ok = false;
        output.status = "rejected";
        output.error = { code, message, retryable: false };
        return output;
      };
      if (request.base_revision !== before.revision.id) {
        output.ok = false;
        output.status = "conflict";
        output.error = { code: "E_CONFLICT", message: "Base revision differs from current revision", retryable: false };
        return output;
      }
      const candidate = structuredClone(before);
      try {
        mutator(candidate);
      } catch (error) {
        if (error instanceof EditError) return reject(error.code, error.message);
        throw error;
      }
      let serialized: string;
      try {
        serialized = serializeProject(candidate);
      } catch (error) {
        output.verification = {
          level: "L0",
          passed: false,
          issues: schemaIssues([{ instancePath: "", message: String(error) }]),
        };
        return reject("E_VALIDATION", String(error));
      }
      const check = parseProject(serialized);
      if (!check.ok) {
        output.verification = { level: "L0", passed: false, issues: schemaIssues(check.errors) };
        return reject("E_VALIDATION", "Project failed L0 validation");
      }
      const issues = validateProjectSemantics(check.project, check.issues);
      output.verification = { level: "L1", passed: !issues.some((issue) => issue.severity === "error"), issues };
      if (!output.verification.passed) return reject("E_VALIDATION", "Project failed L1 validation");
      output.changes = diffProjectEntities(before, check.project).map((change) =>
        describeChange(change, entityOps, request.verb),
      );
      return output;
    },
    undo: (request: WriteRequest) => history(request, "undo"),
    redo: (request: WriteRequest) => history(request, "redo"),
    journal: async () => {
      const parsed = parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      return readLines<JournalEntry>(join(dirname(projectPath), ".zcut", parsed.project.id, "journal.jsonl"));
    },
    snapshotAt: async (revision: string): Promise<Project> => {
      const parsed = parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      let project = parsed.project;
      if (project.revision.id === revision) return project;
      const entries = await readLines<JournalEntry>(join(dirname(projectPath), ".zcut", project.id, "journal.jsonl"));
      if (project.revision.seq > (entries.at(-1)?.seq ?? 1)) throw new HistoryError("E_UNSUPPORTED");
      if (!entries.some((entry) => entry.revision === revision || entry.parent === revision))
        throw new HistoryError("E_NOT_FOUND");
      for (const entry of entries.reverse()) {
        if (entry.revision !== project.revision.id) continue;
        if (entry.kind === "recovered" || !entry.changes) throw new HistoryError("E_UNSUPPORTED");
        project = restoreEntities(project, entry.changes, "before");
        project.revision = { ...project.revision, id: entry.parent ?? "", seq: entry.seq - 1 };
        if (project.revision.id === revision) return project;
      }
      throw new HistoryError("E_NOT_FOUND");
    },
  };
}

export class HistoryError extends Error {
  readonly code: "E_UNSUPPORTED" | "E_NOT_FOUND";
  constructor(code: HistoryError["code"]) {
    super(code);
    this.code = code;
  }
}

class UndoConflict extends Error {
  readonly keys: string[];
  constructor(keys: string[], message: string) {
    super(message);
    this.keys = keys;
  }
}
