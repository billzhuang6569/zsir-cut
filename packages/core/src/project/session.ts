import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Envelope, Verb } from "../dispatch.ts";
import { startPreviewJob } from "../jobs.ts";
import { decisionSummary } from "../read-views.ts";
import { applyEdit } from "./edit.ts";
import { diffProjectEntities, type EntityChange } from "./entities.ts";
import { newId } from "./id.ts";
import { parseProject, serializeProject } from "./io.ts";
import { validateProjectSemantics } from "./semantics.ts";
import { type JournalEntry, openProject, type WriteEnvelope, type WriteRequest } from "./store.ts";
import type { Author, Project } from "./types.ts";

type Input = Record<string, unknown>;
type State = "open" | "in_review" | "approved" | "rejected";
export interface Decision {
  id: string;
  seq: number;
  tag?: string;
  question: string;
  options: { id: string; label: string; note?: string; recommended?: boolean }[];
  allow_other: boolean;
  refs?: ({ kind: "time"; at: string } | { kind: "entity"; id: string })[];
  state: "pending" | "answered" | "skipped";
  answer?: { option_id?: string; text?: string; author: Author; at: string };
  created_by: Author;
}
export interface Session {
  decisions?: Decision[];
  log?: {
    verb: Verb;
    at: string;
    author: Author;
    idempotency_key: string;
    signature: string;
    before: Decision[];
    after: Decision[];
    envelope: Envelope;
  }[];
  session_id: string;
  state: State;
  approval: "manual" | "auto";
  intent: string;
  author: Author;
  base_revision: string;
  base_created_at: string;
  created_at: string;
  updated_at: string;
  begin_key: string;
  begin_signature: string;
  review_key?: string;
  review_signature?: string;
  review_envelope?: Envelope;
  decision_key?: string;
  decision_signature?: string;
  decision_envelope?: Envelope;
}
const signature = (input: Input) =>
  JSON.stringify({
    project: resolve(input.project as string),
    base_revision: input.base_revision,
    author:
      input.author && typeof input.author === "object"
        ? {
            kind: (input.author as Author).kind,
            name: (input.author as Author).name,
          }
        : input.author,
    session_id: input.session_id,
    approval: input.approval,
    intent: input.intent,
    dry_run: input.dry_run,
    target: input.target,
    decisions: input.decisions,
    decision_id: input.decision_id,
    option_id: input.option_id,
    text: input.text,
    skip: input.skip,
  });
