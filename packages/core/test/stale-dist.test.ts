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
  for (const path of ["core/src", "core/dist", "cli/src", "cli/dist", "exporters/src", "exporters/dist"]) {
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

function run(dryRun = true, profile = "premiere-25-xmeml-5", source = false) {
  const entry = source ? "src/index.ts" : "dist/index.js";
  return spawnSync(process.execPath, [join(directory, "packages/cli", entry), "export", project, "--wait"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: "", ZSIR_OTIO_PYTHON: "" },
    input: JSON.stringify(request(dryRun, profile)),
  });
}

it.each(["missing", "stale"])("exports current SRT layers from the source CLI with %s core dist", async (state) => {
  const input = JSON.parse(await readFile(project, "utf8"));
  const layers = JSON.parse(await readFile(join(root, "fixtures/regressions/srt-overlap-layers.zcut.json"), "utf8"));
  input.timelines[0].tracks = input.timelines[0].tracks
    .filter((track: { kind: string }) => track.kind !== "subtitle")
    .concat(layers.timelines[0].tracks);
  input.subtitle_styles.push(...layers.subtitle_styles);
  await writeFile(project, JSON.stringify(input));
  if (state === "missing") {
    await rm(join(directory, "packages/core/dist"), { recursive: true });
    await rm(join(exporters, "dist"), { recursive: true });
  } else {
    const coreDist = join(directory, "packages/core/dist");
    for (const filename of await readdir(coreDist, { recursive: true })) {
      if (filename.endsWith(".js")) await writeFile(join(coreDist, filename), 'throw new Error("STALE CORE LOADED");');
    }
    await writeFile(join(exporters, "dist/index.js"), 'throw new Error("STALE EXPORTER LOADED");');
  }
  const result = run(false, "premiere-25-xmeml-5", true);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(validateEnvelope(envelope).valid).toBe(true);
  expect(envelope.status).toBe("applied");
  const manifest = JSON.parse(await readFile(join(envelope.result.package, "manifest.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(await readFile(join(envelope.result.package, "subtitles/zh-Hans.layer2.srt"), "utf8")).toBe(
    "1\n00:00:01,000 --> 00:00:04,000\n第二条\n\n",
  );
  expect(await readFile(join(envelope.result.package, "subtitles/zh-Hans.layer3.srt"), "utf8")).toBe(
    "1\n00:00:02,000 --> 00:00:03,000\n第三条\n\n",
  );
});

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

it("loads only dist core and exporters from the compiled CLI even if source is broken", async () => {
  await writeFile(join(directory, "packages/core/src/index.ts"), 'throw new Error("SOURCE CORE LOADED");');
  await writeFile(join(exporters, "src/index.ts"), 'throw new Error("SOURCE CODE LOADED");');
  const result = run();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("dry_run");
});

it.each([
  ["./custom.ts", "./index.js"],
  ["../custom.ts", "./dist/index.js"],
])("preserves the explicit custom exporter path %s in compiled jobs", async (module, coreImport) => {
  const custom = join(directory, "packages/core/dist", module);
  const fake = await readFile(join(root, "packages/exporters/test/fake-exporter.mjs"), "utf8");
  await writeFile(custom, fake.replace("../../core/dist/index.js", coreImport));
  await writeFile(custom.replace(/\.ts$/, ".js"), 'throw new Error("REWRITTEN EXPORTER PATH");');
  const result = spawnSync(
    process.execPath,
    [join(directory, "packages/cli/dist/index.js"), "export", project, "--wait"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: module },
      input: JSON.stringify(request(false)),
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.status).toBe("applied");
  const manifest = JSON.parse(await readFile(join(envelope.result.package, "manifest.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(manifest.exporter).toEqual({ version: "test-1", git_sha: "0000000" });
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
  if (distOnly) {
    await rm(join(directory, "packages/core/src"), { recursive: true });
    await rm(join(exporters, "src"), { recursive: true });
  }
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
] as const)("keeps the source-selected %s exporter in the source job worker", async (profile, version) => {
  await writeFile(join(exporters, "dist/index.js"), 'throw new Error("STALE CODE LOADED");');
  const dispatch = await sourceDispatch();
  const accepted = await dispatch("export", request(false, profile));
  expect(accepted.status).toBe("accepted");
  const { job_id } = accepted.result as { job_id: string };
  const { readJob, jobPath } = await import(join(directory, "packages/core/src/jobs.ts"));
  const { id } = JSON.parse(await readFile(project, "utf8"));
  let envelope: Envelope | null = null;
  for (let i = 0; i < 100; i++) {
    const job = await readJob(jobPath(project, id, job_id));
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
