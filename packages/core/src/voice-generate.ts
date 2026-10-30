import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type FishTtsRequest, VoiceError } from "./fish-audio.ts";
import { newId } from "./project/id.ts";
import { probeMedia } from "./project/probe.ts";
import { projectSubtitles } from "./project/projection.ts";
import type { Cue, Media, Project, Transcript } from "./project/types.ts";
import { compare, type Rational } from "./rational.ts";
import { safeVoiceError, type VoiceOptions, voiceConnection } from "./voice.ts";
import { readVoiceSettings, readVoices } from "./voice-storage.ts";

export interface VoiceParams {
  speed?: number;
  volume?: number;
  temperature?: number;
  top_p?: number;
  normalize_loudness?: boolean;
}
export interface VoiceGenerateRequest {
  voice_id: string;
  model?: string;
  items?: { text: string }[];
  cues?: { transcript_id: string; cue_ids: string[]; mode: "per_cue" | "merged" };
  params?: VoiceParams;
  replaces?: string;
}
export interface VoiceMediaInfo {
  kind: "free" | "cues";
  voice_id: string;
  voice_name: string;
  model: string;
  params: VoiceParams;
  text: string;
  transcript_id?: string;
  cue_ids?: string[];
  take_of?: string;
  generated_at: string;
}
function cueVoiceText(transcript: Transcript, cue: Cue): string {
  const first = transcript.tokens.findIndex((token) => token.id === cue.first_token);
  const last = transcript.tokens.findIndex((token) => token.id === cue.last_token);
  return first < 0 || last < first
    ? ""
    : transcript.tokens
        .slice(first, last + 1)
        .map((token) => token.text)
        .join("");
}
function mergedText(texts: string[]): string {
  return texts.reduce((text, next) => text + (text && !/\p{Punctuation}$/u.test(text) ? "，" : "") + next, "");
}
export async function prepareVoiceGenerate(project: Project, input: VoiceGenerateRequest) {
  const voice = (await readVoices()).find((voice) => voice.id === input.voice_id);
  if (!voice) throw new VoiceError("E_NOT_FOUND", "Voice not found", false, "rejected");
  if (input.replaces && !project.media.some((media) => media.id === input.replaces))
    throw new VoiceError("E_NOT_FOUND", "Replacement media not found", false, "rejected");
  let items: { text: string; name: string; cue_ids?: string[] }[];
  if (input.cues) {
    const ref = input.cues;
    const transcript = project.transcripts.find((transcript) => transcript.id === ref.transcript_id);
    if (!transcript || ref.cue_ids.some((id) => !transcript.cues.some((cue) => cue.id === id)))
      throw new VoiceError("E_NOT_FOUND", "Transcript or cue not found", false, "rejected");
    const selected =
      ref.mode === "merged"
        ? transcript.cues.filter((cue) => ref.cue_ids.includes(cue.id))
        : ref.cue_ids.flatMap((id) => transcript.cues.filter((cue) => cue.id === id));
    items = selected.map((cue) => {
      const text = cueVoiceText(transcript, cue);
      return { text, name: Array.from(text).slice(0, 20).join(""), cue_ids: [cue.id] };
    });
    if (items.some((item) => !item.text.length))
      throw new VoiceError("E_VALIDATION", "Cue text must not be empty", false, "rejected");
    if (ref.mode === "merged")
      items = [
        {
          text: mergedText(items.map((item) => item.text)),
          name: items[0]?.name ?? "",
          cue_ids: selected.map((cue) => cue.id),
        },
      ];
  } else items = (input.items ?? []).map(({ text }) => ({ text, name: Array.from(text).slice(0, 20).join("") }));
  return { input, voice, model: input.model ?? (await readVoiceSettings()).voice.model, items };
}

export async function generateVoiceMedia(
  projectPath: string,
  prepared: Awaited<ReturnType<typeof prepareVoiceGenerate>>,
  options: VoiceOptions,
) {
  const { input, voice, model, items } = prepared;
  const { client, key } = await voiceConnection(options);
  const directory = dirname(resolve(projectPath));
  const paths: string[] = [];
  const media: Media[] = new Array(items.length);
  const cleanup = async () => {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  };
  const params = input.params ?? {};
  const { speed, volume, normalize_loudness, ...sampling } = params;
  const prosody = {
    ...(speed === undefined ? {} : { speed }),
    ...(volume === undefined ? {} : { volume }),
    ...(normalize_loudness === undefined ? {} : { normalize_loudness }),
  };
  let next = 0;
  let failure: VoiceError | undefined;
  await mkdir(join(directory, "voice"), { recursive: true });
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (!failure && next < items.length) {
        const index = next++;
        const item = items[index];
        if (!item) break;
        try {
          const request: FishTtsRequest = {
            text: item.text,
            reference_id: voice.fish_model_id,
            format: "wav",
            sample_rate: 44100,
            latency: "normal",
            ...sampling,
            ...(Object.keys(prosody).length ? { prosody } : {}),
          };
          let audio: Uint8Array;
          try {
            audio = await client.generate(request, model);
          } catch (error) {
            throw safeVoiceError(error, key);
          }
          const id = newId("med_");
          const path = join(directory, "voice", `${id}.wav`);
          // Only remove files this job created; an existing asset must never be overwritten.
          const file = await open(path, "wx");
          paths.push(path);
          try {
            await file.writeFile(audio);
          } finally {
            await file.close();
          }
          const imported = await probeMedia(directory, path, options.probe, id);
          if (imported.kind !== "audio") throw new Error("Generated media must be audio");
          const info: VoiceMediaInfo = {
            kind: input.cues ? "cues" : "free",
            voice_id: voice.id,
            voice_name: voice.name,
            model,
            params,
            text: item.text,
            ...(input.cues ? { transcript_id: input.cues.transcript_id, cue_ids: item.cue_ids } : {}),
            ...(input.replaces ? { take_of: input.replaces } : {}),
            generated_at: new Date().toISOString(),
          };
          media[index] = { ...imported, name: item.name, ext: { ...imported.ext, "zsir.voice": info } };
        } catch (error) {
          const failed =
            error instanceof VoiceError
              ? error
              : new VoiceError("E_IO", "Generated audio could not be stored or imported", true);
          failed.item_index = index;
          failure ??= failed;
        }
      }
    }),
  );
  if (failure) {
    await cleanup();
    throw failure;
  }
  return { media, cleanup };
}

/** Recomputed from layer-2 text and the current subtitle projection; never persisted. */
export function voiceMediaState(
  project: Project,
  timelineId: string,
  info: VoiceMediaInfo,
): { stale: boolean; recommended_start: Rational | null } {
  if (info.kind === "free") return { stale: false, recommended_start: null };
  const transcript = project.transcripts.find((transcript) => transcript.id === info.transcript_id);
  const ids = info.cue_ids ?? [];
  const cues = transcript?.cues.filter((cue) => ids.includes(cue.id)) ?? [];
  const stale =
    !transcript ||
    !ids.length ||
    cues.length !== ids.length ||
    mergedText(cues.map((cue) => cueVoiceText(transcript, cue))) !== info.text;
  const projected = project.timelines.some((timeline) => timeline.id === timelineId)
    ? projectSubtitles(project, timelineId)
        .cues.filter((cue) => cue.cue_id === ids[0])
        .sort((a, b) => compare(a.start, b.start))
    : [];
  return { stale, recommended_start: projected[0]?.start ?? null };
}
