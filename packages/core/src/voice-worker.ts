import { readJob } from "./jobs.ts";
import { runVoiceJob } from "./voice-jobs.ts";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Missing voice worker argument");
while (!(await readJob(path)).pid) await new Promise((resolve) => setTimeout(resolve, 10));
await runVoiceJob(path);
