import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandSchemaForVerb,
  openProject,
  parseProject,
  VERBS,
  validateCommand,
  validateEnvelope,
} from "../../core/src/index.ts";
import { createServer } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
const fake = fileURLToPath(new URL("../../exporters/test/fake-exporter.mjs", import.meta.url));
const author = { kind: "agent" as const, name: "test" };
let directory: string;
let project: string;

const invokeCli = (verb: string, input: Record<string, unknown>) => {
  const run = spawnSync(process.execPath, [cli, verb, project], { input: JSON.stringify(input), encoding: "utf8" });
  return { code: run.status, envelope: JSON.parse(run.stdout) as Record<string, unknown> };
};
const withoutRequestId = (value: Record<string, unknown>) => ({ ...value, request_id: "req_ignored" });

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "zcut-parity-")));
  project = join(directory, "std-25.zcut.json");
  await copyFile(fixture, project);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CLI and MCP", () => {
  it("shares session draft reads and missing-session errors", async () => {
    const server = createServer();
    const client = new Client({ name: "session-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const begun = invokeCli("session_begin", {
        base_revision: "rev_fixture_1",
        idempotency_key: "session",
        author,
        approval: "manual",
        intent: "Read draft",
      }).envelope;
      const session_id = (begun.result as { session_id: string }).session_id;
      const edit = invokeCli("edit", {
        session_id,
        base_revision: "rev_fixture_1",
        idempotency_key: "place-session",
        author,
        ops: [
          {
            op: "place",
            media_id: "med_A",
            at: "end",
            mode: "insert",
            video_track: "trk_v1",
            audio_track: "trk_a1",
            source_start: "0s",
            duration: "1s",
          },
        ],
      });
      expect(edit.envelope.status).toBe("drafted");
      const cases = [
        ["inspect", { view: "brief" }],
        ["inspect", { view: "timeline" }],
        ["inspect", { view: "history" }],
        ["read_transcript", { transcript_id: "trs_A_zh" }],
        ["read_transcript", { timeline_id: "tl_std" }],
        ["validate", {}],
        ["diff", { from: "rev_fixture_1" }],
        ["render_preview", { timeline_id: "tl_missing" }],
        ["view_timeline", { timeline_id: "tl_missing" }],
      ] as const;
      for (const selectedSession of [session_id, "ses_missing"]) {
        for (const [verb, fields] of cases) {
          const input = { ...fields, session_id: selectedSession };
          const cliResult = invokeCli(verb, input);
          const envelope = (await client.callTool({ name: `zcut_${verb}`, arguments: { project, ...input } }))
            .structuredContent as Record<string, unknown>;
          expect(validateEnvelope(envelope).valid).toBe(true);
          expect(withoutRequestId(cliResult.envelope)).toEqual(withoutRequestId(envelope));
          if (selectedSession === "ses_missing" || verb === "render_preview" || verb === "view_timeline")
            expect(envelope.error).toMatchObject({ code: "E_NOT_FOUND" });
          else expect(envelope.ok).toBe(true);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  }, 30000);

  it("shares decision writes, retries, validation and persisted session reads", async () => {
    const server = createServer();
    const client = new Client({ name: "decision-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const base = { base_revision: "rev_fixture_1", author };
      const begun = invokeCli("session_begin", {
        ...base,
        idempotency_key: "begin",
        approval: "manual",
        intent: "Decide",
      });
      const session_id = (begun.envelope.result as { session_id: string }).session_id;
      const cases: [string, Record<string, unknown>][] = [
        [
          "session_ask",
          {
            idempotency_key: "ask",
            decisions: [
              {
                id: "dec_1",
                question: "Keep?",
                options: [{ id: "keep", label: "Keep", recommended: true }],
                allow_other: false,
              },
            ],
          },
        ],
        ["session_answer", { idempotency_key: "answer", decision_id: "dec_1", option_id: "keep" }],
        ["session_answer", { idempotency_key: "skip", decision_id: "dec_1", skip: true }],
        ["session_answer", { idempotency_key: "invalid", decision_id: "dec_1", text: "Other" }],
      ];
      for (const [verb, fields] of cases) {
        const input = { ...base, session_id, ...fields };
        const first = invokeCli(verb, input).envelope;
        const second = (await client.callTool({ name: `zcut_${verb}`, arguments: { project, ...input } }))
          .structuredContent as Record<string, unknown>;
        expect(validateEnvelope(first).valid).toBe(true);
        expect(validateEnvelope(second).valid).toBe(true);
        expect(withoutRequestId(first)).toEqual(withoutRequestId(second));
        expect(first.ok).toBe(fields.idempotency_key !== "invalid");
      }
      const input = { session_id, view: "session" };
      const reopened = invokeCli("inspect", input).envelope;
      const mcp = (await client.callTool({ name: "zcut_inspect", arguments: { project, ...input } }))
        .structuredContent as Record<string, unknown>;
      expect(withoutRequestId(reopened)).toEqual(withoutRequestId(mcp));
      expect(reopened.result).toMatchObject({ pending_count: 0, decisions: [{ id: "dec_1", state: "skipped" }] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ["src", "missing"],
    ["src", "stale"],
    ["dist", "missing"],
    ["dist", "stale"],
  ] as const)("runs the %s MCP entry when the other core runtime is %s", async (runtime, state) => {
    await copyFile(join(root, "package.json"), join(directory, "package.json"));
    await cp(join(root, "schema"), join(directory, "schema"), { recursive: true });
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    for (const name of ["core", "mcp"]) {
      for (const mode of ["src", "dist"]) {
        const path = join("packages", name, mode);
        await cp(join(root, path), join(directory, path), { recursive: true });
      }
      await symlink(
        join(root, "packages", name, "node_modules"),
        join(directory, "packages", name, "node_modules"),
        "junction",
      );
    }
    const excluded = runtime === "src" ? "dist" : "src";
    const extension = runtime === "src" ? "ts" : "js";
    if (state === "missing") {
      await rm(join(directory, "packages/core", excluded), { recursive: true });
    } else {
      const filename = runtime === "src" ? "index.js" : "index.ts";
      await writeFile(join(directory, "packages/core", excluded, filename), 'throw new Error("WRONG CORE RUNTIME");');
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(directory, "packages/mcp", runtime, `index.${extension}`)],
      cwd: directory,
    });
    const client = new Client({ name: "source-runtime-test", version: "1" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toEqual(
        VERBS.map((verb) => ({ name: `zcut_${verb}`, inputSchema: commandSchemaForVerb(verb) })),
      );
      const result = await client.callTool({ name: "zcut_validate", arguments: { project } });
      expect(validateEnvelope(result.structuredContent).valid).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, status: "no_op" });
    } finally {
      await client.close();
    }
  });

  it("registers all 21 protocol verbs and returns equivalent envelopes", async () => {
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
        { verb: "render_preview", input: { timeline_id: "tl_missing" } },
        { verb: "view_timeline", input: { timeline_id: "tl_missing" } },
        { verb: "diff", input: { from: "rev_fixture_1" } },
        {
          verb: "session_begin",
          input: { ...base, idempotency_key: "begin-parity", approval: "manual", intent: "Parity test" },
        },
        { verb: "undo", input: { base_revision: "rev_fixture_1", idempotency_key: "missing-author" } },
        { verb: "inspect", input: { view: "brief" } },
        { verb: "read_transcript", input: { transcript_id: "trs_A_zh" } },
        {
          verb: "edit",
          input: {
            ...base,
            idempotency_key: "place-tokens-parity",
            dry_run: true,
            ops: [
              {
                op: "place",
                media_id: "med_A",
                at: "end",
                mode: "insert",
                video_track: "trk_v1",
                audio_track: "trk_a1",
                tokens: { transcript_id: "trs_A_zh", from_token: "tok_010", to_token: "tok_017", pause: "20/50s" },
              },
              {
                op: "place",
                media_id: "med_A",
                at: "end",
                mode: "insert",
                video_track: "trk_v1",
                source_start: "0/25s",
                duration: "50/25s",
              },
            ],
          },
        },
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
        ...[
          [{ op: "update_media", media_id: "med_A", tags: ["A", "A", "B"], rating: 4 }],
          [
            { op: "rename_track", track_id: "trk_v1", name: "视频 Z" },
            { op: "add_track", kind: "video" },
          ],
          [
            {
              op: "add_subtitle_track",
              id: "trk_parity",
              language: "zh",
              carrier_tracks: ["trk_a1"],
              default_style_id: "sty_zh",
            },
            { op: "rename_track", track_id: "trk_parity", name: "字幕 Z" },
          ],
          [
            {
              op: "add_marker",
              id: "mrk_parity",
              at: "0s",
              duration: "0s",
              kind: "chapter",
              text: "chapter",
              level: 1,
            },
            { op: "update_marker", marker_id: "mrk_parity", level: 2 },
          ],
          [{ op: "add_marker", at: "0s", duration: "0s", kind: "note", text: "invalid", level: 1 }],
        ].map((ops, index) => ({
          verb: "edit",
          input: { ...base, dry_run: true, idempotency_key: `format-02-${index}`, ops },
        })),
        { verb: "undo", input: base },
      ] as const;
      for (const { verb, input } of cases) {
        const request = { ...input, project };
        if (verb !== "undo" || "author" in input) expect(validateCommand(verb, request).valid).toBe(true);
        const cliResult = invokeCli(verb, input);
        const mcpResult = await client.callTool({ name: `zcut_${verb}`, arguments: request });
        const envelope = mcpResult.structuredContent as Record<string, unknown>;
        if ("idempotency_key" in input && input.idempotency_key === "place-tokens-parity") {
          expect(cliResult.envelope.status).toBe("dry_run");
          expect(cliResult.envelope.changes).toHaveLength(3);
        }
        expect(validateEnvelope(cliResult.envelope).valid).toBe(true);
        expect(validateEnvelope(envelope).valid).toBe(true);
        expect(JSON.stringify(withoutRequestId(cliResult.envelope))).toBe(JSON.stringify(withoutRequestId(envelope)));
      }
    } finally {
      await client.close();
      await server.close();
    }
  }, 30000);

  it.each(["CLI", "MCP"])(
    "shares create_project results, replay and mismatch after creation via %s",
    async (creator) => {
      await rm(project);
      const server = createServer();
      const client = new Client({ name: "test", version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(left), client.connect(right)]);
      try {
        const input = {
          project,
          name: "新工程",
          timeline: { edit_rate: "25", width: 640, height: 360 },
          subtitles: { language: "zh-Hans" },
          idempotency_key: "create-parity",
          author,
        };
        const first =
          creator === "CLI"
            ? JSON.parse(
                spawnSync(process.execPath, [cli, "create_project"], {
                  input: JSON.stringify(input),
                  encoding: "utf8",
                }).stdout,
              )
            : (await client.callTool({ name: "zcut_create_project", arguments: input })).structuredContent;
        expect(first.status).toBe("applied");
        expect(first.receipt.before).toBeNull();
        expect(validateEnvelope(first)).toEqual({ valid: true, errors: [] });
        for (const request of [input, { ...input, name: "mismatch" }, { ...input, idempotency_key: "other" }]) {
          const cliResult = invokeCli("create_project", request);
          const mcpResult = (await client.callTool({ name: "zcut_create_project", arguments: request }))
            .structuredContent as Record<string, unknown>;
          expect(JSON.stringify(withoutRequestId(cliResult.envelope))).toBe(
            JSON.stringify(withoutRequestId(mcpResult)),
          );
          expect(validateEnvelope(cliResult.envelope)).toEqual({ valid: true, errors: [] });
          expect(validateEnvelope(mcpResult)).toEqual({ valid: true, errors: [] });
          expect(cliResult.code).toBe(request === input ? 0 : 2);
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each(["src", "dist"])(
    "resolves CLI project paths and explains malformed input through %s",
    async (runtime) => {
      const entry = join(root, "packages/cli", runtime, `index.${runtime === "src" ? "ts" : "js"}`);
      const run = (args: string[], input: string) => {
        const result = spawnSync(process.execPath, [entry, ...args], { input, encoding: "utf8" });
        return { code: result.status, stderr: result.stderr, envelope: JSON.parse(result.stdout) };
      };
      for (const args of [["validate"], ["validate", project]]) {
        const output = run(args, JSON.stringify({ project }));
        expect(output.code).toBe(0);
        expect(output.envelope.status).toBe("no_op");
      }
      const mismatch = run(["validate", project], JSON.stringify({ project: "other.zcut.json" }));
      expect(mismatch.code).toBe(2);
      expect(mismatch.envelope.error).toMatchObject({
        code: "E_VALIDATION",
        message: expect.stringContaining(project),
      });
      expect(mismatch.envelope.error.message).toContain("other.zcut.json");
      expect(run(["validate"], "{}").envelope.error.message).toBe("缺少工程路径");
      for (const input of ["not JSON", "null", "[]", "7", "", '"string"']) {
        const output = run(["validate", project], input);
        expect(output.code).toBe(2);
        expect(output.stderr).toBe("");
        expect(output.envelope.error.code).toBe("E_VALIDATION");
        expect(output.envelope.error.message).toMatch(/请求|JSON/);
        expect(output.envelope.error.message).not.toContain("required property");
      }
      const unreadable = run(["validate", "--input", join(directory, "missing.json")], "");
      expect(unreadable.code).toBe(2);
      expect(unreadable.envelope.error.message).toContain("ENOENT");
      const requestFile = join(directory, "request.json");
      await writeFile(requestFile, JSON.stringify({ project }));
      expect(run(["validate", "--input", requestFile], "").code).toBe(0);
      await writeFile(requestFile, "[]");
      expect(run(["validate", "--input", requestFile], "").envelope.error.message).toBe("请求必须是 JSON 对象");
    },
    15000,
  );

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
  }, 15000);

  it("matches export dry run and job status across CLI and MCP", async () => {
    const server = createServer({ exporterModule: fake });
    const client = new Client({ name: "test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const input = {
        project,
        base_revision: "rev_fixture_1",
        idempotency_key: "parity-export",
        author,
        profile: "fcp-11-fcpxml-1.13",
        dry_run: true,
        accept_losses: true,
      };
      const run = spawnSync(process.execPath, [cli, "export", project], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, ZSIR_CUT_EXPORTER_MODULE: fake },
      });
      const cliDry = JSON.parse(run.stdout);
      const mcpDry = (await client.callTool({ name: "zcut_export", arguments: input })).structuredContent as Record<
        string,
        unknown
      >;
      expect(cliDry.status).toBe("dry_run");
      expect(mcpDry.status).toBe("dry_run");
      const normalize = (envelope: Record<string, unknown>) => {
        const result = envelope.result as Record<string, unknown>;
        return {
          ...withoutRequestId(envelope),
          result: { ...result, export_id: "exp_ignored", generated_at: "ignored" },
        };
      };
      expect(normalize(cliDry)).toEqual(normalize(mcpDry));
      const statusInput = { project, job_id: "job_00000000-0000-7000-8000-000000000000" };
      const cliStatus = invokeCli("job_status", { job_id: statusInput.job_id }).envelope;
      const mcpStatus = (await client.callTool({ name: "zcut_job_status", arguments: statusInput }))
        .structuredContent as Record<string, unknown>;
      expect(withoutRequestId(cliStatus)).toEqual(withoutRequestId(mcpStatus));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
