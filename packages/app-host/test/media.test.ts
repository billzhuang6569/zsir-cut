import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseProject } from "../../core/src/index.ts";
import { authorized, byteRange, mediaChannel } from "../src/media.js";

class Response extends Writable {
  status = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  chunks: Buffer[] = [];
  setHeader(key: string, value: unknown) {
    this.headers[key] = value;
  }
  writeHead(status: number, headers = {}) {
    this.status = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  get bytes() {
    return Buffer.concat(this.chunks);
  }
}
describe("read-only media channel", () => {
  it("checks token and single byte ranges including suffix and invalid requests", () => {
    expect(authorized("secret", "secret")).toBe(true);
    expect(authorized("", "secret")).toBe(false);
    expect(byteRange("bytes=2-4", 10)).toEqual([2, 4]);
    expect(byteRange("bytes=-3", 10)).toEqual([7, 9]);
    expect(byteRange("bytes=5-", 10)).toEqual([5, 9]);
    for (const range of ["bytes=20-", "bytes=5-2", "bytes=-0", "bytes=1-2,4-5", "bytes=-"])
      expect(byteRange(range, 10)).toBeNull();
  });
  it("rejects arbitrary paths, authenticates, reads registered proxy bytes, and caches ffmpeg outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut36-media-"));
    try {
      const parsed = parseProject(
        await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
      );
      if (!parsed.ok) throw new Error("Invalid fixture");
      const project = parsed.project;
      const media = project.media[0];
      if (!media) throw new Error("Missing media");
      media.path = "original.mp4";
      media.proxy = { path: "proxy.mp4", fingerprint: { ...media.fingerprint, value: "proxy" } };
      await writeFile(join(directory, media.path), "original");
      await writeFile(join(directory, media.proxy.path), "0123456789");
      const run = vi.fn(async (args: string[]) => {
        if (args.includes("rgb24")) return Buffer.from(Array.from({ length: 27 }, (_, i) => i));
        if (args.includes("mjpeg")) return Buffer.from("jpeg");
        const pcm = Buffer.alloc(400);
        pcm.writeInt16LE(-16384, 0);
        pcm.writeInt16LE(32767, 200);
        return pcm;
      });
      const serve = mediaChannel(join(directory, "project.zcut.json"), "secret", async () => project, run);
      const request = async (query: string, range?: string, method = "GET") => {
        const response = new Response();
        const finished = new Promise<void>((done, reject) => {
          response.on("finish", done);
          response.on("error", reject);
        });
        await serve(
          { url: query, method, headers: range ? { range } : {} } as IncomingMessage,
          response as unknown as ServerResponse,
        );
        await finished;
        return response;
      };
      expect((await request(`/media?media_id=${media.id}`)).status).toBe(401);
      expect((await request("/media?token=secret&media_id=/etc/passwd")).status).toBe(404);
      expect((await request(`/media?token=secret&media_id=${media.id}&path=/etc/passwd`)).status).toBe(404);
      const partial = await request(`/media?token=secret&media_id=${media.id}`, "bytes=2-5");
      expect(partial.status).toBe(206);
      expect(partial.bytes.toString()).toBe("2345");
      expect(partial.headers["Content-Range"]).toBe("bytes 2-5/10");
      expect(partial.headers["Accept-Ranges"]).toBe("bytes");
      expect(partial.headers["Content-Length"]).toBe(4);
      for (const [range, expected, contentRange] of [
        ["bytes=7-", "789", "bytes 7-9/10"],
        ["bytes=-3", "789", "bytes 7-9/10"],
        ["bytes=8-99", "89", "bytes 8-9/10"],
      ]) {
        const response = await request(`/media?token=secret&media_id=${media.id}`, range);
        expect(response.status).toBe(206);
        expect(response.bytes.toString()).toBe(expected);
        expect(response.headers["Content-Range"]).toBe(contentRange);
      }
      const head = await request(`/media?token=secret&media_id=${media.id}`, "bytes=2-5", "HEAD");
      expect(head.status).toBe(206);
      expect(head.bytes.length).toBe(0);
      expect(head.headers["Content-Length"]).toBe(4);
      const whole = await request(`/media?token=secret&media_id=${media.id}`);
      expect(whole.status).toBe(200);
      expect(whole.bytes.toString()).toBe("0123456789");
      expect(whole.headers["Accept-Ranges"]).toBe("bytes");
      const invalid = await request(`/media?token=secret&media_id=${media.id}`, "bytes=99-");
      expect(invalid.headers["Content-Range"]).toBe("bytes */10");

      expect((await request(`/media?token=secret&media_id=${media.id}`, "bytes=99-")).status).toBe(416);
      expect((await request(`/media?token=secret&media_id=${media.id}`, undefined, "POST")).status).toBe(405);
      for (let i = 0; i < 2; i++) {
        expect((await request(`/thumb?token=secret&media_id=${media.id}&at=1s`)).bytes.toString()).toBe("jpeg");
        expect(JSON.parse((await request(`/peaks?token=secret&media_id=${media.id}`)).bytes.toString())).toEqual([
          0.5,
          32767 / 32768,
        ]);
      }
      expect(run).toHaveBeenCalledTimes(2);
      const colors = [
        "#000102",
        "#030405",
        "#060708",
        "#090a0b",
        "#0c0d0e",
        "#0f1011",
        "#121314",
        "#151617",
        "#18191a",
      ];
      for (let i = 0; i < 2; i++)
        expect(
          JSON.parse((await request(`/palette?token=secret&media_id=${media.id}&at=1s`)).bytes.toString()),
        ).toEqual(colors);
      expect(run).toHaveBeenCalledTimes(3);
      const restarted = mediaChannel(join(directory, "project.zcut.json"), "secret", async () => project, run);
      const response = new Response();
      await restarted(
        { url: `/palette?token=secret&media_id=${media.id}&at=1s`, method: "GET", headers: {} } as IncomingMessage,
        response as unknown as ServerResponse,
      );
      expect(JSON.parse(response.bytes.toString())).toEqual(colors);
      expect(run).toHaveBeenCalledTimes(3);
      expect(run.mock.calls.every(([args]) => args.includes(join(directory, "proxy.mp4")))).toBe(true);
      await request(`/thumb?token=secret&media_id=${media.id}&at=2s`);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("caps thumbnails globally, merges queued keys, cancels disconnected waiters and recovers after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-skim-"));
  const jobs: { resolve: (value: Buffer) => void; reject: (error: Error) => void }[] = [];
  let active = 0;
  let maximum = 0;
  try {
    const parsed = parseProject(
      await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
    );
    if (!parsed.ok) throw new Error("Invalid fixture");
    const project = parsed.project;
    const media = project.media[0];
    if (!media) throw new Error("Missing media");
    const run = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      try {
        return await new Promise<Buffer>((resolve, reject) => jobs.push({ resolve, reject }));
      } finally {
        active--;
      }
    });
    const channel = () => mediaChannel(join(directory, "project.zcut.json"), "secret", async () => project, run);
    const first = channel();
    const second = channel();
    const request = (serve: ReturnType<typeof channel>, at: string, token = "secret") => {
      const response = new Response();
      const done = serve(
        { url: `/thumb?token=${token}&media_id=${media.id}&at=${at}`, method: "GET", headers: {} } as IncomingMessage,
        response as unknown as ServerResponse,
      );
      return { response, done };
    };
    const a = request(first, "1s");
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    const b = request(second, "2s");
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    const c = request(first, "3s");
    const duplicate = request(first, "3s");
    const cancelled = request(second, "4s");
    // Give cache misses time to enter the queue before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(run).toHaveBeenCalledTimes(2);
    c.response.destroy();
    cancelled.response.destroy();
    await cancelled.done;
    jobs[0]?.reject(new Error("decode failed"));
    await vi.waitFor(() => expect(jobs).toHaveLength(3));
    jobs[1]?.resolve(Buffer.from("second"));
    jobs[2]?.resolve(Buffer.from("shared"));
    await Promise.all([a.done, b.done, c.done, duplicate.done]);
    expect(a.response.status).toBe(500);
    expect(duplicate.response.bytes.toString()).toBe("shared");
    expect(c.response.headersSent).toBe(false);
    expect(cancelled.response.headersSent).toBe(false);
    expect(maximum).toBe(2);
    expect(run).toHaveBeenCalledTimes(3);
    const hit = request(first, "3s");
    await hit.done;
    expect(hit.response.bytes.toString()).toBe("shared");
    expect(run).toHaveBeenCalledTimes(3);
    const denied = request(first, "5s", "wrong");
    await denied.done;
    expect(denied.response.status).toBe(401);
    expect(run).toHaveBeenCalledTimes(3);
    const retry = request(second, "4s");
    await vi.waitFor(() => expect(jobs).toHaveLength(4));
    jobs[3]?.resolve(Buffer.from("retry"));
    await retry.done;
    expect(retry.response.bytes.toString()).toBe("retry");
  } finally {
    for (const job of jobs) job.resolve(Buffer.from("cleanup"));
    await rm(directory, { recursive: true, force: true });
  }
});

