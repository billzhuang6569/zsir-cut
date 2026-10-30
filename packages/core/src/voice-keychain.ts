import { spawn } from "node:child_process";

export interface VoiceKeychain {
  read(): Promise<string | null>;
  write(key: string | null): Promise<void>;
}
export type SecurityRunner = (args: string[], input?: string) => Promise<{ code: number; stdout: string }>;
const runSecurity: SecurityRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => reject(new Error("Keychain unavailable")));
    child.stdin.on("error", () => reject(new Error("Keychain input failed")));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input);
  });
export function createVoiceKeychain(run: SecurityRunner = runSecurity): VoiceKeychain {
  return {
    async read() {
      const result = await run(["find-generic-password", "-s", "zsir-cut.fish-audio", "-a", "default", "-w"]);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error("Cannot read voice Keychain entry");
      return result.stdout.replace(/\r?\n$/, "") || null;
    },
    async write(key) {
      if (key !== null && Array.from(key).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
        throw new Error("Invalid voice key");
      const command =
        key === null
          ? "delete-generic-password -s zsir-cut.fish-audio -a default"
          : `add-generic-password -U -s zsir-cut.fish-audio -a default -w "${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
      const result = await run(["-i"], `${command}\n`);
      if (result.code !== 0 && !(key === null && result.code === 44))
        throw new Error("Cannot update voice Keychain entry");
      // security -i can exit successfully even when its interactive command failed.
      if ((await createVoiceKeychain(run).read()) !== key) throw new Error("Cannot verify voice Keychain entry");
    },
  };
}
export const readVoiceKey = (keychain: VoiceKeychain = createVoiceKeychain()) =>
  process.env.ZSIR_FISH_API_KEY ? Promise.resolve(process.env.ZSIR_FISH_API_KEY) : keychain.read();
