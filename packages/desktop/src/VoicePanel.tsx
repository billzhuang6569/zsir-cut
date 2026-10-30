import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { UiState } from "../../app-host/src/ui.js";
import type { Voice, VoiceSettings } from "../../core/src/voice-storage.js";
import { IconButton } from "./components.js";
import { DESKTOP_AUTHOR, type ProjectView, requestError } from "./connection.js";
import "./voice.css";

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
const models = ["s2.1-pro", "s2.1-pro-free", "s2-pro", "drama-3"];

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="zc-voice-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="zc-voice-row">
        <h2>{title}</h2>
        <span className="zc-grow" />
        <IconButton icon="close" label="关闭" onClick={close} />
      </div>
      {children}
    </dialog>
  );
}

export function SettingsPage({ call, close }: { call: Call; close: () => void }) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [keySet, setKeySet] = useState(false);
  const [replace, setReplace] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void call("settings_get", {})
      .then((value) => {
        if (disposed) return;
        const result = value as { settings: VoiceSettings; voice_key_set: boolean };
        setSettings(result.settings);
        setKeySet(result.voice_key_set);
      })
      .catch(() => {
        if (!disposed) setError("无法读取设置，请关闭后重试");
      });
    return () => {
      disposed = true;
    };
  }, [call]);
  const save = async (clear = false) => {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    const request = clear
      ? { voice_key: null }
      : {
          voice: { model: settings.voice.model },
          network: settings.network,
          ...((!keySet || replace) && key ? { voice_key: key } : {}),
        };
    setKey("");
    try {
      await call("settings_set", request);
      const value = (await call("settings_get", {})) as { settings: VoiceSettings; voice_key_set: boolean };
      setSettings(value.settings);
      setKeySet(value.voice_key_set);
      setReplace(false);
    } catch {
      setError("设置未能保存，请重试；如已更换密钥，请重新输入");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="设置" close={close}>
      {error && <p role="alert">{error}</p>}
      {settings && (
        <form
          className="zc-voice-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <div>
              fish.audio API Key
              {keySet && !replace ? (
                <div className="zc-voice-row">
                  <span>已设置</span>
                  <button className="zc-btn" type="button" onClick={() => setReplace(true)}>
                    更换
                  </button>
                  <button className="zc-btn" type="button" onClick={() => void save(true)}>
                    清除
                  </button>
                </div>
              ) : (
                <input
                  className="zc-input"
                  aria-label="fish.audio API Key"
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              )}
            </div>
            <label>
              默认模型
              <select
                className="zc-input"
                aria-label="默认模型"
                value={settings.voice.model}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    voice: { ...settings.voice, model: e.target.value as VoiceSettings["voice"]["model"] },
                  })
                }
              >
                {models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
            <label>
              代理地址
              <input
                className="zc-input"
                aria-label="代理地址"
                type="url"
                placeholder="留空使用环境变量或直连"
                value={settings.network.proxy ?? ""}
                onChange={(e) => setSettings({ ...settings, network: { proxy: e.target.value || null } })}
              />
            </label>
            <button className="zc-btn zc-btn-primary" type="submit">
              {busy ? "保存中…" : "保存"}
            </button>
          </fieldset>
        </form>
      )}
    </Modal>
  );
}