it("serves only registered voice samples with token, range, HEAD and symlink checks without a project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-voice-sample-"));
  vi.stubEnv("HOME", directory);
  try {
    const data = join(directory, "Library/Application Support/zsir-cut");
    const id = "voc_00000000-0000-7000-8000-000000000001";
    const sample = `voices/${id}.wav`;
    await mkdir(join(data, "voices"), { recursive: true });
    await writeFile(
      join(data, "voices.json"),
      JSON.stringify({
        schema: "zsir-cut/voices",
        version: 1,
        voices: [
          {
            id,
            name: "示例",
            fish_model_id: "remote",
            source: { kind: "file", name: "sample.wav" },
            sample,
            created_at: "2026-10-30T00:00:00Z",
          },
        ],
      }),
    );
    await writeFile(join(data, sample), "0123456789");
    const load = vi.fn(async () => {
      throw new Error("Must not load a project");
    });
    const serve = mediaChannel(undefined, "secret", load);
    const request = async (query: string, range?: string, method = "GET") => {
      const response = new Response();
      const finished = new Promise<void>((done, reject) => {
        response.on("finish", done);
        response.on("error", reject);
      });
      await serve(
        { url: query, method, headers: range ? { range } : {} } as IncomingMessage,
        response as unknown as ServerResponse,
      );
      await finished;
      return response;
    };
    const url = `/voice-sample?token=secret&voice_id=${id}`;
    expect((await request(`/voice-sample?voice_id=${id}`)).status).toBe(401);
    expect((await request("/voice-sample?token=wrong")).status).toBe(401);
    expect((await request("/voice-sample?token=secret&voice_id=/etc/passwd")).status).toBe(404);
    expect((await request(`${url}&path=/etc/passwd`)).status).toBe(404);
    const full = await request(url);
    expect(full.bytes.toString()).toBe("0123456789");
    expect(full.headers["Content-Type"]).toBe("audio/wav");
    const partial = await request(url, "bytes=2-5");
    expect(partial.status).toBe(206);
    expect(partial.bytes.toString()).toBe("2345");
    expect(partial.headers["Content-Range"]).toBe("bytes 2-5/10");
    const head = await request(url, undefined, "HEAD");
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect(head.headers["Content-Length"]).toBe(10);
    expect((await request(url, "bytes=99-")).status).toBe(416);
    expect((await request(url, undefined, "POST")).status).toBe(405);
    await rm(join(data, sample));
    expect((await request(url)).status).toBe(404);
    await writeFile(join(directory, "outside.wav"), "private");
    await symlink(join(directory, "outside.wav"), join(data, sample));
    expect((await request(url)).status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
