#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Verb } from "../../core/dist/index.js";

const { dispatch, errorEnvelope, newId, parseProject, VERBS }: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

const { jobPath, readJob }: typeof import("../../core/dist/jobs.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/jobs.ts" : "../../core/dist/jobs.js", import.meta.url).href
);

const codes: Record<string, number> = {
  applied: 0,
  dry_run: 0,
  drafted: 0,
  no_op: 0,
  accepted: 0,
  queued: 0,
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
  } catch (error) {
    const verb = process.argv[2] as Verb;
    if (!VERBS.includes(verb)) throw new Error("Unknown verb");
    const envelope = errorEnvelope(verb, newId("req_"), "rejected", "E_VALIDATION", String(error));
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = codes[envelope.status];
    return;
  }
  const [verb, positionalProject] = positionals;
  if (!VERBS.includes(verb as Verb)) throw new Error("Unknown verb");
  const reject = (message: string) => {
    const envelope = errorEnvelope(verb as Verb, newId("req_"), "rejected", "E_VALIDATION", message);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = codes[envelope.status];
  };
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
  } catch (error) {
    reject(`无法读取请求${inputPath ? ` ${inputPath}` : ""}：${String(error)}`);
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    reject("请求必须是 JSON 对象");
    return;
  }
  const input = request as Record<string, unknown>;
  if (positionals.length > 2) {
    reject("工程路径只能指定一次");
    return;
  }
  if (positionalProject && input.project !== undefined && positionalProject !== input.project) {
    reject(`工程路径不一致：${positionalProject}；请求 project：${String(input.project)}`);
    return;
  }
  const project = positionalProject ?? input.project;
  if (verb !== "record_handoff_check" && (project === undefined || project === "")) {
    reject("缺少工程路径");
    return;
  }
  let envelope = await dispatch(
    verb as Verb,
    verb === "record_handoff_check" && positionals.length === 1 ? input : { ...input, project },
    process.env.ZSIR_CUT_EXPORTER_MODULE ? { exporterModule: process.env.ZSIR_CUT_EXPORTER_MODULE } : {},
  );
  if (process.argv.includes("--wait") && envelope.status === "accepted" && project) {
    const jobId = (envelope.result as { job_id: string }).job_id;
    try {
      const parsed = parseProject(await readFile(project as string, "utf8"));
      if (!parsed.ok) throw new Error("Project file is invalid");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const job = await readJob(jobPath(project as string, parsed.project.id, jobId));
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
    } catch (error) {
      envelope = errorEnvelope("job_status", newId("req_"), "failed", "E_IO", String(error));
    }
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = codes[envelope.status];
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
