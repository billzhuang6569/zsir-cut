import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createFishAudioClient, type FishAudioClient, redactVoiceKey, VoiceError } from "./fish-audio.ts";
import { newId } from "./project/id.ts";
import { parseProject } from "./project/io.ts";
import { ffprobe, mediaFromProbe, type Probe } from "./project/probe.ts";
import { add, compare, parseRational, printRational, type Rational, rational } from "./rational.ts";
import { createVoiceKeychain, readVoiceKey, type VoiceKeychain } from "./voice-keychain.ts";
import {
  readVoiceSettings,
  readVoices,
  VOICE_MODELS,
  type Voice,
  validProxy,
  validVoiceName,
  voiceDataPath,
  withVoiceLock,
  writeVoiceFile,
  writeVoices,
} from "./voice-storage.ts";

export interface VoiceOptions {
  voiceKeychain?: VoiceKeychain;
  fishClient?: FishAudioClient;
  voiceFfmpeg?: (args: string[]) => Promise<void>;
  probe?: Probe;
}
export type VoiceEditOp = { op: "rename"; id: string; name: string } | { op: "delete"; id: string };
export interface VoiceCloneRequest {
  name: string;
  file?: string;
  media?: { project: string; media_id: string; source_start: string; duration: string };
  text?: string;
}
const invalid = (message: string) => new VoiceError("E_VALIDATION", message, false, "rejected");
export async function voiceConnection(options: VoiceOptions) {
  const key = await readVoiceKey(options.voiceKeychain);
  if (!key) throw new VoiceError("E_VOICE_AUTH", "fish.audio API Key is not configured", false, "rejected");
  const settings = await readVoiceSettings();
  return { key, client: options.fishClient ?? createFishAudioClient(key, settings.network.proxy) };
}
export async function getVoiceSettings(options: VoiceOptions) {
  return { settings: await readVoiceSettings(), voice_key_set: !!(await readVoiceKey(options.voiceKeychain)) };
}
export async function setVoiceSettings(
  input: { voice?: { model: string }; network?: { proxy: string | null }; voice_key?: string | null },
  options: VoiceOptions,
) {
  if (
    (input.voice && !VOICE_MODELS.includes(input.voice.model as (typeof VOICE_MODELS)[number])) ||
    (input.network && !validProxy(input.network.proxy)) ||
    (typeof input.voice_key === "string" &&
      (!input.voice_key ||
        Array.from(input.voice_key).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))
  )
    throw invalid("Invalid voice settings");
  return withVoiceLock("settings.json", async () => {
    const settings = await readVoiceSettings();
    const before = JSON.stringify(settings);
    if (input.voice) settings.voice.model = input.voice.model as typeof settings.voice.model;
    if (input.network) settings.network.proxy = input.network.proxy;
    let keyChanged = false;
    if (input.voice_key !== undefined && !process.env.ZSIR_FISH_API_KEY) {
      const keychain = options.voiceKeychain ?? createVoiceKeychain();
      keyChanged = (await keychain.read()) !== input.voice_key;
      if (keyChanged) await keychain.write(input.voice_key);
    }
    const changed = JSON.stringify(settings) !== before;
    if (changed) await writeVoiceFile("settings.json", settings);
    return changed || keyChanged
      ? [{ op: "settings_set", entity: "settings", id: "settings", action: "updated" as const }]
      : [];
  });
}
export async function editVoices(ops: VoiceEditOp[], options: VoiceOptions) {
  if (ops.some((op) => op.op === "rename" && !validVoiceName(op.name)))
    throw invalid("Voice names must contain 1 to 40 characters");
  return withVoiceLock("voices.json", async () => {
    const voices = await readVoices();
    // Validate the whole batch before making any remote change.
    const remaining = new Set(voices.map((voice) => voice.id));
    for (const op of ops) {
      if (!remaining.has(op.id)) throw new VoiceError("E_NOT_FOUND", "Voice not found", false, "rejected");
      if (op.op === "delete") remaining.delete(op.id);
    }
    const changes: { op: string; entity: string; id: string; action: "updated" | "removed" }[] = [];
    const actionable = ops.filter(
      (op) => op.op === "delete" || voices.find((voice) => voice.id === op.id)?.name !== op.name,
    );
    if (!actionable.length) return changes;
    const { client, key } = await voiceConnection(options);
    for (const op of ops) {
      const index = voices.findIndex((voice) => voice.id === op.id);
      const voice = voices[index];
      if (!voice) continue;
      try {
        if (op.op === "rename") {
          if (voice.name === op.name) continue;
          await client.updateModel(voice.fish_model_id, op.name);
          voice.name = op.name;
        } else {
          await client.deleteModel(voice.fish_model_id);
          voices.splice(index, 1);
        }
      } catch (error) {
        throw safeVoiceError(error, key);
      }
      changes.push({ op: op.op, entity: "voice", id: op.id, action: op.op === "delete" ? "removed" : "updated" });
    }
    await writeVoices(voices);
    for (const op of ops) if (op.op === "delete") await rm(voiceDataPath(`voices/${op.id}.wav`), { force: true });
    return changes;
  });
}
export function safeVoiceError(error: unknown, key: string): VoiceError {
  return error instanceof VoiceError
    ? new VoiceError(
        error.code,
        redactVoiceKey(error.message, key),
        error.retryable,
        error.status,
        error.upstream_status,
      )
    : new VoiceError("E_VOICE_UPSTREAM", "fish.audio request failed", true);
}
const runFfmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.once("error", () => reject(new Error("Cannot start voice sample conversion")));
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("Voice sample conversion failed"))));
  });
