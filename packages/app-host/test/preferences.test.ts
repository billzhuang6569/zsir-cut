import { on, once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Agents } from "../src/agents.js";
import { createMcpServer, startHost } from "../src/index.js";
import { actions, keyNotation, mergeKeymap, presets } from "../src/keymap.js";
import { DesktopPreferences, defaultPreferences } from "../src/preferences.js";

let home: string;
let host: Awaited<ReturnType<typeof startHost>> | undefined;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcut-prefs-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local/share"));
  vi.spyOn(Agents.prototype, "detect").mockResolvedValue([]);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await host?.close();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
async function connect() {
  host = await startHost();
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  sockets.push(socket);
  await once(socket, "open");
  const messages = on(socket, "message", { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify({ type: "ui_ready" }));
  for await (const [raw] of messages) {
    if (JSON.parse(raw.toString()).type === "bootstrap") break;
  }
  return socket;
}
async function send(socket: WebSocket, verb: string, request: unknown = {}) {
  const reply = new Promise<ReturnType<typeof JSON.parse>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error("Missing prefs response"));
    }, 3000);
    const receive = (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.id !== "prefs") return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
  socket.send(JSON.stringify({ id: "prefs", verb, request }));
  const response = await reply;
  expect(response).toMatchObject({ type: "result", id: "prefs" });
  expect(response.envelope).not.toHaveProperty("receipt");
  return response.envelope;
}
it("defines every action exactly once in both presets using canonical notation", () => {
  expect(actions).toHaveLength(35);
  expect(keyNotation.test("A\n")).toBe(false);
  for (const preset of Object.values(presets)) {
    expect(Object.keys(preset).sort()).toEqual([...actions].sort());
    expect(new Set(Object.values(preset)).size).toBe(actions.length);
    for (const key of Object.values(preset)) expect(key).toMatch(keyNotation);
  }
  expect(mergeKeymap("fcp", { tool_select: "B" })).toMatchObject({
    keymap: { tool_select: "B", tool_blade: null },
    unbound: ["tool_blade"],
  });
  expect(mergeKeymap("fcp", { tool_select: null }).keymap.tool_select).toBeNull();
  expect(mergeKeymap("fcp", { tool_select: "B", tool_blade: "B" })).toEqual(
    mergeKeymap("fcp", { tool_blade: "B", tool_select: "B" }),
  );
});
it("persists nested patches across host restarts, replaces arrays and rejects invalid updates without writes", async () => {
  let socket = await connect();
  const initial = await send(socket, "prefs_get");
  expect(initial.result.prefs).toEqual(defaultPreferences);
  expect(initial.result.preview_cache_directory).toBe(join(home, "Movies/庄Sir剪辑助手/预览缓存"));
  expect(
    await send(socket, "prefs_set", {
      patch: {
        default_agent: "codex",
        ui: { snap: false, chapters: { folded: ["mrk_one", "mrk_two"] } },
        keymap: { overrides: { tool_select: "B" } },
      },
    }),
  ).toMatchObject({ status: "applied", result: { unbound: ["tool_blade"] } });
  expect(await send(socket, "prefs_set", { patch: { ui: { chapters: { folded: ["mrk_two"] } } } })).toMatchObject({
    result: { prefs: { ui: { snap: false, magnetic: true, chapters: { folded: ["mrk_two"], zoom: 1 } } } },
  });
  socket.terminate();
  await host?.close();
  host = undefined;
  socket = await connect();
  expect(await send(socket, "prefs_get")).toMatchObject({
    result: {
      prefs: { default_agent: "codex", ui: { snap: false, chapters: { folded: ["mrk_two"] } } },
      keymap: { tool_select: "B", tool_blade: null },
    },
  });
  const directory =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/zsir-cut")
      : join(home, ".local/share/zsir-cut");
  const file = join(directory, "desktop.json");
  const before = await readFile(file, "utf8");
  const assertSorted = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      expect(Object.keys(value)).toEqual(Object.keys(value).sort());
      for (const child of Object.values(value)) assertSorted(child);
    }
  };
  assertSorted(JSON.parse(before));
  for (const patch of [
    null,
    [],
    { unknown: true },
    { ui: null },
    { ui: { chapters: { zoom: 5 } } },
    { keymap: { overrides: { unknown: "A" } } },
    { keymap: { overrides: { tool_select: "⌘⇧A" } } },
    { preview_cache: { limit_gb: 0 } },
    { preview_cache: { directory: "relative" } },
    { default_agent: "other" },
  ]) {
    expect(await send(socket, "prefs_set", { patch })).toMatchObject({
      status: "rejected",
      error: { code: "E_VALIDATION" },
    });
  }
  expect(await send(socket, "prefs_set", { patch: { ui: { snap: false } } })).toMatchObject({ status: "no_op" });
  expect(await readFile(file, "utf8")).toBe(before);
});
it.each(["{broken", "null"])("recovers corrupt or invalid files and pushes a UI warning: %s", async (content) => {
  const directory = join(home, "data");
  await mkdir(directory);
  await writeFile(join(directory, "desktop.json"), content);
  host = await startHost({ appDataDir: directory });
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  sockets.push(socket);
  await once(socket, "open");
  const messages: unknown[] = [];
  const warning = new Promise<void>((resolve) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "warning") resolve();
    }),
  );
  socket.send(JSON.stringify({ type: "ui_ready" }));
  await warning;
  expect(messages).toMatchObject([
    { type: "bootstrap" },
    { type: "warning", code: "W_PREFS_RESET", message: expect.any(String) },
  ]);
  expect((await send(socket, "prefs_get")).result.prefs).toEqual(defaultPreferences);
  expect(await readFile(join(directory, "desktop.json.broken"), "utf8")).toBe(content);
});
it("serializes concurrent patches without losing fields", async () => {
  const prefs = new DesktopPreferences(home);
  await prefs.load();
  await Promise.all([prefs.set({ ui: { snap: false } }), prefs.set({ ui: { magnetic: false } })]);
  const restarted = new DesktopPreferences(home);
  await restarted.load();
  expect(restarted.get().prefs.ui).toMatchObject({ snap: false, magnetic: false });
});
it("never advertises or accepts prefs verbs via MCP", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "prefs-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const verb of [
      "prefs_get",
      "prefs_set",
      "agents_list",
      "agents_install",
      "agents_update",
      "agents_set_default",
      "permission_answer",
      "preview_cache_status",
      "preview_cache_clear",
      "preview_cache_move",
      "preview_cache_playhead",
      "preview_cache_hint",
    ]) {
      expect(names).not.toContain(`zcut_${verb}`);
      await expect(client.callTool({ name: `zcut_${verb}`, arguments: {} })).rejects.toThrow("Unknown tool");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it("validates and restores the single-file store without a listener", async () => {
  const store = new DesktopPreferences(home);
  await store.load();
  expect(store.get().prefs).toEqual(defaultPreferences);
  expect(store.get().preview_cache_directory).toBe(join(home, "Movies/庄Sir剪辑助手/预览缓存"));
  await store.set({
    default_agent: "codex",
    keymap: { overrides: { tool_select: "B" } },
    ui: { snap: false, chapters: { folded: ["one", "two"] } },
  });
  await store.set({ ui: { chapters: { folded: ["two"] } } });
  const file = join(home, "desktop.json");
  const content = await readFile(file, "utf8");
  const restarted = new DesktopPreferences(home);
  await restarted.load();
  expect(restarted.get()).toMatchObject({
    prefs: { default_agent: "codex", ui: { snap: false, magnetic: true, chapters: { folded: ["two"], zoom: 1 } } },
    keymap: { tool_select: "B", tool_blade: null },
    unbound: ["tool_blade"],
  });
  expect((await restarted.set({ ui: { snap: false } })).status).toBe("no_op");
  for (const patch of [
    null,
    [],
    { unknown: true },
    { ui: null },
    { preview_cache: { limit_gb: 2001 } },
    { keymap: { overrides: { tool_select: "⌘⇧A" } } },
  ]) {
    await expect(restarted.set(patch)).rejects.toThrow();
  }
  expect(await readFile(file, "utf8")).toBe(content);
  for (const broken of ["{broken", "null", "[]", "42", '"text"']) {
    await writeFile(file, broken);
    const recovered = new DesktopPreferences(home);
    await recovered.load();
    expect(recovered.get().prefs).toEqual(defaultPreferences);
    expect(recovered.warning).toMatchObject({ type: "warning", code: "W_PREFS_RESET" });
    expect(await readFile(`${file}.broken`, "utf8")).toBe(broken);
  }
});

it.each([1, 2, 99])("preserves unknown keys at every level through reads and writes of version %s", async (version) => {
  const file = join(home, "desktop.json");
  const stored = {
    ...structuredClone(defaultPreferences),
    version,
    future: { z: [1, { b: false, a: null }], a: "keep" },
    keymap: { preset: "premiere", future: true, overrides: { tool_select: "B", future_action: { key: "X" } } },
    ui: {
      ...defaultPreferences.ui,
      snap: false,
      chapters: { view: "timeline", zoom: 2, folded: ["mrk_one"], future: ["keep"] },
      layout: { left_width: 300, right_width: 400, timeline_height: 0.4, future: null },
    },
  };
  const content = JSON.stringify(stored);
  await writeFile(file, content);
  const store = new DesktopPreferences(home);
  await store.load();
  expect(store.warning).toBeUndefined();
  expect(store.get().prefs).toMatchObject({
    version: version === 1 ? 2 : version,
    keymap: { preset: "premiere", overrides: { tool_select: "B" } },
    ui: { snap: false, chapters: { folded: ["mrk_one"] }, layout: { left_width: 300 } },
  });
  expect(store.get().prefs).not.toHaveProperty("future");
  expect(store.get().prefs.keymap.overrides).not.toHaveProperty("future_action");
  expect(await readdir(home)).toEqual(["desktop.json"]);
  if (version !== 1) expect(await readFile(file, "utf8")).toBe(content);
  await store.set({ version: 2, ui: { magnetic: false }, keymap: { overrides: {} } });
  const expected = {
    ...stored,
    version: version === 1 ? 2 : version,
    keymap: { ...stored.keymap, overrides: { future_action: stored.keymap.overrides.future_action } },
    ui: { ...stored.ui, magnetic: false },
  };
  const written = await readFile(file, "utf8");
  expect(JSON.parse(written)).toEqual(expected);
  expect(written.endsWith("\n")).toBe(true);
  const assertSorted = (value: unknown) => {
    if (value && typeof value === "object") {
      if (!Array.isArray(value)) expect(Object.keys(value)).toEqual(Object.keys(value).sort());
      for (const child of Object.values(value)) assertSorted(child);
    }
  };
  assertSorted(JSON.parse(written));
  const restarted = new DesktopPreferences(home);
  await restarted.load();
  expect(restarted.warning).toBeUndefined();
  expect(restarted.get()).toEqual(store.get());
  expect((await restarted.set({ ui: { magnetic: false } })).status).toBe("no_op");
  expect(await readdir(home)).toEqual(["desktop.json"]);
  expect(await readFile(file, "utf8")).toBe(written);
});

it("defaults a single out-of-range leaf without changing its siblings", async () => {
  const stored = {
    ...defaultPreferences,
    ui: { ...defaultPreferences.ui, snap: false, layout: { left_width: 5, right_width: 400, timeline_height: 0.4 } },
  };
  await writeFile(join(home, "desktop.json"), JSON.stringify(stored));
  const store = new DesktopPreferences(home);
  await store.load();
  expect(store.get().prefs).toEqual({
    ...stored,
    ui: { ...stored.ui, layout: { ...stored.ui.layout, left_width: null } },
  });
  expect(store.warning).toEqual({
    type: "warning",
    code: "W_PREFS_RESET",
    message: "这几项设置无效，已恢复默认：ui.layout.left_width",
  });
  expect(await readdir(home)).toEqual(["desktop.json"]);
});

it("resets only invalid leaves and reports all their paths in one warning", async () => {
  const stored = structuredClone(defaultPreferences);
  stored.default_agent = "codex";
  stored.ui.snap = false;
  stored.ui.layout = { left_width: 5, right_width: 400, timeline_height: 0.4 };
  stored.ui.chapters = { view: "timeline", zoom: 10, folded: ["mrk_one"] };
  stored.keymap.overrides = { tool_select: "invalid", tool_blade: "D" };
  stored.preview_cache.limit_gb = 0;
  const file = join(home, "desktop.json");
  const content = JSON.stringify(stored);
  await writeFile(file, content);
  const store = new DesktopPreferences(home);
  await store.load();
  const expected = {
    ...stored,
    keymap: { ...stored.keymap, overrides: { tool_blade: "D" } },
    preview_cache: { ...stored.preview_cache, limit_gb: defaultPreferences.preview_cache.limit_gb },
    ui: {
      ...stored.ui,
      chapters: { ...stored.ui.chapters, zoom: defaultPreferences.ui.chapters.zoom },
      layout: { ...stored.ui.layout, left_width: defaultPreferences.ui.layout.left_width },
    },
  };
  expect(store.get().prefs).toEqual(expected);
  expect(store.warning).toMatchObject({ type: "warning", code: "W_PREFS_RESET" });
  for (const path of [
    "keymap.overrides.tool_select",
    "preview_cache.limit_gb",
    "ui.chapters.zoom",
    "ui.layout.left_width",
  ])
    expect(store.warning?.message).toContain(path);
  expect(await readdir(home)).toEqual(["desktop.json"]);
  expect(await readFile(file, "utf8")).toBe(content);
  await store.set({ ui: { magnetic: false } });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...expected, ui: { ...expected.ui, magnetic: false } });
});

