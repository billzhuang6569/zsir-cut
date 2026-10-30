import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

export const voiceDataPath = (...parts: string[]) => join(homedir(), "Library/Application Support/zsir-cut", ...parts);
export const VOICE_MODELS = ["s2.1-pro", "s2.1-pro-free", "s2-pro", "drama-3"] as const;
export interface VoiceSettings {
  schema: "zsir-cut/settings";
  version: 1;
  voice: { provider: "fish_audio"; model: (typeof VOICE_MODELS)[number] };
  network: { proxy: string | null };
}
export interface Voice {
  id: string;
  name: string;
  fish_model_id: string;
  source:
    | { kind: "file"; name: string }
    | { kind: "media"; project: string; media_id: string; source_start: string; duration: string };
  sample: string;
  created_at: string;
}
export const validVoiceName = (name: string) => name.trim().length > 0 && Array.from(name).length <= 40;
export function validProxy(proxy: unknown): proxy is string | null {
  if (proxy === null) return true;
  if (typeof proxy !== "string") return false;
  try {
    const url = new URL(proxy);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}
async function readLocal<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(voiceDataPath(name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${name}`);
  }
}
export async function readVoiceSettings(): Promise<VoiceSettings> {
  const value = await readLocal<VoiceSettings>("settings.json", {
    schema: "zsir-cut/settings",
    version: 1,
    voice: { provider: "fish_audio", model: "s2.1-pro" },
    network: { proxy: null },
  });
  if (
    value?.schema !== "zsir-cut/settings" ||
    value.version !== 1 ||
    value.voice?.provider !== "fish_audio" ||
    !VOICE_MODELS.includes(value.voice.model) ||
    !value.network ||
    !validProxy(value.network.proxy)
  )
    throw new Error("Invalid settings.json");
  return {
    schema: value.schema,
    version: 1,
    voice: { provider: "fish_audio", model: value.voice.model },
    network: { proxy: value.network.proxy },
  };
}
export async function readVoices(): Promise<Voice[]> {
  const value = await readLocal<{ schema: string; version: number; voices: Voice[] }>("voices.json", {
    schema: "zsir-cut/voices",
    version: 1,
    voices: [],
  });
  if (value?.schema !== "zsir-cut/voices" || value.version !== 1 || !Array.isArray(value.voices))
    throw new Error("Invalid voices.json");
  const ids = new Set<string>();
  for (const voice of value.voices) {
    if (
      !voice ||
      typeof voice.id !== "string" ||
      !/^voc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(voice.id) ||
      ids.has(voice.id) ||
      typeof voice.name !== "string" ||
      !validVoiceName(voice.name) ||
      typeof voice.fish_model_id !== "string" ||
      !voice.fish_model_id ||
      voice.sample !== `voices/${voice.id}.wav` ||
      typeof voice.created_at !== "string" ||
      !Number.isFinite(Date.parse(voice.created_at)) ||
      !voice.source ||
      (voice.source.kind !== "file" && voice.source.kind !== "media") ||
      (voice.source.kind === "file" && typeof voice.source.name !== "string") ||
      (voice.source.kind === "media" &&
        [voice.source.project, voice.source.media_id, voice.source.source_start, voice.source.duration].some(
          (part) => typeof part !== "string" || !part,
        ))
    )
      throw new Error("Invalid voice library entry");
    ids.add(voice.id);
  }
  return value.voices.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
export async function writeVoiceFile(name: "settings.json" | "voices.json", value: unknown): Promise<void> {
  const path = voiceDataPath(name);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(sorted(value), null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function withVoiceLock<T>(name: "settings.json" | "voices.json", update: () => Promise<T>): Promise<T> {
  const path = voiceDataPath(name);
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 2000;
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      lock = await open(`${path}.lock`, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`${name} lock timed out after 2 seconds`);
      await setTimeout(Math.min(25, deadline - Date.now()));
    }
  }
  try {
    return await update();
  } finally {
    await lock.close();
    await rm(`${path}.lock`, { force: true });
  }
}
export async function writeVoices(voices: Voice[]) {
  voices.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  await writeVoiceFile("voices.json", { schema: "zsir-cut/voices", version: 1, voices });
}
