import { dispatch } from "./dispatch.js";
import { readJob, writeJob } from "./jobs.js";

const [path, python, workerDirectory] = process.argv.slice(2);
if (!path || !python || !workerDirectory) throw new Error("Missing transcribe worker arguments");
let job = await readJob(path);
while (!job.pid) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  job = await readJob(path);
}
job.state = "running";
job.progress = 0.1;
job.message = "转写中";
job.updated_at = new Date().toISOString();
await writeJob(path, job);
try {
  const output = await dispatch("transcribe", job.request, {
    worker: true,
    asrPython: python,
    asrWorkerDirectory: workerDirectory,
    jobFile: path,
  });
  job.state = output.ok ? "succeeded" : "failed";
  job.envelope = output;
  job.message = output.ok ? "完成" : (output.error?.message ?? "转写失败");
} catch (error) {
  job.state = "failed";
  job.message = String(error);
}
job.progress = 1;
job.updated_at = new Date().toISOString();
await writeJob(path, job);
