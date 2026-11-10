import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type Action, actions, presets } from "../../app-host/src/keymap.js";
import type { Preferences } from "../../app-host/src/preferences.js";
import { proxyFormatMessage, validProxy } from "../../app-host/src/proxy.js";
import { AsrSettings } from "./AsrSettings.js";
import { Icon, IconButton } from "./components.js";
import type { HostPush, Subscribe } from "./connection.js";
import { actionLabels, displayKey, recordedKey } from "./settings-keymap.js";
import { SettingsPage as VoiceSettings } from "./VoicePanel.js";
import "./settings.css";

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
export interface PrefsResult {
  prefs: Preferences;
  keymap: Record<Action, string | null>;
  preview_cache_directory: string;
  unbound?: Action[];
}
interface Agent {
  id: "claude" | "codex";
  name: string;
  found: boolean;
  version: string | null;
  path: string | null;
  update_available: boolean;
  default: boolean;
}
interface AgentList {
  agents: Agent[];
  npm: string | null;
}
interface CacheStatus {
  media?: { media_id: string; peaks: string; thumbs: string }[];
  media_bytes?: number;
  directory: string;
  directory_ok: boolean;
  free_bytes: number;
  used_bytes: number;
  limit_bytes: number;
  projects: { project_id: string; name: string; path: string; bytes: number; last_opened: string }[];
}
const pages = [
  ["通用", "settings"],
  ["Agent", "ai"],
  ["字幕识别", "subtitles"],
  ["语音", "voice"],
  ["预览与缓存", "play"],
  ["快捷键", "keyboard"],
  ["关于", "info"],
] as const;
const groups = [
  ["播放与导航", actions.slice(0, 16)],
  ["剪辑", actions.slice(16, 28)],
  ["工具与开关", actions.slice(28)],
] as const;
const bytes = (value: number) => `${(value / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GB`;

