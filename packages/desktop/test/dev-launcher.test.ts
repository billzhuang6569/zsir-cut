import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("passes the chosen absolute project to both startup commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcut-launch-"));
  const capture = join(dir, "calls.jsonl");
  writeFileSync(
    join(dir, "pnpm"),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),project:process.env.ZCUT_PROJECT})+'\\n');`,
    { mode: 0o755 },
  );
  try {
    for (const [args, project, expected] of [
      [[], "", "examples/interview.zcut.json"],
      [[], "fixtures/env project.zcut.json", "fixtures/env project.zcut.json"],
      [["--", "fixtures/参数 工程.zcut.json"], "ignored", "fixtures/参数 工程.zcut.json"],
    ] as const) {
      writeFileSync(capture, "");
      const result = spawnSync(process.execPath, ["apps/desktop-tauri/dev.mjs", ...args], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, ZCUT_PROJECT: project },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { args: ["typecheck"], project: resolve(expected) },
        { args: ["--filter", "@zsir-cut/desktop-tauri", "dev"], project: resolve(expected) },
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
