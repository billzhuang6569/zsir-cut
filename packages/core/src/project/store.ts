import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Batch, type BatchStep, batchPath, batchView, readBatches, saveBatchFile } from "./batch.ts";
import { applyEdit, EditError } from "./edit.ts";
import { diffProjectEntities, type EntityChange, type EntitySnapshot, projectEntitySnapshots } from "./entities.ts";
import { newId } from "./id.ts";
import { parseProject, serializeProject } from "./io.ts";
import { type ValidationIssue, validateProjectSemantics } from "./semantics.ts";
import type { Author, Project } from "./types.ts";

export type WriteVerb =
  | "export"
  | "create_project"
  | "edit"
  | "import_media"
  | "transcribe"
  | "undo"
  | "redo"
  | "session_approve"
  | "restore";
export interface WriteRequest {
  base_revision: string;
  idempotency_key: string;
  author: Author;
  verb: WriteVerb;
  request_id: string;
  ops: unknown[];
  timeline_id?: string;
  target?: string;
  label?: string;
  batch?: Batch;
  batch_id?: string;
  dry_run?: boolean;
  project?: string;
  session_id?: string;
}

export interface OpenProjectOptions {
  projectPath: string;
  clock?: () => Date;
  idGenerator?: () => string;
  lockWaitMs?: number;
  batchRoot?: string;
  sessionId?: string;
  manualApproval?: boolean;
  fault?: (point: "before_step_7" | "after_step_7") => void;
}

type EnvelopeStatus =
  | "queued"
  | "applied"
  | "dry_run"
  | "no_op"
  | "rejected"
  | "conflict"
  | "failed"
  | "committed_unverified";
type ErrorCode =
  | "E_BATCH_OPEN"
  | "E_BATCH_SEQ_TAKEN"
  | "E_BATCH_CLOSED"
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
  receipt: { before: string | null; after: string | null; idempotency_key: string; replayed: boolean } | null;
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
  kind: "write" | "undo" | "redo" | "restore" | "recovered";
  label?: string | null;
  batch?: Omit<Batch, "timeout_s"> | null;
  batch_id?: string;
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
  execution?: boolean;
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
  const prior =
    records.findLast((record) => record.idempotency_key === request.idempotency_key && record.execution !== true) ??
    records.findLast((record) => record.idempotency_key === request.idempotency_key);
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

