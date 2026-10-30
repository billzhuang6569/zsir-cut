import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { dispatch, parseProject, validateEnvelope } from "../../core/src/index.js";
import { type Job, jobPath, readJob, writeJob } from "../../core/src/jobs.ts";
import { createServer } from "../../mcp/src/index.js";

it.each([false, true])(
  "returns the same job summary over CLI and MCP (oversized: %s) without changing job.json",
  async (oversized) => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-summary-"));
    const project = join(directory, "project.zcut.json");
    const server = createServer();
    const client = new Client({ name: "summary-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await copyFile("examples/minimal.zcut.json", project);
      const parsed = parseProject(await readFile(project, "utf8"));
      if (!parsed.ok) throw new Error("Invalid fixture");
      const job_id = "job_00000000-0000-7000-8000-000000000000";
      const path = jobPath(project, parsed.project.id, job_id);
      const final = await dispatch("inspect", { project });
      final.verb = "transcribe";
      final.status = "applied";
      final.changes = Array.from({ length: 12000 }, (_, i) => ({
        op: "transcribe",
        entity: "cue",
        id: `cue_${i}`,
        action: "created",
      }));
      const errorCount = oversized ? 12 : 7;
      final.verification = {
        level: "L1",
        passed: false,
        issues: Array.from({ length: 12000 }, (_, i) => ({
          code: i >= 12000 - errorCount ? "E_REF" : "W_SUB_UNPROJECTED",
          severity: i >= 12000 - errorCount ? "error" : "warning",
          message: `issue ${i}`,
          ids: [`cue_${i}`],
        })),
      };
      if (oversized) final.result = { large: "字".repeat(8192) };
      const job: Job = {
        job_id,
        verb: "transcribe",
        state: "succeeded",
        progress: 1,
        message: "完成",
        created_at: "2026-10-30T00:00:00Z",
        updated_at: "2026-10-30T00:00:00Z",
        request: {
          verb: "transcribe",
          idempotency_key: "summary",
          label: "采访",
          reference_text: "采访".repeat(20000),
          project,
        },
        envelope: final,
      };
      await writeJob(path, job);
      const before = await readFile(path, "utf8");
      await Promise.all([server.connect(left), client.connect(right)]);
      const run = spawnSync(process.execPath, ["packages/cli/src/index.ts", "job_status", project], {
        input: JSON.stringify({ job_id }),
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      const cli = JSON.parse(run.stdout);
      const mcp = (await client.callTool({ name: "zcut_job_status", arguments: { project, job_id } }))
        .structuredContent;
      expect({ ...cli, request_id: null }).toEqual({ ...mcp, request_id: null });
      expect(validateEnvelope(cli).valid).toBe(true);
      expect(cli).toMatchObject({ ok: true, status: "no_op", error: null, result: { state: "succeeded" } });
      if (oversized) expect(Buffer.byteLength(run.stdout)).toBeGreaterThan(8192);
      else expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(8192);
      expect(cli.result.request).toEqual({ verb: "transcribe", idempotency_key: "summary", label: "采访" });
      expect(cli.result.envelope).not.toHaveProperty("changes");
      expect(cli.result.envelope.changes_count).toBe(12000);
      expect(cli.result.envelope.changes_sample).toEqual(final.changes.slice(0, 10));
      expect(cli.result.envelope.verification).toEqual({
        level: final.verification.level,
        passed: final.verification.passed,
        issues_count: 12000,
        issues_sample: [
          ...final.verification.issues.slice(-errorCount),
          ...final.verification.issues.slice(0, 3),
        ].slice(0, 10),
      });
      expect(cli.result.envelope.result).toEqual(final.result);
      expect(await readFile(path, "utf8")).toBe(before);
      expect((await readJob(path)).envelope).toEqual(final);
      for (const envelope of [null, { ...final, changes: [] }, { ...final, changes: final.changes.slice(0, 2) }]) {
        await writeJob(path, { ...job, envelope });
        const status = await dispatch("job_status", { project, job_id });
        expect(status.result).toMatchObject({
          envelope: envelope ? { changes_count: envelope.changes.length, changes_sample: envelope.changes } : null,
        });
      }
      for (const issues of [[], final.verification.issues.slice(0, 2), final.verification.issues.slice(-2)]) {
        await writeJob(path, { ...job, envelope: { ...final, verification: { ...final.verification, issues } } });
        const status = await dispatch("job_status", { project, job_id });
        expect(status.result).toMatchObject({
          envelope: { verification: { issues_count: issues.length, issues_sample: issues } },
        });
        expect((status.result as Job).envelope?.verification).not.toHaveProperty("issues");
      }
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
