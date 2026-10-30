import { ProxyAgent } from "undici";

export class VoiceError extends Error {
  readonly code: "E_VOICE_AUTH" | "E_VOICE_PAYMENT" | "E_VOICE_UPSTREAM" | "E_VALIDATION" | "E_NOT_FOUND";
  readonly retryable: boolean;
  readonly status: "failed" | "rejected";
  constructor(code: VoiceError["code"], message: string, retryable = false, status: "failed" | "rejected" = "failed") {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}
export interface FishAudioClient {
  createModel(input: { name: string; audio: Uint8Array; text?: string }): Promise<{ _id: string }>;
  updateModel(id: string, title: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
}
export const redactVoiceKey = (message: string, key: string) => (key ? message.replaceAll(key, "[redacted]") : message);
export function createFishAudioClient(
  key: string,
  proxy: string | null,
  fetcher: typeof fetch = fetch,
): FishAudioClient {
  async function request(path: string, method: string, body?: FormData, missingOk = false) {
    let agent: ProxyAgent | undefined;
    try {
      const address = proxy ?? process.env.HTTPS_PROXY;
      if (address) agent = new ProxyAgent(address);
      const response = await fetcher(`https://api.fish.audio${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}` },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(120000),
        ...(agent ? { dispatcher: agent } : {}),
        redirect: "error",
      });
      if (response.ok || (missingOk && response.status === 404)) {
        if (method === "POST") {
          const value = (await response.json()) as { _id?: unknown };
          if (typeof value._id !== "string" || !value._id || value._id.includes(key))
            throw new VoiceError("E_VOICE_UPSTREAM", "Invalid fish.audio model response");
          return { _id: value._id };
        }
        await response.arrayBuffer();
        return;
      }
      const status = response.status;
      let message = `fish.audio HTTP ${status}`;
      if (status >= 400 && status < 500 && ![401, 402, 429].includes(status)) {
        const value = (await response.json().catch(() => null)) as { message?: unknown } | null;
        if (typeof value?.message === "string") message += `: ${value.message}`;
      } else await response.arrayBuffer();
      throw new VoiceError(
        status === 401 ? "E_VOICE_AUTH" : status === 402 ? "E_VOICE_PAYMENT" : "E_VOICE_UPSTREAM",
        redactVoiceKey(message, key),
        status === 429 || status >= 500,
      );
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("E_VOICE_UPSTREAM", "Cannot reach fish.audio", true);
    } finally {
      await agent?.close().catch(() => undefined);
    }
  }
  return {
    async createModel({ name, audio, text }) {
      const form = new FormData();
      for (const [field, value] of Object.entries({
        type: "tts",
        train_mode: "fast",
        visibility: "private",
        title: name,
        enhance_audio_quality: "true",
      }))
        form.set(field, value);
      form.set("voices", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "sample.wav");
      if (text) form.set("texts", text);
      const result = await request("/model", "POST", form);
      if (!result) throw new VoiceError("E_VOICE_UPSTREAM", "Missing fish.audio model response");
      return result;
    },
    async updateModel(id, title) {
      const form = new FormData();
      form.set("title", title);
      await request(`/model/${encodeURIComponent(id)}`, "PATCH", form);
    },
    async deleteModel(id) {
      await request(`/model/${encodeURIComponent(id)}`, "DELETE", undefined, true);
    },
  };
}
