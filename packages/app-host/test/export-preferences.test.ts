import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { exportPreferences } from "../src/export-preferences.js";

it("round-trips validated output preferences under the project sidecar without altering the project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-export-prefs-"));
  try {
    const project = join(directory, "project.zcut.json");
    await writeFile(project, "source");
    expect(await exportPreferences(project, "prj_one")).toEqual({});
    const value = { fcp: "/tmp/交接", direct: "/tmp/直接" };
    await exportPreferences(project, "prj_one", value);
    expect(await exportPreferences(project, "prj_one")).toEqual(value);
    expect(JSON.parse(await readFile(join(directory, ".zcut/prj_one/export-preferences.json"), "utf8"))).toEqual(value);
    expect(await exportPreferences(project, "prj_two")).toEqual({});
    await expect(exportPreferences(project, "prj_one", { direct: "relative" })).rejects.toThrow();
    await expect(exportPreferences(project, "prj_one", { arbitrary: "/tmp" })).rejects.toThrow();
    expect(await readFile(project, "utf8")).toBe("source");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("forwards the export panel and subdestination through the desktop MCP tool without a network listener", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../src/index.js");
  let forwarded: unknown;
  const server = createMcpServer(async (verb, request) => {
    forwarded = request;
    return {
      ok: true,
      status: "no_op",
      verb,
      request_id: "req_test",
      receipt: null,
      changes: [],
      verification: { level: "none", passed: true, issues: [] },
      result: null,
      error: null,
    };
  });
  const client = new Client({ name: "export-test", version: "1" });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(transport), client.connect(peer)]);
    const response = await client.callTool({
      name: "zcut_ui_show_panel",
      arguments: { panel: "export", sub: "overlays" },
    });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(forwarded).toEqual({ panel: "export", sub: "overlays" });
  } finally {
    await client.close();
    await server.close();
  }
});
