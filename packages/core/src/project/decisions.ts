import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { add, compare, parseRational } from "../rational.ts";
import { saveBatchFile } from "./batch.ts";
import { assertEditDomain, EditError } from "./edit.ts";
import { projectEntitySnapshots } from "./entities.ts";
import { newId } from "./id.ts";
import type { Decision } from "./session.ts";
import type { JournalEntry, WriteEnvelope, WriteRequest } from "./store.ts";
import { clipTimeMap } from "./time-map.ts";
import type { Project } from "./types.ts";

type Input = Record<string, unknown>;
type Op = { op: string } & Input;
type Ref = (
  | NonNullable<Decision["refs"]>[number]
  | {
      kind: "source";
      occurrence_id: string;
      media_id: string;
      source_start: string;
      duration: string;
    }
) & { missing?: boolean; moved?: boolean };
interface ProjectDecision extends Omit<Decision, "refs" | "options"> {
  refs?: Ref[];
  options: (Decision["options"][number] & { ops?: Op[]; label_after?: string })[];
  asked_at_revision: string;
  turn?: WriteRequest["turn"];
  execution?: { state: "none" | "applied" | "stale" | "failed"; revision?: string; error?: WriteEnvelope["error"] };
}

type Prepare = (entry: JournalEntry, envelope: WriteEnvelope) => Promise<void>;
interface Delivery {
  key: string;
  hash: string;
  at: string;
  output?: WriteEnvelope;
}
interface Pending {
  id: string;
  request: WriteRequest;
  replacement?: ProjectDecision;
  undo?: { entry: JournalEntry; output: WriteEnvelope };
  edit?: { entry: JournalEntry; output: WriteEnvelope };
}
interface DecisionFile {
  schema: "zsir-cut/decisions";
  version: 1;
  decisions: ProjectDecision[];
  deliveries?: Delivery[];
  pending?: Pending;
  seq?: number;
  executions?: Record<string, string[]>;
}

const pathFor = (projectPath: string, projectId: string) =>
  join(dirname(projectPath), ".zcut", projectId, "decisions.json");
async function read(path: string): Promise<DecisionFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DecisionFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schema: "zsir-cut/decisions", version: 1, decisions: [] };
  }
}
export async function readProjectDecisions(projectPath: string, project: Project) {
  const { decisions } = await read(pathFor(projectPath, project.id));
  const snapshots = decisions.some(({ refs }) => refs?.length) ? projectEntitySnapshots(project) : new Map();
  return decisions.map((decision) => withRefs(decision, project, undefined, undefined, snapshots));
}

function overlaps(
  ref: Extract<Ref, { kind: "source" }>,
  clip: { occurrence_id?: unknown; media_id?: unknown },
  points: ReturnType<typeof clipTimeMap>,
) {
  if (clip.occurrence_id !== ref.occurrence_id || clip.media_id !== ref.media_id) return false;
  const start = parseRational(ref.source_start, true);
  const end = add(start, parseRational(ref.duration, true));
  return points.slice(0, -1).some((point, index) => {
    const next = points[index + 1]?.source ?? point.source;
    const other = point.interp === "hold" ? point.source : next;
    const [low, high] = compare(point.source, other) <= 0 ? [point.source, other] : [other, point.source];
    return (
      compare(low, end) < 0 && (compare(high, start) > 0 || (compare(low, high) === 0 && compare(low, start) >= 0))
    );
  });
}

function sourceClips(project: Project, ref: Extract<Ref, { kind: "source" }>) {
  return project.timelines.flatMap((timeline) =>
    timeline.tracks.flatMap((track) =>
      track.kind === "subtitle" ? [] : track.clips.filter((clip) => overlaps(ref, clip, clipTimeMap(clip))),
    ),
  );
}

