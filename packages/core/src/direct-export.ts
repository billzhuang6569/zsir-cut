// biome-ignore-all lint/style/noNonNullAssertion: Schema validation and bounds checks guard indexed entries.
import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { subtitleFiles } from "./export-framework.ts";
import { fingerprint } from "./fingerprint.ts";
import type { ValidationIssue } from "./project/semantics.ts";
import { clipTimeMap } from "./project/time-map.ts";
import type { Project, SubtitleTrack, Timeline } from "./project/types.ts";
import { add, ceil, compare, div, floor, mul, type Rational, rational, sub } from "./rational.ts";

export type DirectProfile = "direct-srt" | "direct-audio-wav";
export class DirectExportExists extends Error {}
const zero = rational(0n);
const rate = rational(48000n);
const safe = (name: string) => name.replaceAll(/[\\/:*?"<>|]/g, "_");
const min = (a: Rational, b: Rational) => (compare(a, b) < 0 ? a : b);
const max = (a: Rational, b: Rational) => (compare(a, b) > 0 ? a : b);

export function directFiles(project: Project, timeline: Timeline, profile: DirectProfile, languages?: string[]) {
  const stem = `${safe(timeline.name)}_r${project.revision.seq}`;
  if (profile === "direct-audio-wav") return [{ name: `${stem}.wav`, data: "" }];
  const tracks = timeline.tracks.filter((track): track is SubtitleTrack => track.kind === "subtitle" && track.enabled);
  const subtitles = subtitleFiles(project, timeline);
  const used = new Set<string>();
  return tracks.flatMap((track) => {
    if (languages && !languages.includes(track.language)) return [];
    // Generate in the original timeline so projection and quantization match handoff exactly.
    const files = subtitles.filter((file) => file.role === "subtitle" && file.track_id === track.id);
    return files.map((file, index) => {
      const base = `${stem}${tracks.length > 1 ? `_${safe(track.name)}` : ""}${index ? `.layer${index + 1}` : ""}`;
      let name = `${base}.srt`;
      for (let suffix = 1; used.has(name); suffix++) name = `${base}.${track.id}.${suffix}.srt`;
      used.add(name);
      return { name, data: file.data };
    });
  });
}

export async function checkDirectFiles(output: string, files: { name: string }[]) {
  for (const file of files) {
    try {
      await lstat(join(output, file.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new DirectExportExists(`Output already exists: ${file.name}`);
  }
}

async function mixAudio(project: Project, timeline: Timeline, projectPath: string, directory: string) {
  const end = timeline.tracks
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .reduce((end, clip) => max(end, add(clip.timeline_start, clip.duration)), zero);
  const frames = ceil(mul(end, rate));
  if (frames * 6n > 0xffffffffn - 36n) throw new Error("Audio exceeds RIFF WAV size limit");
  // shortcut: decoded sources and mix are memory-resident; stream blocks for long-form exports.
  const mixed = new Float64Array(Number(frames) * 2);
  const decoded = new Map<string, Buffer>();
  const warnings: (ValidationIssue & { clipped_samples?: number })[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || !track.enabled) continue;
    const active = track.clips.filter((clip) => clip.enabled !== false);
    const fades = track.transitions.flatMap((transition) => {
      const from = active.find((clip) => clip.id === transition.from_clip);
      const to = active.find((clip) => clip.id === transition.to_clip);
      if (!from || !to) return [];
      const start = sub(
        to.timeline_start,
        transition.alignment === "start"
          ? zero
          : transition.alignment === "end"
            ? transition.duration
            : div(transition.duration, rational(2n)),
      );
      return [{ from: from.id, to: to.id, start, end: add(start, transition.duration), duration: transition.duration }];
    });
    for (const clip of active) {
      const media = project.media.find((item) => item.id === clip.media_id);
      if (!media?.audio) throw new Error(`Audio media missing: ${clip.media_id}`);
      let source = decoded.get(media.id);
      if (!source) {
        const path = resolve(dirname(projectPath), media.path);
        const info = await stat(path);
        if (
          !info.isFile() ||
          info.size !== media.size_bytes ||
          (await fingerprint(path)).value !== media.fingerprint.value
        )
          throw new Error(`Audio media offline or fingerprint mismatch: ${media.id}`);
        const target = join(directory, `${media.id}.pcm`);
        await promisify(execFile)("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          path,
          "-map",
          "0:a:0",
          "-ar",
          "48000",
          "-c:a",
          "pcm_f64le",
          "-f",
          "f64le",
          target,
        ]);
        source = await readFile(target);
        if (source.length % (media.audio.channels * 8) !== 0) throw new Error(`Invalid decoded audio: ${media.id}`);
        decoded.set(media.id, source);
      }
      const channels = clip.source_channels ?? Array.from({ length: media.audio.channels }, (_, i) => i);
      if (!channels.length || channels.some((channel) => channel < 0 || channel >= media.audio!.channels))
        throw new Error(`Invalid source channels: ${clip.id}`);
      if (channels.length > 2)
        warnings.push({
          code: "W_AUDIO_CHANNELS_DROPPED",
          severity: "warning",
          message: "Only the first two selected channels were exported",
          ids: [clip.id],
        });
      const incoming = fades.filter((fade) => fade.to === clip.id);
      const outgoing = fades.filter((fade) => fade.from === clip.id);
      const points = clipTimeMap(clip);
      const gain = 10 ** ((clip.gain_db ?? 0) / 20);
      if (!Number.isFinite(gain)) throw new Error(`Invalid audio gain: ${clip.id}`);
      for (let segment = 0; segment < points.length - 1; segment++) {
        const first = points[segment]!,
          last = points[segment + 1]!;
        const slope = first.interp === "hold" ? zero : div(sub(last.source, first.source), sub(last.at, first.at));
        let start = add(clip.timeline_start, first.at),
          stop = add(clip.timeline_start, last.at);
        if (segment === 0) for (const fade of incoming) start = min(start, fade.start);
        if (segment === points.length - 2) for (const fade of outgoing) stop = max(stop, fade.end);
        const begin = ceil(mul(max(zero, start), rate)),
          finish = ceil(mul(min(end, stop), rate));
        const sourceAtBegin = mul(
          add(first.source, mul(sub(sub(div(rational(begin), rate), clip.timeline_start), first.at), slope)),
          rate,
        );
        // Integer stepping preserves exact fractional positions without per-sample time conversion.
        const denominator = sourceAtBegin.denominator * slope.denominator;
        let numerator = sourceAtBegin.numerator * slope.denominator;
        const step = slope.numerator * sourceAtBegin.denominator;
        const envelopes = [...incoming, ...outgoing].map((fade) => ({
          incoming: fade.to === clip.id,
          begin: mul(fade.start, rate),
          length: mul(fade.duration, rate),
        }));
        for (let frame = begin; frame < finish; frame++, numerator += step) {
          const position = rational(numerator, denominator);
          const sample = slope.numerator < 0n ? ceil(position) - 1n : floor(position);
          const offset = Number(sample) * media.audio.channels * 8;
          if (sample < 0n || offset + media.audio.channels * 8 > source.length)
            throw new Error(`Audio source range unavailable: ${clip.id}`);
          let amplitude = gain;
          for (const fade of envelopes) {
            const progress = div(sub(rational(frame), fade.begin), fade.length);
            if (compare(progress, zero) < 0 || compare(progress, rational(1n)) >= 0) continue;
            const phase = ((Number(progress.numerator) / Number(progress.denominator)) * Math.PI) / 2;
            amplitude *= fade.incoming ? Math.sin(phase) : Math.cos(phase);
          }
          for (let channel = 0; channel < 2; channel++) {
            const value = source.readDoubleLE(offset + channels[channel % Math.min(channels.length, 2)]! * 8);
            if (!Number.isFinite(value)) throw new Error(`Non-finite audio sample: ${media.id}`);
            mixed[Number(frame) * 2 + channel]! += value * amplitude;
          }
        }
      }
    }
  }
  const data = Buffer.alloc(44 + mixed.length * 3);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(288000, 28);
  data.writeUInt16LE(6, 32);
  data.writeUInt16LE(24, 34);
  data.write("data", 36);
  data.writeUInt32LE(mixed.length * 3, 40);
  let clipped = 0;
  for (let i = 0; i < mixed.length; i++) {
    const value = mixed[i]!;
    if (value < -1 || value > 1) clipped++;
    data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608))), 44 + i * 3, 3);
  }
  if (clipped)
    warnings.push({
      code: "W_AUDIO_CLIPPED",
      severity: "warning",
      message: `${clipped} channel samples clipped`,
      ids: [timeline.id],
      clipped_samples: clipped,
    });
  return { data, warnings };
}

export async function runDirectExport(
  project: Project,
  timeline: Timeline,
  projectPath: string,
  output: string,
  profile: DirectProfile,
  files: { name: string; data: string }[],
) {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, ".zcut-direct-"));
  const published: string[] = [];
  try {
    const audio =
      profile === "direct-audio-wav" ? await mixAudio(project, timeline, projectPath, temporary) : undefined;
    const results = [];
    for (const [i, file] of files.entries()) {
      const data = audio?.data ?? Buffer.from(file.data);
      const staged = join(temporary, `output-${i}`);
      await writeFile(staged, data);
      results.push({ name: file.name, size_bytes: data.length });
    }
    for (const [i, file] of files.entries()) {
      const destination = join(output, file.name);
      try {
        await link(join(temporary, `output-${i}`), destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new DirectExportExists(`Output already exists: ${file.name}`);
        throw error;
      }
      published.push(destination);
    }
    return { files: results, warnings: audio?.warnings ?? [] };
  } catch (error) {
    for (const path of published) await rm(path);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
