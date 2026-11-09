import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export type ModelId = "1.7b" | "0.6b";
export interface ModelProgress {
  id: ModelId;
  bytes_total: number;
  bytes_done: number;
  state: "missing" | "queued" | "downloading" | "ready";
  error: string | null;
}
interface RemoteFile {
  path: string;
  size: number;
  type: string;
  lfs?: { oid: string; size: number };
}
export type ModelResponse = AsyncIterable<Uint8Array> & {
  statusCode?: number | undefined;
  headers: { location?: string | undefined; link?: string | undefined; "content-range"?: string | undefined };
  destroy(): void;
};
export type ModelRequest = (url: string, signal: AbortSignal, offset?: number) => Promise<ModelResponse>;
export const modelNames = { "1.7b": "Qwen3-ASR-1.7B-8bit", "0.6b": "Qwen3-ASR-0.6B-8bit" };
export const alignName = "Qwen3-ForcedAligner-0.6B-8bit";
export const supportedAsr = (platform = process.platform, arch = process.arch) =>
  platform === "darwin" && arch === "arm64";
const origins = ["https://huggingface.co", "https://hf-mirror.com"];
export const requestModel: ModelRequest = async (url, signal, offset = 0) => {
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: process.env.HTTPS_PROXY } });
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const request = https.get(
          url,
          { agent, signal, headers: offset ? { Range: `bytes=${offset}-` } : {} },
          resolve,
        );
        request.setTimeout(60_000, () => request.destroy(new Error("下载超时")));
        request.on("error", reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        url = new URL(response.headers.location, url).href;
        if (!url.startsWith("https://")) throw new Error("下载地址无效");
      } else {
        response.once("close", () => agent.destroy());
        return response;
      }
    }
    throw new Error("下载地址重定向过多");
  } catch (error) {
    agent.destroy();
    throw error;
  }
};
async function fileBytes(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
async function validFile(path: string, file: RemoteFile) {
  try {
    if ((await stat(path)).size !== file.size) return false;
  } catch {
    return false;
  }
  if (file.lfs) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === file.lfs.oid;
  }
  return true;
}
export class AsrModels {
  private models: ModelProgress[] = (["1.7b", "0.6b"] as const).map((id) => ({
    id,
    bytes_total: 0,
    bytes_done: 0,
    state: "missing",
    error: null,
  }));
  private queue: ModelId[] = [];
  private active: { id: ModelId; controller: AbortController; done: Promise<void> } | undefined;
  private lastPush = 0;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(
    private push: (event: ModelProgress & { type: "asr_model_progress" }) => void,
    private directory = join(homedir(), ".zsir-cut/models"),
    private request: ModelRequest = requestModel,
  ) {}
  private emit(model: ModelProgress) {
    const send = () => {
      this.lastPush = Date.now();
      this.push({ type: "asr_model_progress", ...model });
    };
    if (Date.now() - this.lastPush >= 1000) send();
    else if (!this.pushTimer)
      this.pushTimer = setTimeout(
        () => {
          this.pushTimer = undefined;
          for (const item of this.models) this.push({ type: "asr_model_progress", ...item });
          this.lastPush = Date.now();
        },
        1000 - (Date.now() - this.lastPush),
      );
  }
  private async installed(name: string) {
    try {
      const files = await readdir(join(this.directory, name));
      return files.includes("config.json") && files.some((file) => file.endsWith(".safetensors"));
    } catch {
      return false;
    }
  }
  async status() {
    for (const model of this.models)
      if (model.state !== "downloading" && model.state !== "queued") {
        model.state =
          (await this.installed(modelNames[model.id])) && (await this.installed(alignName)) ? "ready" : "missing";
      }
    for (const model of this.models)
      if (model.state === "ready" && !model.bytes_total) {
        let bytes = 0;
        for (const name of [modelNames[model.id], alignName]) {
          try {
            const manifest: RemoteFile[] = JSON.parse(
              await readFile(join(this.directory, name, ".zsir-manifest.json"), "utf8"),
            );
            bytes += manifest.reduce((sum, file) => sum + file.size, 0);
          } catch {}
        }
        model.bytes_total = model.bytes_done = bytes;
      }
    return this.models.map((model) => ({ ...model }));
  }
  async download(id: ModelId) {
    const model = this.models.find((item) => item.id === id);
    if (!model || model.state === "queued" || model.state === "downloading") return;
    if ((await this.status()).find((item) => item.id === id)?.state === "ready") return;
    if (this.closed || this.queue.includes(id) || this.active?.id === id) return;
    model.error = null;
    model.state = "queued";
    this.queue.push(id);
    this.emit(model);
    this.next();
  }
  private next() {
    if (this.active || this.closed) return;
    const id = this.queue.shift();
    if (!id) return;
    const model = this.models.find((item) => item.id === id);
    if (!model) return;
    const controller = new AbortController();
    model.state = "downloading";
    this.emit(model);
    const done = this.perform(model, controller.signal)
      .catch(() => {
        model.state = "missing";
        model.error = controller.signal.aborted ? null : "下载未完成，请重试";
      })
      .finally(() => {
        this.active = undefined;
        this.emit(model);
        this.next();
      });
    this.active = { id, controller, done };
  }
  private async list(origin: string, name: string, signal: AbortSignal) {
    let url: string | undefined = `${origin}/api/models/mlx-community/${name}/tree/main?recursive=true&limit=1000`;
    const files: RemoteFile[] = [];
    while (url) {
      const response = await this.request(url, signal);
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error("无法读取模型清单");
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of response) chunks.push(chunk);
      const entries: RemoteFile[] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(entries)) throw new Error("模型清单无效");
      for (const file of entries) {
        if (file.type !== "file") continue;
        const path = resolve(this.directory, `${name}.partial`, file.path);
        if (
          !path.startsWith(`${resolve(this.directory, `${name}.partial`)}${sep}`) ||
          file.path.includes("\\") ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          (file.lfs && (!/^[a-f0-9]{64}$/.test(file.lfs.oid) || file.lfs.size !== file.size))
        )
          throw new Error("模型清单无效");
        files.push(file);
      }
      const next = response.headers.link?.match(/<([^>]+)>;\s*rel="next"/u)?.[1];
      url = next ? new URL(next, origin).href : undefined;
      if (url && !url.startsWith(`${origin}/api/models/`)) throw new Error("模型清单地址无效");
    }
    if (!files.some((file) => file.path.endsWith(".safetensors")) || !files.some((file) => file.path === "config.json"))
      throw new Error("模型清单不完整");
    return files;
  }
  private async perform(model: ModelProgress, signal: AbortSignal) {
    for (const origin of origins) {
      signal.throwIfAborted();
      try {
        const pending: { name: string; files: RemoteFile[] }[] = [];
        for (const name of [modelNames[model.id], alignName])
          if (!(await this.installed(name))) pending.push({ name, files: await this.list(origin, name, signal) });
        model.bytes_total = pending.reduce(
          (sum, entry) => sum + entry.files.reduce((sum, file) => sum + file.size, 0),
          0,
        );
        model.bytes_done = 0;
        for (const { name, files } of pending) {
          const partial = join(this.directory, `${name}.partial`);
          await mkdir(partial, { recursive: true });
          for (const file of files) {
            signal.throwIfAborted();
            const path = join(partial, file.path);
            await mkdir(dirname(path), { recursive: true });
            let offset = await fileBytes(path);
            if (offset === file.size && (await validFile(path, file))) {
              model.bytes_done += offset;
              continue;
            }
            if (offset >= file.size) {
              await rm(path, { force: true });
              offset = 0;
            }
            const response = await this.request(
              `${origin}/mlx-community/${name}/resolve/main/${file.path.split("/").map(encodeURIComponent).join("/")}`,
              signal,
              offset,
            );
            if (response.statusCode !== 200 && response.statusCode !== 206) {
              response.destroy();
              throw new Error("下载失败");
            }
            if (
              response.statusCode === 206 &&
              (!offset || response.headers["content-range"] !== `bytes ${offset}-${file.size - 1}/${file.size}`)
            ) {
              response.destroy();
              throw new Error("续传范围无效");
            }
            if (response.statusCode === 200) offset = 0;
            model.bytes_done += offset;
            const self = this;
            async function* progress() {
              for await (const chunk of response) {
                signal.throwIfAborted();
                model.bytes_done += chunk.byteLength;
                self.emit(model);
                yield chunk;
              }
            }
            await pipeline(progress(), createWriteStream(path, { flags: offset ? "a" : "w" }), { signal });
            if (!(await validFile(path, file))) {
              await rm(path, { force: true });
              throw new Error("模型校验失败");
            }
          }
          signal.throwIfAborted();
          await writeFile(join(partial, ".zsir-manifest.json"), JSON.stringify(files));
          await rename(partial, join(this.directory, name));
        }
        model.state = "ready";
        model.error = null;
        return;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    throw new Error("模型下载失败");
  }
  async cancel(id: ModelId) {
    this.queue = this.queue.filter((item) => item !== id);
    if (this.active?.id === id) {
      this.active.controller.abort();
      await this.active.done;
    }
    const model = this.models.find((item) => item.id === id);
    if (model) {
      model.state = "missing";
      model.error = null;
      this.emit(model);
    }
  }
  async delete(id: ModelId) {
    // The shared aligner is removed only while the download queue is idle.
    await this.cancel(id);
    await rm(join(this.directory, modelNames[id]), { recursive: true, force: true });
    await rm(join(this.directory, `${modelNames[id]}.partial`), { recursive: true, force: true });
    const other: ModelId = id === "1.7b" ? "0.6b" : "1.7b";
    if (!this.active && !this.queue.length && !(await this.installed(modelNames[other]))) {
      await rm(join(this.directory, alignName), { recursive: true, force: true });
      await rm(join(this.directory, `${alignName}.partial`), { recursive: true, force: true });
    }
  }
  async close() {
    this.closed = true;
    this.queue = [];
    this.active?.controller.abort();
    await this.active?.done;
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
export const asrMemory = () => totalmem();
