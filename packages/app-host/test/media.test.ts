import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(run.mock.calls.every(([args]) => args.includes(join(directory, "proxy.mp4")))).toBe(true);
      await request(`/thumb?token=secret&media_id=${media.id}&at=2s`);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
