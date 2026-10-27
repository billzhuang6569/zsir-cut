#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dispatch, VERBS, type Verb } from "../../core/dist/index.js";

const codes: Record<string, number> = {
  applied: 0,
  dry_run: 0,
  drafted: 0,
  no_op: 0,
  accepted: 0,
  failed: 1,
  rejected: 2,
  conflict: 3,
  committed_unverified: 4,
};

async function main(): Promise<void> {
  let inputPath: string | undefined;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: { input: { type: "string" }, wait: { type: "boolean" } },
      allowPositionals: true,
    });
    inputPath = parsed.values.input;
    positionals = parsed.positionals;
  } catch {
    const verb = process.argv[2] as Verb;
    if (!VERBS.includes(verb)) throw new Error("Unknown verb");
    const envelope = await dispatch(verb, {});
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = codes[envelope.status];
    return;
  }
  const [verb, project] = positionals;
  if (!VERBS.includes(verb as Verb)) throw new Error("Unknown verb");
  let request: unknown;
  try {
    const text = inputPath
      ? await readFile(inputPath, "utf8")
      : await new Promise<string>((resolve, reject) => {
          let body = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk: string) => {
            body += chunk;
          });
          process.stdin.on("end", () => resolve(body));
          process.stdin.on("error", reject);
        });
    request = JSON.parse(text);
  } catch {
    request = undefined;
  }
  const input = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  let envelope = await dispatch(
    verb as Verb,
    verb === "record_handoff_check" && positionals.length === 1
      ? input
      : positionals.length === 2
        ? { ...input, project }
        : {},
    process.env.ZSIR_CUT_EXPORTER_MODULE ? { exporterModule: process.env.ZSIR_CUT_EXPORTER_MODULE } : {},
  );
  if (process.argv.includes("--wait") && envelope.status === "accepted" && project) {
    const jobId = (envelope.result as { job_id: string }).job_id;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await dispatch("job_status", { project, job_id: jobId });
      if (!status.ok) {
        envelope = status;
        break;
      }
      const job = status.result as { state: string; envelope: typeof envelope | null };
      if (job.state === "succeeded" || job.state === "failed") {
        envelope = job.envelope ?? {
          ...envelope,
          ok: false,
          status: "failed",
          error: { code: "E_IO", message: "Export worker exited unexpectedly", retryable: true },
          result: null,
        };
        break;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = codes[envelope.status];
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
