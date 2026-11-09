import { homedir } from "node:os";
import { win32 } from "node:path";

export function commonProgramDirectories(platform = process.platform, env = process.env) {
  return platform === "win32"
    ? [
        win32.join(env.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Links"),
        "C:\\ProgramData\\chocolatey\\bin",
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin"];
}
export function hostPath(env = process.env, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return [
    ...new Set([...commonProgramDirectories(platform, env), ...(env.PATH ?? "").split(delimiter)].filter(Boolean)),
  ].join(delimiter);
}
export async function checkMediaPrograms(find: (name: string) => Promise<string | null>, platform = process.platform) {
  const names = ["ffmpeg", "ffprobe"];
  const paths = await Promise.all(names.map((name) => find(name)));
  return {
    missing: names.filter((_, index) => !paths[index]),
    install: platform === "win32" ? "winget install Gyan.FFmpeg" : "brew install ffmpeg",
  };
}
