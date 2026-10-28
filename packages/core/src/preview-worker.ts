import { dirname, join } from "node:path";
import { dispatch } from "./dispatch.ts";
import { readJob, writeJob } from "./jobs.ts";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Missing preview worker argument");
let job = await readJob(path);
while (!job.pid) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  job = await readJob(path);
}
job.state = "running";
job.progress = 0.1;
job.message = "渲染中";
job.updated_at = new Date().toISOString();
await writeJob(path, job);
try {
  const output = await dispatch(job.verb, job.request, {
    worker: true,
    jobFile: path,
    previewProjectPath: join(dirname(path), "project.zcut.json"),
  });
  job.state = output.ok ? "succeeded" : "failed";
  job.envelope = output;
  job.message = output.ok ? "完成" : (output.error?.message ?? "渲染失败");
} catch (error) {
  job.state = "failed";
  job.message = String(error);
}
job.progress = 1;
job.updated_at = new Date().toISOString();
await writeJob(path, job);
