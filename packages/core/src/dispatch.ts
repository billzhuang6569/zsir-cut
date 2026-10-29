import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkDirectFiles,
  DirectExportExists,
  type DirectProfile,
  directFiles,
  runDirectExport,
} from "./direct-export.ts";
import {
  defaultProfile,
  type Exporter,
  lossReport,
  PROFILES,
  type ProfileId,
  recordHandoffCheck,
  runExport,
} from "./export-framework.ts";
import { fingerprint } from "./fingerprint.ts";
import { jobPath, readJob, startExportJob, startPreviewJob, startTranscribeJob } from "./jobs.ts";
import { renderPreview, timelineFrames, viewTimeline } from "./preview.ts";
import { buildProject, type CreateProjectRequest } from "./project/create.ts";
import { applyEdit } from "./project/edit.ts";
import { diffProjectEntities } from "./project/entities.ts";
import { newId } from "./project/id.ts";
import { parseProject } from "./project/io.ts";
import { relinkMedia, validateProjectMedia } from "./project/media.ts";
import { ffprobe, mediaFromProbe, type Probe } from "./project/probe.ts";
import { type ValidationIssue, validateProjectSemantics } from "./project/semantics.ts";
import { runSession } from "./project/session.ts";
import {
  findIdempotentWrite,
  HistoryError,
  openProject,
  type WriteEnvelope,
  type WriteRequest,
} from "./project/store.ts";
import type { Author, Media } from "./project/types.ts";
import { add, compare, parseRational, rational } from "./rational.ts";
import { inspect, readTranscript } from "./read-views.ts";
import { normalizeCommand, validateCommand } from "./schema.ts";
import { AsrError, applyTranscription, invokeAsr, type TranscribeRequest, workerMilliseconds } from "./transcribe.ts";

export const VERBS = [
  "create_project",
  "inspect",
  "read_transcript",
  "validate",
  "diff",
  "import_media",
  "edit",
  "undo",
  "redo",
  "restore",
  "batch_status",
  "transcribe",
  "session_begin",
  "session_review",
  "session_approve",
  "session_reject",
  "session_ask",
  "session_answer",
  "render_preview",
  "view_timeline",
  "export",
  "record_handoff_check",
  "job_status",
] as const;
export type Verb = (typeof VERBS)[number];

export type Envelope = Omit<WriteEnvelope, "verb" | "verification" | "status"> & {
  verb: Verb;
  status: WriteEnvelope["status"] | "accepted" | "drafted";
  verification: { level: "none" | "L0" | "L1" | "L2"; passed: boolean; issues: ValidationIssue[] };
};

