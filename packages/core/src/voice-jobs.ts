import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type DispatchOptions, dispatch } from "./dispatch.ts";
import { type Job, jobPath, readJob, writeJob } from "./jobs.ts";
import { newId } from "./project/id.ts";
import { voiceDataPath } from "./voice-storage.ts";

export const voiceJobPath = (id: string) => voiceDataPath("jobs", id, "job.json");
export async function startVoiceJob(
  request: Record<string, unknown>,
  launch?: (path: string) => Promise<void>,
  project?: { path: string; id: string },
) {
  const id = newId("job_");
  const path = project ? jobPath(project.path, project.id, id) : voiceJobPath(id);
  const now = new Date().toISOString();
  const job: Job = {
    job_id: id,
    verb: project ? "voice_generate" : "voice_clone",
    request,
    state: "queued",
    progress: 0,
    message: "排队中",
    created_at: now,
    updated_at: now,
    envelope: null,
  };
  await writeJob(path, job);
  if (launch) await launch(path);
  else {
    const worker = fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "./voice-worker.ts" : "./voice-worker.js", import.meta.url),
    );
    const child = spawn(process.execPath, [worker, path], { stdio: "ignore", detached: true });
    child.unref();
    if (!child.pid) throw new Error("Cannot start voice worker");
    job.pid = child.pid;
    await writeJob(path, job);
  }
  return id;
}
export async function runVoiceJob(path: string, options: DispatchOptions = {}) {
  const job = await readJob(path);
  job.state = "running";
  job.progress = 0.1;
  job.message = job.verb === "voice_generate" ? "生成中" : "克隆中";
  job.updated_at = new Date().toISOString();
  await writeJob(path, job);
  const output = await dispatch(job.verb, job.request, { ...options, worker: true });
  job.state = output.ok ? "succeeded" : "failed";
  job.envelope = output;
  job.message = output.ok ? "完成" : (output.error?.message ?? "克隆失败");
  job.progress = 1;
  job.updated_at = new Date().toISOString();
  await writeJob(path, job);
}
