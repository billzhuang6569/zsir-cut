import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  defaultProfile,
  dispatch,
  PROFILES,
  parseProject,
  printRational,
  quantizeCue,
  rational,
  subtitleFiles,
  validateCommand,
  validateLossReport,
  validateManifest,
} from "../src/index.js";

const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
const fake = fileURLToPath(new URL("../../exporters/test/fake-exporter.mjs", import.meta.url));
const slow = fileURLToPath(new URL("../../exporters/test/fake-slow-exporter.mjs", import.meta.url));
const author = { kind: "agent", name: "test" };
let directory: string;
let projectPath: string;
const request = (extra: Record<string, unknown> = {}) => ({
  project: projectPath,
  base_revision: "rev_fixture_1",
  idempotency_key: "export-test",
  author,
  profile: "fcp-11-fcpxml-1.13",
  output: directory,
  accept_losses: true,
  ...extra,
});
const project = async () => {
  const result = parseProject(await readFile(projectPath, "utf8"));
  if (!result.ok) throw new Error("fixture invalid");
  return result.project;
};
const finish = async (jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const status = await dispatch("job_status", { project: projectPath, job_id: jobId });
    const job = status.result as {
      state: string;
      message: string;
      envelope: { status: string; result: { package: string }; error?: { message: string } };
    };
    if (job.state === "succeeded" || job.state === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("job timeout");
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-export-"));
  projectPath = join(directory, "std-25.zcut.json");
  await copyFile(fixture, projectPath);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("builds the standard cutting list and splits segmented retimes for OTIO and xmeml", async () => {
  const p = await project();
  const timeline = p.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  const rows = cuttingList(p, timeline, "fcp-11-fcpxml-1.13");
  expect(rows).toHaveLength(21);
  expect(rows.find((row) => row.clip_id === "clp_ext")?.source_in).toBe(629760);
  expect(rows.find((row) => row.clip_id === "clp_still")?.source_out).toBe(75);
  expect(rows.find((row) => row.clip_id === "clp_a8")).toMatchObject({ source_in: 2345, source_out: 2470 });
  expect(rows.filter((row) => row.clip_id === "clp_a8")).toHaveLength(1);
  expect(rows.find((row) => row.clip_id === "clp_a8")?.speed).toBe("map");
  for (const profile of ["resolve-18.5-otio", "premiere-25-xmeml-5"] as const) {
    const split = cuttingList(p, timeline, profile);
    expect(split.filter((row) => row.clip_id === "clp_a8")).toHaveLength(4);
    expect(compareCuttingLists(split, split).zero_frame_deviation).toBe(true);
    expect(compareCuttingLists(split, rows).zero_frame_deviation).toBe(false);
  }
});

it("counts still sources at 25 fps and rounds source samples at a half upward", async () => {
  const df = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-2997-df.zcut.json", import.meta.url), "utf8"),
  );
  if (!df.ok || !df.project.timelines[0]) throw new Error("DF fixture invalid");
  const rows = cuttingList(df.project, df.project.timelines[0], "fcp-11-fcpxml-1.13");
  expect(rows).toHaveLength(21);
  expect(rows.find((row) => row.clip_id === "clp_still")?.source_out).toBe(63);
  expect(rows.find((row) => row.clip_id === "clp_ext")?.source_in).toBe(502806);

  const p = await project();
  const timeline = p.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  const audio = timeline.tracks.find(
    (track) => track.kind === "audio" && track.clips.some((clip) => clip.id === "clp_ext"),
  );
  if (!audio || audio.kind !== "audio") throw new Error("External audio missing");
  const clip = audio.clips.find((item) => item.id === "clp_ext");
  if (!clip) throw new Error("External clip missing");
  clip.source_start = rational(1n, 96000n);
  expect(cuttingList(p, timeline, "fcp-11-fcpxml-1.13").find((row) => row.clip_id === "clp_ext")?.source_in).toBe(1);
});

it("compares xmeml source cuts in native units after sequence-frame rounding", async () => {
  const parsed = parseProject(await readFile("fixtures/regressions/xmeml-sequence-grid.zcut.json", "utf8"));
  if (!parsed.ok || !parsed.project.timelines[0]) throw new Error("Grid fixture invalid");
  const p = parsed.project;
  const timeline = parsed.project.timelines[0];
  const rows = cuttingList(p, timeline, "premiere-25-xmeml-5");
  expect(rows.find((row) => row.clip_id === "clp_ext")).toMatchObject({ source_in: 1920, source_out: 49920 });
  for (const profile of ["resolve-18.5-otio", "fcp-11-fcpxml-1.13"] as const)
    expect(cuttingList(p, timeline, profile).find((row) => row.clip_id === "clp_ext")).toMatchObject({
      source_in: 960,
      source_out: 48960,
    });
});

it("chooses and caches a supported host profile through an injectable detector", async () => {
  expect(PROFILES["resolve-18.5-otio"].format_version).toBe("0.17");
  const settings = join(directory, "hosts.json");
  let calls = 0;
  const detect = async () => {
    calls++;
    return { final_cut_pro: "10.8", davinci_resolve: "21.1" };
  };
  expect(await defaultProfile(detect, settings)).toBe("fcp-10.6-fcpxml-1.11");
  expect(await defaultProfile(detect, settings)).toBe("fcp-10.6-fcpxml-1.11");
  expect(calls).toBe(1);
  expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ final_cut_pro: "10.8", davinci_resolve: "21.1" });
});

