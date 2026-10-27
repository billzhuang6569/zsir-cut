// biome-ignore-all lint/style/noNonNullAssertion: ffprobe fields are checked before use.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { div, floor, mul, rational } from "../rational.js";
import { frameToTimecode } from "../timecode.js";
import type { Media } from "./types.js";

interface PacketTime {
  pts: bigint;
  duration: bigint;
}

interface PacketSummary {
  count: number;
  first300: PacketTime[];
  last?: PacketTime;
}

export interface ProbePacket {
  stream_index: number;
  pts: string | number;
  duration: string | number;
}

export interface ProbeData {
  streams: {
    index: number;
    codec_type?: string;
    disposition?: { attached_pic?: number };
    r_frame_rate?: string;
    nb_read_packets?: string;
    width?: number;
    height?: number;
    sample_aspect_ratio?: string;
    sample_rate?: string;
    channels?: number;
    duration_ts?: string;
    time_base?: string;
    duration?: string;
    tags?: Record<string, string>;
  }[];
  format?: { tags?: Record<string, string> };
  packets?: ProbePacket[];
  summaries?: Map<number, PacketSummary>;
}

export type Probe = (path: string) => Promise<ProbeData>;

type Runner = (args: string[], onLine: (line: string) => void) => Promise<void>;

const runFfprobe: Runner = async (args, onLine) => {
  const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(new Error(`ffprobe ${error.code === "ENOENT" ? "not found" : "failed to start"}: ${error.message}`)),
    );
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `ffprobe exited ${code}`))));
  });
  try {
    await Promise.all([
      (async () => {
        for await (const line of createInterface({ input: child.stdout })) onLine(line);
      })(),
      closed,
    ]);
  } catch (error) {
    child.kill();
    throw error;
  }
};

function recordPacket(summaries: Map<number, PacketSummary>, packet: ProbePacket): void {
  const item = { pts: BigInt(packet.pts), duration: BigInt(packet.duration) };
  if (item.duration <= 0n) throw new Error("Invalid packet duration");
  const summary = summaries.get(packet.stream_index) ?? { count: 0, first300: [] };
  summary.count++;
  if (summary.first300.length < 300 || item.pts < summary.first300.at(-1)!.pts) {
    summary.first300.push(item);
    summary.first300.sort((a, b) => (a.pts < b.pts ? -1 : a.pts > b.pts ? 1 : 0));
    if (summary.first300.length > 300) summary.first300.pop();
  }
  if (
    !summary.last ||
    item.pts > summary.last.pts ||
    (item.pts === summary.last.pts && item.duration > summary.last.duration)
  )
    summary.last = item;
  summaries.set(packet.stream_index, summary);
}

export async function ffprobe(path: string, runner: Runner = runFfprobe): Promise<ProbeData> {
  let metadata = "";
  await runner(["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", path], (line) => {
    metadata += line;
  });
  const result = JSON.parse(metadata) as ProbeData;
  if (result.streams.some((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)) {
    const summaries = new Map<number, PacketSummary>();
    await runner(
      [
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_packets",
        "-show_entries",
        "packet=stream_index,pts,duration",
        "-of",
        "compact=p=0:nk=0",
        path,
      ],
      (line) => {
        if (!line) return;
        const fields = Object.fromEntries(line.split("|").map((field) => field.split("=")));
        const streamIndex = Number(fields.stream_index);
        if (!Number.isInteger(streamIndex) || fields.pts === undefined || fields.duration === undefined)
          throw new Error("Invalid ffprobe packet");
        recordPacket(summaries, { stream_index: streamIndex, pts: fields.pts, duration: fields.duration });
      },
    );
    result.summaries = summaries;
  }
  return result;
}

const rate = (value: string) => {
  const [numerator, denominator = "1"] = value.replace(":", "/").split("/");
  return rational(BigInt(numerator!), BigInt(denominator));
};
const decimal = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return rational(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length));
};

