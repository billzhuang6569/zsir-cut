export const proxyFormatMessage = "地址格式不对，例如 http://127.0.0.1:7890";

export function validProxy(value: string) {
  const proxy = value.trim();
  if (!proxy) return true;
  const match = /^http:\/\/(\[[\da-fA-F:.]+\]|[a-zA-Z0-9.-]+):(\d+)$/u.exec(proxy);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return false;
  try {
    const url = new URL(proxy);
    return (
      url.hostname.startsWith("[") ||
      url.hostname.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(label))
    );
  } catch {
    return false;
  }
}