it("registers the FCPXML exporter and keeps overlays unsupported", async () => {
  expect((await dispatch("export", request({ dry_run: true }))).status).toBe("dry_run");
  expect(
    (await dispatch("export", request({ overlay: true, dry_run: true }), { exporterModule: fake })).error?.code,
  ).toBe("E_UNSUPPORTED");
});

it("quantizes subtitle in and out on 25 and 30000/1001 frame grids and clips the result", async () => {
  const halfway = quantizeCue(rational(1n, 50n), rational(3n, 50n), rational(25n), rational(0n), rational(1n));
  expect(halfway && [printRational(halfway.start, true), printRational(halfway.end, true)]).toEqual(["1/25s", "2/25s"]);
  const q25 = quantizeCue(rational(19n, 1000n), rational(3n, 100n), rational(25n), rational(0n), rational(1n));
  expect(q25 && [printRational(q25.start, true), printRational(q25.end, true)]).toEqual(["0s", "1/25s"]);
  const q2997 = quantizeCue(
    rational(1n, 100n),
    rational(4n, 100n),
    rational(30000n, 1001n),
    rational(0n),
    rational(1n),
  );
  expect(q2997 && [printRational(q2997.start, true), printRational(q2997.end, true)]).toEqual(["0s", "1001/30000s"]);
  const clipped = quantizeCue(rational(0n), rational(1n, 100n), rational(25n), rational(0n), rational(1n, 50n));
  expect(clipped && printRational(clipped.end, true)).toBe("1/50s");
  const p = await project();
  const timeline = p.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  timeline.edit_rate = rational(30000n, 1001n);
  const subtitle = timeline.tracks.find((track) => track.kind === "subtitle");
  if (!subtitle || subtitle.kind !== "subtitle") throw new Error("Subtitle track missing");
  subtitle.free_cues = [
    { id: "cue_quantized", timeline_start: rational(1n, 100n), duration: rational(3n, 100n), text: "测试" },
  ];
  timeline.tracks = [subtitle];
  expect(subtitleFiles(p, timeline).find((file) => file.role === "subtitle")?.data).toContain(
    "00:00:00,000 --> 00:00:00,033",
  );
});

