import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/dispatch.ts";
import { parseProject } from "../src/project/io.ts";

const io = vi.hoisted(() => ({
  directories: [] as string[],
  syncedDirectories: [] as string[],
  syncedFiles: [] as string[],
  failFile: "",
  failDirectory: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const path = String(args[0]);
      const directory = (await handle.stat()).isDirectory();
      if (directory) io.directories.push(path);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        (directory ? io.syncedDirectories : io.syncedFiles).push(path);
        if (
          (directory && (process.platform === "win32" || io.failDirectory)) ||
          (!directory &&
            io.failFile &&
            (io.failFile === ".tmp" ? path.endsWith(".tmp") : basename(path) === io.failFile))
        )
          throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
        await sync();
      });
      return handle;
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const author = { kind: "agent", name: "windows-write-test" };
let directory: string;
let project: string;
const load = async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid project");
  return parsed.project;
};
const edit = async (extra: Record<string, unknown> = {}) =>
  dispatch("edit", {
    project,
    author,
    base_revision: (await load()).revision.id,
    idempotency_key: "edit",
    label: "Add a video track",
    ops: [{ op: "add_track", kind: "video" }],
    ...extra,
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-windows-writes-"));
  project = join(directory, "project.zcut.json");
  io.directories.length = 0;
  io.syncedDirectories.length = 0;
  io.syncedFiles.length = 0;
  io.failFile = "";
  io.failDirectory = false;
});
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(["win32", "darwin", "linux"])("preserves file fsync and applies all write paths on %s", async (value) => {
  Object.defineProperty(process, "platform", { value });
  const created = await dispatch("create_project", {
    project,
    author,
    name: "Windows writes",
    timeline: { edit_rate: "25", width: 640, height: 360 },
    idempotency_key: "create",
  });
  expect(created.status, JSON.stringify(created.error)).toBe("applied");
  const root = join(directory, ".zcut", (await load()).id);
  const recordsPath = join(root, "idempotency.jsonl");
  const creationRecord = JSON.parse((await readFile(recordsPath, "utf8")).trim());
  const oldRecords = Array.from({ length: 1001 }, (_, index) => ({
    ...creationRecord,
    idempotency_key: `old-${index}`,
    at: "2000-01-01T00:00:00Z",
    envelope: { ...creationRecord.envelope, verb: "edit" },
  }));
  await writeFile(
    recordsPath,
    `${[creationRecord, ...oldRecords].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const media = join(directory, "media.mp4");
  await writeFile(media, "synthetic probe input");
  const imported = await dispatch(
    "import_media",
    { project, author, base_revision: created.receipt?.after, idempotency_key: "import", paths: [media] },
    {
      probe: async () => ({
        streams: [
          { index: 0, codec_type: "video", r_frame_rate: "25/1", width: 640, height: 360, time_base: "1/1000" },
        ],
        packets: [0, 40].map((pts) => ({ stream_index: 0, pts, duration: 40 })),
      }),
    },
  );
  expect(imported.status, JSON.stringify(imported.error)).toBe("applied");
  expect((await readFile(recordsPath, "utf8")).trim().split("\n")).toHaveLength(1001);
  expect(io.syncedFiles.some((path) => path.startsWith(`${recordsPath}.`) && path.endsWith(".tmp"))).toBe(true);

  const edited = await edit({ batch: { id: "bat_windows", seq: 1, count: 1 } });
  expect(edited.status, JSON.stringify(edited.error)).toBe("applied");
  expect(JSON.parse(await readFile(join(root, "batches/bat_windows/state.json"), "utf8")).state).toBe("complete");
  const session = await dispatch("session_begin", {
    project,
    author,
    base_revision: edited.receipt?.after,
    idempotency_key: "session",
    approval: "manual",
    intent: "Test session persistence",
  });
  expect(session.ok, JSON.stringify(session.error)).toBe(true);
  const sessionPath = join(root, "sessions", session.result?.session_id as string, "session.json");
  expect(JSON.parse(await readFile(sessionPath, "utf8")).state).toBe("open");
  expect((await load()).media).toHaveLength(1);
  expect((await load()).timelines[0]?.tracks.filter((track) => track.kind === "video")).toHaveLength(2);
  expect(io.syncedFiles).toEqual(expect.arrayContaining([join(root, "journal.jsonl"), recordsPath]));
  expect(io.syncedFiles.some((path) => path.startsWith(`${sessionPath}.`))).toBe(true);
  expect(io.syncedFiles.some((path) => path.startsWith(join(root, "batches/bat_windows")))).toBe(true);
  if (value === "win32") {
    expect(io.directories).toEqual([]);
    expect(io.syncedDirectories).toEqual([]);
  } else {
    expect(io.syncedDirectories).toEqual(io.directories);
    expect(io.syncedDirectories).toEqual(
      expect.arrayContaining([directory, root, join(root, "batches/bat_windows"), dirname(sessionPath)]),
    );
  }
});

it.each([
  ["lock", "failed"],
  [".tmp", "failed"],
  ["journal.jsonl", "committed_unverified"],
  ["idempotency.jsonl", "committed_unverified"],
])("preserves Windows file fsync EPERM for %s as %s", async (file, status) => {
  await copyFile("fixtures/projects/std-25.zcut.json", project);
  const before = await readFile(project, "utf8");
  Object.defineProperty(process, "platform", { value: "win32" });
  io.failFile = file;
  const result = await edit();
  expect(result).toMatchObject({ status, error: { code: "E_IO", message: expect.stringContaining("EPERM") } });
  if (status === "failed") expect(await readFile(project, "utf8")).toBe(before);
  else expect(result.receipt?.after).toBe((await load()).revision.id);
});

it("preserves POSIX directory fsync EPERM as committed_unverified", async () => {
  await copyFile("fixtures/projects/std-25.zcut.json", project);
  Object.defineProperty(process, "platform", { value: "darwin" });
  io.failDirectory = true;
  const result = await edit();
  expect(result).toMatchObject({
    status: "committed_unverified",
    error: { code: "E_IO", message: expect.stringContaining("EPERM") },
  });
  expect(result.receipt?.after).toBe((await load()).revision.id);
});