it.each([null, [], "invalid"])("resets an invalid nested object (%j) without losing other settings", async (layout) => {
  const stored = { ...defaultPreferences, ui: { ...defaultPreferences.ui, snap: false, layout } };
  await writeFile(join(home, "desktop.json"), JSON.stringify(stored));
  const store = new DesktopPreferences(home);
  await store.load();
  expect(store.get().prefs.ui).toEqual({ ...defaultPreferences.ui, snap: false });
  expect(store.warning?.message).toContain("ui.layout");
  expect(await readdir(home)).toEqual(["desktop.json"]);
});
it("initializes the selected Agent from persisted default_agent", async () => {
  const prefs = new DesktopPreferences(home);
  await prefs.set({ default_agent: "codex" });
  const selected: (string | undefined)[] = [];
  vi.spyOn(Agents.prototype, "stop").mockImplementation(async function (this: Agents) {
    selected.push(this.selected);
  });
  const project = join(home, "project.zcut.json");
  await writeFile(project, await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url)));
  host = await startHost({ project, appDataDir: home });
  await host.close();
  host = undefined;
  expect(selected).toEqual(["codex"]);
});

it("replaces overrides wholesale and persists empty overrides when restoring preset defaults", async () => {
  const prefs = new DesktopPreferences(home);
  await prefs.load();
  await prefs.set({ keymap: { overrides: { tool_select: "B", toggle_snap: null } }, ui: { snap: false } });
  const replaced = await prefs.set({ keymap: { overrides: { tool_blade: "D" } } });
  expect(replaced.result.prefs.keymap.overrides).toEqual({ tool_blade: "D" });
  expect(replaced.result.keymap).toEqual(mergeKeymap("fcp", { tool_blade: "D" }).keymap);
  await prefs.set({ keymap: { preset: "premiere" } });
  expect(prefs.get().prefs.keymap.overrides).toEqual({ tool_blade: "D" });
  const reset = await prefs.set({ keymap: { overrides: {} } });
  expect(reset.status).toBe("applied");
  expect(reset.result.prefs.keymap).toEqual({ preset: "premiere", overrides: {} });
  expect(reset.result.keymap).toEqual(presets.premiere);
  expect(reset.result.unbound).toEqual([]);
  expect(reset.result.prefs.ui.snap).toBe(false);
  expect(JSON.parse(await readFile(join(home, "desktop.json"), "utf8")).keymap.overrides).toEqual({});
  const restarted = new DesktopPreferences(home);
  await restarted.load();
  expect(restarted.get().prefs.keymap.overrides).toEqual({});
  expect(restarted.get().keymap).toEqual(presets.premiere);
  expect((await prefs.set({ keymap: { overrides: {} } })).status).toBe("no_op");
});

