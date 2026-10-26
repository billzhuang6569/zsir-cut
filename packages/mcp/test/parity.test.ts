import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openProject, parseProject, VERBS, validateCommand, validateEnvelope } from "../../core/dist/index.js";
import { createServer } from "../src/index.js";

const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
const author = { kind: "agent" as const, name: "test" };
let directory: string;
let project: string;

const invokeCli = (verb: string, input: Record<string, unknown>) => {
  const run = spawnSync(process.execPath, [cli, verb, project], { input: JSON.stringify(input), encoding: "utf8" });
  return { code: run.status, envelope: JSON.parse(run.stdout) as Record<string, unknown> };
};
const withoutRequestId = (value: Record<string, unknown>) => ({ ...value, request_id: "req_ignored" });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-parity-"));
  project = join(directory, "std-25.zcut.json");
  await copyFile(fixture, project);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CLI and MCP", () => {
  it("registers all 18 protocol verbs and returns equivalent envelopes", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(VERBS.map((verb) => `zcut_${verb}`));
      const base = { base_revision: "rev_fixture_1", idempotency_key: "undo-empty", author };
      const cases = [
        { verb: "validate", input: {} },
        { verb: "validate", input: { media: true } },
        { verb: "undo", input: { base_revision: "rev_fixture_1", idempotency_key: "missing-author" } },
        { verb: "inspect", input: {} },
        {
          verb: "edit",
          input: {
            base_revision: "rev_fixture_1",
            idempotency_key: "edit-preview",
            author,
            dry_run: true,
            ops: [{ op: "set_clip", clip_id: "clp_v9", label: "preview" }],
          },
        },
        { verb: "undo", input: base },
      ] as const;
      for (const { verb, input } of cases) {
        const request = { ...input, project };
        if (verb !== "undo" || "author" in input) expect(validateCommand(verb, request).valid).toBe(true);
        const cliResult = invokeCli(verb, input);
        const mcpResult = await client.callTool({ name: `zcut_${verb}`, arguments: request });
        const envelope = mcpResult.structuredContent as Record<string, unknown>;
        expect(validateEnvelope(cliResult.envelope).valid).toBe(true);
        expect(validateEnvelope(envelope).valid).toBe(true);
        expect(JSON.stringify(withoutRequestId(cliResult.envelope))).toBe(JSON.stringify(withoutRequestId(envelope)));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("maps all CLI exit statuses", async () => {
    expect(invokeCli("validate", {}).code).toBe(0);
    const requestFile = join(directory, "request.json");
    await writeFile(requestFile, "{}");
    const fromFile = spawnSync(process.execPath, [cli, "validate", project, "--input", requestFile], {
      encoding: "utf8",
    });
    expect(fromFile.status).toBe(0);
    expect(validateEnvelope(JSON.parse(fromFile.stdout)).valid).toBe(true);
    expect(invokeCli("undo", { base_revision: "rev_fixture_1", idempotency_key: "bad" }).code).toBe(2);
    const parsed = parseProject(await readFile(project, "utf8"));
    if (!parsed.ok) throw new Error("Invalid fixture");
    const changed = await openProject({ projectPath: project }).commitWrite(
      {
        verb: "edit",
        request_id: "req_setup",
        base_revision: "rev_fixture_1",
        idempotency_key: "setup",
        author,
        ops: [],
      },
      (candidate) => {
        candidate.name = "Changed";
      },
    );
    expect(changed.status).toBe("applied");
    const revision = changed.receipt?.after;
    expect(invokeCli("undo", { base_revision: revision, idempotency_key: "undo", author }).code).toBe(0);
    expect(invokeCli("undo", { base_revision: revision, idempotency_key: "stale", author }).code).toBe(3);
    const missing = join(directory, "missing.zcut.json");
    const failed = spawnSync(process.execPath, [cli, "validate", missing], { input: "{}", encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(validateEnvelope(JSON.parse(failed.stdout)).valid).toBe(true);
    const malformed = spawnSync(process.execPath, [cli, "validate", project, "--unknown"], {
      input: "{}",
      encoding: "utf8",
    });
    expect(malformed.status).toBe(2);
    expect(validateEnvelope(JSON.parse(malformed.stdout)).valid).toBe(true);
  });
});
