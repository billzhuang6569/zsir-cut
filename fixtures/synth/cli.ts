import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fingerprint } from "../../packages/core/src/fingerprint.ts";
import { frameToTimecode } from "../../packages/core/src/timecode.ts";
import { type Token, wavPcm24 } from "./audio.ts";
import { decodeBarcode } from "./barcode.ts";
import { bindProject, type FingerprintTable } from "./bind.ts";
import { baseFrame, HEIGHT, isWhiteFrame, overlayText, WIDTH } from "./picture.ts";

const root = resolve("fixtures/.media");
const temp = join(root, ".tmp");
const font = "/System/Library/Fonts/Hiragino Sans GB.ttc";
const script = JSON.parse(readFileSync("fixtures/synth/script.json", "utf8")) as {
  tokens: Token[];
  sentences: Array<{ text: string; start_ms: number }>;
};
type Media = {
  id: number;
  path: string;
  rate?: string;
  frames?: number;
  seconds?: number;
  start?: string;
  channels?: 1 | 2;
  kind?: "still" | "alpha" | "vfr";
};
const media: Media[] = [
  { id: 1, path: "25/A_25.mov", rate: "25", frames: 3000, seconds: 120, start: "10:00:00:00", channels: 2 },
  { id: 2, path: "25/B_25.mov", rate: "25", frames: 2250, seconds: 90, start: "10:00:01:12", channels: 2 },
  {
    id: 11,
    path: "2997/A_2997.mov",
    rate: "30000/1001",
    frames: 3597,
    seconds: 120,
    start: "10:00:00;00",
    channels: 2,
  },
  { id: 12, path: "2997/B_2997.mov", rate: "30000/1001", frames: 2698, seconds: 90, start: "10:00:01;12", channels: 2 },
  { id: 21, path: "shared/外录音频.wav", seconds: 125, start: "09:59:58:00", channels: 1 },
  { id: 41, path: "shared/台词朗读.wav", seconds: 120, channels: 1 },
  { id: 22, path: "shared/静帧.png", kind: "still" },
  { id: 23, path: "shared/图形_alpha.mov", kind: "alpha", rate: "25", frames: 125, seconds: 5, start: "00:00:00:00" },
  { id: 24, path: "shared/手机录屏_vfr.mp4", kind: "vfr", rate: "30", frames: 900, seconds: 30, channels: 1 },
  {
    id: 31,
    path: "shared/素材 盘/100% 原片/批次1/同名素材.mov",
    rate: "25",
    frames: 250,
    seconds: 10,
    start: "11:00:00:00",
    channels: 2,
  },
  {
    id: 32,
    path: "shared/素材 盘/100% 原片/批次2/同名素材.mov",
    rate: "25",
    frames: 250,
    seconds: 10,
    start: "12:00:00:00",
    channels: 2,
  },
];

function sameRate(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const [an, ad = "1"] = actual.split("/");
  const [en, ed = "1"] = expected.split("/");
  return BigInt(an!) * BigInt(ed) === BigInt(en!) * BigInt(ad);
}

function nearNominal30(actual: string | undefined): boolean {
  if (!actual) return false;
  const [numerator, denominator] = actual.split("/").map(BigInt);
  return numerator! * 10n >= denominator! * 299n && numerator! * 10n <= denominator! * 301n;
}

function decimalRatio(value: string): [bigint, bigint] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
}

