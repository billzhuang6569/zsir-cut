import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestModel } from "../src/asr-models.js";
import { networkTest } from "../src/network-test.js";
import { DesktopPreferences } from "../src/preferences.js";
import {
  createProxyResolver,
  parseSystemProxy,
  proxyEnvironment,
  proxyFormatMessage,
  validProxy,
} from "../src/proxy.js";

const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(https_proxy|http_proxy|all_proxy|no_proxy)$/i.test(key)) vi.stubEnv(key, undefined);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function proxyServer(connect: (host: string, socket: Duplex) => void) {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket) => connect(request.url ?? "", socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, proxy: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
it("selects proxies in order and builds an isolated child environment", () => {
  const startup = {
    HTTPS_PROXY: "http://first:1",
    https_proxy: "http://second:2",
    HTTP_PROXY: "http://third:3",
    http_proxy: "http://fourth:4",
    NO_PROXY: "private.test",
    no_proxy: "other.test",
    ALL_PROXY: "socks://ignored",
    PATH: "/bin",
  };
  const run = vi.fn(
    () => "HTTPEnable : 1\nHTTPProxy : system\nHTTPPort : 80",
  ) as unknown as typeof import("node:child_process").execFileSync;
  const resolve = createProxyResolver(startup, "darwin", run);
  expect(resolve(" http://saved:9 ")).toEqual({ source: "setting", proxy: "http://saved:9" });
  expect(resolve()).toEqual({ source: "environment", proxy: "http://first:1" });
  const env = proxyEnvironment("", startup, resolve);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(env[key]).toBe("http://first:1");
  expect(env).toMatchObject({
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "private.test,other.test,127.0.0.1,localhost,::1",
    PATH: "/bin",
  });
  expect(env.ALL_PROXY).toBeUndefined();
  expect(proxyEnvironment("http://saved:9", startup, resolve).NO_PROXY).toBe("127.0.0.1,localhost,::1");
  expect(createProxyResolver({}, "darwin", run)()).toEqual({ source: "system", proxy: "http://system:80" });
  const direct = createProxyResolver({}, "linux", run);
  expect(direct()).toEqual({ source: "none", proxy: null });
  expect(proxyEnvironment("", { PATH: "/bin", ALL_PROXY: "bad" }, direct)).toEqual({ PATH: "/bin" });
  for (const [key, value] of Object.entries({
    https_proxy: "http://second:2",
    HTTP_PROXY: "http://third:3",
    http_proxy: "http://fourth:4",
  }))
    expect(createProxyResolver({ [key]: value }, "linux", run)().proxy).toBe(value);
});
it("parses system proxy fixtures and ignores PAC, SOCKS, disabled and invalid settings", async () => {
  const mac = await readFile(new URL("./fixtures/proxy/scutil.txt", import.meta.url), "utf8");
  const windows = await readFile(new URL("./fixtures/proxy/reg.txt", import.meta.url), "utf8");
  expect(parseSystemProxy(mac, "darwin")).toBe("http://secure.example:8443");
  expect(parseSystemProxy(mac.replace("HTTPSEnable : 1", "HTTPSEnable : 0"), "darwin")).toBe(
    "http://http.example:8080",
  );
  expect(parseSystemProxy(mac.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1"), "darwin")).toBeNull();
  expect(
    parseSystemProxy(
      mac.replace("HTTPSEnable : 1", "HTTPSEnable : 0").replace("HTTPEnable : 1", "HTTPEnable : 0"),
      "darwin",
    ),
  ).toBeNull();
  expect(parseSystemProxy("", "darwin")).toBeNull();
  expect(parseSystemProxy(mac.replace("HTTPSPort : 8443", "HTTPSPort : 99999"), "darwin")).toBeNull();
  expect(parseSystemProxy(windows, "win32")).toBe("http://b.example:443");
  expect(parseSystemProxy(windows.replace("http=a.example:80;https=b.example:443", "a.example:80"), "win32")).toBe(
    "http://a.example:80",
  );
  expect(parseSystemProxy(windows.replace(";https=b.example:443", ""), "win32")).toBe("http://a.example:80");
  expect(parseSystemProxy(`${windows}    AutoConfigURL    REG_SZ    http://pac.test/pac\n`, "win32")).toBeNull();
  expect(parseSystemProxy(windows.replace("0x1", "0x0"), "win32")).toBeNull();
});
it("caches system results for at most 30 seconds and handles command failure", () => {
  let time = 1000;
  const run = vi
    .fn()
    .mockReturnValueOnce("HTTPEnable : 1\nHTTPProxy : first\nHTTPPort : 80")
    .mockImplementationOnce(() => {
      throw new Error("failed");
    });
  const resolve = createProxyResolver(
    {},
    "darwin",
    run as unknown as typeof import("node:child_process").execFileSync,
    () => time,
  );
  expect(resolve().proxy).toBe("http://first:80");
  time += 29_999;
  expect(resolve().proxy).toBe("http://first:80");
  time++;
  expect(resolve()).toEqual({ source: "none", proxy: null });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledWith("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 });
  const winRun = vi.fn().mockReturnValue("");
  createProxyResolver({}, "win32", winRun as unknown as typeof import("node:child_process").execFileSync)();
  expect(winRun).toHaveBeenCalledWith(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
    { encoding: "utf8", timeout: 2000 },
  );
});
it.each(["", "  ", "http://127.0.0.1:7890", " http://proxy.example:65535 ", "http://localhost:1", "http://[::1]:8080"])(
  "accepts proxy %j",
  (value) => expect(validProxy(value)).toBe(true),
);
it.each([
  "https://host:80",
  "socks5://host:80",
  "http://host",
  "http://host:0",
  "http://host:65536",
  "http://host:80/",
  "http://host:80/path",
  "http://user:pass@host:80",
  "http://host:80?x",
  "http://host:80#x",
  "http://-host:80",
  "http://host..test:80",
  "http://999.0.0.1:80",
  "http://host:1.5",
  "http://host:80\n/path",
])("rejects proxy %j", (value) => expect(validProxy(value)).toBe(false));
it("defaults legacy preferences without migration and persists trimmed addresses, rejecting invalid writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-prefs-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const prefs = new DesktopPreferences(directory);
  await prefs.set({ ui: { snap: false } });
  const file = join(directory, "desktop.json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.network;
  const original = JSON.stringify(legacy);
  await writeFile(file, original);
  await prefs.load();
  expect(prefs.get().prefs.network.proxy).toBe("");
  expect(prefs.warning).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe(original);
  await prefs.set({ network: { proxy: " http://localhost:7890 " } });
  await prefs.load();
  expect(prefs.get().prefs).toMatchObject({
    version: 2,
    network: { proxy: "http://localhost:7890" },
    ui: { snap: false },
  });
  const before = await readFile(file, "utf8");
  await expect(prefs.set({ network: { proxy: "https://bad:10" } })).rejects.toThrow(proxyFormatMessage);
  expect(await readFile(file, "utf8")).toBe(before);
  await prefs.set({ network: { proxy: "  " } });
  expect(prefs.get().prefs.network.proxy).toBe("");
});
it("reports refused proxy connections using the exact service reasons", async () => {
  const { server, proxy } = await proxyServer(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await networkTest({ proxy });
  expect(result.results.map((item) => item.id)).toEqual(["claude", "codex"]);
  for (const item of result.results)
    expect(item).toMatchObject({
      ok: false,
      ms: expect.any(Number),
      reason: `连不上代理 ${proxy.slice("http://".length)}。检查代理软件有没有打开，端口对不对。`,
    });
});
it("bounds a silent local proxy at eight seconds", async () => {
  const hosts: string[] = [];
  const { proxy } = await proxyServer((host) => {
    hosts.push(host);
  });
  const result = await networkTest({ proxy });
  expect(hosts.sort()).toEqual(["api.anthropic.com:443", "api.openai.com:443"]);
  for (const item of result.results) {
    expect(item).toMatchObject({ ok: false, reason: "8 秒内没有响应。检查代理是否能访问外网。" });
    expect(item.ms).toBeGreaterThanOrEqual(7900);
    expect(item.ms).toBeLessThan(9000);
  }
}, 12000);
it("returns the first raw error line for other proxy errors and routes model downloads through that proxy", async () => {
  const hosts: string[] = [];
  const { proxy } = await proxyServer((host, socket) => {
    hosts.push(host);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const result = await networkTest({ proxy });
  for (const item of result.results) expect(item.reason).toMatch(/^连不上。错误：.*502/u);
  await expect(requestModel("https://model.invalid/weights", AbortSignal.timeout(1000), 123, proxy)).rejects.toThrow();
  expect(hosts).toContain("model.invalid:443");
});
it("tests direct access without startup proxies, uses HEAD, accepts any HTTP status and rejects invalid input", async () => {
  const options: unknown[] = [];
  vi.spyOn(https, "request").mockImplementation(((
    _url: unknown,
    config: { agent: https.Agent; method: string },
    callback: (response: { resume: () => void; statusCode: number }) => void,
  ) => {
    options.push(config);
    const request = new EventEmitter();
    return Object.assign(request, { end: () => callback({ resume: () => {}, statusCode: 401 }) });
  }) as unknown as typeof https.request);
  expect((await networkTest({ proxy: "" })).results.every((item) => item.ok && item.reason === null)).toBe(true);
  for (const option of options) expect(option).toMatchObject({ method: "HEAD" });
  expect(await networkTest({ proxy: "" })).toMatchObject({ source: "none", proxy: null });
  await expect(networkTest({ proxy: "socks5://host:1234" })).rejects.toThrow(proxyFormatMessage);
  expect(options).toHaveLength(4);
});

it("reports the chosen fallback and uses it for both network probes", async () => {
  const agents: https.Agent[] = [];
  vi.spyOn(https, "request").mockImplementation(((
    _url: unknown,
    config: { agent: https.Agent },
    callback: (response: { resume: () => void }) => void,
  ) => {
    agents.push(config.agent);
    return Object.assign(new EventEmitter(), { end: () => callback({ resume: () => {} }) });
  }) as unknown as typeof https.request);
  for (const [source, proxy] of [
    ["environment", "http://env:123"],
    ["system", "http://system:456"],
  ] as const) {
    const resolve = () => ({ source, proxy });
    expect(await networkTest({ proxy: "" }, resolve)).toMatchObject({ source, proxy });
    expect(agents.splice(0).map((agent) => agent.options.proxyEnv?.HTTPS_PROXY)).toEqual([proxy, proxy]);
  }
});
it.each([
  ["http://localhost:80", "ECONNREFUSED", "refused", "连不上代理 localhost:80。检查代理软件有没有打开，端口对不对。"],
  ["http://localhost:7890", "ETIMEDOUT", "timed out", "8 秒内没有响应。检查代理是否能访问外网。"],
  ["http://localhost:7890", "ECONNRESET", "first line\nprivate details", "连不上。错误：first line"],
  ["", "ECONNREFUSED", "direct refusal", "连不上。错误：direct refusal"],
])("formats %s %s without exposing extra error lines", async (proxy, code, message, reason) => {
  vi.spyOn(https, "request").mockImplementation((() => {
    const request = new EventEmitter();
    return Object.assign(request, {
      end: () => queueMicrotask(() => request.emit("error", Object.assign(new Error(message), { code }))),
    });
  }) as unknown as typeof https.request);
  for (const result of (await networkTest({ proxy })).results) expect(result).toMatchObject({ ok: false, reason });
});
it("applies saved or inherited proxy settings to the model HTTP agent and preserves range requests", async () => {
  const agents: https.Agent[] = [];
  const headers: unknown[] = [];
  vi.spyOn(https, "get").mockImplementation(((
    _url: unknown,
    options: { agent: https.Agent; headers: unknown },
    callback: (response: unknown) => void,
  ) => {
    agents.push(options.agent);
    headers.push(options.headers);
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: () => {} });
    queueMicrotask(() => callback(response));
    return Object.assign(new EventEmitter(), { setTimeout: () => {}, destroy: () => {} });
  }) as unknown as typeof https.get);
  for (const proxy of ["http://saved:7890", ""]) {
    const response = await requestModel("https://model.invalid/weights", new AbortController().signal, 123, proxy);
    response.destroy();
    (response as unknown as EventEmitter).emit("close");
  }
  expect(agents.map((agent) => agent.options.proxyEnv?.HTTPS_PROXY)).toEqual(["http://saved:7890", undefined]);
  expect(agents[0]?.options.proxyEnv?.NO_PROXY).toContain("localhost");
  expect(headers).toEqual([{ Range: "bytes=123-" }, { Range: "bytes=123-" }]);
});
