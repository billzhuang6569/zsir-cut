import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Envelope, validateEnvelope, validateManifest } from "../src/index.js";

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
  for (const path of ["core/src", "core/dist", "cli/dist", "exporters/src", "exporters/dist"]) {
    await cp(join(root, "packages", path), join(directory, "packages", path), { recursive: true });
  }
  await symlink(join(root, "packages/core/node_modules"), join(directory, "packages/core/node_modules"), "junction");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const request = (dryRun = true, profile = "premiere-25-xmeml-5") => ({
  project,
  base_revision: "rev_fixture_1",
  idempotency_key: "dist-guard",
  author: { kind: "agent", name: "test" },
  profile,
  output,
  accept_losses: true,
  dry_run: dryRun,
});

async function sourceDispatch() {
  return (await import(join(directory, "packages/core/src/dispatch.ts")))
    .dispatch as typeof import("../src/dispatch.js").dispatch;
}

function run(dryRun = true, profile = "premiere-25-xmeml-5") {
  return spawnSync(process.execPath, [join(directory, "packages/cli/dist/index.js"), "export", project, "--wait"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: "", ZSIR_OTIO_PYTHON: "" },
    input: JSON.stringify(request(dryRun, profile)),
  });
}

it("loads source exporters when core runs from TypeScript even if dist is broken", async () => {
  await writeFile(join(exporters, "dist/index.js"), 'throw new Error("STALE CODE LOADED");');
  const dispatch = await sourceDispatch();
  for (const profile of ["fcp-11-fcpxml-1.13", "resolve-18.5-otio", "premiere-25-xmeml-5"]) {
    const envelope = await dispatch("export", request(true, profile));
    expect(validateEnvelope(envelope).valid).toBe(true);
    expect(envelope.status, JSON.stringify(envelope.error)).toBe("dry_run");
  }
  expect(await readdir(output)).toEqual([]);
});

it("loads source exporters without exporters dist", async () => {
  await rm(join(exporters, "dist"), { recursive: true });
  const dispatch = await sourceDispatch();
  expect((await dispatch("export", request())).status).toBe("dry_run");
});

it("ignores unchanged source file touches in source and compiled runtimes", async () => {
  const source = join(exporters, "src/xmeml.ts");
  const original = await readFile(source);
  await utimes(source, 4102444800, 4102444800);
  expect(await readFile(source)).toEqual(original);
  const dispatch = await sourceDispatch();
  expect((await dispatch("export", request())).status).toBe("dry_run");
  const result = run();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("dry_run");
});

it("loads only dist exporters from the compiled CLI even if source is broken", async () => {
  await writeFile(join(exporters, "src/index.ts"), 'throw new Error("SOURCE CODE LOADED");');
  const result = run();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("dry_run");
});

it.each(["index", "otio", "xmeml"])("reports missing compiled %s with a build instruction", async (name) => {
  await rm(join(exporters, `dist/${name}.js`));
  const result = run(false);
  expect(result.status, result.stderr).toBe(1);
  const envelope = JSON.parse(result.stdout);
  expect(validateEnvelope(envelope).valid).toBe(true);
  expect(envelope).toMatchObject({
    status: "failed",
    error: { code: "E_IO", message: expect.stringContaining("pnpm typecheck") },
  });
  expect(envelope.error.message).not.toContain("已过期");
  expect(await readdir(output)).toEqual([]);
});

it.each([
  ["premiere-25-xmeml-5", "1.13.0", false],
  ["resolve-18.5-otio", "1.12.0", true],
] as const)("exports %s with actual version %s (dist only: %s)", async (profile, version, distOnly) => {
  if (distOnly) await rm(join(exporters, "src"), { recursive: true });
  const result = run(false, profile);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.status).toBe("applied");
  const manifest = JSON.parse(await readFile(join(envelope.result.package, "manifest.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(manifest.exporter).toEqual({ version, git_sha: "0000000" });
});

it.each([
  ["premiere-25-xmeml-5", "1.13.0"],
  ["resolve-18.5-otio", "1.12.0"],
] as const)("keeps the source-selected %s exporter in the compiled job worker", async (profile, version) => {
  await writeFile(join(exporters, "dist/index.js"), 'throw new Error("STALE CODE LOADED");');
  const dispatch = await sourceDispatch();
  const accepted = await dispatch("export", request(false, profile));
  expect(accepted.status).toBe("accepted");
  const { job_id } = accepted.result as { job_id: string };
  let envelope: Envelope | null = null;
  for (let i = 0; i < 100; i++) {
    const result = await dispatch("job_status", { project, job_id });
    const job = result.result as { state: string; envelope: Envelope | null };
    if (job.state === "succeeded" || job.state === "failed") {
      envelope = job.envelope;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(envelope?.status, JSON.stringify(envelope?.error)).toBe("applied");
  const result = envelope?.result as { package: string };
  const manifest = JSON.parse(await readFile(join(result.package, "manifest.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(manifest.exporter).toEqual({ version, git_sha: "0000000" });
});
