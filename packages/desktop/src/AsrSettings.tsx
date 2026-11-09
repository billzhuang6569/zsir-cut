import { useEffect, useId, useRef, useState } from "react";
import type { ModelProgress } from "../../app-host/src/asr-models.js";
import type { Preferences } from "../../app-host/src/preferences.js";
import { Icon } from "./components.js";
import type { Subscribe } from "./connection.js";

interface Status {
  supported: boolean;
  recommended: "1.7b" | "0.6b";
  api_key_set: boolean;
  models: ModelProgress[];
}
type TestResult =
  | { ok: true; audio_seconds: number; used_seconds: number; text: string }
  | { ok: false; code: string; reason: string };
export function AsrSettings({
  call,
  subscribe,
  prefs,
  save,
}: {
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  subscribe: Subscribe;
  prefs: Preferences;
  save: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const keyId = useId();
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const dirtyKey = useRef(false);
  const keyWrite = useRef(Promise.resolve());
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disposed = useRef(false);
  const { mode, model } = prefs.asr;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    disposed.current = false;
    void call("asr_status", {})
      .then((value) => {
        if (!disposed.current) setStatus(value as Status);
      })
      .catch(() => {
        if (!disposed.current) setError("未能完成，请重试");
      });
    const unsubscribe = subscribe((event) => {
      if (event.type === "asr_model_progress")
        setStatus((current) =>
          current
            ? {
                ...current,
                models: current.models.map((item) =>
                  item.id === event.id ? ({ ...item, ...event } as ModelProgress) : item,
                ),
              }
            : current,
        );
    });
    return () => {
      disposed.current = true;
      unsubscribe();
    };
  }, [call, subscribe]);
  const refresh = async () => {
    const value = await call("asr_status", {});
    if (!disposed.current) setStatus(value as Status);
  };
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch {
      if (!disposed.current) setError("未能完成，请重试");
    }
  };
  const saveKey = () => {
    if (!dirtyKey.current) return keyWrite.current;
    dirtyKey.current = false;
    const value = key.trim() || null;
    keyWrite.current = keyWrite.current
      .catch(() => {})
      .then(async () => {
        await call("asr_key_set", { key: value });
        if (!disposed.current) {
          setResult(null);
          setStatus((current) => (current ? { ...current, api_key_set: value !== null } : current));
        }
      })
      .catch((error) => {
        dirtyKey.current = true;
        throw error;
      });
    return keyWrite.current;
  };
  const test = async () => {
    if (busy) return;
    const testedMode = mode;
    setBusy(true);
    await run(async () => {
      if (mode === "api") await saveKey();
      const value = await call("asr_test", { mode });
      if (!disposed.current && modeRef.current === testedMode) setResult(value as TestResult);
    });
    if (!disposed.current) setBusy(false);
  };
  if (status?.supported === false) return <p className="zc-muted">这个版本的 Windows 版不能识别字幕</p>;
  if (!status) return error ? <p role="alert">{error}</p> : null;
  const ready =
    mode === "api"
      ? status.api_key_set || Boolean(key.trim())
      : status.models.some((item) => item.id === model && item.state === "ready");
  return (
    <div className="zc-asr-settings">
      <fieldset className="zc-seg is-block" aria-label="识别方式" disabled={busy}>
        {(
          [
            ["local", "本地模型"],
            ["api", "API 识别"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            className={mode === value ? "is-active" : ""}
            onClick={() =>
              void run(async () => {
                await saveKey();
                await save({ asr: { mode: value } });
                setResult(null);
              })
            }
          >
            {label}
          </button>
        ))}
      </fieldset>
      <p className="zc-meta">
        {mode === "local"
          ? "在这台电脑上识别。声音不会上传，下载好模型后不用联网。"
          : "声音会上传到火山引擎识别，不占这台电脑的内存，按用量计费。"}
      </p>
      {mode === "local" ? (
        <div className="zc-settings-card">
          {status.models.map((item) => {
            const name = item.id === "1.7b" ? "高精度" : "省内存";
            return (
              <div className="zc-asr-model" key={item.id}>
                <button
                  type="button"
                  className="zc-asr-choice"
                  aria-label={`使用${name}`}
                  aria-pressed={model === item.id}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await save({ asr: { model: item.id } });
                      setResult(null);
                    })
                  }
                >
                  <span className="zc-asr-radio" aria-hidden="true" />
                  <span>
                    <strong>{name}</strong>
                    {item.id === status.recommended && <span className="zc-chip is-sm">这台电脑推荐</span>}
                    <span className="zc-meta">
                      {item.id === "1.7b"
                        ? "约 3.8 GB，内存大于 16 GB 的电脑用"
                        : "约 2.3 GB，内存 16 GB 及以下的电脑用"}
                    </span>
                  </span>
                </button>
                {item.state === "downloading" || item.state === "queued" ? (
                  <div className="zc-asr-download">
                    <span>
                      <span className="zc-asr-download-labels">
                        <span>
                          {item.state === "queued"
                            ? "排队中"
                            : `下载中 ${item.bytes_total ? Math.floor((item.bytes_done / item.bytes_total) * 100) : 0}%`}
                        </span>
                        <span className="zc-meta">
                          {(item.bytes_done / 1_000_000_000).toFixed(1)} GB /{" "}
                          {(item.bytes_total / 1_000_000_000).toFixed(1)} GB
                        </span>
                      </span>
                      <progress aria-label={`${name}下载进度`} value={item.bytes_done} max={item.bytes_total || 1} />
                    </span>
                    <button
                      type="button"
                      className="zc-btn"
                      onClick={() =>
                        void run(async () => {
                          await call("asr_model_cancel", { model: item.id });
                          await refresh();
                        })
                      }
                    >
                      取消
                    </button>
                  </div>
                ) : item.state === "ready" ? (
                  <>
                    <span className="zc-meta">已下载</span>
                    <button
                      type="button"
                      className="zc-icon-btn"
                      aria-label={`删除${name}`}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("asr_model_delete", { model: item.id });
                          setResult(null);
                          await refresh();
                        })
                      }
                    >
                      <Icon name="trash" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="zc-btn is-secondary"
                    onClick={() =>
                      void run(async () => {
                        await call("asr_model_download", { model: item.id });
                        await refresh();
                      })
                    }
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
                    </svg>
                    下载
                  </button>
                )}
                {item.error && (
                  <span role="alert" className="zc-meta">
                    {item.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="zc-settings-field">
            <span>服务</span>
            <div className="zc-asr-service">火山引擎 · 豆包语音识别</div>
          </div>
          <div className="zc-settings-field">
            <label htmlFor={keyId}>API Key</label>
            <div className="zc-settings-row">
              <input
                id={keyId}
                className="zc-input"
                type={show ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={status.api_key_set ? "••••••••••••••••" : "粘贴火山引擎的 API Key"}
                value={key}
                disabled={busy}
                onChange={(event) => {
                  dirtyKey.current = true;
                  setKey(event.target.value);
                  setResult(null);
                }}
                onBlur={() =>
                  void run(async () => {
                    await saveKey();
                  })
                }
              />
              <button
                type="button"
                className="zc-icon-btn"
                aria-label={show ? "隐藏 API Key" : "显示 API Key"}
                onClick={() => setShow(!show)}
              >
                <Icon name="eye" />
              </button>
              <a
                className="zc-btn is-secondary"
                href="https://console.volcengine.com/speech/app"
                target="_blank"
                rel="noreferrer"
              >
                去火山引擎获取
              </a>
            </div>
            <span className="zc-meta">只保存在这台电脑上。</span>
          </div>
        </>
      )}
      <div className="zc-settings-card zc-asr-test">
        <div className="zc-settings-row">
          <span className="zc-grow">
            <strong>测试</strong>
            <span className="zc-meta">用一段 5 秒的中文语音试一次。</span>
          </span>
          <button type="button" className="zc-btn" disabled={!ready || busy} onClick={() => void test()}>
            <Icon name="play" />
            {busy ? "测试中…" : result ? "再测一次" : "开始测试"}
          </button>
        </div>
        {result ? (
          <output className="zc-asr-result" aria-live="polite">
            {result.ok ? (
              <>
                <span>
                  <span className="zc-dot is-approved" />
                  通过 · {result.audio_seconds.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒语音，用{" "}
                  {result.used_seconds.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒识别完
                </span>
                <span className="zc-meta">识别结果：{result.text}</span>
              </>
            ) : (
              <>
                <span>没有通过</span>
                <span className="zc-meta">{result.reason}</span>
              </>
            )}
          </output>
        ) : (
          mode === "local" && !ready && <span className="zc-meta">模型下载好后可以测试。</span>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
