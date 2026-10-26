import { readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fingerprint } from "./fingerprint.js";
import { applyEdit, SUBTITLE_OPS } from "./project/edit.js";
import { newId } from "./project/id.js";
import { parseProject } from "./project/io.js";
import { relinkMedia, validateProjectMedia } from "./project/media.js";
import { ffprobe, mediaFromProbe, type Probe } from "./project/probe.js";
import { type ValidationIssue, validateProjectSemantics } from "./project/semantics.js";
import { openProject, type WriteEnvelope, type WriteRequest } from "./project/store.js";
import type { Author, Media } from "./project/types.js";
import { validateCommand } from "./schema.js";

export const VERBS = [
  "inspect",
  "read_transcript",
  "validate",
  "diff",
  "import_media",
  "edit",
  "undo",
  "redo",
  "transcribe",
  "session_begin",
  "session_review",
  "session_approve",
  "session_reject",
  "render_preview",
  "view_timeline",
  "export",
  "record_handoff_check",
  "job_status",
] as const;
export type Verb = (typeof VERBS)[number];

export type Envelope = Omit<WriteEnvelope, "verb" | "verification"> & {
  verb: Verb;
  verification: { level: "none" | "L0" | "L1" | "L2"; passed: boolean; issues: ValidationIssue[] };
};

export interface DispatchOptions {
  probe?: Probe;
}

type Request = Record<string, unknown>;

function basic(verb: Verb, requestId: string): Envelope {
  return {
    ok: true,
    status: "no_op",
    verb,
    request_id: requestId,
    receipt: null,
    changes: [],
    verification: { level: "none", passed: false, issues: [] },
    result: null,
    error: null,
  };
}

function errorEnvelope(
  verb: Verb,
  requestId: string,
  status: "rejected" | "failed",
  code: "E_VALIDATION" | "E_UNSUPPORTED" | "E_MIXED_DOMAIN" | "E_IO" | "E_INTERNAL",
  message: string,
  retryable = false,
): Envelope {
  const output = basic(verb, requestId);
  output.ok = false;
  output.status = status;
  output.error = { code, message, retryable };
  return output;
}

function writeRequest(
  verb: "edit" | "import_media" | "undo" | "redo",
  requestId: string,
  input: Request,
): WriteRequest {
  return {
    verb,
    request_id: requestId,
    base_revision: input.base_revision as string,
    idempotency_key: input.idempotency_key as string,
    author: input.author as Author,
    ops:
      verb === "import_media"
        ? [{ paths: input.paths, relink: input.relink }]
        : verb === "edit"
          ? (input.ops as unknown[])
          : [],
    ...(typeof input.timeline_id === "string" ? { timeline_id: input.timeline_id } : {}),
    ...(typeof input.target === "string" ? { target: input.target } : {}),
  };
}

async function importMedia(input: Request, requestId: string, probe: Probe): Promise<Envelope> {
  const projectPath = input.project as string;
  const directory = dirname(resolve(projectPath));
  const parsed = parseProject(await readFile(projectPath, "utf8"));
  if (!parsed.ok)
    return errorEnvelope("import_media", requestId, "rejected", "E_VALIDATION", "Project file is invalid");
  const store = openProject({ projectPath });
  const request = writeRequest("import_media", requestId, input);
  if (input.relink) {
    const relink = input.relink as { search_roots: string[]; media_ids?: string[] };
    const found = await relinkMedia(parsed.project, directory, relink.search_roots, relink.media_ids);
    const paths = new Map(found.relinked.map((item) => [item.media_id, item.new_path]));
    return store.commitWrite(
      request,
      (project) => {
        for (const media of project.media) {
          const path = paths.get(media.id);
          if (path) media.path = path;
        }
      },
      undefined,
      { relinked: found.relinked, not_found: found.not_found, skipped: found.skipped },
    );
  }
  const created: Media[] = [];
  const skipped: { media_id: string }[] = [];
  for (const path of input.paths as string[]) {
    const absolute = resolve(directory, path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Not a file: ${path}`);
    const digest = await fingerprint(absolute);
    const existing = [...parsed.project.media, ...created].find(
      (item) => item.size_bytes === info.size && item.fingerprint.value === digest.value,
    );
    if (existing) {
      skipped.push({ media_id: existing.id });
      continue;
    }
    const detected = mediaFromProbe(absolute, await probe(absolute));
    created.push({
      id: newId("med_"),
      name: basename(absolute),
      path: relative(directory, absolute).split("\\").join("/"),
      original_path: absolute,
      size_bytes: info.size,
      fingerprint: digest,
      ...detected,
    });
  }
  return store.commitWrite(
    request,
    (project) => {
      project.media.push(...created);
    },
    undefined,
    { imported: created.map((media) => ({ media_id: media.id })), skipped },
  );
}

export async function dispatch(verb: Verb, input: unknown, options: DispatchOptions = {}): Promise<Envelope> {
  const requestId = newId("req_");
  const check = validateCommand(verb, input);
  if (!check.valid)
    return errorEnvelope(
      verb,
      requestId,
      "rejected",
      "E_VALIDATION",
      check.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ") || "Invalid request",
    );
  const request = input as Request;
  if (verb !== "validate" && verb !== "undo" && verb !== "redo" && verb !== "import_media" && verb !== "edit")
    return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", `Verb ${verb} is not implemented`);
  try {
    if (verb === "edit") {
      const ops = request.ops as ({ op: string } & Record<string, unknown>)[];
      if (ops.some((op) => SUBTITLE_OPS.has(op.op)) && !ops.every((op) => SUBTITLE_OPS.has(op.op)))
        return errorEnvelope(
          "edit",
          requestId,
          "rejected",
          "E_MIXED_DOMAIN",
          "Editing and subtitle operations cannot be mixed",
        );
      const store = openProject({ projectPath: request.project as string });
      const entityOps: Record<string, string> = {};
      const mutator = (project: Parameters<typeof applyEdit>[0]) =>
        applyEdit(
          project,
          ops,
          entityOps,
          `${request.base_revision}:${request.idempotency_key}`,
          request.timeline_id as string | undefined,
        );
      const write = writeRequest("edit", requestId, request);
      return request.dry_run === true
        ? await store.previewWrite(write, mutator, entityOps)
        : await store.commitWrite(write, mutator, entityOps);
    }
    if (verb === "undo" || verb === "redo") {
      const store = openProject({ projectPath: request.project as string });
      return await store[verb](writeRequest(verb, requestId, request));
    }
    if (verb === "import_media") return await importMedia(request, requestId, options.probe ?? ffprobe);
    const parsed = parseProject(await readFile(request.project as string, "utf8"));
    if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
    const issues = validateProjectSemantics(parsed.project, parsed.issues);
    if (request.media === true)
      issues.push(...(await validateProjectMedia(parsed.project, dirname(resolve(request.project as string)))));
    const output = basic(verb, requestId);
    output.verification = {
      level: request.media === true ? "L2" : "L1",
      passed: !issues.some((issue) => issue.severity === "error"),
      issues,
    };
    output.result = {};
    return output;
  } catch (error) {
    return errorEnvelope(verb, requestId, "failed", "E_IO", String(error), true);
  }
}
