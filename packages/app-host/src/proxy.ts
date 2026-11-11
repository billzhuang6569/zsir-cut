import { execFileSync } from "node:child_process";
import { validProxy } from "./proxy-format.js";

export { proxyFormatMessage, validProxy } from "./proxy-format.js";

export function parseSystemProxy(output: string, platform: NodeJS.Platform): string | null {
  let address: string | undefined;
  if (platform === "darwin") {
    const values: Record<string, string> = Object.fromEntries(
      [...output.matchAll(/^\s*(\w+)\s*:\s*(.*?)\s*$/gmu)].map((m) => [m[1], m[2]]),
    );
    if (values.ProxyAutoConfigEnable === "1") return null;
    const prefix = values.HTTPSEnable === "1" ? "HTTPS" : values.HTTPEnable === "1" ? "HTTP" : null;
    if (prefix && values[`${prefix}Proxy`] && values[`${prefix}Port`])
      address = `http://${values[`${prefix}Proxy`]}:${values[`${prefix}Port`]}`;
  } else if (platform === "win32") {
    const values: Record<string, string> = Object.fromEntries(
      [...output.matchAll(/^\s*(\w+)\s+REG_\w+\s+(.*?)\s*$/gmu)].map((m) => [m[1], m[2]]),
    );
    if (values.AutoConfigURL || values.ProxyEnable?.toLowerCase() !== "0x1") return null;
    const server = values.ProxyServer;
    if (server) {
      const entries = server.split(";").map((part) => part.trim());
      const selected = server.includes("=")
        ? (entries.find((part) => /^https=/iu.test(part))?.slice(6) ??
          entries.find((part) => /^http=/iu.test(part))?.slice(5))
        : server.trim();
      if (selected) address = `http://${selected}`;
    }
  }
  return address && validProxy(address) ? address : null;
}

type ProxySelection = { source: "setting" | "environment" | "system" | "none"; proxy: string | null };
export function createProxyResolver(
  startup: NodeJS.ProcessEnv = { ...process.env },
  platform: NodeJS.Platform = process.platform,
  run: typeof execFileSync = execFileSync,
  now: () => number = Date.now,
) {
  let cached: { at: number; proxy: string | null } | undefined;
  return (setting = ""): ProxySelection => {
    if (setting.trim()) return { source: "setting", proxy: setting.trim() };
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      const value = startup[key]?.trim();
      if (value) return { source: "environment", proxy: value };
    }
    if (!cached || now() - cached.at >= 30_000 || now() < cached.at) {
      let proxy: string | null = null;
      try {
        const output =
          platform === "darwin"
            ? run("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 })
            : platform === "win32"
              ? run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
                  encoding: "utf8",
                  timeout: 2000,
                })
              : "";
        proxy = parseSystemProxy(String(output), platform);
      } catch {}
      cached = { at: now(), proxy };
    }
    return cached.proxy ? { source: "system", proxy: cached.proxy } : { source: "none", proxy: null };
  };
}

const startup = { ...process.env };
export const resolveProxy = createProxyResolver(startup);
export function proxyEnvironment(
  setting = "",
  env: NodeJS.ProcessEnv = process.env,
  resolve = resolveProxy,
): NodeJS.ProcessEnv {
  const selected = resolve(setting);
  const bypassEnv = env === process.env ? startup : env;
  const result = { ...env };
  for (const key of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
  ])
    delete result[key];
  if (!selected.proxy) return result;
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) result[key] = selected.proxy;
  result.NODE_USE_ENV_PROXY = "1";
  result.NO_PROXY = result.no_proxy = [
    ...new Set([
      ...(selected.source === "environment"
        ? [bypassEnv.NO_PROXY, bypassEnv.no_proxy].flatMap((value) =>
            (value ?? "")
              .split(",")
              .map((host) => host.trim())
              .filter(Boolean),
          )
        : []),
      "127.0.0.1",
      "localhost",
      "::1",
    ]),
  ].join(",");
  return result;
}