export function SettingsPage({
  call,
  subscribe,
  close,
  onPrefs,
  projectPath,
  initialPage = "通用",
}: {
  call: Call;
  subscribe: Subscribe;
  close: () => void;
  onPrefs: (value: PrefsResult) => void;
  openRecognition: () => void;
  projectPath: string | null;
  initialPage?: (typeof pages)[number][0];
}) {
  const proxyId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<string>(initialPage);
  const [prefs, setPrefs] = useState<PrefsResult | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agents, setAgents] = useState<AgentList | null>(null);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [directory, setDirectory] = useState("");
  const [proxy, setProxy] = useState("");
  const [proxyError, setProxyError] = useState("");
  const [testing, setTesting] = useState(false);
  const testingProxy = useRef(false);
  const savingProxy = useRef<string | null>(null);
  const [networkResults, setNetworkResults] = useState<
    { id: "claude" | "codex"; ok: boolean; ms: number; reason: string | null }[] | null
  >(null);
  const cacheDirectory = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [recording, setRecording] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [installing, setInstalling] = useState(false);
  const job = useRef<string | null>(null);
  const outputs = useRef(new Map<string, HostPush[]>());
  const [log, setLog] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [manual, setManual] = useState("");
  const acceptPrefs = useCallback(
    (value: PrefsResult) => {
      setPrefs(value);
      onPrefs(value);
      setMessage(
        value.unbound?.length
          ? `已取消「${value.unbound.map((action) => actionLabels[action]).join("」「")}」的快捷键`
          : "",
      );
    },
    [onPrefs],
  );
  const refreshCache = useCallback(async () => {
    try {
      const value = (await call("preview_cache_status", {})) as CacheStatus;
      setCache(value);
      cacheDirectory.current = value.directory;
      setDirectory(value.directory);
    } catch {
      setCache(null);
    }
  }, [call]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    let disposed = false;
    void call("prefs_get", {})
      .then((value) => {
        if (disposed) return;
        const result = value as PrefsResult;
        acceptPrefs(result);
        setProxy(result.prefs.network.proxy);
        setDirectory(result.preview_cache_directory);
      })
      .catch(() => {
        if (!disposed) setError("暂时无法读取偏好设置");
      });
    void call("agents_list", {})
      .then((value) => {
        if (!disposed) setAgents(value as AgentList);
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) setAgentsLoading(false);
      });
    void refreshCache();
    return () => {
      disposed = true;
    };
  }, [call, acceptPrefs, refreshCache]);
  const showOutput = useCallback((events: HostPush[]) => {
    setLog(events.flatMap((event) => (typeof event.line === "string" ? [event.line] : [])));
    const done = events.find((event) => event.done);
    if (done) {
      setInstalling(false);
      setMessage(done.ok ? "安装完成" : "安装未完成，请查看日志后重试");
    }
  }, []);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "agents_changed") setAgents(event as unknown as AgentList);
        if (event.type === "preview_cache") {
          const status = event as unknown as CacheStatus;
          setCache(status);
          if (cacheDirectory.current !== status.directory) setDirectory(status.directory);
          cacheDirectory.current = status.directory;
        }
        if (event.type === "agents_output" && typeof event.job_id === "string") {
          const events = [...(outputs.current.get(event.job_id) ?? []), event];
          outputs.current.set(event.job_id, events);
          if (event.job_id === job.current) showOutput(events);
        }
      }),
    [subscribe, showOutput],
  );
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch {
      setError("未能完成，请重试");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const save = async (patch: Record<string, unknown>) => {
    acceptPrefs((await call("prefs_set", { patch })) as PrefsResult);
  };
  const checkProxy = () => {
    const valid = validProxy(proxy);
    setProxyError(valid ? "" : proxyFormatMessage);
    return valid;
  };
  const saveProxy = async () => {
    if (!prefs || !checkProxy()) return;
    const value = proxy.trim();
    setProxy(value);
    if ((value === prefs.prefs.network.proxy && savingProxy.current === null) || savingProxy.current === value) return;
    savingProxy.current = value;
    try {
      await save({ network: { proxy: value } });
    } catch {
      setError("未能完成，请重试");
    } finally {
      if (savingProxy.current === value) savingProxy.current = null;
    }
  };
  const testNetwork = async () => {
    if (testingProxy.current || !checkProxy()) return;
    testingProxy.current = true;
    setTesting(true);
    setNetworkResults(null);
    setError("");
    try {
      const result = (await call("network_test", { proxy: proxy.trim() })) as {
        results: NonNullable<typeof networkResults>;
      };
      setNetworkResults(result.results);
    } catch {
      setError("未能完成，请重试");
    } finally {
      testingProxy.current = false;
      setTesting(false);
    }
  };
  const install = (agent: Agent) =>
    run(async () => {
      setLog([]);
      setLogOpen(true);
      setManual("");
      setInstalling(true);
      job.current = null;
      try {
        const result = (await call(agent.found ? "agents_update" : "agents_install", { id: agent.id })) as {
          job_id: string;
        };
        job.current = result.job_id;
        showOutput(outputs.current.get(result.job_id) ?? []);
      } catch (cause) {
        setInstalling(false);
        const instruction = (cause as { manual?: string }).manual;
        if (instruction) setManual(instruction);
        else throw cause;
      }
    });
  const move = () =>
    run(async () => {
      const target = isTauri() ? await open({ directory: true, multiple: false }) : directory.trim();
      if (!target || typeof target !== "string") return;
      await call("preview_cache_move", { directory: target });
      acceptPrefs((await call("prefs_get", {})) as PrefsResult);
      await refreshCache();
    });
  const clear = (project_id?: string) =>
    run(async () => {
      await call("preview_cache_clear", project_id ? { project_id } : {});
      await refreshCache();
    });
  return (
    <dialog
      ref={dialog}
      className="zc-settings zc-dialog"
      data-page={page}
      aria-label="设置"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <nav aria-label="设置分类" className="zc-settings-nav">
        <h2>设置</h2>
        {pages.map(([name, icon]) => (
          <button
            key={name}
            type="button"
            className={`zc-row${page === name ? " is-active" : ""}`}
            aria-current={page === name ? "page" : undefined}
            onClick={() => {
              setPage(name);
              setRecording(null);
              setError("");
              setMessage("");
            }}
          >
            <Icon name={icon} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <section className="zc-settings-content" aria-label={page}>
        <header className="zc-settings-header">
          <h3>{page}</h3>
          <span className="zc-grow" />
          <IconButton icon="close" label="关闭" onClick={close} />
        </header>
        {error && <p role="alert">{error}</p>}
        {message && <output>{message}</output>}
        <div className="zc-settings-body">
          {page === "Agent" && (
            <>
              <div className="zc-settings-row">
                <p className="zc-muted">在这里安装、更新或选择默认 Agent。</p>
                <button
                  className="zc-btn"
                  type="button"
                  disabled={busy || installing}
                  onClick={() =>
                    void run(async () => {
                      setAgents((await call("agents_list", { refresh: true })) as AgentList);
                    })
                  }
                >
                  检查更新
                </button>
              </div>
              {!agents ? (
                <p className="zc-muted">{agentsLoading ? "正在读取 Agent…" : "暂时无法读取 Agent"}</p>
              ) : (
                <>
                  <div className="zc-settings-card">
                    {agents.agents.map((agent) => (
                      <article key={agent.id} className="zc-settings-agent">
                        <span className="zc-settings-agent-icon">
                          <Icon name="ai" size={28} />
                        </span>
                        <div className="zc-grow">
                          <div className="zc-settings-row">
                            <strong>{agent.name}</strong>
                            {agent.default && <span className="zc-chip is-sm">默认</span>}
                            {agent.update_available && <span className="zc-chip is-sm">有新版</span>}
                          </div>
                          <p className="zc-meta">
                            {agent.found
                              ? `已找到${agent.version ? ` · ${agent.version.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? agent.version}` : ""}`
                              : "没有找到"}
                          </p>
                          {agent.path && <p className="zc-meta zc-settings-path zc-selectable">{agent.path}</p>}
                        </div>
                        {agent.found && (
                          <button
                            type="button"
                            className="zc-btn"
                            disabled={busy || agent.default}
                            onClick={() =>
                              void run(async () => {
                                await call("agents_set_default", { id: agent.id });
                                setAgents((await call("agents_list", {})) as AgentList);
                              })
                            }
                          >
                            {agent.default ? "默认 Agent" : "设为默认"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="zc-btn"
                          disabled={busy || installing}
                          aria-label={`${agent.found ? "更新" : "安装"} ${agent.name}`}
                          onClick={() => void install(agent)}
                        >
                          {agent.found ? "更新" : "一键安装"}
                        </button>
                      </article>
                    ))}
                  </div>
                  {!agents.npm && (
                    <p className="zc-muted">
                      请先安装 Node.js（含 npm），然后在终端运行：
                      <br />
                      <code>npm install -g @anthropic-ai/claude-code</code>
                      <br />
                      <code>npm install -g @openai/codex</code>
                    </p>
                  )}
                </>
              )}
              {manual && <output>{manual}</output>}
              {logOpen && (
                <details open className="zc-settings-log">
                  <summary>安装日志{installing ? " · 进行中" : ""}</summary>
                  <pre role="log" aria-label="安装输出">
                    {log.join("\n") || "等待输出…"}
                  </pre>
                </details>
              )}
            </>
          )}
          {page === "快捷键" &&
            (prefs ? (
              <>
                <p className="zc-muted">选择习惯会恢复该套默认按键。点按键可改成自己的键。</p>
                <div className="zc-settings-presets">
                  {(["premiere", "fcp"] as const).map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      className={`zc-settings-card${prefs.prefs.keymap.preset === preset ? " is-active" : ""}`}
                      aria-pressed={prefs.prefs.keymap.preset === preset}
                      disabled={busy}
                      onClick={() =>
                        void run(() => save({ keymap: { preset, overrides: {} }, ui: { magnetic: preset === "fcp" } }))
                      }
                    >
                      <Icon name="keyboard" />
                      <strong>{preset === "premiere" ? "Premiere" : "Final Cut Pro"}</strong>
                      <span className="zc-meta">
                        {prefs.prefs.keymap.preset === preset ? "正在使用" : "使用这套习惯"}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="zc-settings-row">
                  <input
                    className="zc-input"
                    aria-label="搜索快捷键"
                    placeholder="搜索动作或快捷键"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <button
                    type="button"
                    className="zc-btn"
                    disabled={busy}
                    onClick={() => void run(() => save({ keymap: { overrides: {} } }))}
                  >
                    恢复默认
                  </button>
                </div>
                <div className="zc-settings-tables">
                  {groups.map(([title, group]) => {
                    const filtered = group.filter((action) =>
                      `${actionLabels[action]} ${displayKey(prefs.keymap[action])}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    );
                    return (
                      filtered.length > 0 && (
                        <table className="zc-settings-keytable" key={title}>
                          <caption>{title}</caption>
                          <thead>
                            <tr>
                              <th>动作</th>
                              <th>Premiere</th>
                              <th>Final Cut Pro</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((action) => (
                              <tr key={action}>
                                <td>
                                  {actionLabels[action]}
                                  {prefs.keymap[action] !== presets[prefs.prefs.keymap.preset][action] && (
                                    <span className="zc-meta"> · 已修改</span>
                                  )}
                                </td>
                                {(["premiere", "fcp"] as const).map((preset) => (
                                  <td key={preset}>
                                    {preset === prefs.prefs.keymap.preset ? (
                                      <button
                                        className="zc-kbd"
                                        type="button"
                                        disabled={busy}
                                        aria-label={`修改${actionLabels[action]}`}
                                        onClick={() => setRecording(action)}
                                        onBlur={() => setRecording(null)}
                                        onKeyDown={(event) => {
                                          if (recording !== action || event.nativeEvent.isComposing) return;
                                          event.stopPropagation();
                                          if (event.key === "Escape") {
                                            event.preventDefault();
                                            setRecording(null);
                                            return;
                                          }
                                          if (event.key === "Tab") {
                                            setRecording(null);
                                            return;
                                          }
                                          event.preventDefault();
                                          const key = recordedKey(event.nativeEvent);
                                          if (key) {
                                            setRecording(null);
                                            void run(() =>
                                              save({
                                                keymap: {
                                                  overrides: { ...prefs.prefs.keymap.overrides, [action]: key },
                                                },
                                              }),
                                            );
                                          }
                                        }}
                                      >
                                        {recording === action ? "请按键…" : displayKey(prefs.keymap[action])}
                                      </button>
                                    ) : (
                                      <span className="zc-meta">{displayKey(presets[preset][action])}</span>
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )
                    );
                  })}
                </div>
                {!actions.some((action) =>
                  `${actionLabels[action]} ${displayKey(prefs.keymap[action])}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                ) && <p className="zc-muted">没有匹配的快捷键</p>}
              </>
            ) : (
              <p className="zc-muted">暂时无法读取快捷键</p>
            ))}
          {page === "预览与缓存" && (
            <>
              <label className="zc-settings-field">
                缓存放在哪里
                <div className="zc-settings-row">
                  <input
                    className="zc-input"
                    aria-label="缓存位置"
                    value={directory}
                    disabled={busy || !cache}
                    readOnly={isTauri()}
                    onChange={(event) => setDirectory(event.target.value)}
                  />
                  <button
                    type="button"
                    className="zc-btn"
                    disabled={busy || !prefs || !cache}
                    onClick={() => void move()}
                  >
                    换位置…
                  </button>
                  <button
                    type="button"
                    className="zc-btn"
                    disabled={busy || !cache || !isTauri()}
                    onClick={() =>
                      void run(async () => {
                        if (cache) await revealItemInDir(cache.directory);
                      })
                    }
                  >
                    在访达中显示
                  </button>
                </div>
              </label>
              {cache ? (
                <p className="zc-meta">
                  这个磁盘还剩 {bytes(cache.free_bytes)}
                  {!cache.directory_ok && " · 缓存位置暂不可用"}
                </p>
              ) : (
                <p className="zc-muted">缓存暂不可用</p>
              )}
              {prefs && (
                <div className="zc-settings-row">
                  <span className="zc-grow">{cache ? `已用 ${bytes(cache.used_bytes)}，最多用` : "缓存上限"}</span>
                  <label>
                    <span className="zc-sr-only">缓存上限</span>
                    <select
                      className="zc-input"
                      aria-label="缓存上限"
                      disabled={busy || !cache}
                      value={prefs.prefs.preview_cache.limit_gb}
                      onChange={(event) =>
                        void run(async () => {
                          await save({ preview_cache: { limit_gb: Number(event.target.value) } });
                          await refreshCache();
                        })
                      }
                    >
                      {[...new Set([10, 20, 50, 100, 200, 2000, prefs.prefs.preview_cache.limit_gb])]
                        .sort((a, b) => a - b)
                        .map((limit) => (
                          <option key={limit} value={limit}>
                            {limit} GB
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="zc-btn is-danger"
                    disabled={busy || !cache}
                    onClick={() => void clear()}
                  >
                    全部清空
                  </button>
                </div>
              )}
              {cache && (
                <progress
                  className="zc-settings-usage"
                  aria-label="缓存用量"
                  value={cache.used_bytes}
                  max={cache.limit_bytes || 1}
                />
              )}
              {cache && (
                <p className="zc-meta">
                  波形和缩略图：{cache.media?.length ?? 0} 个素材，
                  {cache.media?.filter((item) => item.peaks === "ready" || item.thumbs === "ready").length ?? 0}{" "}
                  个已就绪，占用{" "}
                  {((cache.media_bytes ?? 0) / 1024 ** 2).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB
                </p>
              )}
              {prefs && (
                <fieldset className="zc-settings-options" disabled={busy || !cache}>
                  <div className="zc-settings-row">
                    <span className="zc-grow">预览画质</span>
                    <fieldset className="zc-seg" aria-label="预览画质">
                      {(["540p", "720p", "1080p"] as const).map((quality) => (
                        <button
                          type="button"
                          key={quality}
                          className={prefs.prefs.preview_cache.quality === quality ? "is-active" : ""}
                          aria-pressed={prefs.prefs.preview_cache.quality === quality}
                          onClick={() => void run(() => save({ preview_cache: { quality } }))}
                        >
                          {quality}
                        </button>
                      ))}
                    </fieldset>
                  </div>
                  {(
                    [
                      ["auto", "剪完自动在后台准备"],
                      ["pause_on_battery", "用电池时暂停准备"],
                    ] as const
                  ).map(([key, label]) => (
                    <div className="zc-settings-row" key={key}>
                      <span className="zc-grow">{label}</span>
                      <button
                        type="button"
                        className={`zc-switch${prefs.prefs.preview_cache[key] ? " is-on" : ""}`}
                        role="switch"
                        aria-label={label}
                        aria-checked={prefs.prefs.preview_cache[key]}
                        onClick={() =>
                          void run(() => save({ preview_cache: { [key]: !prefs.prefs.preview_cache[key] } }))
                        }
                      />
                    </div>
                  ))}
                </fieldset>
              )}
              {cache && (
                <table className="zc-settings-projects">
                  <thead>
                    <tr>
                      <th>工程</th>
                      <th>占用</th>
                      <th>状态</th>
                      <th>
                        <span className="zc-sr-only">清理</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cache.projects.map((project) => (
                      <tr key={project.project_id}>
                        <td>{project.name}</td>
                        <td>{bytes(project.bytes)}</td>
                        <td>{project.path === projectPath ? "当前工程" : "已缓存"}</td>
                        <td>
                          <button
                            type="button"
                            className="zc-btn"
                            disabled={busy}
                            aria-label={`清掉${project.name}`}
                            onClick={() => void clear(project.project_id)}
                          >
                            清掉
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          {page === "语音" && <VoiceSettings embedded call={call} close={close} />}
          {page === "字幕识别" && prefs && (
            <AsrSettings call={call} subscribe={subscribe} prefs={prefs.prefs} save={save} />
          )}
          {page === "通用" && (
            <div className="zc-network-settings">
              <div className="zc-network-intro">
                <b>网络代理</b>
                <p className="zc-hint">AI 面板、字幕整理和一键安装 Agent 都通过这个代理联网。留空就直接联网。</p>
              </div>
              <div className="zc-field">
                <label htmlFor={proxyId}>代理地址</label>
                <input
                  id={proxyId}
                  aria-label="代理地址"
                  className="zc-input mono"
                  value={proxy}
                  placeholder="例如 http://127.0.0.1:7890"
                  disabled={!prefs || testing}
                  aria-invalid={!!proxyError}
                  aria-describedby={`${proxyId}-${proxyError ? "error" : "hint"}`}
                  onChange={(event) => {
                    setProxy(event.target.value);
                    setProxyError("");
                    setNetworkResults(null);
                  }}
                  onBlur={() => void saveProxy()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void saveProxy();
                    }
                  }}
                />
                <span id={`${proxyId}-hint`} className="zc-hint">
                  填 http 开头的地址，代理软件里一般叫「HTTP 端口」。
                </span>
                {proxyError && (
                  <span id={`${proxyId}-error`} role="alert" className="zc-network-error">
                    {proxyError}
                  </span>
                )}
              </div>
              <div className="zc-network-test">
                <div className="zc-settings-row">
                  <span className="zc-grow">
                    <b>测试连接</b>
                    <span className="zc-hint">检查能不能连上 Claude Code 和 Codex 的服务。</span>
                  </span>
                  <button
                    type="button"
                    className="zc-btn"
                    disabled={!prefs || testing}
                    onClick={() => void testNetwork()}
                  >
                    <Icon name="play" size={14} />
                    {testing ? "测试中…" : networkResults ? "再测一次" : "测试连接"}
                  </button>
                </div>
                <div aria-live="polite" aria-busy={testing}>
                  {networkResults && (
                    <div className="zc-network-results">
                      {networkResults.map((result) => (
                        <div className="zc-network-result" key={result.id}>
                          <span className={`zc-dot ${result.ok ? "is-approved" : "is-danger"}`} aria-hidden="true" />
                          <span className="zc-network-name">{result.id === "claude" ? "Claude Code" : "Codex"}</span>
                          <span className="zc-network-reason">
                            {result.ok ? `能连上，用了 ${(result.ms / 1000).toFixed(1)} 秒` : result.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="zc-muted">剪辑习惯可在「快捷键」中设置，预览选项可在「预览与缓存」中设置。</p>
            </div>
          )}
          {page === "关于" && (
            <>
              <h2>庄Sir剪辑助手</h2>
              <p className="zc-muted">和 AI 一起剪辑，再交给熟悉的剪辑软件收尾。</p>
            </>
          )}
        </div>
      </section>
    </dialog>
  );
}
