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
      options: { input: { type: "string" } },
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
  const envelope = await dispatch(verb as Verb, positionals.length === 2 ? { ...input, project } : {});
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = codes[envelope.status];
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