export function useVoicePanel({
  call,
  state,
  update,
  project,
  config,
}: {
  call: Call;
  state: UiState;
  update: (state: UiState) => void;
  project: ProjectView | null;
  config?: { port: number; token: string } | undefined;
}) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [file, setFile] = useState("");
  const [name, setName] = useState("");
  const [items, setItems] = useState([{ id: crypto.randomUUID(), text: "" }]);
  const [model, setModel] = useState("");
  const [params, setParams] = useState<Record<string, number | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Voice | null>(null);
  const [renaming, setRenaming] = useState<Voice | null>(null);
  const [newName, setNewName] = useState("");
  const area = useRef<HTMLElement>(null);
  const alive = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const result = (await call("voice_list", {})) as { voices: Voice[] };
    if (alive.current) setVoices(result.voices);
  }, [call]);
  useEffect(() => {
    if (state.panel === "voice") void refresh().catch(() => setError("无法读取音色库，请切换标签后重试"));
  }, [state.panel, refresh]);
  useEffect(() => {
    if (!voices.some((voice) => voice.id === voiceId)) setVoiceId(voices[0]?.id ?? "");
  }, [voices, voiceId]);
  const sub = state.sub ?? "clone";
  const choose = (path: string) => {
    setFile(path);
    if (!name)
      setName(
        path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, "")
          .slice(0, 40) ?? "",
      );
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    if (!isTauri() || state.panel !== "voice" || sub !== "clone") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const rect = area.current?.getBoundingClientRect();
        const { x, y } = event.payload.position;
        const scale = window.devicePixelRatio;
        if (
          rect &&
          x / scale >= rect.left &&
          x / scale <= rect.right &&
          y / scale >= rect.top &&
          y / scale <= rect.bottom &&
          event.payload.paths[0]
        )
          chooseRef.current(event.payload.paths[0]);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => setError("无法接收拖入文件，请使用选择文件"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [state.panel, sub]);
  const run = async (verb: string, request: Record<string, unknown>, success: string) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = (await call(verb, request)) as { job_id?: string };
      if (result.job_id) {
        setProgress(0);
        while (alive.current) {
          const job = (await call("job_status", {
            job_id: result.job_id,
            ...(verb === "voice_generate" ? { project: request.project } : {}),
          })) as {
            state: string;
            progress: number;
            envelope: { ok: boolean; result: unknown; error: { code: string; message: string } | null } | null;
          };
          if (!alive.current) return;
          setProgress(job.progress);
          if (job.state === "failed" || job.state === "cancelled" || job.envelope?.ok === false) {
            setError(job.envelope ? requestError(job.envelope) : "语音任务未完成，请重试");
            return;
          }
          if (job.state === "succeeded") {
            const warnings = (job.envelope?.result as { warnings?: { code: string }[] } | null)?.warnings;
            if (warnings?.some((w) => w.code === "W_VOICE_SAMPLE_TRIMMED")) success += "，参考音频已截取前 60 秒";
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!alive.current) return;
      await refresh();
      setMessage(success);
      setDeleting(null);
      setRenaming(null);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "语音操作失败，请重试");
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };
  const controls = (
    <div className="zc-voice-form">
      <div className="zc-seg" role="tablist" aria-label="语音子页">
        {[
          ["clone", "克隆"],
          ["generate", "生成"],
          ["results", "结果"],
        ].map(([value, label]) => (
          <button
            key={value}
            className="zc-btn"
            type="button"
            role="tab"
            aria-selected={sub === value}
            onClick={() => update({ ...state, sub: value ?? "clone" })}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {progress !== null && <progress aria-label="语音任务进度" max={1} value={progress} />}
      {sub === "clone" && (
        <>
          <section
            aria-label="参考音频"
            ref={area}
            className="zc-voice-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const path = (e.dataTransfer.files[0] as (File & { path?: string }) | undefined)?.path;
              if (path) choose(path);
              else setError("请使用选择文件，或输入本机文件路径");
            }}
          >
            <p>拖入参考音频</p>
            <p className="zc-muted">建议 10–30 秒干净人声，至少 5 秒；超过 60 秒只取前 60 秒</p>
            {isTauri() ? (
              <button
                className="zc-btn"
                type="button"
                onClick={() =>
                  void open({
                    multiple: false,
                    directory: false,
                    filters: [
                      { name: "音频与视频", extensions: ["wav", "mp3", "m4a", "flac", "aac", "ogg", "mp4", "mov"] },
                    ],
                  })
                    .then((path) => {
                      if (typeof path === "string") choose(path);
                    })
                    .catch(() => setError("无法选择文件，请重试"))
                }
              >
                选择文件
              </button>
            ) : (
              <input
                className="zc-input"
                aria-label="参考音频路径"
                placeholder="本机文件的绝对路径"
                value={file}
                onChange={(e) => choose(e.target.value)}
              />
            )}
            {isTauri() && file && <p>{file.split(/[\\/]/).pop()}</p>}
          </section>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("voice_clone", { name, file }, "音色已加入音色库");
            }}
          >
            <label>
              音色名称
              <input
                className="zc-input"
                aria-label="音色名称"
                required
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="zc-btn zc-btn-primary" type="submit" disabled={busy || !file || !name.trim()}>
              克隆音色
            </button>
          </form>
          <h3>音色库</h3>
          {voices.length === 0 && <p className="zc-muted">还没有音色，先克隆一个吧</p>}
          {voices.map((voice) => (
            <div className="zc-voice-card" key={voice.id}>
              <div className="zc-voice-row">
                <strong>{voice.name}</strong>
                <span className="zc-grow" />
                <IconButton
                  icon="replace"
                  label={`改名「${voice.name}」`}
                  disabled={busy}
                  onClick={() => {
                    setRenaming(voice);
                    setNewName(voice.name);
                  }}
                />
                <IconButton
                  icon="trash"
                  label={`删除「${voice.name}」`}
                  disabled={busy}
                  onClick={() => setDeleting(voice)}
                />
              </div>
              {config && (
                // biome-ignore lint/a11y/useMediaCaption: Reference samples have no transcript.
                <audio
                  aria-label={`试听「${voice.name}」`}
                  controls
                  preload="none"
                  src={`http://127.0.0.1:${config.port}/voice-sample?token=${encodeURIComponent(config.token)}&voice_id=${encodeURIComponent(voice.id)}`}
                  onError={() => setError("试听文件无法播放，请重试")}
                />
              )}
            </div>
          ))}
        </>
      )}
      {sub === "generate" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!project || !state.project) return;
            void run(
              "voice_generate",
              {
                project: state.project,
                base_revision: project.revision.id,
                idempotency_key: crypto.randomUUID(),
                author: DESKTOP_AUTHOR,
                label: "生成配音",
                voice_id: voiceId,
                items: items.map(({ text }) => ({ text })),
                ...(model ? { model } : {}),
                ...(Object.keys(params).length ? { params } : {}),
              },
              "配音已加入项目素材",
            );
          }}
        >
          <fieldset disabled={busy}>
            <label>
              音色
              <select
                className="zc-input"
                aria-label="音色"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                <option value="" disabled>
                  请选择音色
                </option>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
            {items.map((item, index) => (
              <div key={item.id}>
                <label>
                  配音文字 {index + 1}
                  <textarea
                    className="zc-input"
                    aria-label={`配音文字 ${index + 1}`}
                    required
                    maxLength={2000}
                    value={item.text}
                    onChange={(e) =>
                      setItems(items.map((old, i) => (i === index ? { ...old, text: e.target.value } : old)))
                    }
                  />
                </label>
                {items.length > 1 && (
                  <IconButton
                    icon="trash"
                    label={`删除文字 ${index + 1}`}
                    onClick={() => setItems(items.filter((_, i) => i !== index))}
                  />
                )}
              </div>
            ))}
            <IconButton
              icon="plus"
              label="添加文字"
              disabled={items.length >= 50}
              onClick={() => setItems([...items, { id: crypto.randomUUID(), text: "" }])}
            />
            <details>
              <summary>细调</summary>
              <label>
                模型
                <select className="zc-input" aria-label="模型" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">使用设置中的默认模型</option>
                  {models.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              {[
                ["speed", "语速", 0.5, 2, 1],
                ["volume", "音量（dB）", undefined, undefined, 0],
                ["temperature", "温度", 0, 1, 0.7],
                ["top_p", "采样范围", 0, 1, 0.7],
              ].map(([key, label, min, max, placeholder]) => (
                <label key={String(key)}>
                  {label}
                  <input
                    className="zc-input"
                    aria-label={String(label)}
                    type="number"
                    step="any"
                    min={min}
                    max={max}
                    placeholder={String(placeholder)}
                    value={params[String(key)] === undefined ? "" : Number(params[String(key)])}
                    onChange={(e) =>
                      setParams((old) => {
                        const next = { ...old };
                        if (!e.target.value) delete next[String(key)];
                        else next[String(key)] = Number(e.target.value);
                        return next;
                      })
                    }
                  />
                </label>
              ))}
              <label>
                响度归一化
                <select
                  className="zc-input"
                  aria-label="响度归一化"
                  value={params.normalize_loudness === undefined ? "" : String(params.normalize_loudness)}
                  onChange={(e) =>
                    setParams((old) => {
                      const next = { ...old };
                      if (e.target.value === "") delete next.normalize_loudness;
                      else next.normalize_loudness = e.target.value === "true";
                      return next;
                    })
                  }
                >
                  <option value="">默认（开启）</option>
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </label>
            </details>
            <button
              className="zc-btn zc-btn-primary"
              type="submit"
              disabled={!project || !voiceId || items.some(({ text }) => !text.trim())}
            >
              生成配音
            </button>
          </fieldset>
        </form>
      )}
      {sub === "results" && <p className="zc-muted">结果页将在 V1.4 开放，当前生成的配音可在「素材」中查看。</p>}
      {renaming && (
        <Modal
          title="音色改名"
          close={() => {
            if (!busy) setRenaming(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("voice_edit", { ops: [{ op: "rename", id: renaming.id, name: newName }] }, "音色已改名");
            }}
          >
            <input
              className="zc-input"
              aria-label="新音色名称"
              maxLength={40}
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="zc-btn" disabled={busy || !newName.trim()} type="submit">
              保存名称
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除音色"
          close={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p>删除「{deleting.name}」也会同时删除 fish.audio 上的音色。已生成的素材仍可使用。</p>
          <button className="zc-btn" type="button" disabled={busy} onClick={() => setDeleting(null)}>
            取消
          </button>
          <button
            className="zc-btn"
            type="button"
            disabled={busy}
            onClick={() => void run("voice_edit", { ops: [{ op: "delete", id: deleting.id }] }, "音色已删除")}
          >
            确认删除
          </button>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
    </div>
  );
  return controls;
}
