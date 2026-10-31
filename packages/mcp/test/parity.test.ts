import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandSchemaForVerb,
  flattenMcpSchema,
  openProject,
  parseProject,
  VERBS,
  validateCommand,
  validateEnvelope,
  writeVoices,
} from "../../core/src/index.ts";
import { createServer } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
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
  vi.stubEnv("HOME", directory);
  project = join(directory, "std-25.zcut.json");
  await copyFile(fixture, project);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("CLI and MCP", () => {
  it("shares mark_proofread dry-run, writes and replay envelopes", async () => {
    const server = createServer();
    const client = new Client({ name: "proofread-parity", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const input = {
        project,
        base_revision: "rev_fixture_1",
        idempotency_key: "mark-proofread",
        author,
        label: "AI 校对字幕（没有要改的字）",
        ops: [{ op: "mark_proofread", transcript_id: "trs_A_zh" }],
      };
      for (const dry_run of [true, false]) {
        const request = { ...input, dry_run };
        const cliResult = invokeCli("edit", request);
        expect(cliResult.code).toBe(0);
        expect(cliResult.envelope.status).toBe(dry_run ? "dry_run" : "applied");
        const mcp = (await client.callTool({ name: "zcut_edit", arguments: request })).structuredContent as Record<
          string,
          unknown
        >;
        expect(validateEnvelope(mcp).valid).toBe(true);
        if (!dry_run) {
          expect(mcp.receipt).toMatchObject({ replayed: true });
          mcp.receipt = { ...(mcp.receipt as Record<string, unknown>), replayed: false };
        }
        expect(withoutRequestId(cliResult.envelope)).toEqual(withoutRequestId(mcp));
        const saved = parseProject(await readFile(project, "utf8"));
        if (!saved.ok) throw new Error("Invalid project");
        expect(saved.project.transcripts.find((t) => t.id === "trs_A_zh")?.ext?.["zsir.proofread"]).toEqual(
          dry_run ? undefined : { by: author.name },
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("begins a session through the SDK with an object author", async () => {
    const server = createServer();
    const client = new Client({ name: "object-author", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(31);
      for (const tool of tools.tools) {
        if (
          ![
            "zcut_record_handoff_check",
            "zcut_terms_list",
            "zcut_terms_edit",
            "zcut_settings_get",
            "zcut_settings_set",
            "zcut_voice_list",
            "zcut_voice_edit",
            "zcut_voice_clone",
          ].includes(tool.name)
        )
          expect(tool.inputSchema.properties?.author).toMatchObject({
            type: "object",
            properties: { kind: { enum: ["human", "agent", "system"] }, name: { type: "string" } },
          });
      }
      expect(
        (
          await client.callTool({
            name: "zcut_session_begin",
            arguments: {
              project,
              author,
              base_revision: "rev_fixture_1",
              idempotency_key: "object-author",
              approval: "manual",
              intent: "测试会话",
            },
          })
        ).structuredContent,
      ).toMatchObject({ ok: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

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
        label: "Test edit",
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
        VERBS.map((verb) => ({ name: `zcut_${verb}`, inputSchema: flattenMcpSchema(commandSchemaForVerb(verb)) })),
      );
      const result = await client.callTool({ name: "zcut_validate", arguments: { project } });
      expect(validateEnvelope(result.structuredContent).valid).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, status: "no_op" });
    } finally {
      await client.close();
    }
  });

  it("registers all protocol verbs and returns equivalent envelopes", async () => {
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
            label: "Test edit",
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
            label: "Test edit",
            ops: [{ op: "set_clip", clip_id: "clp_v9", label: "preview" }],
          },
        },
        ...[
          [{ op: "resegment", transcript_id: "trs_A_zh", cut_after: ["tok_020", "tok_024"] }],
          [{ op: "set_recognition", terms: [" 飞书 ", "飞书", ""], remove_fillers: true }],
          [{ op: "replace_text", find: "今天", replace: "现在" }],
          [{ op: "replace_text", find: "先", replace: "首先" }],
          [{ op: "replace_text", find: "never matches", replace: "" }],
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
          input: { ...base, label: "Test edit", dry_run: true, idempotency_key: `format-02-${index}`, ops },
        })),
        { verb: "undo", input: base },
      ] as const;
      for (const { verb, input } of cases) {
        const request = { ...input, project };
        if (verb !== "undo" || "author" in input) expect(validateCommand(verb, request).valid).toBe(true);
        const cliResult = invokeCli(verb, input);
        const mcpResult = await client.callTool({ name: `zcut_${verb}`, arguments: request });
        const envelope = mcpResult.structuredContent as Record<string, unknown>;
        if ("ops" in input && input.ops[0]?.op === "resegment") {
          expect(cliResult.envelope.status).toBe("dry_run");
          expect(cliResult.envelope.changes).toEqual(
            expect.arrayContaining([expect.objectContaining({ entity: "transcript", id: "trs_A_zh" })]),
          );
        }
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
    15000,
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
        label: "Test edit",
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

  it.each(["direct-srt", "direct-audio-wav"])("matches %s dry-run across CLI and MCP", async (profile) => {
    const server = createServer();
    const client = new Client({ name: "direct-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      const input = {
        project,
        base_revision: "rev_fixture_1",
        idempotency_key: "direct-parity",
        author,
        profile,
        dry_run: true,
        output: join(directory, "out"),
      };
      const cliResult = invokeCli("export", input);
      const mcpResult = (await client.callTool({ name: "zcut_export", arguments: input })).structuredContent as Record<
        string,
        unknown
      >;
      expect(cliResult.code).toBe(0);
      expect(cliResult.envelope.status).toBe("dry_run");
      expect(validateEnvelope(mcpResult).valid).toBe(true);
      expect(withoutRequestId(cliResult.envelope)).toEqual(withoutRequestId(mcpResult));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["direct-srt", "direct-audio-wav"])(
    "matches %s worker results and bytes across CLI and MCP",
    async (profile) => {
      if (profile === "direct-audio-wav") {
        const raw = JSON.parse(await readFile(project, "utf8"));
        raw.media = [];
        raw.transcripts = [];
        raw.timelines[0].markers = [];
        raw.timelines[0].tracks = [
          { id: "trk_audio", kind: "audio", name: "Audio", enabled: true, clips: [], transitions: [] },
        ];
        await writeFile(project, JSON.stringify(raw));
      }
      const server = createServer();
      const client = new Client({ name: "direct-worker", version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(left), client.connect(right)]);
      try {
        const input = { project, base_revision: "rev_fixture_1", idempotency_key: "direct-worker", author, profile };
        const run = spawnSync(process.execPath, [cli, "export", project, "--wait"], {
          input: JSON.stringify({ ...input, output: join(directory, "cli") }),
          encoding: "utf8",
        });
        const cliResult = JSON.parse(run.stdout);
        expect(cliResult.status).toBe("applied");
        const accepted = (
          await client.callTool({ name: "zcut_export", arguments: { ...input, output: join(directory, "mcp") } })
        ).structuredContent as { result: { job_id: string } };
        let final: Record<string, unknown> | undefined;
        for (let i = 0; i < 100; i++) {
          const response = (
            await client.callTool({ name: "zcut_job_status", arguments: { project, job_id: accepted.result.job_id } })
          ).structuredContent as { result: { state: string; envelope: Record<string, unknown> } };
          if (["succeeded", "failed"].includes(response.result.state)) {
            final = response.result.envelope;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(final).toBeDefined();
        const { changes, verification, ...cliSummary } = cliResult;
        const { issues, ...verificationSummary } = verification;
        expect(
          withoutRequestId({
            ...cliSummary,
            changes_count: changes.length,
            changes_sample: changes.slice(0, 10),
            verification: {
              ...verificationSummary,
              issues_count: issues.length,
              issues_sample: [
                ...issues.filter((issue: { severity: string }) => issue.severity === "error"),
                ...issues.filter((issue: { severity: string }) => issue.severity !== "error"),
              ].slice(0, 10),
            },
          }),
        ).toEqual(withoutRequestId(final as Record<string, unknown>));
        for (const file of cliResult.result.files)
          expect(await readFile(join(directory, "cli", file.name))).toEqual(
            await readFile(join(directory, "mcp", file.name)),
          );
      } finally {
        await client.close();
        await server.close();
      }
    },
    20000,
  );

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

it("shares queued admission, batch status, undo, restore and historical reads between CLI and MCP", async () => {
  const server = createServer();
  const client = new Client({ name: "steps-parity", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    expect((await client.listTools()).tools).toHaveLength(31);
    const base = { base_revision: "rev_fixture_1", author, label: "Parity step" };
    const pair = async (verb: string, input: Record<string, unknown>, expectedStatus: string) => {
      const cliResult = invokeCli(verb, input);
      const mcpResult = await client.callTool({ name: `zcut_${verb}`, arguments: { ...input, project } });
      const actual = mcpResult.structuredContent as Record<string, unknown>;
      expect(validateEnvelope(cliResult.envelope).valid).toBe(true);
      expect(validateEnvelope(actual).valid).toBe(true);
      expect(cliResult.envelope.status, JSON.stringify(cliResult.envelope)).toBe(expectedStatus);
      expect(cliResult.code).toBe(expectedStatus === "failed" ? 1 : expectedStatus === "rejected" ? 2 : 0);
      if (actual.receipt && cliResult.envelope.receipt && !["failed", "rejected"].includes(expectedStatus)) {
        expect(actual.receipt).toMatchObject({ replayed: true });
        actual.receipt = { ...(actual.receipt as Record<string, unknown>), replayed: false };
      }
      expect(withoutRequestId(actual)).toEqual(withoutRequestId(cliResult.envelope));
      return cliResult.envelope;
    };
    const second = {
      ...base,
      idempotency_key: "batch-second",
      batch: { id: "bat_parity", seq: 2, count: 2 },
      ops: [{ op: "set_clip", clip_id: "clp_v1", label: "Second" }],
    };
    await pair("edit", second, "queued");
    await pair("batch_status", { batch_id: "bat_parity" }, "no_op");
    await pair(
      "edit",
      { ...base, idempotency_key: "blocked", ops: [{ op: "set_clip", clip_id: "clp_v1", label: "Other" }] },
      "failed",
    );
    const first = await pair(
      "edit",
      {
        ...base,
        idempotency_key: "batch-first",
        batch: { id: "bat_parity", seq: 1, count: 2 },
        ops: [{ op: "set_clip", clip_id: "clp_v1", label: "First" }],
      },
      "applied",
    );
    const firstRevision = (first.receipt as { after: string }).after;
    await pair("batch_status", { batch_id: "bat_parity" }, "no_op");
    await pair("inspect", { view: "history" }, "no_op");
    for (const view of ["entity", "timeline"])
      await pair(
        "inspect",
        { view, ...(view === "entity" ? { id: "clp_v1" } : {}), at_revision: firstRevision },
        "no_op",
      );
    for (const verb of ["render_preview", "view_timeline"])
      await pair(verb, { timeline_id: "tl_missing", output: directory, at_revision: firstRevision }, "rejected");
    let parsed = parseProject(await readFile(project, "utf8"));
    if (!parsed.ok) throw new Error("Invalid project");
    await pair(
      "undo",
      { ...base, base_revision: parsed.project.revision.id, idempotency_key: "undo-batch", batch_id: "bat_parity" },
      "applied",
    );
    parsed = parseProject(await readFile(project, "utf8"));
    if (!parsed.ok) throw new Error("Invalid project");
    await pair(
      "restore",
      { ...base, base_revision: parsed.project.revision.id, idempotency_key: "restore-step", target: firstRevision },
      "applied",
    );
    await pair("edit", { ...second, idempotency_key: "occupied" }, "rejected");
    await pair("batch_status", { batch_id: "bat_absent" }, "rejected");
  } finally {
    await client.close();
    await server.close();
  }
}, 30000);

it("shares overlay edit settings and export dry-run envelopes between CLI and MCP", async () => {
  const server = createServer();
  const client = new Client({ name: "overlay-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const added = invokeCli("edit", {
      base_revision: "rev_fixture_1",
      idempotency_key: "overlay-add",
      author,
      label: "Add overlay",
      ops: [
        {
          op: "add_overlay",
          id: "ovl_parity",
          name: "中文",
          timeline_id: "tl_std",
          subtitle_track_id: "trk_sub_zh",
          output_path: join(directory, "sub.mov"),
        },
      ],
    }).envelope;
    expect(added.status, JSON.stringify(added)).toBe("applied");
    const parsed = parseProject(await readFile(project, "utf8"));
    if (!parsed.ok) throw new Error("Bad project");
    for (const overlay_id of ["ovl_parity", "ovl_missing"]) {
      const input = {
        base_revision: parsed.project.revision.id,
        idempotency_key: `overlay-${overlay_id}`,
        author,
        profile: "subtitle-overlay",
        overlay_id,
        dry_run: true,
      };
      const cliResult = invokeCli("export", input).envelope;
      const mcpResult = (await client.callTool({ name: "zcut_export", arguments: { project, ...input } }))
        .structuredContent as Record<string, unknown>;
      expect(validateEnvelope(mcpResult).valid).toBe(true);
      expect(withoutRequestId(cliResult)).toEqual(withoutRequestId(mcpResult));
      expect(cliResult.status).toBe(overlay_id === "ovl_parity" ? "dry_run" : "rejected");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it("shares global terms list/edit envelopes through CLI and MCP without project receipts", async () => {
  const server = createServer();
  const client = new Client({ name: "terms-parity", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "zcut_terms_edit")?.inputSchema).not.toHaveProperty(
      "properties.project",
    );
    for (const [action, input, status] of [
      ["edit", { ops: [{ op: "add", text: "飞书" }] }, "applied"],
      ["list", {}, "no_op"],
      ["list", { state: "blocked", query: "飞" }, "no_op"],
      ["edit", { ops: [{ op: "remove", text: "飞书" }] }, "applied"],
      ["edit", { ops: [{ op: "add", text: " " }] }, "rejected"],
    ] as const) {
      // Reset before each write so both transports observe the same initial state.
      const file = join(directory, "request.json");
      await writeFile(file, JSON.stringify(input));
      const cliRun = spawnSync(process.execPath, [cli, "terms", action, "--input", file], { encoding: "utf8" });
      const cliEnvelope = JSON.parse(cliRun.stdout);
      if (action === "edit" && status === "applied") {
        const undo = { ops: [{ op: input.ops[0].op === "add" ? "remove" : "add", text: "飞书" }] };
        await client.callTool({ name: "zcut_terms_edit", arguments: undo });
      }
      const mcp = (await client.callTool({ name: `zcut_terms_${action}`, arguments: input }))
        .structuredContent as Record<string, unknown>;
      expect(mcp.status).toBe(status);
      expect(validateEnvelope(mcp)).toEqual({ valid: true, errors: [] });
      expect(validateEnvelope(cliEnvelope)).toEqual({ valid: true, errors: [] });
      expect(mcp.receipt).toBeNull();
      expect(withoutRequestId(mcp)).toEqual(withoutRequestId(cliEnvelope));
    }
    const plain = spawnSync(process.execPath, [cli, "terms", "list"], { encoding: "utf8" });
    expect(JSON.parse(plain.stdout).ok).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

it("shares insert move schema, dry-run changes, commit replay and multi-group rejection without sockets", async () => {
  await copyFile(new URL("../../../fixtures/regressions/move-insert.zcut.json", import.meta.url), project);
  const server = createServer();
  const client = new Client({ name: "insert-move", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const input = {
      project,
      author,
      base_revision: "rev_example_1",
      idempotency_key: "insert-move",
      label: "插入移动",
      ops: [{ op: "move", clip_ids: ["clp_v2"], to: "5s", mode: "insert" }],
    };
    for (const request of [
      { ...input, dry_run: true },
      input,
      {
        ...input,
        idempotency_key: "multi",
        ops: [{ op: "move", clip_ids: ["clp_v1", "clp_v2"], to: "0s", mode: "insert" }],
        base_revision: undefined,
      },
    ]) {
      if (request.idempotency_key === "multi")
        request.base_revision = JSON.parse(await readFile(project, "utf8")).revision.id;
      let cliResult = invokeCli("edit", request);
      if (cliResult.envelope.status === "applied") cliResult = invokeCli("edit", request);
      const mcpResult = (await client.callTool({ name: "zcut_edit", arguments: request })).structuredContent as Record<
        string,
        unknown
      >;
      expect(validateEnvelope(mcpResult).valid).toBe(true);
      expect(withoutRequestId(cliResult.envelope)).toEqual(withoutRequestId(mcpResult));
      if (request.idempotency_key === "multi") expect(mcpResult.error).toMatchObject({ code: "E_VALIDATION" });
      else expect(cliResult.envelope.status).toBe(request.dry_run ? "dry_run" : "applied");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it("shares global voice/settings envelopes without project fields or Keychain access", async () => {
  vi.stubEnv("ZSIR_FISH_API_KEY", "parity-test-key");
  const server = createServer();
  const client = new Client({ name: "voice-parity", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const settingsPath = join(directory, "Library/Application Support/zsir-cut/settings.json");
    const cases: [string, Record<string, unknown>][] = [
      ["settings_get", {}],
      [
        "settings_set",
        { voice: { model: "drama-3" }, network: { proxy: "http://127.0.0.1:7897" }, voice_key: "ignored-key" },
      ],
      ["settings_set", { voice: { model: "invalid" } }],
      ["voice_list", {}],
      ["voice_edit", { ops: [] }],
      ["voice_edit", { ops: [{ op: "rename", id: "voc_019a0000-0000-7000-8000-000000000001", name: " " }] }],
      ["voice_edit", { ops: [{ op: "delete", id: "voc_019a0000-0000-7000-8000-000000000001" }] }],
      ["voice_clone", { name: " ", file: "/unused.wav" }],
      ["voice_clone", { name: "missing source" }],
      ["job_status", { job_id: "job_019a0000-0000-7000-8000-000000000001" }],
    ];
    for (const [verb, input] of cases) {
      if (verb === "settings_set") await rm(settingsPath, { force: true });
      const file = join(directory, "voice-request.json");
      await writeFile(file, JSON.stringify(input));
      const args = verb === "job_status" ? [verb] : verb.split("_");
      const run = spawnSync(process.execPath, [cli, ...args, "--input", file], { encoding: "utf8" });
      expect(run.stdout, run.stderr).not.toBe("");
      const cliOutput = JSON.parse(run.stdout);
      if (verb === "settings_set") await rm(settingsPath, { force: true });
      const mcp = (await client.callTool({ name: `zcut_${verb}`, arguments: input })).structuredContent as Record<
        string,
        unknown
      >;
      expect(validateEnvelope(mcp)).toEqual({ valid: true, errors: [] });
      expect(validateEnvelope(cliOutput)).toEqual({ valid: true, errors: [] });
      expect(withoutRequestId(cliOutput)).toEqual(withoutRequestId(mcp));
      expect(mcp.receipt).toBeNull();
      expect(JSON.stringify(mcp)).not.toContain("parity-test-key");
      expect(run.status).toBe(mcp.status === "rejected" ? 2 : mcp.status === "failed" ? 1 : 0);
    }
    for (const [group, action] of [
      ["settings", "get"],
      ["voice", "list"],
    ]) {
      const run = spawnSync(process.execPath, [cli, group, action], { encoding: "utf8" });
      expect(JSON.parse(run.stdout).status).toBe("no_op");
    }
  } finally {
    await client.close();
    await server.close();
  }
}, 15000);

it("never reflects a malformed settings request containing a key in CLI errors", async () => {
  const secret = "malformed-secret-must-not-leak";
  const run = spawnSync(process.execPath, [cli, "settings", "set"], {
    encoding: "utf8",
    input: `{"voice_key": ${secret}}`,
  });
  expect(run.status).toBe(2);
  expect(JSON.parse(run.stdout)).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
  expect(run.stdout + run.stderr).not.toContain(secret);
});

it("shares project voice_generate validation, completed worker receipts and idempotent replay between CLI and MCP", async () => {
  vi.stubEnv("ZSIR_FISH_API_KEY", "fake-generation-key");
  vi.stubEnv("HTTPS_PROXY", "");
  const voiceId = "voc_019a0000-0000-7000-8000-000000000001";
  await mkdir(join(directory, "Library/Application Support/zsir-cut"), { recursive: true });
  await writeVoices([
    {
      id: voiceId,
      name: "Test voice",
      fish_model_id: "fish-ref",
      source: { kind: "file", name: "sample.wav" },
      sample: `voices/${voiceId}.wav`,
      created_at: "2026-10-30T00:00:00.000Z",
    },
  ]);
  const bin = join(directory, "bin");
  await mkdir(bin);
  const probe = join(bin, "ffprobe");
  const metadata = {
    streams: [
      { index: 0, codec_type: "audio", sample_rate: "44100", channels: 1, duration_ts: "44100", time_base: "1/44100" },
    ],
  };
  await writeFile(probe, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(metadata))});\n`);
  await chmod(probe, 0o700);
  const preload = join(directory, "fake-tts.mjs");
  await writeFile(
    preload,
    'globalThis.fetch = async (_url, init) => new Response("fake WAV:" + JSON.parse(init.body).text);',
  );
  const server = createServer();
  const client = new Client({ name: "voice-generation-parity", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const base = {
      project,
      base_revision: "rev_fixture_1",
      idempotency_key: "voice-parity",
      author,
      voice_id: voiceId,
      items: [{ text: "第一段" }, { text: "第二段" }],
    };
    for (const extra of [
      { items: [] },
      { params: { speed: 3 } },
      { cues: { transcript_id: "trs_A_zh", cue_ids: ["cue_zh_00"], mode: "merged" } },
      { voice_id: "voc_missing" },
      { base_revision: "rev_old" },
    ]) {
      const input = { ...base, ...extra };
      const run = invokeCli("voice_generate", input);
      const mcp = (await client.callTool({ name: "zcut_voice_generate", arguments: input }))
        .structuredContent as Record<string, unknown>;
      expect(withoutRequestId(run.envelope)).toEqual(withoutRequestId(mcp));
    }
    for (const entry of ["src/index.ts", "dist/index.js"]) {
      const parsed = parseProject(await readFile(project, "utf8"));
      if (!parsed.ok) throw new Error("Invalid fixture");
      const input = { ...base, base_revision: parsed.project.revision.id, idempotency_key: `voice-${entry}` };
      const file = join(directory, "generate-request.json");
      await writeFile(file, JSON.stringify(input));
      const cliEntry = fileURLToPath(new URL(`../../cli/${entry}`, import.meta.url));
      const run = spawnSync(process.execPath, [cliEntry, "voice", "generate", project, "--input", file, "--wait"], {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
      });
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const output = JSON.parse(run.stdout);
      expect(output).toMatchObject({
        status: "applied",
        verb: "voice_generate",
        changes: [{ entity: "media" }, { entity: "media" }],
      });
      expect(validateEnvelope(output).valid).toBe(true);
      const mcp = (await client.callTool({ name: "zcut_voice_generate", arguments: input }))
        .structuredContent as Record<string, unknown>;
      expect(mcp.receipt).toMatchObject({ replayed: true });
      output.receipt.replayed = true;
      expect(withoutRequestId(output)).toEqual(withoutRequestId(mcp));
      expect(JSON.stringify(mcp)).not.toContain("fake-generation-key");
    }
  } finally {
    await client.close();
    await server.close();
  }
}, 30000);
