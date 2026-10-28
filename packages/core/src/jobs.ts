import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Envelope } from "./dispatch.ts";
import { newId } from "./project/id.ts";
import { serializeProject } from "./project/io.ts";
import type { Project } from "./project/types.ts";

export interface Job {
  job_id: string;
  verb: "export" | "transcribe" | "render_preview" | "view_timeline";
  request: Record<string, unknown>;
  state: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  created_at: string;
  updated_at: string;
  envelope: Envelope | null;
  pid?: number;
}
export function jobPath(project: string, projectId: string, jobId: string) {
  return join(dirname(resolve(project)), ".zcut", projectId, "jobs", jobId, "job.json");
}
export async function writeJob(path: string, job: Job) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`);
  await rename(temporary, path);
}
export async function readJob(path: string): Promise<Job> {
  let job = JSON.parse(await readFile(path, "utf8")) as Job;
  if ((job.state === "running" || job.state === "queued") && job.pid) {
    try {
      process.kill(job.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        // The worker may have committed its final envelope after our first read, then exited.
        job = JSON.parse(await readFile(path, "utf8")) as Job;
        if (job.state === "succeeded" || job.state === "failed") return job;
        job.state = "failed";
        job.progress = 1;
        job.message = "子进程意外退出";
        job.updated_at = new Date().toISOString();
        await writeJob(path, job);
      }
    }
  }
  return job;
}
export async function startExportJob(
  project: string,
  projectId: string,
  request: Record<string, unknown>,
  exporterModule: string,
) {
  const jobId = newId("job_");
  const path = jobPath(project, projectId, jobId);
  const now = new Date().toISOString();
  const job: Job = {
    job_id: jobId,
    verb: "export",
    request,
    state: "queued",
    progress: 0,
    message: "排队中",
    created_at: now,
    updated_at: now,
    envelope: null,
  };
  await writeJob(path, job);
  const worker = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./export-worker.ts" : "./export-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [worker, path, exporterModule], { stdio: "ignore", detached: true });
  child.unref();
  if (!child.pid) throw new Error("Failed to start export worker");
  job.pid = child.pid;
  await writeJob(path, job);
  return jobId;
}

export async function startPreviewJob(
  verb: "render_preview" | "view_timeline",
  projectPath: string,
  project: Project,
  request: Record<string, unknown>,
) {
  const jobId = newId("job_");
  const path = jobPath(projectPath, project.id, jobId);
  const now = new Date().toISOString();
  const job: Job = {
    job_id: jobId,
    verb,
    request,
    state: "queued",
    progress: 0,
    message: "排队中",
    created_at: now,
    updated_at: now,
    envelope: null,
  };
  await writeJob(path, job);
  // Render the revision accepted by this job even if the draft advances while queued.
  await writeFile(join(dirname(path), "project.zcut.json"), serializeProject(project));
  const worker = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./preview-worker.ts" : "./preview-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [worker, path], { stdio: "ignore", detached: true });
  child.unref();
  if (!child.pid) throw new Error("Failed to start preview worker");
  job.pid = child.pid;
  await writeJob(path, job);
  return jobId;
}

export async function startTranscribeJob(
  project: string,
  projectId: string,
  request: Record<string, unknown>,
  python: string,
  workerDirectory: string,
) {
  const jobId = newId("job_");
  const path = jobPath(project, projectId, jobId);
  const now = new Date().toISOString();
  const job: Job = {
    job_id: jobId,
    verb: "transcribe",
    request,
    state: "queued",
    progress: 0,
    message: "排队中",
    created_at: now,
    updated_at: now,
    envelope: null,
  };
  await writeJob(path, job);
  const runner = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./transcribe-worker.ts" : "./transcribe-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [runner, path, python, workerDirectory], { stdio: "ignore", detached: true });
  child.unref();
  if (!child.pid) throw new Error("Failed to start transcribe worker");
  job.pid = child.pid;
  await writeJob(path, job);
  return jobId;
}