function withRefs(
  decision: ProjectDecision,
  project: Project,
  changed?: Set<string>,
  original?: Project,
  snapshots?: ReturnType<typeof projectEntitySnapshots>,
) {
  if (!decision.refs?.length) return { ...decision };
  const entities = snapshots ?? projectEntitySnapshots(project);
  return {
    ...decision,
    refs: decision.refs.map((ref): Ref => {
      if (ref.kind === "time") return ref;
      const ids = ref.kind === "entity" ? [ref.id] : sourceClips(project, ref).map((clip) => clip.id);
      const exists = ids.some((id) => entities.has(id));
      const affected =
        changed &&
        (ids.some((id) => changed.has(id)) ||
          (ref.kind === "source" &&
            (changed.has(ref.media_id) ||
              (original && sourceClips(original, ref).some((clip) => changed.has(clip.id))))));
      const { missing: _missing, moved, ...anchor } = ref;
      return { ...anchor, ...(exists ? (affected || moved ? { moved: true } : {}) : { missing: true }) };
    }),
  };
}

function references(ops: Op[]): Set<string> {
  const keys = new Set<string>();
  const idFields = new Set([
    "from_clip",
    "to_clip",
    "from_token",
    "to_token",
    "after_token",
    "cut_after",
    "carrier_tracks",
    "tracks",
    "video_track",
    "audio_track",
    "tokens",
    "id",
  ]);
  const collect = (value: Input) => {
    for (const [field, ref] of Object.entries(value)) {
      if (/_ids?$/.test(field) || idFields.has(field))
        for (const id of Array.isArray(ref) ? ref : [ref]) if (typeof id === "string") keys.add(id);
      if (["tokens", "range"].includes(field) && ref && typeof ref === "object" && !Array.isArray(ref))
        collect(ref as Input);
    }
    if (value.track_id && value.occurrence_id && value.cue_id)
      keys.add(`override:${value.track_id}:${value.occurrence_id}:${value.cue_id}`);
  };
  for (const op of ops) {
    collect(op);
    if (op.op === "set_recognition" || op.op.endsWith("_overlay")) keys.add("project");
  }
  return keys;
}

function decisionTimeline(project: Project, decision: ProjectDecision, keys: Set<string>) {
  if (project.timelines.length === 1) return {};
  const snapshots = projectEntitySnapshots(project);
  const timelines = new Set<string>();
  const locate = (key: string) => {
    let entity = snapshots.get(key);
    while (entity) {
      if (entity.entity === "timeline") {
        timelines.add(entity.value.id as string);
        return;
      }
      entity = entity.parent ? snapshots.get(entity.parent) : undefined;
    }
  };
  for (const key of keys) locate(key);
  if (!timelines.size) {
    for (const ref of decision.refs ?? []) {
      if (ref.kind === "entity") locate(ref.id);
      if (ref.kind === "source") for (const clip of sourceClips(project, ref)) locate(clip.id);
    }
  }
  const timeline_id = timelines.values().next().value;
  return timelines.size === 1 && timeline_id ? { timeline_id } : {};
}

interface Context {
  project: () => Promise<Project>;
  journal: () => Promise<JournalEntry[]>;
  snapshotAt: (revision: string) => Promise<Project>;
  append: (entry: JournalEntry) => Promise<void>;
  edit: (request: WriteRequest, ops: Op[], prepare?: Prepare, previewProject?: Project) => Promise<WriteEnvelope>;
  undo: (request: WriteRequest, prepare?: Prepare, projected?: (project: Project) => void) => Promise<WriteEnvelope>;
  clock: () => Date;
}
type Reply = (status: WriteEnvelope["status"], after?: string) => WriteEnvelope;