async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const path = join(directory, "session.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, hostname: hostname() }), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number; hostname: string };
        if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
          let stale = false;
          try {
            process.kill(owner.pid, 0);
          } catch (check) {
            stale = (check as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (stale) {
            await rm(path);
            continue;
          }
        }
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ENOENT" && !(check instanceof SyntaxError)) throw check;
      }
      if (Date.now() >= deadline) throw new Error("Session lock is busy");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
}
const readProject = async (path: string): Promise<Project> => {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error("Project file is invalid");
  return parsed.project;
};
const output = (verb: Verb, requestId: string): Envelope => ({
  ok: true,
  status: "no_op",
  verb,
  request_id: requestId,
  receipt: null,
  changes: [],
  verification: { level: "none", passed: false, issues: [] },
  result: {},
  error: null,
});
const reject = (
  verb: Verb,
  id: string,
  code: "E_SESSION_STATE" | "E_CONFLICT" | "E_NOT_FOUND" | "E_IDEMPOTENCY_MISMATCH" | "E_VALIDATION",
  message: string,
): Envelope => {
  const envelope = output(verb, id);
  envelope.ok = false;
  envelope.status = code === "E_CONFLICT" ? "conflict" : "rejected";
  envelope.error = { code, message, retryable: false };
  return envelope;
};
const metadata = async (path: string, value: Session) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
};
const writeRequest = (verb: WriteRequest["verb"], id: string, input: Input, ops: unknown[] = []): WriteRequest => ({
  verb,
  request_id: id,
  base_revision: input.base_revision as string,
  idempotency_key: input.idempotency_key as string,
  author: input.author as Author,
  ops,
  ...(typeof input.timeline_id === "string" ? { timeline_id: input.timeline_id } : {}),
  ...(typeof input.target === "string" ? { target: input.target } : {}),
});
const activeWrites = (entries: JournalEntry[]) => {
  const undone = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "undo" && entry.target) undone.add(entry.target);
    if (entry.kind === "redo" && entry.target) undone.delete(entry.target);
  }
  return entries.filter((entry) => entry.kind === "write" && !undone.has(entry.revision));
};
const subtitleEntities = new Set(["transcript", "run", "token", "cue", "override", "free_cue", "style"]);
const classify = (changes: EntityChange[]) => ({
  timeline_changes: changes.filter(
    (change) =>
      !subtitleEntities.has(change.entity) &&
      !(change.entity === "track" && (change.after ?? change.before)?.kind === "subtitle"),
  ),
  subtitle_changes: changes.filter(
    (change) =>
      subtitleEntities.has(change.entity) ||
      (change.entity === "track" && (change.after ?? change.before)?.kind === "subtitle"),
  ),
});
const draftEnvelope = (envelope: WriteEnvelope, sessionId: string): Envelope =>
  ({
    ...envelope,
    status: envelope.status === "applied" ? "drafted" : envelope.status,
    receipt: envelope.receipt ? { ...envelope.receipt, session_id: sessionId } : null,
  }) as Envelope;

