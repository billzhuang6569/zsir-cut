import https from "node:https";
import { z } from "zod";
import { proxyEnvironment, proxyFormatMessage, resolveProxy, validProxy } from "./proxy.js";

const proxyAddress = z.string().trim().refine(validProxy, proxyFormatMessage);

export async function networkTest(input: unknown, resolve = resolveProxy) {
  const { proxy } = z.strictObject({ proxy: proxyAddress }).parse(input);
  const selected = resolve(proxy);
  const results = await Promise.all(
    (
      [
        ["claude", "https://api.anthropic.com"],
        ["codex", "https://api.openai.com"],
      ] as const
    ).map(async ([id, url]) => {
      const agent = new https.Agent({ proxyEnv: proxyEnvironment(proxy, undefined, () => selected), timeout: 8000 });
      const started = performance.now();
      const signal = AbortSignal.timeout(8000);
      try {
        await new Promise<void>((resolve, reject) => {
          const request = https.request(url, { method: "HEAD", agent, signal }, (response) => {
            response.resume();
            resolve();
          });
          request.on("error", reject);
          request.end();
        });
        return { id, ok: true, ms: Math.round(performance.now() - started), reason: null };
      } catch (error) {
        const cause = error as NodeJS.ErrnoException & { proxyTunnelTimeout?: number };
        const reason =
          signal.aborted || cause.code === "ETIMEDOUT" || cause.proxyTunnelTimeout
            ? "8 秒内没有响应。检查代理是否能访问外网。"
            : selected.proxy && cause.code === "ECONNREFUSED"
              ? `连不上代理 ${selected.proxy.slice("http://".length)}。检查代理软件有没有打开，端口对不对。`
              : `连不上。错误：${(cause.message ?? String(error)).split(/\r?\n/u)[0]}`;
        return { id, ok: false, ms: Math.round(performance.now() - started), reason };
      } finally {
        agent.destroy();
      }
    }),
  );
  return { results, ...selected };
}
