import { dispatch } from "./dispatch.ts";
import { readJob, writeJob } from "./jobs.ts";

const [path, modulePath] = process.argv.slice(2);
if (!path || !modulePath) throw new Error("Missing export worker arguments");
let job = await readJob(path);
while (!job.pid) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  job = await readJob(path);
}
job.state = "running";
job.progress = 0.1;
job.message = "导出中";
job.updated_at = new Date().toISOString();
await writeJob(path, job);
try {
  const output = await dispatch("export", job.request, { worker: true, exporterModule: modulePath });
  job.state = output.ok ? "succeeded" : "failed";
  job.envelope = output;
  job.message = output.ok ? "完成" : (output.error?.message ?? "导出失败");
} catch (error) {
  job.state = "failed";
  job.message = String(error);
}
job.progress = 1;
job.updated_at = new Date().toISOString();
await writeJob(path, job);