function run(command: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(command, args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    env:
      command === "swift"
        ? {
            ...process.env,
            CLANG_MODULE_CACHE_PATH: join(temp, "swift-cache"),
            SWIFT_MODULECACHE_PATH: join(temp, "swift-cache"),
          }
        : process.env,
  });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr.toString()}`);
  return result.stdout;
}

async function renderLabels(): Promise<Map<string, { pixels: Buffer; width: number; height: number }>> {
  if (!existsSync(font)) throw new Error(`Missing Chinese font: ${font}`);
  const labels = [
    ..."0123456789:;".split("").map((text) => ({
      name: `char-${text === ":" ? "colon" : text === ";" ? "semicolon" : text}`,
      text,
      width: 36,
      height: 52,
      size: 34,
    })),
    ...media.map((item) => ({
      name: `asset-${item.id}`,
      text: `${[1, 11].includes(item.id) ? "A" : [2, 12].includes(item.id) ? "B" : item.path.split("/").at(-1)!.split(".")[0]} · ${item.id}`,
      width: 500,
      height: 52,
      size: 30,
    })),
    ...script.tokens.map((token) => ({
      name: `token-${token.index}`,
      text: token.text,
      width: 900,
      height: 72,
      size: 42,
      center: true,
    })),
  ];
  await mkdir(temp, { recursive: true });
  const manifest = join(temp, "labels.json");
  await writeFile(manifest, JSON.stringify(labels));
  run("swift", ["fixtures/synth/render-text.swift", manifest, join(temp, "labels")]);
  const output = new Map<string, { pixels: Buffer; width: number; height: number }>();
  for (const label of labels)
    output.set(label.name, {
      pixels: await readFile(join(temp, "labels", `${label.name}.rgba`)),
      width: label.width,
      height: label.height,
    });
  return output;
}

function drawLabel(
  frame: Buffer,
  labels: Map<string, { pixels: Buffer; width: number; height: number }>,
  key: string,
  x: number,
  y: number,
  dark = false,
): void {
  const label = labels.get(key);
  if (!label) throw new Error(`Missing rendered text: ${key}`);
  overlayText(frame, label.pixels, label.width, label.height, x, y, dark);
}

function drawCharacters(
  frame: Buffer,
  labels: Map<string, { pixels: Buffer; width: number; height: number }>,
  value: string,
  x: number,
  y: number,
  dark = false,
): void {
  for (const character of value) {
    drawLabel(
      frame,
      labels,
      `char-${character === ":" ? "colon" : character === ";" ? "semicolon" : character}`,
      x,
      y,
      dark,
    );
    x += character === ":" || character === ";" ? 22 : 29;
  }
}

function picture(
  item: Media,
  index: number,
  labels: Map<string, { pixels: Buffer; width: number; height: number }>,
): Buffer {
  const [num, den] = item.rate === "30000/1001" ? [30000, 1001] : [Number(item.rate ?? 25), 1];
  const frame = baseFrame(item.id, index, num, den, item.kind === "still");
  const dark = item.kind !== "still" && isWhiteFrame(index, num, den);
  if (item.kind === "alpha" && !dark) {
    for (let y = 135; y < 405; y++)
      for (let x = 240; x < 720; x++) {
        const offset = (y * WIDTH + x) * 3;
        frame[offset] = 0;
        frame[offset + 1] = 130;
        frame[offset + 2] = 160;
      }
  }
  drawLabel(frame, labels, `asset-${item.id}`, 24, 20, dark);
  if (item.kind !== "still") {
    drawCharacters(frame, labels, index.toString().padStart(6, "0"), 730, 20, dark);
    if (item.start)
      drawCharacters(
        frame,
        labels,
        frameToTimecode(BigInt(index), item.rate!, item.start.includes(";"), item.start),
        24,
        465,
        dark,
      );
    if (item.id === 1 || item.id === 11) {
      const token = script.tokens.find(
        (entry) => entry.start_ms * num <= index * den * 1000 && index * den * 1000 < entry.end_ms * num,
      );
      if (token) drawLabel(frame, labels, `token-${token.index}`, 30, 230, dark);
    }
  }
  if (item.kind !== "alpha") return frame;
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const source = (y * WIDTH + x) * 3,
        target = (y * WIDTH + x) * 4;
      rgba[target] = frame[source]!;
      rgba[target + 1] = frame[source + 1]!;
      rgba[target + 2] = frame[source + 2]!;
      const labelRow = (y >= 20 && y < 80) || (y >= 465 && y < 520);
      rgba[target + 3] =
        (x >= 240 && x < 720 && y >= 135 && y < 405) ||
        y >= HEIGHT - 16 ||
        (labelRow && frame[source] !== (dark ? 255 : 38))
          ? 255
          : 0;
    }
  return rgba;
}

async function encode(
  item: Media,
  labels: Map<string, { pixels: Buffer; width: number; height: number }>,
): Promise<void> {
  const destination = join(root, item.path);
  await mkdir(dirname(destination), { recursive: true });
  if (item.id === 41) {
    await generateSpoken();
    return;
  }
  if (item.id === 21) {
    const source = join(temp, "external.wav");
    await writeFile(source, wavPcm24(125, 21, 1, script.tokens, true));
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-c:a",
      "pcm_s24le",
      "-write_bext",
      "1",
      "-metadata",
      "time_reference=1727904000",
      "-metadata",
      "origination_time=09:59:58",
      "-y",
      destination,
    ]);
    return;
  }
  const audio = item.channels ? join(temp, `audio-${item.id}.wav`) : undefined;
  if (audio && !existsSync(audio))
    await writeFile(audio, wavPcm24(item.seconds!, item.id, item.channels!, script.tokens));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    item.kind === "alpha" ? "rgba" : "rgb24",
    "-video_size",
    `${WIDTH}x${HEIGHT}`,
    "-framerate",
    item.rate ?? "25",
    "-i",
    "pipe:0",
  ];
  if (audio) args.push("-i", audio);
  args.push("-map", "0:v");
  if (audio) args.push("-map", "1:a");
  if (item.kind === "still") args.push("-frames:v", "1", "-c:v", "png");
  else if (item.kind === "alpha")
    args.push("-frames:v", String(item.frames), "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le");
  else
    args.push(
      "-frames:v",
      String(item.frames),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "36",
      "-g",
      "1",
      "-pix_fmt",
      "yuv420p",
    );
  if (audio) args.push("-c:a", "pcm_s24le");
  if (item.kind === "vfr")
    args.push(
      "-vf",
      "settb=1/60000,setpts=(2*N-mod(N\\,2))/(60*TB)",
      "-fps_mode",
      "vfr",
      "-enc_time_base:v",
      "1/60000",
    );
  if (item.start && item.kind !== "still") args.push("-timecode", item.start);
  args.push("-y", destination);
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.stdin.on("error", (error: Error) => {
    errors += `\n${error.message}`;
  });
  for (let index = 0; index < (item.frames ?? 1); index++) {
    if (!child.stdin.writable) break;
    if (!child.stdin.write(picture(item, index, labels))) {
      try {
        await once(child.stdin, "drain");
      } catch {
        break;
      }
    }
  }
  if (child.stdin.writable) child.stdin.end();
  const code = await new Promise<number | null>((done) => child.once("close", done));
  if (code !== 0) throw new Error(`${item.path}: ffmpeg exited ${code}: ${errors}`);
  console.log(`generated ${item.path}`);
}

async function generateSpoken(): Promise<void> {
  await mkdir(temp, { recursive: true });
  const destination = join(root, "shared/台词朗读.wav");
  await mkdir(dirname(destination), { recursive: true });
  const inputs: string[] = [];
  const filters: string[] = [];
  for (const sentence of script.sentences) {
    const clip = join(temp, `spoken-${inputs.length}.aiff`);
    run("say", ["-v", "Tingting", "-o", clip, sentence.text]);
    filters.push(`[${inputs.length}:a]adelay=${sentence.start_ms}:all=1[s${inputs.length}]`);
    inputs.push(clip);
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs.flatMap((input) => ["-i", input]),
    "-filter_complex",
    `${filters.join(";")};${inputs.map((_, index) => `[s${index}]`).join("")}amix=inputs=${inputs.length}:duration=longest:normalize=0,atrim=0:120,apad=whole_dur=120[a]`,
    "-map",
    "[a]",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s24le",
    "-t",
    "120",
    "-y",
    destination,
  ];
  run("ffmpeg", args);
  console.log("generated shared/台词朗读.wav");
}

async function generate(): Promise<void> {
  const labels = await renderLabels();
  try {
    for (const item of media) await encode(item, labels);
    const table: FingerprintTable = {};
    for (const item of media) {
      const path = join(root, item.path);
      table[item.path] = { path: item.path, size_bytes: (await stat(path)).size, fingerprint: await fingerprint(path) };
    }
    await writeFile(join(root, "fingerprints.json"), `${JSON.stringify(table, null, 2)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function bind(): Promise<void> {
  const table = JSON.parse(await readFile(join(root, "fingerprints.json"), "utf8")) as FingerprintTable;
  const output = join(root, "projects");
  await mkdir(output, { recursive: true });
  for (const name of ["std-25", "std-2997-df", "std-2997-ndf"]) {
    const filename = `${name}.zcut.json`;
    await writeFile(
      join(output, filename),
      bindProject(await readFile(join("fixtures/projects", filename), "utf8"), table, join(output, filename), root),
    );
    console.log(`bound ${filename}`);
  }
}

async function relocate(target: string | undefined): Promise<void> {
  if (!target) throw new Error("Usage: pnpm fixtures:relocate <new root directory>");
  const destination = resolve(target);
  if (existsSync(destination)) throw new Error(`Destination exists: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(root, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(root, destination, { recursive: true, errorOnExist: true, force: false });
    const table = JSON.parse(await readFile(join(root, "fingerprints.json"), "utf8")) as FingerprintTable;
    for (const entry of Object.values(table)) {
      const copied = join(destination, entry.path);
      if (
        (await stat(copied)).size !== entry.size_bytes ||
        (await fingerprint(copied)).value !== entry.fingerprint.value
      )
        throw new Error(`Relocation copy mismatch: ${entry.path}; original remains at ${root}`);
    }
    await rm(root, { recursive: true });
  }
  console.log(`relocated to ${destination}`);
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "gen":
      await generate();
      break;
    case "spoken":
      try {
        await generateSpoken();
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      break;
    case "bind":
      await bind();
      break;
    case "check":
      await check();
      break;
    case "relocate":
      await relocate(process.argv[3]);
      break;
    default:
      throw new Error("Usage: node fixtures/synth/cli.ts gen|spoken|bind|check|relocate");
  }
}

async function check(): Promise<void> {
  const table = JSON.parse(await readFile(join(root, "fingerprints.json"), "utf8")) as FingerprintTable;
  let referenceAudio: Buffer | undefined;
  for (const item of media) {
    const path = join(root, item.path);
    const fail = (part: string, detail: string): never => {
      throw new Error(`${item.path}: ${part}: ${detail}`);
    };
    const measured = await stat(path);
    if (measured.size !== table[item.path]?.size_bytes)
      fail("size", `expected ${table[item.path]?.size_bytes}, got ${measured.size}`);
    const actualFingerprint = await fingerprint(path);
    if (actualFingerprint.value !== table[item.path]?.fingerprint.value) fail("fingerprint", "content differs");
    const probe = JSON.parse(
      run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path]).toString(),
    ) as {
      streams: Array<{
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
        avg_frame_rate?: string;
        nb_read_frames?: string;
        sample_rate?: string;
        channels?: number;
        bits_per_raw_sample?: string;
        tags?: Record<string, string>;
      }>;
      format: { duration?: string; tags?: Record<string, string> };
    };
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    let frameTimes: string[] = [];
    if (item.id === 21) {
      if (video) fail("streams", "unexpected video");
      if (probe.format.tags?.time_reference !== "1727904000")
        fail("start timecode", "missing 09:59:58:00 BWF time reference");
    } else if (item.id !== 41) {
      const pictureStream = video ?? fail("video", "missing stream");
      if (pictureStream.width !== WIDTH || pictureStream.height !== HEIGHT)
        fail("dimensions", `${pictureStream.width}x${pictureStream.height}`);
      if (Number(pictureStream.nb_read_frames) !== (item.frames ?? 1))
        fail("frames", `expected ${item.frames ?? 1}, got ${pictureStream.nb_read_frames}`);
      if (
        item.kind !== "still" &&
        !(item.kind === "vfr"
          ? nearNominal30(pictureStream.avg_frame_rate)
          : sameRate(pictureStream.avg_frame_rate, item.rate!))
      )
        fail("frame rate", `${pictureStream.avg_frame_rate} instead of ${item.rate}`);
      if (item.kind === "alpha") {
        if (pictureStream.codec_name !== "prores" || !pictureStream.pix_fmt?.startsWith("yuva"))
          fail("codec", `expected ProRes 4444 with alpha, got ${pictureStream.codec_name}/${pictureStream.pix_fmt}`);
        for (const [name, x, y, expected] of [
          ["center", 500, 200, 255],
          ["outside", 800, 200, 0],
          ["barcode", 500, 530, 255],
        ] as const) {
          const alpha = run("ffmpeg", [
            "-v",
            "error",
            "-i",
            path,
            "-vf",
            `select=eq(n\\,1),alphaextract,crop=2:2:${x}:${y},scale=1:1,format=gray`,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "pipe:1",
          ]);
          if (alpha.length !== 1 || Math.abs(alpha[0]! - expected) > 10)
            fail(`alpha ${name}`, `${alpha[0]} instead of ${expected}`);
        }
      }
      if (item.start && item.kind !== "still" && pictureStream.tags?.timecode !== item.start)
        fail("start timecode", `${pictureStream.tags?.timecode} instead of ${item.start}`);
      const probes = new Set([0, (item.frames ?? 1) - 1]);
      for (let sample = 0; sample < 5; sample++) probes.add((sample * 7919 + item.id * 1049) % (item.frames ?? 1));
      for (const frame of probes) {
        const raw = run("ffmpeg", [
          "-v",
          "error",
          "-i",
          path,
          "-vf",
          `select=eq(n\\,${frame}),crop=960:16:0:524,scale=48:1:flags=area,format=gray`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
        if (raw.length !== 48) fail(`barcode frame ${frame}`, `expected 48 bytes, got ${raw.length}`);
        const bits = Array.from(raw, (shade) => Number(shade >= 128));
        const decoded = (() => {
          try {
            return decodeBarcode(bits);
          } catch (error) {
            return fail(`barcode frame ${frame}`, String(error));
          }
        })();
        if (decoded.id !== item.id || decoded.frame !== frame)
          fail(`barcode frame ${frame}`, `decoded ${decoded.id}/${decoded.frame}`);
      }
      if (item.kind !== "still") {
        const numerator = item.rate === "30000/1001" ? 30000n : BigInt(item.rate!);
        const denominator = item.rate === "30000/1001" ? 1001n : 1n;
        const whiteFrames = Array.from({ length: item.seconds! }, (_, second) =>
          Number((BigInt(second) * numerator) / denominator),
        );
        const expression =
          item.rate === "30000/1001" ? "eq(n\\,floor(ceil(n*1001/30000)*30000/1001))" : `eq(mod(n\\,${item.rate})\\,0)`;
        const white = run("ffmpeg", [
          "-v",
          "error",
          "-i",
          path,
          "-vf",
          `select=${expression},crop=2:2:500:200,scale=1:1,format=gray`,
          "-frames:v",
          String(whiteFrames.length),
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
        if (white.length !== whiteFrames.length)
          fail("white frames", `expected ${whiteFrames.length}, got ${white.length}`);
        for (let second = 0; second < white.length; second++)
          if (white[second]! < 245) fail(`white frame ${whiteFrames[second]}`, `pixel ${white[second]}`);
        const [actualNumerator, actualDenominator] = decimalRatio(probe.format.duration ?? "0");
        const expectedNumerator = item.kind === "vfr" ? BigInt(item.seconds!) : BigInt(item.frames!) * denominator;
        const expectedDenominator = item.kind === "vfr" ? 1n : numerator;
        const difference = actualNumerator * expectedDenominator - expectedNumerator * actualDenominator;
        const absoluteDifference = difference < 0n ? -difference : difference;
        if (absoluteDifference * numerator > actualDenominator * expectedDenominator * denominator)
          fail("duration", `${probe.format.duration} instead of ${expectedNumerator}/${expectedDenominator}s`);
      }
      if (item.kind === "vfr") {
        const packets = JSON.parse(
          run("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=duration_time",
            "-of",
            "json",
            path,
          ]).toString(),
        ) as { packets: Array<{ duration_time?: string }> };
        if (new Set(packets.packets.map((packet) => packet.duration_time)).size < 2)
          fail("VFR", "constant packet duration");
      }
      if (item.channels) {
        const frames = JSON.parse(
          run("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            path,
          ]).toString(),
        ) as { frames: Array<{ best_effort_timestamp_time: string }> };
        frameTimes = frames.frames.map((frame) => frame.best_effort_timestamp_time);
        if (frameTimes.length !== item.frames)
          fail("frame timestamps", `${frameTimes.length} instead of ${item.frames}`);
      }
    }
    if (item.id === 41) {
      if (video) fail("streams", "unexpected video");
      if (probe.format.duration !== "120.000000") fail("duration", `${probe.format.duration} instead of 120.000000`);
    }
    if (item.channels) {
      if (
        !audio ||
        audio.channels !== item.channels ||
        audio.sample_rate !== "48000" ||
        audio.codec_name !== "pcm_s24le" ||
        audio.bits_per_raw_sample !== "24"
      ) {
        fail("audio", `expected ${item.channels} channel 48 kHz 24 bit PCM`);
      }
      if (item.id === 41) {
        console.log(`checked ${item.path}`);
        continue;
      }
      const pcm = run("ffmpeg", [
        "-v",
        "error",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-af",
        "pan=mono|c0=c0",
        "-c:a",
        "pcm_s24le",
        "-f",
        "s24le",
        "pipe:1",
      ]);
      if (item.id === 1) referenceAudio = pcm;
      if (item.id === 11 && !pcm.equals(referenceAudio ?? Buffer.alloc(0))) fail("channel 0", "A_25 and A_2997 differ");
      if (item.id === 21 && !pcm.subarray(96000 * 3, 122 * 48000 * 3).equals(referenceAudio ?? Buffer.alloc(0)))
        fail("channel 0", "external audio does not match A after its 2 s lead");
      const sampleAt = (sample: number): number => {
        const offset = sample * 3;
        const unsigned = pcm[offset]! | (pcm[offset + 1]! << 8) | (pcm[offset + 2]! << 16);
        return (unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned) / 8388608;
      };
      const firstPulse = item.id === 21 ? 2 : 0;
      for (let second = firstPulse; second < item.seconds!; second++) {
        const index = second * 48000;
        if (Math.abs(sampleAt(index + 1)) < 0.05) fail(`pulse ${second}s`, "missing onset");
        if (second > 0 && Math.abs(sampleAt(index - 1)) > 0.05) fail(`pulse ${second}s`, "early onset");
        if (video) {
          const sourceSecond = item.id === 21 ? second - 2 : second;
          const num = item.rate === "30000/1001" ? 30000 : Number(item.rate);
          const den = item.rate === "30000/1001" ? 1001 : 1;
          const white = Math.floor((sourceSecond * num) / den);
          if (
            !isWhiteFrame(white, num, den) ||
            !(white * den <= sourceSecond * num && sourceSecond * num < (white + 1) * den)
          )
            fail(`pulse ${second}s`, `white frame ${white} does not contain onset`);
          const [startNumerator, startDenominator] = decimalRatio(frameTimes[white] ?? "0");
          const [endNumerator, endDenominator] = decimalRatio(frameTimes[white + 1] ?? "0");
          if (
            startNumerator > BigInt(sourceSecond) * startDenominator ||
            endNumerator <= BigInt(sourceSecond) * endDenominator
          )
            fail(
              `pulse ${second}s`,
              `decoded white frame ${white} spans ${frameTimes[white]}..${frameTimes[white + 1]}`,
            );
        }
      }
    } else if (audio) fail("audio", "unexpected stream");
    console.log(`checked ${item.path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
