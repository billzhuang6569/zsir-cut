import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import type { Project } from "../../core/dist/index.js";

export const authorized = (supplied: string, token: string) => {
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
export function byteRange(header: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size
    ? [start, end]
    : null;
}
export async function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((done, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let errors = "";
    child.stdout.on("data", (part: Buffer) => chunks.push(part));
    child.stderr.on("data", (part: Buffer) => {
      errors += part.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done(Buffer.concat(chunks)) : reject(new Error(errors || "ffmpeg failed")),
    );
  });
}
export function mediaChannel(
  projectPath: string | undefined,
  token: string,
  load: () => Promise<Project>,
  run = runFfmpeg,
) {
  const pending = new Map<string, Promise<Buffer>>();
  async function cached(file: string, generate: () => Promise<Buffer>) {
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const active = pending.get(file);
    if (active) return active;
    const work = (async () => {
      const bytes = await generate();
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return bytes;
    })();
    pending.set(file, work);
    try {
      return await work;
    } finally {
      pending.delete(file);
    }
  }
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!authorized(url.searchParams.get("token") ?? "", token)) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      if (
        !projectPath ||
        !["/media", "/thumb", "/peaks", "/palette"].includes(url.pathname) ||
        [...url.searchParams.keys()].some((key) => !["token", "media_id", "at"].includes(key))
      ) {
        response.writeHead(404).end();
        return;
      }
      const project = await load();
      const media = project.media.find((item) => item.id === url.searchParams.get("media_id"));
      if (!media) {
        response.writeHead(404).end();
        return;
      }
      let source = resolve(dirname(projectPath), media.path);
      let fingerprint = media.fingerprint.value;
      if (media.proxy) {
        const proxy = resolve(dirname(projectPath), media.proxy.path);
        try {
          await stat(proxy);
          source = proxy;
          fingerprint = media.proxy.fingerprint.value;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      response.setHeader("Cache-Control", "private, no-cache");
      if (url.pathname !== "/media") {
        const at = url.searchParams.get("at") ?? "0s";
        const { parseRational, floor, mul, rational, compare } = (await import(
          new URL(
            import.meta.url.endsWith(".ts") ? "../../core/src/rational.ts" : "../../core/dist/rational.js",
            import.meta.url,
          ).href
        )) as typeof import("../../core/dist/rational.js");
        const time = parseRational(at, true);
        if (compare(time, media.duration) > 0) {
          response.writeHead(400).end();
          return;
        }
        const ns = floor(mul(time, rational(1_000_000_000n)));
        const seconds = `${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, "0")}`;
        const thumb = url.pathname === "/thumb";
        const palette = url.pathname === "/palette";
        const key = createHash("sha256")
          .update(`${fingerprint}:${palette ? `palette-v1:${at}` : thumb ? at : "peaks-100hz-v1"}`)
          .digest("hex");
        const file = join(
          dirname(projectPath),
          ".zcut",
          project.id,
          "cache",
          palette ? "palettes" : thumb ? "thumbs" : "peaks",
          key + (thumb ? ".jpg" : ".json"),
        );
        const bytes = await cached(file, async () => {
          if (palette) {
            const rgb = await run([
              "-ss",
              seconds,
              "-i",
              source,
              "-frames:v",
              "1",
              "-vf",
              "scale=3:3:flags=area",
              "-pix_fmt",
              "rgb24",
              "-f",
              "rawvideo",
              "pipe:1",
            ]);
            if (rgb.length !== 27) throw new Error("Invalid palette frame");
            return Buffer.from(
              JSON.stringify(Array.from({ length: 9 }, (_, i) => `#${rgb.subarray(i * 3, i * 3 + 3).toString("hex")}`)),
            );
          }
          if (thumb)
            return run([
              "-ss",
              seconds,
              "-i",
              source,
              "-frames:v",
              "1",
              "-vf",
              "scale=160:-2",
              "-f",
              "image2pipe",
              "-vcodec",
              "mjpeg",
              "pipe:1",
            ]);
          const pcm = await run(["-i", source, "-vn", "-ac", "1", "-ar", "10000", "-f", "s16le", "pipe:1"]);
          const peaks: number[] = [];
          for (let offset = 0; offset < pcm.length; offset += 200) {
            let peak = 0;
            for (let i = offset; i + 1 < Math.min(offset + 200, pcm.length); i += 2)
              peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)) / 32768);
            peaks.push(peak);
          }
          return Buffer.from(JSON.stringify(peaks));
        });
        response
          .writeHead(200, { "Content-Type": thumb ? "image/jpeg" : "application/json", "Content-Length": bytes.length })
          .end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      const size = (await stat(source)).size;
      const range = request.headers.range ? byteRange(request.headers.range, size) : undefined;
      if (range === null) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      const types: Record<string, string> = {
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".jpg": "image/jpeg",
        ".png": "image/png",
      };
      response.writeHead(range ? 206 : 200, {
        "Content-Type": types[extname(source).toLowerCase()] ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": range ? range[1] - range[0] + 1 : size,
        ...(range ? { "Content-Range": `bytes ${range[0]}-${range[1]}/${size}` } : {}),
      });
      if (request.method === "HEAD" || size === 0) {
        response.end();
        return;
      }
      const stream = createReadStream(source, range ? { start: range[0], end: range[1] } : {});
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent)
        response.writeHead(error instanceof Error && /rational/.test(error.message) ? 400 : 500).end();
      else response.destroy();
    }
  };
}