it("runs export through a job, writes a schema-valid package, and records a handoff check", async () => {
  expect(validateCommand("export", request()).valid).toBe(true);
  const accepted = await dispatch("export", request(), { exporterModule: fake });
  expect(accepted.status).toBe("accepted");
  const id = (accepted.result as { job_id: string }).job_id;
  const job = await finish(id);
  expect(job.state).toBe("succeeded");
  const root = job.envelope.result.package;
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const report = JSON.parse(await readFile(join(root, "loss-report.json"), "utf8"));
  expect(validateManifest(manifest).valid).toBe(true);
  expect(validateLossReport(report).valid).toBe(true);
  expect(manifest.validation.schema.status).toBe("pass");
  expect(manifest.validation.media_resolved.status).toBe(
    manifest.media.every((item: { online: boolean }) => item.online) ? "pass" : "fail",
  );
  expect(report.items.filter((item: { reason_code: string }) => item.reason_code === "R_MEDIA_OFFLINE")).toHaveLength(
    manifest.media.filter((item: { online: boolean }) => !item.online).length,
  );
  expect(manifest.validation.host_import.status).toBe("not_run");
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, file.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  const originalFiles = new Map(
    manifest.files
      .filter((file: { role: string }) => file.role !== "loss_report")
      .map((file: { path: string; sha256: string }) => [file.path, file.sha256]),
  );
  const repeated = await dispatch("export", request({ output: join(directory, "repeat") }), { exporterModule: fake });
  const repeatedJob = await finish((repeated.result as { job_id: string }).job_id);
  const repeatedManifest = JSON.parse(
    await readFile(join(repeatedJob.envelope.result.package, "manifest.json"), "utf8"),
  );
  expect(
    new Map(
      repeatedManifest.files
        .filter((file: { role: string }) => file.role !== "loss_report")
        .map((file: { path: string; sha256: string }) => [file.path, file.sha256]),
    ),
  ).toEqual(originalFiles);
  const checkInput = {
    package: root,
    check: "host_import",
    status: "pass",
    by: "Bill",
    host_version: "12.4",
    items: [{ check: "导入无错误", status: "pass" }],
  };
  expect(validateCommand("record_handoff_check", checkInput).valid).toBe(true);
  expect(validateCommand("record_handoff_check", { ...checkInput, base_revision: "rev_fixture_1" }).valid).toBe(false);
  const check = await dispatch("record_handoff_check", checkInput);
  expect(check.status).toBe("applied");
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const replaced = spawnSync(process.execPath, [cli, "record_handoff_check"], {
    input: JSON.stringify({
      ...checkInput,
      status: "warn",
      notes: "重开后需复核",
      items: [{ check: "字幕末条", status: "warn", notes: "时间偏差" }],
    }),
    encoding: "utf8",
  });
  expect(replaced.status).toBe(0);
  expect(JSON.parse(replaced.stdout).status).toBe("applied");
  const after = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  expect(validateManifest(after).valid).toBe(true);
  expect(after.validation.host_import).toMatchObject({
    status: "warn",
    by: "Bill",
    notes: "重开后需复核",
    items: [{ check: "字幕末条", status: "warn", notes: "时间偏差" }],
  });
  expect(after.validation.host_import.items).toHaveLength(1);
  expect(after.validation.host_render_comparison.status).toBe("not_run");
});

it("returns only a report for dry run and gates error losses", async () => {
  const base = (await import(fake)).default;
  const dry = await dispatch("export", request({ dry_run: true }), { exporter: base });
  expect(dry.status).toBe("dry_run");
  expect(validateLossReport(dry.result).valid).toBe(true);
  const loss = {
    entity_id: "clp_a8",
    entity_kind: "clip",
    feature: "speed_segmented",
    status: "unsupported",
    severity: "error",
    timeline_range: null,
    reason_code: "R_FORMAT_NO_FIELD",
    consequence: "变速丢失",
    fallback_asset: null,
    recoverable_from_source_project: true,
  };
  const exporter = { ...base, losses: () => [loss] };
  expect((await dispatch("export", request({ dry_run: true, accept_losses: false }), { exporter })).error?.code).toBe(
    "E_VALIDATION",
  );
  expect((await dispatch("export", request({ dry_run: true, accept_losses: true }), { exporter })).status).toBe(
    "dry_run",
  );
  const acceptedLoss = await dispatch("export", request({ dry_run: true }), { exporter });
  expect(
    (acceptedLoss.result as { items: { reason_code: string }[] }).items.some(
      (item) => item.reason_code === "R_FORMAT_NO_FIELD",
    ),
  ).toBe(true);
});

it("reports a killed export worker as failed", async () => {
  const accepted = await dispatch("export", request(), { exporterModule: slow });
  expect(accepted.status).toBe("accepted");
  const id = (accepted.result as { job_id: string }).job_id;
  let pid: number | undefined;
  for (let i = 0; i < 40; i++) {
    const state = (await dispatch("job_status", { project: projectPath, job_id: id })).result as {
      pid?: number;
      state: string;
    };
    pid = state.pid;
    if (state.state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!pid) throw new Error("worker pid missing");
  process.kill(pid, "SIGKILL");
  const job = await finish(id);
  expect(job.state).toBe("failed");
  expect(job.envelope).toBeNull();
});

it("includes the mismatched clip and values in a failed export job", async () => {
  const modulePath = join(directory, "mismatch.mjs");
  await writeFile(
    modulePath,
    `import base from ${JSON.stringify(pathToFileURL(fake).href)}; export default { ...base, async readBack(data) { const rows = await base.readBack(data); rows[0].source_out++; return rows; } };`,
  );
  const accepted = await dispatch("export", request(), { exporterModule: modulePath });
  expect(accepted.status).toBe("accepted");
  const job = await finish((accepted.result as { job_id: string }).job_id);
  expect(job.state).toBe("failed");
  expect(job.message).toContain("clp_v1");
  expect(job.message).toContain("source_out");
  expect(job.envelope?.error?.message).toBe(job.message);
});

it("CLI --wait prints the final envelope", () => {
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "export", projectPath, "--wait"], {
    input: JSON.stringify(request()),
    encoding: "utf8",
    env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: fake },
    timeout: 10000,
  });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout).status).toBe("applied");
});
