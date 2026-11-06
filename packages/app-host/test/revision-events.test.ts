import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type Envelope, type JournalEntry, openProject } from "../../core/src/index.ts";
import { jobPath, writeJob } from "../../core/src/jobs.ts";
import { Agents } from "../src/agents.js";
import { startHost } from "../src/index.js";
import { type ProjectChanged, projectChanged } from "../src/revision-events.js";

let directory: string;
let project: string;
let host: Awaited<ReturnType<typeof startHost>>;
let socket: WebSocket;
let client: Client;
let sequence = 0;
const events: ProjectChanged[] = [];
const author = { kind: "agent", name: "test-agent" };
const marker = (n: number) => ({
  op: "add_marker",
  id: `mrk_event_${n}`,
  at: `${n}s`,
  duration: "0s",
  kind: "note",
  text: `第 ${n} 步`,
});
const current = async () => JSON.parse(await readFile(project, "utf8"));
const request = async (extra: Record<string, unknown> = {}) => ({
  project,
  base_revision: (await current()).revision.id,
  idempotency_key: `event-${++sequence}`,
  author,
  label: "改动说明",
  ...extra,
});
async function call(verb: string, input: Record<string, unknown>) {
  const id = String(++sequence);
  const reply = new Promise<Envelope>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off("message", listener);
      resolve(message.envelope);
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify({ id, verb, request: input }));
  return reply;
}
describe("host revision pushes", () => {
  beforeEach(async () => {
    vi.spyOn(Agents.prototype, "detect").mockResolvedValue([]);
    directory = await mkdtemp(join(tmpdir(), "zcut-events-"));
    project = join(directory, "project.zcut.json");
    await copyFile(new URL("../../../examples/interview.zcut.json", import.meta.url), project);
    host = await startHost({ project, appDataDir: directory });
    socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
    await once(socket, "open");
    const bootstrap = once(socket, "message");
    socket.send(JSON.stringify({ type: "ui_ready" }));
    expect(JSON.parse((await bootstrap)[0].toString()).type).toBe("bootstrap");
    events.length = 0;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "project_changed") events.push(message);
    });
    client = new Client({ name: "events-test", version: "1" });
    const [server, transport] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.mcp.connect(server), client.connect(transport)]);
  });
  afterEach(async () => {
    await client?.close();
    socket?.terminate();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("pushes all five agent batch steps in journal order when the first step drains queued steps", async () => {
    const base = (await current()).revision.id;
    const step = async (seq: number) => {
      const result = await client.callTool({
        name: "zcut_edit",
        arguments: await request({
          base_revision: base,
          batch: { id: "bat_events", seq, count: 5 },
          label: `第 ${seq} 步`,
          reason: `理由 ${seq}`,
          ops: [marker(seq)],
        }),
      });
      return result.structuredContent as unknown as Envelope;
    };
    for (const seq of [5, 3, 2, 4]) expect((await step(seq)).status).toBe("queued");
    expect(events).toHaveLength(0);
    expect((await step(1)).ok).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(5));
    const history = await call("inspect", { project, view: "history" });
    const entries = (history.result?.entries as JournalEntry[]).toReversed();
    expect(events).toEqual(entries.map((entry) => projectChanged(entry, null)));
    expect(events.map((event) => event.batch?.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((event) => event.revision.seq)).toEqual(entries.map((entry) => entry.seq));
    expect(events[0]).toMatchObject({
      target: "main",
      session_id: null,
      label: "第 1 步",
      reason: "理由 1",
      author,
      summary: { marker: { added: 1, removed: 0, changed: 0 } },
      changes: [{ key: "mrk_event_1", entity: "marker" }],
      truncated: false,
    });
  });

  it("keeps complete counts when more than 50 changes are truncated and does not repeat idempotent writes", async () => {
    const input = await request({
      author: { kind: "human", name: "UI" },
      ops: Array.from({ length: 55 }, (_, n) => marker(n)),
    });
    expect((await call("edit", input)).ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ summary: { marker: { added: 55, removed: 0, changed: 0 } }, truncated: true });
    expect(events[0]?.changes).toHaveLength(50);
    expect((await call("edit", input)).receipt?.replayed).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("targets the session draft and also pushes undo, redo, restore and session approval", async () => {
    const begun = await call("session_begin", await request({ approval: "manual", intent: "草稿" }));
    expect(begun.ok).toBe(true);
    const session_id = begun.result?.session_id as string;
    const input = await request({ session_id, ops: [marker(1)] });
    expect((await call("edit", input)).status).toBe("drafted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: "session", session_id, verb: "edit" });
    const draft = join(directory, ".zcut", (await current()).id, "sessions", session_id, "draft.zcut.json");
    const [entry] = await openProject({ projectPath: draft }).journal();
    if (!entry) throw new Error("Missing draft journal entry");
    expect(events[0]).toEqual(projectChanged(entry, session_id));
    for (const verb of ["undo", "redo"] as const) {
      expect((await call(verb, await request({ session_id, base_revision: events.at(-1)?.revision.id }))).ok).toBe(
        true,
      );
      expect(events.at(-1)).toMatchObject({ target: "session", session_id, verb });
    }
    expect((await call("session_review", await request({ session_id }))).ok).toBe(true);
    expect((await call("session_approve", await request({ session_id }))).ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ target: "main", session_id, verb: "session_approve" });
    const mainRevision = events.at(-1)?.revision.id;
    expect((await call("undo", await request())).ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ target: "main", verb: "undo" });
    expect((await call("restore", await request({ target: mainRevision }))).ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ target: "main", verb: "restore" });
  });

  it("observes long-task journal receipts through job_status only once", async () => {
    const input = await request();
    const envelope = await openProject({ projectPath: project }).commitWrite(
      { ...input, author: { kind: "agent", name: "worker" }, verb: "transcribe", request_id: "req_worker", ops: [] },
      (candidate) => {
        candidate.name = "worker result";
      },
    );
    const job_id = "job_event";
    const now = new Date().toISOString();
    await writeJob(jobPath(project, (await current()).id, job_id), {
      job_id,
      verb: "transcribe",
      request: input,
      state: "succeeded",
      progress: 1,
      message: "done",
      created_at: now,
      updated_at: now,
      envelope,
    });
    for (let n = 0; n < 2; n++) expect((await call("job_status", { project, job_id })).ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: "transcribe",
      revision: { id: envelope.receipt?.after },
      changes: [{ key: "project", entity: "project" }],
      summary: { project: { added: 0, removed: 0, changed: 1 } },
    });
  });
});