export interface DispatchOptions {
  probe?: Probe;
  exporter?: Exporter;
  exporterModule?: string;
  worker?: boolean;
  asrPython?: string;
  asrWorkerDirectory?: string;
  jobFile?: string;
  previewProjectPath?: string;
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

export function errorEnvelope(
  verb: Verb,
  requestId: string,
  status: "rejected" | "failed" | "conflict",
  code:
    | "E_VALIDATION"
    | "E_UNSUPPORTED"
    | "E_MIXED_DOMAIN"
    | "E_IO"
    | "E_INTERNAL"
    | "E_SESSION_STATE"
    | "E_NOT_FOUND"
    | "E_CONFLICT"
    | "E_IDEMPOTENCY_MISMATCH"
    | "E_BATCH_OPEN",
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
  verb: "export" | "edit" | "import_media" | "transcribe" | "undo" | "redo" | "restore",
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
      verb === "transcribe"
        ? [
            {
              media_id: input.media_id,
              source_channels: input.source_channels,
              range: input.range,
              language: input.language,
              engine: input.engine,
              hotwords: input.hotwords,
              rules: input.rules,
            },
          ]
        : verb === "import_media"
          ? [{ paths: input.paths, relink: input.relink }]
          : verb === "export"
            ? [{ profile: input.profile, overlay_id: input.overlay_id }]
            : verb === "edit"
              ? (input.ops as unknown[])
              : [],
    ...(typeof input.timeline_id === "string" ? { timeline_id: input.timeline_id } : {}),
    ...(typeof input.target === "string" ? { target: input.target } : {}),
    ...(typeof input.label === "string" ? { label: input.label } : {}),
    ...(typeof input.project === "string" ? { project: input.project } : {}),
    ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
    ...(input.dry_run === true ? { dry_run: true } : {}),
    ...(input.batch ? { batch: input.batch as NonNullable<WriteRequest["batch"]> } : {}),
    ...(typeof input.batch_id === "string" ? { batch_id: input.batch_id } : {}),
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

function limitBrief(output: Envelope): void {
  const brief = output.result as Record<string, unknown>;
  while (Buffer.byteLength(JSON.stringify(output), "utf8") > 16 * 1024) {
    const timelines = brief.timelines as {
      review_markers: unknown[];
      review_markers_truncated: boolean;
      tracks: unknown[];
      tracks_truncated: boolean;
    }[];
    const markers = timelines.find((item) => item.review_markers.length);
    if (markers) {
      markers.review_markers.pop();
      markers.review_markers_truncated = true;
      continue;
    }
    const media = brief.media as unknown[];
    if (media.length) {
      media.pop();
      brief.media_truncated = true;
      continue;
    }
    const tracks = timelines.find((item) => item.tracks.length);
    if (tracks) {
      tracks.tracks.pop();
      tracks.tracks_truncated = true;
      continue;
    }
    for (const [list, flag] of [
      ["transcripts", "transcripts_truncated"],
      ["timelines", "timelines_truncated"],
      ["sessions", "sessions_truncated"],
      ["recent_revisions", "recent_revisions_truncated"],
    ] as const) {
      const values = brief[list] as unknown[];
      if (values.length) {
        values.pop();
        brief[flag] = true;
        break;
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(output), "utf8") > 16 * 1024 &&
      !(brief.transcripts as unknown[]).length &&
      !timelines.length &&
      !(brief.sessions as unknown[]).length &&
      !(brief.recent_revisions as unknown[]).length
    )
      throw new Error("Brief metadata exceeds 16 KB");
  }
}

export async function dispatch(verb: Verb, input: unknown, options: DispatchOptions = {}): Promise<Envelope> {
  const requestId = newId("req_");
  input = normalizeCommand(verb, input);
  if (
    input &&
    typeof input === "object" &&
    "session_id" in input &&
    ![
      "edit",
      "undo",
      "redo",
      "session_review",
      "session_approve",
      "session_reject",
      "session_ask",
      "session_answer",
      "inspect",
      "read_transcript",
      "validate",
      "diff",
      "render_preview",
      "view_timeline",
      "batch_status",
    ].includes(verb)
  )
    return errorEnvelope(verb, requestId, "rejected", "E_SESSION_STATE", "Verb cannot enter a session");
  const check = validateCommand(verb, input);
  if (!check.valid)
    return errorEnvelope(
      verb,
      requestId,
      "rejected",
      "E_VALIDATION",
      check.errors
        .map(
          (item) =>
            `${item.instancePath || "/"}: ${item.message}${item.params.additionalProperty ? ` (${item.params.additionalProperty})` : ""}${item.params.unevaluatedProperty ? ` (${item.params.unevaluatedProperty})` : ""}`,
        )
        .join("; ") || "Invalid request",
    );
  const request = input as Request;
  if (
    verb !== "validate" &&
    verb !== "inspect" &&
    verb !== "read_transcript" &&
    verb !== "diff" &&
    verb !== "undo" &&
    verb !== "redo" &&
    verb !== "restore" &&
    verb !== "batch_status" &&
    verb !== "import_media" &&
    verb !== "transcribe" &&
    verb !== "edit" &&
    verb !== "render_preview" &&
    verb !== "view_timeline" &&
    verb !== "export" &&
    verb !== "record_handoff_check" &&
    verb !== "job_status" &&
    verb !== "create_project" &&
    !verb.startsWith("session_")
  )
    return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", `Verb ${verb} is not implemented`);
  try {
    if (verb === "create_project") {
      const create = request as unknown as CreateProjectRequest;
      return await openProject({ projectPath: create.project }).createProject(
        {
          verb,
          request_id: requestId,
          base_revision: "",
          idempotency_key: create.idempotency_key,
          author: create.author,
          ops: [create],
        },
        () => buildProject(create, options.probe ?? ffprobe),
      );
    }
    if (verb === "record_handoff_check") {
      const value = {
        status: request.status,
        at: new Date().toISOString(),
        ...(request.by ? { by: request.by } : {}),
        ...(request.host_version ? { host_version: request.host_version } : {}),
        ...(request.notes ? { notes: request.notes } : {}),
        ...(request.items ? { items: request.items } : {}),
      };
      const manifest = await recordHandoffCheck(
        request.package as string,
        request.check as "host_import" | "host_render_comparison",
        value,
      );
      const output = basic(verb, requestId);
      output.status = "applied";
      output.result = { manifest };
      return output;
    }
    if (verb === "job_status") {
      const parsed = parseProject(await readFile(request.project as string, "utf8"));
      if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      const output = basic(verb, requestId);
      output.result = (await readJob(
        jobPath(request.project as string, parsed.project.id, request.job_id as string),
      )) as unknown as Record<string, unknown>;
      return output;
    }
    let projectPath = request.project as string;
    const mediaProjectPath = projectPath;
    if (
      request.session_id !== undefined &&
      ["inspect", "read_transcript", "validate", "diff", "render_preview", "view_timeline"].includes(verb)
    ) {
      const main = parseProject(await readFile(projectPath, "utf8"));
      if (!main.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      const directory = join(
        dirname(resolve(projectPath)),
        ".zcut",
        main.project.id,
        "sessions",
        request.session_id as string,
      );
      try {
        await readFile(join(directory, "session.json"), "utf8");
        projectPath = join(directory, "draft.zcut.json");
        await stat(projectPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Session not found");
        throw error;
      }
    }
    if (verb === "render_preview" || verb === "view_timeline") {
      const extra = Object.keys(request).filter(
        (key) => !["project", "author", "session_id", "timeline_id", "output", "at_revision"].includes(key),
      );
      if (extra.length)
        return errorEnvelope(
          verb,
          requestId,
          "rejected",
          "E_UNSUPPORTED",
          `Unsupported preview fields: ${extra.join(", ")}`,
        );
      if (
        (request.timeline_id !== undefined && typeof request.timeline_id !== "string") ||
        (request.output !== undefined && (typeof request.output !== "string" || !request.output))
      )
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Invalid timeline_id or output");
      const parsed = parseProject(await readFile(options.previewProjectPath ?? projectPath, "utf8"));
      if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      const project =
        request.at_revision && !options.previewProjectPath
          ? await openProject({ projectPath }).snapshotAt(request.at_revision as string)
          : parsed.project;
      const timeline = project.timelines.find((item) => item.id === (request.timeline_id ?? project.timelines[0]?.id));
      if (!timeline) return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Timeline not found");
      if (timelineFrames(timeline) <= 0n)
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Timeline has no frames");
      const issues = validateProjectSemantics(project, parsed.issues);
      if (issues.some((issue) => issue.severity === "error"))
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project has validation errors");
      if (!options.worker) {
        const jobId = await startPreviewJob(verb, mediaProjectPath, project, request);
        const output = basic(verb, requestId);
        output.status = "accepted";
        output.result = { job_id: jobId };
        return output;
      }
      if (!options.jobFile) return errorEnvelope(verb, requestId, "failed", "E_INTERNAL", "Missing job path");
      const jobId = basename(dirname(options.jobFile));
      const directory = resolve((request.output as string | undefined) ?? dirname(options.jobFile));
      const safeName = (name: string) => name.replaceAll(/[\\/:*?"<>|]/g, "_");
      const result =
        verb === "render_preview"
          ? await renderPreview(project, timeline, mediaProjectPath, {
              output: join(directory, `${safeName(project.name)}_r${project.revision.seq}_preview_${jobId}.mov`),
              profile: "preview",
              exportId: jobId,
            })
          : await viewTimeline(project, timeline, mediaProjectPath, join(directory, `view_${jobId}`));
      const output = basic(verb, requestId);
      output.status = "applied";
      output.result = result;
      output.verification = { level: "L1", passed: true, issues };
      return output;
    }
    if (verb === "transcribe") {
      const parsed = parseProject(await readFile(request.project as string, "utf8"));
      if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      if (!options.worker) {
        const replay = await findIdempotentWrite(
          request.project as string,
          parsed.project.id,
          writeRequest("transcribe", requestId, request),
        );
        if (replay === "mismatch")
          return errorEnvelope(
            verb,
            requestId,
            "rejected",
            "E_IDEMPOTENCY_MISMATCH",
            "Idempotency key was used for another request",
          );
        if (replay) return replay;
        const batch = await openProject({ projectPath: request.project as string }).batchBlocker();
        if (batch) {
          const output = errorEnvelope(
            verb,
            requestId,
            "failed",
            "E_BATCH_OPEN",
            "A batch is open on this target",
            true,
          );
          if (output.error) output.error.details = batch;
          return output;
        }
      }
      if (!options.worker && request.base_revision !== parsed.project.revision.id)
        return errorEnvelope(verb, requestId, "conflict", "E_CONFLICT", "Base revision differs from current revision");
      if (request.dry_run === true)
        return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "Transcribe dry run is not supported");
      const media = parsed.project.media.find((item) => item.id === request.media_id);
      if (!media) return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Media not found");
      if (
        !media.audio ||
        ((request.source_channels as number[] | undefined)?.length !== undefined &&
          (request.source_channels as number[]).length !== 1)
      )
        return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "ASR worker requires one audio channel");
      if (((request.source_channels as number[] | undefined)?.[0] ?? 0) >= media.audio.channels)
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Source channel is unavailable");
      if (
        typeof request.language === "string" &&
        request.language !== "auto" &&
        !/^(zh|en)(-|$)/u.test(request.language)
      )
        return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "ASR worker supports Chinese and English");
      if (request.range) {
        const range = request.range as { start: string; duration: string };
        try {
          workerMilliseconds(range.start);
          workerMilliseconds(range.duration);
        } catch {
          return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "ASR range must use whole milliseconds");
        }
        const start = parseRational(range.start, true);
        const duration = parseRational(range.duration, true);
        if (compare(duration, rational(0n)) <= 0 || compare(add(start, duration), media.duration) > 0)
          return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "ASR range is outside media");
      }
      if (!options.worker) {
        const directory =
          options.asrWorkerDirectory ?? fileURLToPath(new URL("../../../workers/asr/", import.meta.url));
        const python = options.asrPython ?? resolve(directory, ".venv/bin/python");
        const jobId = await startTranscribeJob(
          request.project as string,
          parsed.project.id,
          request,
          python,
          directory,
        );
        const output = basic(verb, requestId);
        output.status = "accepted";
        output.result = { job_id: jobId };
        return output;
      }
      if (!options.jobFile || !options.asrPython || !options.asrWorkerDirectory)
        return errorEnvelope(verb, requestId, "failed", "E_INTERNAL", "Missing ASR worker configuration");
      try {
        const result = await invokeAsr(
          parsed.project,
          request as TranscribeRequest,
          join(dirname(options.jobFile), "asr-result.json"),
          options.asrPython,
          options.asrWorkerDirectory,
        );
        return await openProject({ projectPath: request.project as string }).commitWrite(
          writeRequest("transcribe", requestId, request),
          (project) => applyTranscription(project, request as TranscribeRequest, result),
          {},
          { warnings: result.warnings },
        );
      } catch (error) {
        if (error instanceof AsrError) {
          const output = errorEnvelope(verb, requestId, "failed", "E_INTERNAL", error.message, error.retryable);
          if (output.error) output.error.details = { code: error.code };
          return output;
        }
        throw error;
      }
    }
    if (verb === "export") {
      const parsed = parseProject(await readFile(request.project as string, "utf8"));
      if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      const project = parsed.project;
      if (request.profile === "subtitle-overlay") {
        const write = writeRequest("export", requestId, request);
        const replay = await findIdempotentWrite(request.project as string, project.id, write);
        if (replay === "mismatch")
          return errorEnvelope(
            verb,
            requestId,
            "rejected",
            "E_IDEMPOTENCY_MISMATCH",
            "Idempotency key was used for another export",
          );
        if (replay) return replay;
        if (request.base_revision !== project.revision.id)
          return errorEnvelope(verb, requestId, "conflict", "E_CONFLICT", "Base revision differs from project");
        const overlay = project.subtitle_overlays?.find((item) => item.id === request.overlay_id);
        if (!overlay) return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Overlay not found");
        const issues = validateProjectSemantics(project, parsed.issues);
        if (issues.some((issue) => issue.severity === "error"))
          return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project semantics are invalid");
        const output = basic(verb, requestId);
        if (request.dry_run) {
          output.status = "dry_run";
          output.result = { files: [{ path: overlay.output_path }] };
          return output;
        }
        const blocker = await openProject({ projectPath: request.project as string }).batchBlocker();
        if (blocker)
          return errorEnvelope(verb, requestId, "failed", "E_BATCH_OPEN", "A batch is open on this target", true);
        if (!options.worker) {
          const jobId = await startExportJob(request.project as string, project.id, request, "subtitle-overlay");
          output.status = "accepted";
          output.result = { job_id: jobId };
          return output;
        }
        const modulePath = new URL(
          import.meta.url.endsWith(".ts")
            ? "../../exporters/src/subtitle-overlay.ts"
            : "../../exporters/dist/subtitle-overlay.js",
          import.meta.url,
        );
        const { renderSubtitleOverlay } = await import(modulePath.href);
        const result: Record<string, unknown> = {};
        return await openProject({ projectPath: request.project as string }).commitWrite(
          write,
          async (candidate) => {
            const target = candidate.subtitle_overlays?.find((item) => item.id === request.overlay_id);
            if (!target) throw new HistoryError("E_NOT_FOUND");
            const rendered = await renderSubtitleOverlay(candidate, target, request.project as string);
            Object.assign(result, rendered);
            target.last_export = {
              revision_id: candidate.revision.id,
              created_at: new Date().toISOString(),
              size_bytes: rendered.files[0].size_bytes,
            };
          },
          {},
          result,
        );
      }
      if (request.base_revision !== project.revision.id)
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Base revision differs from project");
      if (request.profile === "direct-srt" || request.profile === "direct-audio-wav") {
        if (request.overlay === true)
          return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "Overlay export is not implemented");
        const timeline = project.timelines.find(
          (item) => item.id === (request.timeline_id ?? project.timelines[0]?.id),
        );
        if (!timeline) return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Timeline not found");
        const issues = validateProjectSemantics(project, parsed.issues);
        if (issues.some((item) => item.severity === "error"))
          return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project semantics are invalid");
        const profile: DirectProfile = request.profile;
        const files = directFiles(project, timeline, profile, request.subtitle_languages as string[] | undefined);
        const outputDirectory = resolve((request.output as string | undefined) ?? dirname(request.project as string));
        try {
          await checkDirectFiles(outputDirectory, files);
          const output = basic(verb, requestId);
          if (request.dry_run) {
            output.status = "dry_run";
            output.result = { files: files.map((file) => ({ name: file.name })) };
          } else if (!options.worker) {
            const jobId = await startExportJob(request.project as string, project.id, request, "direct");
            output.status = "accepted";
            output.result = { job_id: jobId };
          } else {
            const result = await runDirectExport(
              project,
              timeline,
              request.project as string,
              outputDirectory,
              profile,
              files,
            );
            output.status = "applied";
            output.result = result;
            output.verification = {
              level: "L1",
              passed: true,
              issues: [
                ...issues,
                ...result.warnings.map(({ code, severity, message, ids }) => ({ code, severity, message, ids })),
              ],
            };
          }
          return output;
        } catch (error) {
          if (error instanceof DirectExportExists)
            return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", error.message);
          throw error;
        }
      }
      const profile = (request.profile as ProfileId | undefined) ?? (await defaultProfile());
      if (!profile || !Object.hasOwn(PROFILES, profile))
        return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "No supported profile selected");
      if (request.overlay === true)
        return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "Overlay export is not implemented");
      const exporters = resolve(dirname(fileURLToPath(import.meta.url)), "../../exporters");
      const sourceModule = join(exporters, "src/index.ts");
      const distModule = join(exporters, "dist/index.js");
      const builtinModule = import.meta.url.endsWith(".ts") ? sourceModule : distModule;
      const exporterModule =
        options.exporterModule ??
        (profile === "fcp-11-fcpxml-1.13" ||
        profile === "fcp-10.6-fcpxml-1.11" ||
        profile === "resolve-21-fcpxml-1.11" ||
        profile === "resolve-18.5-otio" ||
        profile === "premiere-25-xmeml-5"
          ? builtinModule
          : undefined);
      let exporter = options.exporter;
      if (!exporter && exporterModule) {
        let loaded: Record<string, Exporter>;
        try {
          // Resolve explicit relative paths before TypeScript can rewrite their extensions.
          const moduleUrl =
            exporterModule.startsWith("./") || exporterModule.startsWith("../")
              ? new URL(exporterModule, import.meta.url).href
              : exporterModule;
          loaded = await import(isAbsolute(moduleUrl) ? pathToFileURL(moduleUrl).href : moduleUrl);
        } catch (error) {
          if (exporterModule === distModule && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND")
            throw new Error(`导出器编译产物缺失，请先在项目根目录运行 pnpm typecheck 构建后重试：${String(error)}`);
          throw error;
        }
        // Pass the selected exporter module to the job worker.
        exporter =
          exporterModule === sourceModule || exporterModule === distModule
            ? loaded[`${PROFILES[profile].format}Exporter`]
            : loaded.default;
      }
      if (!exporter)
        return errorEnvelope(
          verb,
          requestId,
          "rejected",
          "E_UNSUPPORTED",
          `Exporter for ${profile} is not implemented`,
        );
      const timeline = project.timelines.find((item) => item.id === (request.timeline_id ?? project.timelines[0]?.id));
      if (!timeline) return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Timeline not found");
      const report = await lossReport(
        project,
        profile,
        exporter,
        newId("exp_"),
        request.dry_run ? "preview" : "final",
        timeline,
        new Date().toISOString(),
        request.project as string,
      );
      if (report.summary.worst_severity === "error" && !request.accept_losses)
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Export has error-level losses");
      if (request.dry_run) {
        const output = basic(verb, requestId);
        output.status = "dry_run";
        output.result = report;
        return output;
      }
      if (!options.worker) {
        if (!exporterModule)
          return errorEnvelope(verb, requestId, "rejected", "E_UNSUPPORTED", "Exporter worker module is required");
        const jobId = await startExportJob(request.project as string, project.id, request, exporterModule);
        const output = basic(verb, requestId);
        output.status = "accepted";
        output.result = { job_id: jobId };
        return output;
      }
      const result = await runExport(
        project,
        request as unknown as Parameters<typeof runExport>[1],
        exporter,
        newId("exp_"),
        new Date().toISOString(),
        profile,
      );
      if (result.rejected)
        return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Export has error-level losses");
      const output = basic(verb, requestId);
      output.status = "applied";
      output.result = { package: result.package, report: result.report };
      const issues = validateProjectSemantics(project, parsed.issues);
      output.verification = { level: "L1", passed: !issues.some((item) => item.severity === "error"), issues };
      return output;
    }
    if (verb.startsWith("session_") || (request.session_id !== undefined && ["edit", "undo", "redo"].includes(verb)))
      return await runSession(verb, request, requestId);
    if (verb === "edit") {
      const ops = request.ops as ({ op: string } & Record<string, unknown>)[];
      const store = openProject({ projectPath: request.project as string });
      const entityOps: Record<string, string> = {};
      const result = {};
      const mutator = (project: Parameters<typeof applyEdit>[0]) =>
        applyEdit(
          project,
          ops,
          entityOps,
          `${request.base_revision}:${request.idempotency_key}`,
          request.timeline_id as string | undefined,
          false,
          undefined,
          result,
        );
      const write = writeRequest("edit", requestId, request);
      return request.dry_run === true
        ? await store.previewWrite(write, mutator, entityOps, result)
        : await store.commitWrite(write, mutator, entityOps, result);
    }
    if (verb === "undo" || verb === "redo" || verb === "restore") {
      const store = openProject({ projectPath: request.project as string });
      return await store[verb](writeRequest(verb, requestId, request));
    }
    if (verb === "import_media") return await importMedia(request, requestId, options.probe ?? ffprobe);
    if (verb === "batch_status") {
      const main = parseProject(await readFile(mediaProjectPath, "utf8"));
      if (!main.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
      const output = basic(verb, requestId);
      output.result = await openProject({
        projectPath,
        batchRoot: join(dirname(resolve(mediaProjectPath)), ".zcut", main.project.id),
      }).batchStatus(request.batch_id as string);
      return output;
    }
    if (verb === "diff") {
      const store = openProject({ projectPath });
      try {
        const current = parseProject(await readFile(projectPath, "utf8"));
        if (!current.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
        const from = await store.snapshotAt(request.from as string);
        const to = await store.snapshotAt((request.to as string | undefined) ?? current.project.revision.id);
        const result = basic(verb, requestId);
        result.result = { from: request.from, to: to.revision.id, changes: diffProjectEntities(from, to) };
        return result;
      } catch (error) {
        if (error instanceof HistoryError) return errorEnvelope(verb, requestId, "rejected", error.code, error.message);
        throw error;
      }
    }
    const parsed = parseProject(await readFile(projectPath, "utf8"));
    if (parsed.ok && request.at_revision)
      parsed.project = await openProject({ projectPath }).snapshotAt(request.at_revision as string);
    if (!parsed.ok) return errorEnvelope(verb, requestId, "rejected", "E_VALIDATION", "Project file is invalid");
    if (verb === "inspect" || verb === "read_transcript") {
      try {
        const output = basic(verb, requestId);
        output.result =
          verb === "inspect"
            ? await inspect(parsed.project, projectPath, request, mediaProjectPath)
            : readTranscript(parsed.project, request);
        if (verb === "inspect" && request.view === "brief") limitBrief(output);
        return output;
      } catch (error) {
        if (String(error).includes("E_NOT_FOUND:"))
          return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", String(error));
        throw error;
      }
    }
    const issues = validateProjectSemantics(parsed.project, parsed.issues);
    if (request.media === true)
      issues.push(...(await validateProjectMedia(parsed.project, dirname(resolve(mediaProjectPath)))));
    const output = basic(verb, requestId);
    output.verification = {
      level: request.media === true ? "L2" : "L1",
      passed: !issues.some((issue) => issue.severity === "error"),
      issues,
    };
    output.result = {};
    return output;
  } catch (error) {
    if (error instanceof HistoryError) return errorEnvelope(verb, requestId, "rejected", error.code, error.message);
    if (verb === "job_status" && (error as NodeJS.ErrnoException).code === "ENOENT")
      return errorEnvelope(verb, requestId, "rejected", "E_NOT_FOUND", "Job not found");
    const output = errorEnvelope(verb, requestId, "failed", "E_IO", String(error), true);
    if (output.error && (error as { reason?: string }).reason === "busy") output.error.details = { reason: "busy" };
    return output;
  }
}