export async function runSession(verb: Verb, input: Input, id: string): Promise<Envelope> {
  const projectPath = resolve(input.project as string);
  const main = await readProject(projectPath);
  const root = join(dirname(projectPath), ".zcut", main.id, "sessions");
  if (verb === "session_begin") {
    if (input.session_id) return reject(verb, id, "E_SESSION_STATE", "A session cannot begin inside a session");
    await mkdir(root, { recursive: true });
    return locked(root, async () => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        try {
          const existing = JSON.parse(await readFile(join(root, name, "session.json"), "utf8")) as Session;
          if (existing.begin_key === input.idempotency_key) {
            if (existing.begin_signature !== signature(input))
              return reject(verb, id, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another session request");
            const result = output(verb, id);
            result.result = {
              session_id: existing.session_id,
              base_revision: existing.base_revision,
              state: "open",
            };
            return result;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (input.base_revision !== main.revision.id)
        return reject(verb, id, "E_CONFLICT", "Base revision differs from current revision");
      const session_id = newId("ses_");
      const directory = join(root, session_id);
      await mkdir(directory);
      const now = new Date().toISOString();
      const session: Session = {
        session_id,
        decisions: [],
        log: [],
        state: "open",
        approval: input.approval as Session["approval"],
        intent: input.intent as string,
        author: input.author as Author,
        base_revision: main.revision.id,
        base_created_at: main.revision.created_at,
        created_at: now,
        updated_at: now,
        begin_key: input.idempotency_key as string,
        begin_signature: signature(input),
      };
      await writeFile(join(directory, "draft.zcut.json"), serializeProject(main), { flag: "wx" });
      await metadata(join(directory, "session.json"), session);
      const result = output(verb, id);
      result.result = { session_id, base_revision: session.base_revision, state: session.state };
      return result;
    });
  }
  const sessionId = input.session_id as string;
  const directory = join(root, sessionId);
  try {
    return await locked(directory, () => runExistingSession(verb, input, id, projectPath, directory, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(verb, id, "E_NOT_FOUND", "Session not found");
    throw error;
  }
}

async function runExistingSession(
  verb: Verb,
  input: Input,
  id: string,
  projectPath: string,
  directory: string,
  sessionId: string,
): Promise<Envelope> {
  const sessionPath = join(directory, "session.json");
  let session: Session;
  try {
    session = JSON.parse(await readFile(sessionPath, "utf8")) as Session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(verb, id, "E_NOT_FOUND", "Session not found");
    throw error;
  }
  const draftPath = join(directory, "draft.zcut.json");
  const draft = openProject({ projectPath: draftPath });
  if (verb === "session_ask" || verb === "session_answer") {
    const previous = session.log?.find((entry) => entry.idempotency_key === input.idempotency_key);
    if (previous) {
      if (previous.verb !== verb || previous.signature !== signature(input))
        return reject(verb, id, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another decision request");
      return previous.envelope;
    }
  }
  if (verb === "session_review" && session.review_key === input.idempotency_key && session.review_envelope) {
    if (session.review_signature !== signature(input))
      return reject(verb, id, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another session request");
    return session.review_envelope;
  }
  if (session.state === "approved" || session.state === "rejected") {
    if (session.decision_key === input.idempotency_key && session.decision_envelope?.verb === verb) {
      if (session.decision_signature !== signature(input))
        return reject(verb, id, "E_IDEMPOTENCY_MISMATCH", "Idempotency key was used for another session request");
      return {
        ...session.decision_envelope,
        receipt: session.decision_envelope.receipt ? { ...session.decision_envelope.receipt, replayed: true } : null,
      };
    }
    return reject(verb, id, "E_SESSION_STATE", "Session is closed");
  }
  if (verb === "session_ask" || verb === "session_answer") {
    const current = await readProject(draftPath);
    if (input.base_revision !== current.revision.id)
      return reject(verb, id, "E_CONFLICT", "Draft revision differs from current revision");
    const decisions = session.decisions ?? [];
    const before = structuredClone(decisions);
    const now = new Date().toISOString();
    const result = output(verb, id);
    if (verb === "session_ask") {
      const additions = input.decisions as Omit<Decision, "seq" | "state" | "created_by">[];
      if (decisions.length + additions.length > 50)
        return reject(verb, id, "E_VALIDATION", "A session can contain at most 50 decisions");
      const ids = new Set(decisions.map((decision) => decision.id));
      const optionIds = new Set(decisions.flatMap((decision) => decision.options.map((option) => option.id)));
      const created: string[] = [];
      for (const addition of additions) {
        const decisionId = addition.id ?? newId("dec_");
        if (ids.has(decisionId)) return reject(verb, id, "E_VALIDATION", "Decision IDs must be unique in a session");
        ids.add(decisionId);
        for (const [index, option] of addition.options.entries()) {
          if (optionIds.has(option.id))
            return reject(verb, id, "E_VALIDATION", "Option IDs must be unique in a session");
          optionIds.add(option.id);
          if (option.recommended && index !== 0)
            return reject(verb, id, "E_VALIDATION", "Only the first option may be recommended");
        }
        decisions.push({
          ...addition,
          id: decisionId,
          seq: decisions.length + 1,
          allow_other: addition.allow_other ?? true,
          state: "pending",
          created_by: input.author as Author,
        });
        created.push(decisionId);
      }
      result.result = { decision_ids: created };
      session.state = "open";
    } else {
      const decision = decisions.find((item) => item.id === input.decision_id);
      if (!decision) return reject(verb, id, "E_NOT_FOUND", "Decision not found");
      if (input.text !== undefined && !decision.allow_other)
        return reject(verb, id, "E_VALIDATION", "This decision does not allow a text answer");
      if (input.option_id !== undefined && !decision.options.some((option) => option.id === input.option_id))
        return reject(verb, id, "E_NOT_FOUND", "Option not found in this decision");
      decision.state = input.skip === true ? "skipped" : "answered";
      delete decision.answer;
      if (input.skip !== true)
        decision.answer = {
          ...(input.option_id !== undefined
            ? { option_id: input.option_id as string }
            : { text: input.text as string }),
          author: input.author as Author,
          at: now,
        };
      result.result = { decision_id: decision.id, state: decision.state };
    }
    if (input.dry_run === true) {
      result.status = "dry_run";
      return result;
    }
    result.status = "drafted";
    session.decisions = decisions;
    session.updated_at = now;
    // Keep decisions and their audit/idempotency record in the same atomic replacement.
    session.log ??= [];
    session.log.push({
      verb,
      at: now,
      author: input.author as Author,
      idempotency_key: input.idempotency_key as string,
      signature: signature(input),
      before,
      after: structuredClone(decisions),
      envelope: result,
    });
    await metadata(sessionPath, session);
    return result;
  }
  if (verb === "edit" || verb === "undo" || verb === "redo") {
    if (session.state === "in_review" && verb !== "edit")
      return reject(verb, id, "E_SESSION_STATE", "Session is in review");
    const request = writeRequest(verb, id, input, verb === "edit" ? (input.ops as unknown[]) : []);
    let applied: WriteEnvelope;
    if (verb === "edit") {
      const ops = input.ops as ({ op: string } & Record<string, unknown>)[];
      const entityOps: Record<string, string> = {};
      const mutator = (candidate: Project) =>
        applyEdit(
          candidate,
          ops,
          entityOps,
          `${input.base_revision}:${input.idempotency_key}`,
          input.timeline_id as string | undefined,
          session.approval === "manual",
        );
      applied =
        input.dry_run === true
          ? await draft.previewWrite(request, mutator, entityOps)
          : await draft.commitWrite(request, mutator, entityOps);
    } else applied = await draft[verb](request);
    if (session.state === "in_review" && verb === "edit" && applied.ok && applied.status !== "dry_run") {
      session.state = "open";
      session.updated_at = new Date().toISOString();
      try {
        await metadata(sessionPath, session);
      } catch (error) {
        if (applied.status === "applied")
          return {
            ...draftEnvelope(applied, sessionId),
            ok: false,
            status: "committed_unverified",
            error: { code: "E_IO", message: String(error), retryable: false },
          };
        throw error;
      }
    }
    return draftEnvelope(applied, sessionId);
  }
  if (verb === "session_review") {
    if (session.state !== "open") return reject(verb, id, "E_SESSION_STATE", "Session is not open");
    const current = await readProject(draftPath);
    if (input.base_revision !== current.revision.id)
      return reject(verb, id, "E_CONFLICT", "Draft revision differs from current revision");
    const base = await draft.snapshotAt(session.base_revision);
    const entries = await draft.journal();
    const issues = validateProjectSemantics(current);
    const result = output(verb, id);
    result.verification = { level: "L1", passed: !issues.some((issue) => issue.severity === "error"), issues };
    result.result = {
      base_revision: session.base_revision,
      draft_revision: current.revision.id,
      ...decisionSummary(current, session),
      ...classify(diffProjectEntities(base, current)),
      ops: entries.filter((entry) => entry.kind === "write").flatMap((entry) => entry.ops ?? []),
      verification: result.verification,
      preview_job: await startPreviewJob("render_preview", projectPath, current, {
        project: projectPath,
        session_id: sessionId,
        output: join(directory, "preview"),
      }),
    };
    session.state = "in_review";
    session.updated_at = new Date().toISOString();
    await metadata(sessionPath, session);
    let approvalResult: Envelope | undefined;
    if (session.approval === "auto") {
      const mainNow = await readProject(projectPath);
      const approval = await approve(
        session,
        draft,
        draftPath,
        projectPath,
        sessionPath,
        {
          ...input,
          base_revision: mainNow.revision.id,
        },
        id,
      );
      approvalResult = approval;
      result.result = { ...result.result, approval: approval };
      if (!approval.ok) {
        result.ok = false;
        result.status = approval.status;
        result.error = approval.error;
      }
    }
    session.review_key = input.idempotency_key as string;
    session.review_signature = signature(input);
    session.review_envelope = result;
    try {
      await metadata(sessionPath, session);
    } catch (error) {
      if (approvalResult?.receipt?.after)
        return {
          ...result,
          ok: false,
          status: "committed_unverified",
          receipt: approvalResult.receipt,
          error: { code: "E_IO", message: String(error), retryable: false },
        };
      throw error;
    }
    return result;
  }
  if (verb === "session_reject") {
    if (session.state !== "open" && session.state !== "in_review")
      return reject(verb, id, "E_SESSION_STATE", "Session cannot be rejected");
    const mainNow = await readProject(projectPath);
    if (input.base_revision !== mainNow.revision.id)
      return reject(verb, id, "E_CONFLICT", "Base revision differs from current revision");
    session.state = "rejected";
    session.updated_at = new Date().toISOString();
    const result = output(verb, id);
    result.result = { session_id: sessionId, state: session.state };
    session.decision_key = input.idempotency_key as string;
    session.decision_signature = signature(input);
    session.decision_envelope = result;
    await metadata(sessionPath, session);
    return result;
  }
  if (verb === "session_approve") {
    if (session.state !== "in_review") return reject(verb, id, "E_SESSION_STATE", "Session is not in review");
    return approve(session, draft, draftPath, projectPath, sessionPath, input, id);
  }
  return reject(verb, id, "E_SESSION_STATE", "Verb is not allowed in session");
}

async function approve(
  session: Session,
  draft: ReturnType<typeof openProject>,
  draftPath: string,
  projectPath: string,
  sessionPath: string,
  input: Input,
  id: string,
): Promise<Envelope> {
  const main = await readProject(projectPath);
  const current = await readProject(draftPath);
  const entries = await draft.journal();
  const writes = activeWrites(entries);
  const times = new Map(entries.map((entry) => [entry.revision, entry.at]));
  const ops = entries.filter((entry) => entry.kind === "write").flatMap((entry) => entry.ops ?? []);
  let failed: Record<string, unknown> | undefined;
  const write = await openProject({ projectPath }).commitWrite(
    writeRequest("session_approve", id, input, ops),
    (candidate) => {
      if (main.revision.id === session.base_revision) {
        const revision = candidate.revision;
        Object.assign(candidate, structuredClone(current));
        candidate.revision = revision;
      } else {
        for (const entry of writes) {
          try {
            applyEdit(
              candidate,
              entry.ops as ({ op: string } & Record<string, unknown>)[],
              {},
              `${entry.parent}:${entry.idempotency_key}`,
              entry.timeline_id,
              session.approval === "manual",
              times.get(entry.parent ?? "") ?? session.base_created_at,
            );
          } catch (error) {
            failed = { revision: entry.revision, ops: entry.ops, reason: String(error) };
            throw error;
          }
        }
      }
    },
  );
  if (
    write.status === "rejected" &&
    write.error?.code !== "E_IDEMPOTENCY_MISMATCH" &&
    main.revision.id !== session.base_revision
  ) {
    const result = reject("session_approve", id, "E_CONFLICT", "Session replay failed");
    result.result = {
      failed_operations: failed ? [failed] : [{ ops, reason: write.error?.message ?? "Validation failed" }],
    };
    result.verification = write.verification;
    return result;
  }
  const result = { ...write, verb: "session_approve" } as Envelope;
  if (write.ok) {
    const pending = (session.decisions ?? []).filter((decision) => decision.state === "pending").length;
    if (pending)
      result.result = {
        ...result.result,
        warnings: [
          ...((result.result?.warnings as unknown[] | undefined) ?? []),
          { code: "W_DECISIONS_PENDING", count: pending, message: `${pending} decisions are still pending` },
        ],
      };
    session.state = "approved";
    session.updated_at = new Date().toISOString();
    session.decision_key = input.idempotency_key as string;
    session.decision_signature = signature(input);
    session.decision_envelope = result;
    try {
      await metadata(sessionPath, session);
    } catch (error) {
      return {
        ...result,
        ok: false,
        status: "committed_unverified",
        error: { code: "E_IO", message: String(error), retryable: false },
      };
    }
  }
  return result;
}
