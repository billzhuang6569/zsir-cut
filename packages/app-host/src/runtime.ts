import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function commonProgramDirectories(platform = process.platform, env = process.env) {
  return platform === "win32"
    ? [
        win32.join(env.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Links"),
        "C:\\ProgramData\\chocolatey\\bin",
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin"];
}
export function hostPath(env = process.env, platform = process.platform, node = process.execPath) {
  const delimiter = platform === "win32" ? ";" : ":";
  const path = platform === "win32" ? win32 : posix;
  const root = path.dirname(node);
  return [
    ...new Set(
      [
        ...(env.ZCUT_PACKAGED === "1" ? [path.join(root, "bin"), root] : []),
        ...commonProgramDirectories(platform, env),
        ...(env.PATH ?? "").split(delimiter),
      ].filter(Boolean),
    ),
  ].join(delimiter);
}