it("projects clip positions using exact rationals and counts added, removed and changed entities", () => {
  const clip = { timeline_start: "1/3s", duration: "1/6s" };
  const change = {
    key: "clp_test",
    entity: "clip" as const,
    before: clip,
    after: null,
    before_parent: "trk_old",
    after_parent: null,
    before_index: null,
    after_index: null,
  };
  const result = projectChanged(
    {
      kind: "write",
      revision: "rev_test",
      parent: null,
      seq: 1,
      at: "",
      changes: [
        change,
        { ...change, before: null, after: clip, after_parent: "trk_new" },
        { ...change, after: { ...clip, timeline_start: "2/3s" }, after_parent: "trk_new" },
      ],
    },
    null,
  );
  expect(result.summary).toEqual({ clip: { added: 1, removed: 1, changed: 1 } });
  expect(result.changes).toEqual([
    { key: "clp_test", entity: "clip", before: { track_id: "trk_old", start: "1/3s", end: "1/2s" }, after: null },
    { key: "clp_test", entity: "clip", before: null, after: { track_id: "trk_new", start: "1/3s", end: "1/2s" } },
    {
      key: "clp_test",
      entity: "clip",
      before: { track_id: "trk_old", start: "1/3s", end: "1/2s" },
      after: { track_id: "trk_new", start: "2/3s", end: "5/6s" },
    },
  ]);
});

it("counts all entity types beyond the 50-row limit without leaking non-clip snapshots", () => {
  const changes = Array.from({ length: 55 }, (_, n) => ({
    key: `tok_${n}`,
    entity: "token" as const,
    before: { text: "old" },
    after: { text: "new" },
    before_parent: "trs_test",
    after_parent: "trs_test",
    before_index: null,
    after_index: null,
  }));
  const event = projectChanged(
    {
      kind: "write",
      revision: "rev_many",
      parent: null,
      seq: 1,
      at: "",
      changes: [
        ...changes,
        {
          ...changes[0],
          key: "mrk_added",
          entity: "marker",
          before: null,
          after: { text: "added" },
          before_parent: null,
          after_parent: "tl_main",
          before_index: null,
          after_index: null,
        },
        {
          ...changes[0],
          key: "mrk_removed",
          entity: "marker",
          before: { text: "removed" },
          after: null,
          before_parent: "tl_main",
          after_parent: null,
          before_index: null,
          after_index: null,
        },
      ],
    },
    null,
  );
  expect(event.summary).toEqual({
    token: { added: 0, removed: 0, changed: 55 },
    marker: { added: 1, removed: 1, changed: 0 },
  });
  expect(event.truncated).toBe(true);
  expect(event.changes).toEqual(changes.slice(0, 50).map(({ key, entity }) => ({ key, entity })));
});