it("loads pre-layout preferences and validates, deep-merges and restores layout across restarts", async () => {
  const file = join(home, "desktop.json");
  const legacy = structuredClone(defaultPreferences);
  Reflect.deleteProperty(legacy.ui, "layout");
  await writeFile(file, JSON.stringify(legacy));
  const store = new DesktopPreferences(home);
  await store.load();
  expect(store.warning).toBeUndefined();
  expect(store.get().prefs.ui.layout).toEqual(defaultPreferences.ui.layout);
  await store.set({ ui: { layout: { left_width: 560, right_width: 600, timeline_height: 0.75 } } });
  await store.set({ ui: { layout: { left_width: 200 } } });
  const restarted = new DesktopPreferences(home);
  await restarted.load();
  expect(restarted.get().prefs.ui.layout).toEqual({ left_width: 200, right_width: 600, timeline_height: 0.75 });
  await restarted.set({ ui: { layout: { timeline_height: 0.432 } } });
  await restarted.set({ ui: { snap: false } });
  expect(restarted.get().prefs.ui.layout).toEqual({ left_width: 200, right_width: 600, timeline_height: 0.432 });
  await restarted.set({ ui: { layout: { right_width: 240, timeline_height: 0.2 } } });
  const before = await readFile(file, "utf8");
  for (const layout of [
    null,
    { unknown: 1 },
    { left_width: 199 },
    { left_width: 561 },
    { left_width: 300.5 },
    { right_width: 239 },
    { right_width: 601 },
    { right_width: 340.1 },
    { timeline_height: 0.199 },
    { timeline_height: 0.751 },
    { timeline_height: 0.4321 },
  ])
    await expect(restarted.set({ ui: { layout } })).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  await restarted.set({ ui: { layout: { left_width: null, right_width: null, timeline_height: null } } });
  const reset = new DesktopPreferences(home);
  await reset.load();
  expect(reset.get().prefs.ui.layout).toEqual(defaultPreferences.ui.layout);
});

it.each([true, false])(
  "migrates v1 battery=%s exactly once and preserves other preferences",
  async (pause_on_battery) => {
    const file = join(home, "desktop.json");
    const legacy = structuredClone(defaultPreferences);
    legacy.preview_cache.pause_on_battery = pause_on_battery;
    legacy.ui.snap = false;
    await writeFile(file, JSON.stringify({ ...legacy, version: 1 }));
    const store = new DesktopPreferences(home);
    await store.load();
    expect(store.warning).toBeUndefined();
    expect(store.get().prefs).toEqual({
      ...legacy,
      version: 2,
      preview_cache: { ...legacy.preview_cache, pause_on_battery: false },
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store.get().prefs);
    await store.set({ preview_cache: { pause_on_battery: true } });
    const content = await readFile(file, "utf8");
    const restarted = new DesktopPreferences(home);
    await restarted.load();
    expect(restarted.get().prefs.preview_cache.pause_on_battery).toBe(true);
    expect(await readFile(file, "utf8")).toBe(content);
  },
);
