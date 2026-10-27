import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { validateEnvelope, validateManifest } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;
let project: string;
let output: string;
let exporters: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-stale-dist-"));
  project = join(directory, "project.zcut.json");
  output = join(directory, "output");
  exporters = join(directory, "packages/exporters");
  await mkdir(output);
  await copyFile(join(root, "package.json"), join(directory, "package.json"));
  await copyFile(join(root, "fixtures/projects/std-25.zcut.json"), project);
  await cp(join(root, "schema"), join(directory, "schema"), { recursive: true });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "junction");
  for (const path of ["core/dist", "cli/src", "cli/dist", "exporters/src", "exporters/dist"]) {
    await cp(join(root, "packages", path), join(directory, "packages", path), { recursive: true });
  }
  await symlink(join(root, "packages/core/node_modules"), join(directory, "packages/core/node_modules"), "junction");
  // File copy times differ by platform; establish a fresh baseline explicitly.
  for (const name of ["index", "otio", "xmeml"]) {
    await utimes(join(exporters, `src/${name}.ts`), 1000, 1000);
    await utimes(join(exporters, `dist/${name}.js`), 2000, 2000);
  }
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function run(entry: "src" | "dist", dryRun = true, profile = "premiere-25-xmeml-5") {
  return spawnSync(
    process.execPath,
    [join(directory, `packages/cli/${entry}/index.${entry === "src" ? "ts" : "js"}`), "export", project, "--wait"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: "", ZSIR_OTIO_PYTHON: "" },
      input: JSON.stringify({
        base_revision: "rev_fixture_1",
        idempotency_key: "stale-dist",
        author: { kind: "agent", name: "test" },
        profile,
        output,
        accept_losses: true,
        dry_run: dryRun,
      }),
    },
  );
}

it.each(["src", "dist"] as const)("%s CLI rejects stale entry code before importing it", async (entry) => {
  await writeFile(join(exporters, "dist/index.js"), 'throw new Error("STALE CODE LOADED");');
  await utimes(join(exporters, "dist/index.js"), 2000, 2000);
  await utimes(join(exporters, "src/index.ts"), 3000, 3000);
  const result = run(entry, false);
  expect(result.status, result.stderr).toBe(1);
  const envelope = JSON.parse(result.stdout);
  expect(validateEnvelope(envelope).valid).toBe(true);
  expect(envelope).toMatchObject({ status: "failed", error: { code: "E_IO" } });
  expect(envelope.error.message).toContain("pnpm typecheck");
  expect(envelope.error.message).not.toContain("STALE CODE LOADED");
  expect(await readdir(output)).toEqual([]);
});

it.each(["otio", "xmeml"])("rejects a stale %s dependency even with a fresh entry", async (name) => {
  await utimes(join(exporters, `src/${name}.ts`), 3000, 3000);
  const result = run("src");
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "E_IO",
    message: expect.stringContaining(`${name}.ts`),
  });
});

it("rejects a missing compiled dependency with a build instruction", async () => {
  await rm(join(exporters, "dist/xmeml.js"));
  const result = run("dist");
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "E_IO",
    message: expect.stringContaining("pnpm typecheck"),
  });
});

it.each([
  ["premiere-25-xmeml-5", "1.13.0", false],
  ["resolve-18.5-otio", "1.12.0", true],
] as const)("exports %s with actual version %s (dist only: %s)", async (profile, version, distOnly) => {
  if (distOnly) await rm(join(exporters, "src"), { recursive: true });
  const result = run("dist", false, profile);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.status).toBe("applied");
  const manifest = JSON.parse(await readFile(join(envelope.result.package, "manifest.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(manifest.exporter).toEqual({ version, git_sha: "0000000" });
});