// ffmpeg accepts decimal seconds; derive them with integer arithmetic at nanosecond precision.
const ffmpegSeconds = (value: Rational) => {
  const nanos = (value.numerator * 1000000000n) / value.denominator;
  return `${nanos / 1000000000n}.${String(nanos % 1000000000n).padStart(9, "0")}`;
};
export async function prepareVoiceClone(input: VoiceCloneRequest, options: VoiceOptions) {
  if (!validVoiceName(input.name)) throw invalid("Voice names must contain 1 to 40 characters");
  let file = input.file ?? "";
  let start = rational(0n);
  let duration: Rational;
  let source: Voice["source"];
  let text = input.text;
  if (input.media) {
    const ref = input.media;
    const parsed = parseProject(await readFile(ref.project, "utf8"));
    if (!parsed.ok) throw invalid("Project file is invalid");
    const media = parsed.project.media.find((item) => item.id === ref.media_id);
    if (!media) throw new VoiceError("E_NOT_FOUND", "Media not found", false, "rejected");
    if (!media.audio) throw invalid("Voice source must contain audio");
    start = parseRational(ref.source_start, true);
    duration = parseRational(ref.duration, true);
    if (compare(add(start, duration), media.duration) > 0) throw invalid("Voice source range exceeds media duration");
    file = resolve(dirname(ref.project), media.path);
    source = {
      kind: "media",
      project: parsed.project.id,
      media_id: media.id,
      source_start: printRational(start, true),
      duration: printRational(duration, true),
    };
    if (text === undefined) {
      const end = add(start, compare(duration, rational(60n)) > 0 ? rational(60n) : duration);
      const transcript = parsed.project.transcripts.find((item) => item.media_id === media.id);
      text = transcript?.tokens
        .filter((token) => token.text && compare(token.align.end, start) > 0 && compare(token.align.start, end) < 0)
        .map((token) => token.text)
        .join("");
    }
  } else {
    if (!isAbsolute(file)) throw invalid("Voice source file must be an absolute path");
    const data = await (options.probe ?? ffprobe)(file);
    const streams = data.streams.filter((stream) => stream.codec_type === "audio");
    if (!streams.length) throw invalid("Voice source must contain audio");
    const detected = mediaFromProbe(file, { ...data, streams });
    duration = detected.duration;
    source = { kind: "file", name: basename(file) };
  }
  if (compare(duration, rational(5n)) < 0) throw invalid("Voice sample must be at least 5 seconds");
  const trimmed = compare(duration, rational(60n)) > 0;
  const used = trimmed ? rational(60n) : duration;
  return { file, source, text, trimmed, start, duration: used };
}
export async function cloneVoice(input: VoiceCloneRequest, options: VoiceOptions) {
  const prepared = await prepareVoiceClone(input, options);
  const { client, key } = await voiceConnection(options);
  const id = newId("voc_");
  const sample = `voices/${id}.wav`;
  const path = voiceDataPath(sample);
  await mkdir(dirname(path), { recursive: true });
  try {
    await (options.voiceFfmpeg ?? runFfmpeg)([
      "-v",
      "error",
      "-nostdin",
      "-ss",
      ffmpegSeconds(prepared.start),
      "-i",
      prepared.file,
      "-t",
      ffmpegSeconds(prepared.duration),
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-n",
      path,
    ]);
    const sampleData = await (options.probe ?? ffprobe)(path);
    if (compare(mediaFromProbe(path, sampleData).duration, rational(5n)) < 0)
      throw invalid("Voice sample must be at least 5 seconds");
    let model: { _id: string };
    try {
      model = await client.createModel({
        name: input.name,
        audio: await readFile(path),
        ...(prepared.text ? { text: prepared.text } : {}),
      });
      if (typeof model._id !== "string" || !model._id || model._id.includes(key))
        throw new VoiceError("E_VOICE_UPSTREAM", "Invalid fish.audio model response");
    } catch (error) {
      throw safeVoiceError(error, key);
    }
    const voice: Voice = {
      id,
      name: input.name,
      fish_model_id: model._id,
      source: prepared.source,
      sample,
      created_at: new Date().toISOString(),
    };
    await withVoiceLock("voices.json", async () => {
      const voices = await readVoices();
      voices.push(voice);
      await writeVoices(voices);
    });
    return { voice, warnings: prepared.trimmed ? [{ code: "W_VOICE_SAMPLE_TRIMMED" }] : [] };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}