export async function projectDecisionStore(projectPath: string, projectId: string, ctx: Context) {
  const path = pathFor(projectPath, projectId);
  const file = await read(path);
  const save = () => saveBatchFile(path, file);
  const pendingCount = () => file.decisions.filter(({ state }) => state === "pending").length;
  let deliveries = file.deliveries ?? [];
  file.deliveries = deliveries;
  file.executions ??= {};
  const executions = file.executions;
  const replyFor =
    (request: WriteRequest, before: string): Reply =>
    (status, after) => ({
      ok: ["applied", "no_op", "dry_run"].includes(status),
      status,
      verb: request.verb,
      request_id: request.request_id,
      receipt: { before, after: after ?? null, idempotency_key: request.idempotency_key, replayed: false },
      changes: [],
      verification: { level: "none", passed: false, issues: [] },
      result: null,
      error: null,
    });
  const resultFor = (decision: ProjectDecision) => ({
    decision: structuredClone(decision),
    pending: pendingCount(),
    changed: [decision.id],
  });
  const retain = () => {
    const finished = file.decisions.filter(({ state }) => state !== "pending");
    const expired = new Set(finished.slice(0, Math.max(0, finished.length - 200)).map(({ id }) => id));
    file.decisions = file.decisions.filter(({ id }) => !expired.has(id));
    for (const id of expired) delete executions[id];
    const cutoff = ctx.clock().getTime() - 7 * 24 * 60 * 60 * 1000;
    deliveries = deliveries.filter(({ at }, index) => index >= deliveries.length - 1000 || Date.parse(at) >= cutoff);
    file.deliveries = deliveries;
  };
  const recover = async (prepared: Pending["edit"]) => {
    if (!prepared) return undefined;
    if (!(await ctx.journal()).some(({ revision }) => revision === prepared.entry.revision)) {
      if ((await ctx.project()).revision.id !== prepared.entry.revision) return undefined;
      await ctx.append(prepared.entry);
    }
    return prepared.output;
  };

  async function execute(decision: ProjectDecision, work: Pending, previewProject?: Project): Promise<WriteEnvelope> {
    const request = work.request;
    const current = previewProject ?? (await ctx.project());
    const reply = replyFor(request, current.revision.id);
    const option = decision.options.find(({ id }) => id === decision.answer?.option_id);
    let out = reply(request.dry_run ? "dry_run" : "no_op");
    const ignored = executions[decision.id] ?? [];
    executions[decision.id] = ignored;
    if (work.undo) {
      const undo = await recover(work.undo);
      if (!undo) throw new Error("Decision undo was not committed");
      ignored.push(work.undo.entry.revision);
    }
    const applied = await recover(work.edit);
    if (applied && work.edit) {
      ignored.push(work.edit.entry.revision);
      decision.execution = { state: "applied", revision: work.edit.entry.revision };
      out = applied;
    } else if (!option?.ops) {
      decision.execution = { state: "none" };
    } else {
      const journal = await ctx.journal();
      const baseSeq =
        journal.find(({ revision }) => revision === decision.asked_at_revision)?.seq ??
        (journal.find(({ parent }) => parent === decision.asked_at_revision)?.seq ?? 1) - 1;
      const following = journal.filter(({ revision, seq }) => !ignored.includes(revision) && seq > baseSeq);
      const keys = references(option.ops);
      const changes = following.flatMap(({ changes }) => changes ?? []);
      const changed = new Set(
        changes
          .filter(
            ({ key, before, after }) =>
              keys.has(key) ||
              (typeof before?.occurrence_id === "string" && keys.has(before.occurrence_id)) ||
              (typeof after?.occurrence_id === "string" && keys.has(after.occurrence_id)),
          )
          .map(({ key }) => key),
      );
      const unknown =
        current.revision.id !== decision.asked_at_revision &&
        ((!baseSeq && !journal.some(({ parent }) => parent === decision.asked_at_revision)) ||
          current.revision.seq > (journal.at(-1)?.seq ?? 1) ||
          following.some(({ changes }) => !changes));
      if (unknown || changed.size) {
        decision.execution = { state: "stale" };
        const original = await ctx.snapshotAt(decision.asked_at_revision).catch(() => undefined);
        Object.assign(decision, withRefs(decision, current, changed, original));
      } else {
        const editRequest: WriteRequest = {
          ...request,
          verb: "edit",
          base_revision: current.revision.id,
          idempotency_key: `decision-edit:${request.idempotency_key}`,
          ...(decision.turn ? { turn: decision.turn } : {}),
          label: option.label_after ?? `按你的选择：${option.label}`,
          ops: option.ops,
          ...decisionTimeline(current, decision, keys),
        };
        if (!decision.turn) delete editRequest.turn;
        out = await ctx.edit(
          editRequest,
          option.ops,
          request.dry_run
            ? undefined
            : async (entry, output) => {
                work.edit = { entry, output };
                await save();
              },
          previewProject,
        );
        if (!out.ok && out.status !== "committed_unverified") {
          decision.execution = { state: "failed", error: out.error };
          out.status = "rejected";
        } else if (out.ok && out.receipt?.after) {
          ignored.push(out.receipt.after);
          decision.execution = { state: "applied", revision: out.receipt.after };
        } else if (out.ok) decision.execution = { state: "none" };
      }
    }
    Object.assign(decision, withRefs(decision, request.dry_run ? current : await ctx.project()));
    const revisions = [work.undo?.entry.revision, out.receipt?.after].filter(Boolean);
    return {
      ...out,
      verb: request.verb,
      request_id: request.request_id,
      receipt: out.receipt
        ? {
            ...out.receipt,
            idempotency_key: request.idempotency_key,
          }
        : null,
      result: { ...out.result, ...resultFor(decision), ...(revisions.length ? { revisions } : {}) },
    };
  }

  async function finish(decision: ProjectDecision, work: Pending) {
    const output = await execute(decision, work);
    if (output.status === "committed_unverified") return output;
    const delivery = deliveries.find(({ key }) => key === work.request.idempotency_key);
    if (delivery) delivery.output = output;
    delete file.pending;
    retain();
    await save();
    return output;
  }

  return {
    check(key: string, hash: string) {
      const delivery = deliveries.find(({ key: candidate }) => candidate === key);
      if (!delivery) return undefined;
      return delivery.hash === hash ? delivery.output : "mismatch";
    },
    async resume() {
      const work = file.pending;
      // An undo prepared before the project replacement has no effect if that replacement never happened.
      if (work?.undo && !(await recover(work.undo))) {
        delete file.pending;
        const index = deliveries.findIndex(({ key }) => key === work.request.idempotency_key);
        if (index >= 0) deliveries.splice(index, 1);
        await save();
      } else if (work) {
        const index = file.decisions.findIndex(({ id }) => id === work.id);
        const decision = work.replacement ?? file.decisions[index];
        if (index < 0 || !decision) throw new Error("Pending decision not found");
        file.decisions[index] = decision;
        const output = await finish(decision, work);
        if (output.status === "committed_unverified") throw new Error("Decision execution is awaiting recovery");
      }
      for (const decision of file.decisions) {
        if (decision.state !== "answered" || decision.execution || !decision.answer) continue;
        const current = await ctx.project();
        const request: WriteRequest = {
          verb: "answer",
          author: decision.answer.author,
          ops: [],
          request_id: newId("req_"),
          base_revision: current.revision.id,
          idempotency_key: `recover:${decision.id}:${decision.answer.at}`,
          project: projectPath,
        };
        file.pending = { id: decision.id, request };
        await save();
        const output = await finish(decision, file.pending);
        if (output.status === "committed_unverified") throw new Error("Decision execution is awaiting recovery");
      }
    },
    async handle(request: WriteRequest, input: Input, hash: string, project: Project) {
      const reply = replyFor(request, project.revision.id);
      const reject = (code: NonNullable<WriteEnvelope["error"]>["code"], message: string) => ({
        ...reply("rejected"),
        error: { code, message, retryable: false },
      });
      const delivery = { key: request.idempotency_key, hash, at: ctx.clock().toISOString() };
      if (request.verb === "ask") {
        const additions = input.decisions as (Omit<
          ProjectDecision,
          "id" | "seq" | "state" | "created_by" | "asked_at_revision"
        > & { id?: string })[];
        if (pendingCount() + additions.length > 50)
          return reject("E_VALIDATION", "A project can contain at most 50 pending decisions");
        const ids = new Set(file.decisions.map(({ id }) => id));
        const optionIds = new Set(file.decisions.flatMap(({ options }) => options.map(({ id }) => id)));
        let seq = file.seq ?? file.decisions.at(-1)?.seq ?? 0;
        const created: ProjectDecision[] = [];
        for (const addition of additions) {
          const id = addition.id ?? newId("dec_");
          if (ids.has(id)) return reject("E_VALIDATION", "Decision IDs must be unique in a project");
          ids.add(id);
          for (const [index, option] of addition.options.entries()) {
            if (optionIds.has(option.id) || (index !== 0 && option.recommended))
              return reject("E_VALIDATION", "Option IDs must be unique and only the first option may be recommended");
            optionIds.add(option.id);
            if (option.ops) {
              try {
                assertEditDomain(
                  option.ops,
                  project.timelines.flatMap(({ tracks }) => tracks),
                );
              } catch (error) {
                if (!(error instanceof EditError)) throw error;
                return reject(error.code, error.message);
              }
            }
          }
          if (addition.refs?.some((ref) => ref.kind === "source" && ref.duration === "0s"))
            return reject("E_VALIDATION", "Source reference duration must be positive");
          created.push({
            ...addition,
            id,
            seq: ++seq,
            allow_other: addition.allow_other ?? true,
            state: "pending",
            created_by: request.author,
            asked_at_revision: request.base_revision,
            ...(request.turn ? { turn: request.turn } : {}),
          });
        }
        const output = reply(request.dry_run ? "dry_run" : "no_op");
        const changed = created.map(({ id }) => id);
        output.result = { decision_ids: changed, changed, pending: pendingCount() + created.length };
        if (!request.dry_run) {
          file.decisions.push(...created);
          file.seq = seq;
          deliveries.push({ ...delivery, output });
          retain();
          await save();
        }
        return output;
      }
      const index = file.decisions.findIndex(({ id }) => id === input.decision_id);
      const previous = file.decisions[index];
      if (!previous) return reject("E_NOT_FOUND", "Decision not found");
      if (input.option_id !== undefined && !previous.options.some(({ id }) => id === input.option_id))
        return reject("E_NOT_FOUND", "Option not found in this decision");
      if (input.text !== undefined && !previous.allow_other)
        return reject("E_VALIDATION", "This decision does not allow a text answer");
      const decision = structuredClone(previous);
      delete decision.execution;
      delete decision.answer;
      decision.refs?.forEach((ref) => {
        delete ref.missing;
        delete ref.moved;
      });
      decision.state = input.skip ? "skipped" : "answered";
      if (!input.skip)
        decision.answer = {
          ...(typeof input.option_id === "string" ? { option_id: input.option_id } : { text: input.text as string }),
          author: request.author,
          at: delivery.at,
        };
      const work: Pending = { id: decision.id, request };
      const previousRevision = previous.execution?.revision;
      if (previousRevision) {
        const ownRevisions = executions[decision.id] ?? [];
        if (!ownRevisions.includes(previousRevision)) ownRevisions.push(previousRevision);
        executions[decision.id] = ownRevisions;
      }
      if (request.dry_run) {
        if (!previousRevision) return execute(decision, work);
        let projected = project;
        const undo = await ctx.undo({ ...request, verb: "undo", target: previousRevision }, undefined, (candidate) => {
          projected = candidate;
        });
        if (!undo.ok) return { ...undo, verb: request.verb };
        const output = await execute(decision, work, projected);
        return { ...output, changes: [...undo.changes, ...output.changes] };
      }
      const stage = () => {
        if (!work.undo) file.decisions[index] = decision;
        deliveries.push(delivery);
        file.pending = work;
        return save();
      };
      if (previousRevision) {
        const undo = await ctx.undo(
          {
            ...request,
            verb: "undo",
            target: previousRevision,
            ...(decision.turn ? { turn: decision.turn } : {}),
            idempotency_key: `decision-undo:${request.idempotency_key}`,
          },
          async (entry, output) => {
            work.undo = { entry, output };
            work.replacement = decision;
            await stage();
          },
        );
        if (!undo.ok)
          return {
            ...undo,
            verb: request.verb,
            receipt: undo.receipt ? { ...undo.receipt, idempotency_key: request.idempotency_key } : null,
          };
        if (!work.undo) await stage();
        else {
          file.decisions[index] = decision;
          await save();
        }
      } else await stage();
      return finish(decision, work);
    },
  };
}