export function mediaFromProbe(path: string, data: ProbeData): Pick<Media, "kind" | "duration"> & Partial<Media> {
  const video = data.streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const audio = data.streams.find((stream) => stream.codec_type === "audio");
  if (!video && !audio) throw new Error("No video or audio stream");
  const summaries = data.summaries ?? new Map<number, PacketSummary>();
  for (const packet of data.packets ?? []) recordPacket(summaries, packet);
  const packets = video && summaries.get(video.index);
  const count = packets?.count ?? Number(video?.nb_read_packets ?? 0);
  const image = video && count === 1 && /\.(?:png|jpe?g|webp|tiff?|bmp|gif|heic|avif)$/i.test(path);
  if (video && !image && (!Number.isSafeInteger(count) || count < 2 || !packets))
    throw new Error("Video packet count unavailable");
  const frameRate = video && rate(video.r_frame_rate ?? "0");
  if (video && (!frameRate || frameRate.numerator === 0n)) throw new Error("Video frame rate unavailable");
  const sampleRate = audio && rate(audio.sample_rate ?? "0");
  if (audio && (!sampleRate || sampleRate.numerator === 0n)) throw new Error("Audio sample rate unavailable");
  if (video && (!video.width || !video.height)) throw new Error("Video dimensions unavailable");
  if (audio && !audio.channels) throw new Error("Audio channel count unavailable");
  const sourceDuration =
    audio?.duration_ts && audio.time_base
      ? mul(rational(BigInt(audio.duration_ts)), rate(audio.time_base))
      : audio?.duration
        ? decimal(audio.duration)
        : undefined;
  if (!video && !sourceDuration) throw new Error("Audio sample count unavailable");
  if (audio && sourceDuration && mul(sourceDuration, sampleRate!).denominator !== 1n)
    throw new Error("Audio sample count is not exact");
  const stamps = packets?.first300.map((packet) => packet.pts) ?? [];
  const deltas = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
  const vfr =
    deltas.length > 1 &&
    deltas.some((delta) => {
      const difference = delta - deltas[0]!;
      return difference > 1n || difference < -1n;
    });
  let videoDuration = video && div(rational(BigInt(count)), frameRate!);
  if (video && !image) {
    const first = packets?.first300[0];
    const last = packets?.last;
    if (!first || !last || !video.time_base) throw new Error("Video packet timing unavailable");
    const ticks = last.pts - first.pts + last.duration;
    if (ticks <= 0n) throw new Error("Invalid video packet duration");
    videoDuration = mul(rational(ticks), rate(video.time_base));
  }
  const tags = { ...data.format?.tags, ...audio?.tags, ...video?.tags };
  const timecode =
    data.streams.find((stream) => stream.codec_type === "data" && stream.tags?.timecode)?.tags?.timecode ??
    video?.tags?.timecode;
  const bext = !video && (audio?.tags?.time_reference ?? data.format?.tags?.time_reference);
  const startSamples = bext ? BigInt(bext) : undefined;
  if (startSamples !== undefined && !Number.isSafeInteger(Number(startSamples)))
    throw new Error("WAV bext sample reference exceeds JSON integer precision");
  const wavTimecode =
    startSamples !== undefined && sampleRate
      ? frameToTimecode(floor(mul(div(rational(startSamples), sampleRate), rational(25n))), "25")
      : undefined;
  return {
    kind: image ? "image" : video ? "video" : "audio",
    duration: image ? rational(3600n) : video ? videoDuration! : sourceDuration!,
    ...(video
      ? {
          video: {
            rate: frameRate!,
            width: video.width!,
            height: video.height!,
            ...(video.sample_aspect_ratio && video.sample_aspect_ratio !== "0:1"
              ? { pixel_aspect: rate(video.sample_aspect_ratio) }
              : {}),
            vfr,
          },
        }
      : {}),
    ...(audio ? { audio: { sample_rate: sampleRate!, channels: audio.channels! } } : {}),
    ...(timecode ? { start_timecode: timecode } : wavTimecode ? { start_timecode: wavTimecode } : {}),
    ...(startSamples !== undefined ? { ext: { zsir: { start_samples: Number(startSamples) } } } : {}),
    ...(tags.reel_name ? { reel: tags.reel_name } : {}),
  };
}