async function acquireLock(directory: string, requestId: string, lockWaitMs: number, at: () => string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      const handle = await open(join(directory, "lock"), "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            acquired_at: at(),
            request_id: requestId,
          }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(join(directory, "lock"), "utf8")) as {
          pid?: number;
          hostname?: string;
        };
        if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid && owner.pid > 0) {
          let stale = false;
          try {
            process.kill(owner.pid, 0);
          } catch (check) {
            stale = (check as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (stale) {
            await rm(join(directory, "lock"), { force: true });
            await appendSynced(join(directory, "lock-events.jsonl"), {
              at: at(),
              event: "stale_lock",
              owner,
              taker: { pid: process.pid, hostname: hostname(), request_id: requestId },
            });
            continue;
          }
        }
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ENOENT" && !(check instanceof SyntaxError)) throw check;
      }
      if (Date.now() >= deadline)
        throw Object.assign(new Error("Project lock is busy"), { code: "E_IO", reason: "busy" });
      await pause(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
}

export function openProject(options: OpenProjectOptions) {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => newId("rev_"));
  const lockWaitMs = options.lockWaitMs ?? 10_000;
  const projectPath = options.projectPath;

  async function write(
    request: WriteRequest,
    mutator: (project: Project) => void | Promise<void>,
    kind: "write" | "undo" | "redo" | "restore",
    target?: string,
    entityOps: Record<string, string> = {},
    result: Record<string, unknown> | null = null,
    create?: () => Promise<Project>,
    inLock = false,
  ): Promise<WriteEnvelope> {
    const envelope = (status: EnvelopeStatus, before: string, after: string | null = null): WriteEnvelope => ({
      ok: status === "queued" || status === "applied" || status === "dry_run" || status === "no_op",
      status,
      verb: request.verb,
      request_id: request.request_id,
      receipt: before
        ? { before: create ? null : before, after, idempotency_key: request.idempotency_key, replayed: false }
        : null,
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
    if (request.verb === "restore" && (options.sessionId || request.session_id))
      return fail(
        "rejected",
        request.base_revision,
        "E_SESSION_STATE",
        "Restore is only available on the main project",
      );
    if (request.label !== undefined && (!request.label || [...request.label].length > 80))
      return fail("rejected", request.base_revision, "E_VALIDATION", "Label must contain 1 to 80 characters");
    if (request.verb === "edit" && request.author.kind === "agent" && !request.label)
      return fail("rejected", request.base_revision, "E_VALIDATION", "Agent edit requires label");
    if (request.dry_run) return previewWrite(request, mutator, entityOps, result ?? {});
    let before = request.base_revision;
    let lockPath = "";
    let locked = false;
    let committedRevision: string | null = null;
    let creationLock = "";
    let batchLock = "";
    try {
      if (create) {
        const parent = await realpath(dirname(projectPath));
        const pathKey = createHash("sha256").update(basename(projectPath)).digest("hex");
        const gate = join(parent, ".zcut", `create_${pathKey}`);
        await acquireLock(gate, request.request_id, lockWaitMs, () => clock().toISOString());
        creationLock = join(gate, "lock");
      }
      let initialProject: Project | undefined;
      let exists = true;
      try {
        const info = await lstat(projectPath);
        if (create && !info.isFile()) return fail("rejected", "", "E_VALIDATION", "工程路径已存在");
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
      }
      if (create && !exists) initialProject = await create();
      else {
        const initial = parseProject(await readFile(projectPath, "utf8"));
        if (!initial.ok) {
          if (create) return fail("rejected", "", "E_VALIDATION", "工程文件已存在");
          throw new Error("Project file is invalid");
        }
        initialProject = initial.project;
      }
      const directory = join(dirname(projectPath), ".zcut", initialProject.id);
      lockPath = join(directory, "lock");
      if (!inLock) {
        if (options.batchRoot && options.batchRoot !== directory) {
          await acquireLock(options.batchRoot, request.request_id, lockWaitMs, () => clock().toISOString());
          batchLock = join(options.batchRoot, "lock");
        }
        await acquireLock(directory, request.request_id, lockWaitMs, () => clock().toISOString());
        locked = true;
      }
      const parsed =
        create && !exists
          ? { ok: true as const, project: initialProject }
          : parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      const current = parsed.project;
      before = current.revision.id;
      const journalPath = join(directory, "journal.jsonl");
      const idempotencyPath = join(directory, "idempotency.jsonl");
      const journal = await readLines<JournalEntry>(journalPath);
      let recoveredWrite = false;
      if (!create && current.revision.seq > (journal.at(-1)?.seq ?? 1)) {
        const recovered: JournalEntry = {
          kind: "recovered",
          label: null,
          batch: null,
          revision: before,
          parent: current.revision.parent,
          seq: current.revision.seq,
          at: current.revision.created_at,
        };
        await appendSynced(journalPath, recovered);
        journal.push(recovered);
        recoveredWrite = true;
      }
      const batches = inLock ? [] : await readBatches(options.batchRoot ?? directory, clock());
      if (recoveredWrite) {
        for (const state of batches.filter(
          (state) => state.state === "open" && state.target === (options.sessionId ?? null),
        )) {
          state.state = "failed";
          state.failed_seq = Object.keys(state.revisions).length + 1;
          state.reason = {
            code: "E_UNSUPPORTED",
            message: "Batch interrupted by an unrecoverable revision",
            retryable: false,
          };
          await saveBatchFile(join(batchPath(options.batchRoot ?? directory, state.id), "state.json"), state);
        }
      }
      const records = await readLines<IdempotencyEntry>(idempotencyPath);
      const hash = requestHash(request);
      if (
        create &&
        exists &&
        (journal[0]?.verb !== "create_project" || journal[0]?.idempotency_key !== request.idempotency_key)
      )
        return fail("rejected", "", "E_VALIDATION", "工程文件已存在");
      const prior =
        records.findLast(
          (record) =>
            record.idempotency_key === request.idempotency_key &&
            (inLock ? record.execution === true : record.execution !== true),
        ) ?? records.findLast((record) => record.idempotency_key === request.idempotency_key);
      if (prior && !(inLock && prior.envelope.status === "queued")) {
        if (prior.request_hash !== hash)
          return fail("rejected", before, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another request");
        return {
          ...prior.envelope,
          receipt: prior.envelope.receipt ? { ...prior.envelope.receipt, replayed: true } : null,
        };
      }
      if (create && exists) return fail("rejected", "", "E_VALIDATION", "工程文件已存在，缺少新建工程的幂等回执");
      if (!inLock) {
        const root = options.batchRoot ?? directory;
        const targetId = options.sessionId ?? null;
        const occupied = batches.find(
          (state) => state.state === "open" && state.target === targetId && state.id !== request.batch?.id,
        );
        if (occupied)
          return fail("failed", before, "E_BATCH_OPEN", "A batch is open on this target", batchView(occupied), true);
        if (request.batch) {
          const batch = request.batch;
          if (batch.seq > batch.count) return fail("rejected", before, "E_VALIDATION", "Batch seq exceeds count");
          let state = batches.find((state) => state.id === batch.id);
          if (state && (state.count !== batch.count || state.target !== targetId))
            return fail("rejected", before, "E_VALIDATION", "Batch count and session_id must match");
          const path = batchPath(root, batch.id);
          if (state?.received.includes(batch.seq)) {
            const step = JSON.parse(await readFile(join(path, `${batch.seq}.json`), "utf8")) as BatchStep;
            if (requestHash(step.request) !== hash)
              return fail("rejected", before, "E_BATCH_SEQ_TAKEN", "Batch sequence is already taken");
          }
          if (state && state.state !== "open") return fail("rejected", before, "E_BATCH_CLOSED", "Batch is closed");
          state ??= {
            id: batch.id,
            target: targetId,
            state: "open",
            count: batch.count,
            timeout_s: 30,
            last_received_at: clock().toISOString(),
            received: [],
            revisions: {},
            failed_seq: null,
            reason: null,
          };
          if (!state.received.includes(batch.seq)) {
            const at = clock().toISOString();
            await saveBatchFile(join(path, `${batch.seq}.json`), { request, received_at: at });
            state.received.push(batch.seq);
            state.last_received_at = at;
          }
          if (batch.seq === 1) state.timeout_s = batch.timeout_s ?? 30;
          await saveBatchFile(join(path, "state.json"), state);
          const executed: number[] = [];
          let own: WriteEnvelope | undefined;
          for (
            let seq = Object.keys(state.revisions).length + 1;
            seq <= state.count && state.received.includes(seq);
            seq++
          ) {
            const step = JSON.parse(await readFile(join(path, `${seq}.json`), "utf8")) as BatchStep;
            const entityOps: Record<string, string> = {};
            const stepResult = {};
            const outcome = await write(
              step.request,
              (candidate) =>
                applyEdit(
                  candidate,
                  step.request.ops as ({ op: string } & Record<string, unknown>)[],
                  entityOps,
                  `${step.request.base_revision}:${step.request.idempotency_key}`,
                  step.request.timeline_id,
                  options.manualApproval ?? false,
                  undefined,
                  stepResult,
                ),
              "write",
              undefined,
              entityOps,
              stepResult,
              undefined,
              true,
            );
            if (!outcome.ok) {
              state.state = "failed";
              state.failed_seq = seq;
              state.reason = outcome.error;
              await saveBatchFile(join(path, "state.json"), state);
              const output: WriteEnvelope = {
                ...outcome,
                request_id: request.request_id,
                receipt:
                  outcome.status === "committed_unverified" ? outcome.receipt : envelope("rejected", before).receipt,
                status: outcome.status === "committed_unverified" ? outcome.status : "rejected",
                result: { ...outcome.result, batch: { ...batchView(state), executed } },
              };
              await appendSynced(idempotencyPath, {
                idempotency_key: request.idempotency_key,
                request_hash: hash,
                at: clock().toISOString(),
                envelope: output,
              });
              return output;
            }
            if (!outcome.receipt?.after) throw new Error("Batch step has no revision");
            committedRevision = outcome.receipt.after;
            state.revisions[String(seq)] = outcome.receipt.after;
            executed.push(seq);
            if (seq === batch.seq) own = outcome;
            if (seq === state.count) state.state = "complete";
            await saveBatchFile(join(path, "state.json"), state);
          }
          const output = own ?? envelope("queued", before);
          output.result = { ...output.result, batch: { ...batchView(state), executed } };
          // Queued receipts stay replayable; execution has its own journal receipt.
          if (own || !prior)
            await appendSynced(idempotencyPath, {
              idempotency_key: request.idempotency_key,
              request_hash: hash,
              at: clock().toISOString(),
              envelope: output,
            });
          return output;
        }
      }

      if (!create && (!request.batch || request.batch.seq === 1) && request.base_revision !== before) {
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
      if (inLock) {
        const unverified = journal.find((entry) => entry.idempotency_key === request.idempotency_key);
        if (unverified) {
          const output = envelope("committed_unverified", unverified.parent ?? before, unverified.revision);
          output.error = {
            code: "E_IO",
            message: "Batch revision has no execution receipt; inspect before continuing",
            retryable: false,
          };
          return output;
        }
      }
      const candidate = structuredClone(current);
      try {
        await mutator(candidate);
      } catch (error) {
        if (error instanceof HistoryError) return fail("rejected", before, error.code, error.message);
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
      const changes: EntityChange[] = create
        ? [...projectEntitySnapshots(check.project)].map(([key, snapshot]) => ({
            key,
            entity: snapshot.entity,
            before: null,
            after: snapshot.value,
            before_parent: null,
            after_parent: snapshot.parent,
            before_index: null,
            after_index: snapshot.index,
          }))
        : diffProjectEntities(current, check.project);
      if (
        changes.length === 0 &&
        !request.batch &&
        !request.batch_id &&
        (kind !== "restore" || request.target === before)
      ) {
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
      candidate.revision = create
        ? { ...candidate.revision, created_at: clock().toISOString() }
        : {
            seq: current.revision.seq + 1,
            id: idGenerator(),
            parent: before,
            created_at: clock().toISOString(),
            author: request.author,
          };
      const bytes = serializeProject(candidate);
      if (create) {
        const timeline = candidate.timelines[0];
        result = {
          project_id: candidate.id,
          timeline_id: timeline?.id,
          revision: { seq: 1, id: candidate.revision.id },
          ...(timeline?.tracks.some((track) => track.kind === "subtitle") ? { subtitle_track_id: "trk_sub1" } : {}),
        };
      }
      const output = envelope("applied", before, candidate.revision.id);
      output.result = result;
      output.verification = { level: "L1", passed: true, issues };
      output.changes = changes.map((change) => describeChange(change, entityOps, request.verb));
      options.fault?.("before_step_7");
      const temp = join(dirname(projectPath), `.${current.id}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (create) await link(temp, projectPath);
        else await rename(temp, projectPath);
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
        label: request.label ?? null,
        batch: request.batch ? { id: request.batch.id, seq: request.batch.seq, count: request.batch.count } : null,
        ...(request.batch_id ? { batch_id: request.batch_id } : {}),
        revision: candidate.revision.id,
        parent: create ? null : before,
        seq: candidate.revision.seq,
        at: candidate.revision.created_at,
        author: request.author,
        verb: request.verb,
        request_id: request.request_id,
        idempotency_key: request.idempotency_key,
        ops: request.ops,
        ...(request.timeline_id ? { timeline_id: request.timeline_id } : {}),
        changes,
        ...((request.target ?? target) ? { target: (request.target ?? target) as string } : {}),
      };
      await appendSynced(journalPath, entry);
      const now = clock().getTime();
      const recentKeys = new Set(
        [...new Set([request.idempotency_key, ...records.toReversed().map((record) => record.idempotency_key)])].slice(
          0,
          1000,
        ),
      );
      const retained = records.filter(
        (record) =>
          record.envelope.verb === "create_project" ||
          recentKeys.has(record.idempotency_key) ||
          now - Date.parse(record.at) <= 7 * 24 * 60 * 60 * 1000,
      );
      const record = {
        execution: inLock,
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
      if (error instanceof EditError) return fail("rejected", "", error.code, error.message);
      if (create && (error as NodeJS.ErrnoException).code === "EEXIST")
        return fail("rejected", "", "E_VALIDATION", "工程文件已存在");
      return fail(
        "failed",
        before,
        (error as NodeJS.ErrnoException).code ? "E_IO" : "E_INTERNAL",
        String(error),
        (error as { reason?: string }).reason === "busy" ? { reason: "busy" } : undefined,
        true,
      );
    } finally {
      if (locked) await rm(lockPath, { force: true });
      if (creationLock) await rm(creationLock, { force: true });
      if (batchLock) await rm(batchLock, { force: true });
    }
  }

  async function history(input: WriteRequest, direction: "undo" | "redo"): Promise<WriteEnvelope> {
    const request = { ...input };
    let target = request.target;
    const mutator = async (project: Project) => {
      const entries = await readLines<JournalEntry>(join(dirname(projectPath), ".zcut", project.id, "journal.jsonl"));
      const undone = new Set<string>();
      for (const entry of entries) {
        const targets = entry.batch_id
          ? entries.filter((item) => item.batch?.id === entry.batch_id).map((item) => item.revision)
          : entry.target
            ? [entry.target]
            : [];
        for (const revision of targets) {
          if (entry.kind === "undo") undone.add(revision);
          if (entry.kind === "redo") undone.delete(revision);
        }
      }
      target ??=
        direction === "undo"
          ? entries.findLast((entry) => entry.kind === "write" && !undone.has(entry.revision))?.revision
          : entries.findLast((entry) => entry.kind === "undo" && entry.target && undone.has(entry.target))?.target;
      const redoBatch =
        direction === "redo"
          ? entries.findLast((entry) => entry.kind === "undo" && entry.target === target)?.batch_id
          : undefined;
      const batchId = request.batch_id ?? redoBatch;
      let targetEntry = entries.find((entry) => entry.revision === target);
      if (batchId) {
        const group = entries.filter((entry) => entry.batch?.id === batchId);
        const first = group[0];
        const last = group.at(-1);
        if (
          !first?.parent ||
          !last ||
          group.some((entry) => (direction === "undo" ? undone.has(entry.revision) : !undone.has(entry.revision)))
        )
          throw new UndoConflict([batchId], "No undoable batch");
        const combined = new Map<string, EntityChange>();
        for (const entry of group) {
          if (!entry.changes) throw new HistoryError("E_UNSUPPORTED");
          for (const change of entry.changes) {
            const previous = combined.get(change.key);
            combined.set(
              change.key,
              previous
                ? {
                    ...change,
                    before: previous.before,
                    before_parent: previous.before_parent,
                    before_index: previous.before_index,
                  }
                : change,
            );
          }
        }
        target = last.revision;
        request.batch_id = batchId;
        targetEntry = { ...last, changes: [...combined.values()] };
      }
      if (target) request.target = target;
      if (
        !targetEntry ||
        targetEntry.kind !== "write" ||
        !targetEntry.changes ||
        (direction === "undo" ? undone.has(targetEntry.revision) : !undone.has(targetEntry.revision))
      )
        throw new UndoConflict(target ? [target] : [], "No undoable target revision");
      if (targetEntry.verb === "create_project") throw new EditError("E_UNSUPPORTED", "Cannot undo project creation");
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
      const restored = restoreEntities(project, targetEntry.changes, direction === "undo" ? "before" : "after");
      if (!restored.recognition) delete project.recognition;
      Object.assign(project, restored);
    };
    return write(request, mutator, direction, target);
  }

  async function snapshotAt(revision: string): Promise<Project> {
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
  }

  async function readBatchState(batchId?: string) {
    const parsed = parseProject(await readFile(projectPath, "utf8"));
    if (!parsed.ok) throw new Error("Project file is invalid");
    const directory = options.batchRoot ?? join(dirname(projectPath), ".zcut", parsed.project.id);
    await acquireLock(directory, newId("req_"), lockWaitMs, () => clock().toISOString());
    try {
      const state = (await readBatches(directory, clock())).find((state) =>
        batchId ? state.id === batchId : state.state === "open" && state.target === (options.sessionId ?? null),
      );
      if (!state && batchId) throw new HistoryError("E_NOT_FOUND");
      return state ? batchView(state) : null;
    } finally {
      await rm(join(directory, "lock"), { force: true });
    }
  }

  async function previewWrite(
    request: WriteRequest,
    mutator: (project: Project) => void | Promise<void>,
    entityOps: Record<string, string> = {},
    result: Record<string, unknown> = {},
  ): Promise<WriteEnvelope> {
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
      result,
      error: null,
    };
    const reject = (code: ErrorCode, message: string) => {
      output.ok = false;
      output.status = "rejected";
      output.error = { code, message, retryable: false };
      return output;
    };
    if (request.verb === "edit" && request.author.kind === "agent" && !request.label)
      return reject("E_VALIDATION", "Agent edit requires label");
    if ((!request.batch || request.batch.seq === 1) && request.base_revision !== before.revision.id) {
      output.ok = false;
      output.status = "conflict";
      output.error = { code: "E_CONFLICT", message: "Base revision differs from current revision", retryable: false };
      return output;
    }
    const candidate = structuredClone(before);
    try {
      await mutator(candidate);
    } catch (error) {
      if (error instanceof HistoryError) return reject(error.code, error.message);
      if (error instanceof UndoConflict) {
        const result = reject("E_UNDO_CONFLICT", error.message);
        if (result.error) result.error.details = { keys: error.keys };
        return result;
      }
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
  }

  return {
    createProject: (request: WriteRequest, create: () => Promise<Project>) =>
      write(request, () => {}, "write", undefined, {}, null, create),
    commitWrite: (
      request: WriteRequest,
      mutator: (project: Project) => void | Promise<void>,
      entityOps?: Record<string, string>,
      result?: Record<string, unknown>,
    ) => write(request, mutator, "write", undefined, entityOps, result),
    previewWrite,
    batchStatus: (batchId: string) => readBatchState(batchId),
    batchBlocker: () => readBatchState(),
    restore: (request: WriteRequest) =>
      write(
        request,
        async (project) => {
          const restored = await snapshotAt(request.target ?? "");
          restored.revision = project.revision;
          for (const key of Object.keys(project)) delete (project as unknown as Record<string, unknown>)[key];
          Object.assign(project, restored);
        },
        "restore",
        request.target,
      ),
    undo: (request: WriteRequest) => history(request, "undo"),
    redo: (request: WriteRequest) => history(request, "redo"),
    journal: async () => {
      const parsed = parseProject(await readFile(projectPath, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      return readLines<JournalEntry>(join(dirname(projectPath), ".zcut", parsed.project.id, "journal.jsonl"));
    },
    snapshotAt,
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
