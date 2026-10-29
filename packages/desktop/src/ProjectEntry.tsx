import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ai-components.js";
import { Icon, IconButton } from "./components.js";
import type { ProjectView } from "./connection.js";
import "./entry.css";

interface Recent {
  path: string;
  name: string;
  openedAt: string;
  exists: boolean;
}
const folder = (path: string) => path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
const leaf = (path: string) => path.split("/").at(-1) || "未命名工程";
export function relativeTime(time: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000));
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
}
export function ProjectEntry({
  project,
  call,
  changed,
  error,
  aiBusy = false,
  config,
  connectionEpoch = 0,
}: {
  project: ProjectView | null;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  changed: (media: boolean) => void;
  error: string | null;
  connectionEpoch?: number;
  aiBusy?: boolean;
  config?: { port: number; token: string } | undefined;
}) {
  const modal = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<{ resolve: (value: boolean) => void } | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState<"new" | "open" | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [name, setName] = useState("未命名工程");
  const [path, setPath] = useState("");
  const [match, setMatch] = useState(false);
  const [rate, setRate] = useState("25");
  const [size, setSize] = useState("1920×1080");
  const [language, setLanguage] = useState("zh");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh the list when the bound project changes.
  useEffect(() => {
    void call("recent_projects", {})
      .then((rows) => {
        if (Array.isArray(rows)) setRecent(rows as Recent[]);
      })
      .catch(() => {});
  }, [call, project, connectionEpoch]);
  useEffect(() => {
    if (!form && !confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLElement>("input,button,select")?.focus();
    return () => previous?.focus();
  }, [form, confirmation]);
  const modalKeys = (event: React.KeyboardEvent) => {
    const nodes = Array.from(
      modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea") ?? [],
    );
    if (event.key === "Escape" && !busy) {
      setForm(null);
      setMenu(false);
    }
    if (event.key === "Tab") {
      const target = event.shiftKey ? nodes.at(-1) : nodes[0];
      if (document.activeElement === (event.shiftKey ? nodes[0] : nodes.at(-1))) {
        event.preventDefault();
        target?.focus();
      }
    }
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const confirmSwitch = async () => {
    if (aiBusy && !(await new Promise<boolean>((resolve) => setConfirmation({ resolve }))))
      throw new Error("已取消切换工程");
  };
  const switchTo = async (next: string | null, confirmed = false) => {
    if (!confirmed) await confirmSwitch();
    await call("project_open", { path: next });
    changed(false);
    setMenu(false);
    setForm(null);
  };
  const newForm = useCallback((files: string[] = []) => {
    const directory = files[0] ? folder(files[0]) : "";
    const title = directory ? leaf(directory) : "未命名工程";
    setPaths(files);
    setName(title);
    setPath(directory ? `${directory}/${title}.zcut.json` : "");
    setMatch(files.some((file) => /\.(mp4|mov|mkv|mxf|avi|webm|m4v)$/i.test(file)));
    setForm("new");
    setMenu(false);
    setFailure(null);
  }, []);
  useEffect(() => {
    if (project || !isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") newForm(event.payload.paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => setFailure("无法接收拖入的文件"));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [project, newForm]);
  const chooseOpen = () =>
    run(async () => {
      if (!isTauri()) {
        setForm("open");
        setPath("");
        setMenu(false);
        return;
      }
      const selected = await open({ multiple: false, filters: [{ name: "剪辑工程", extensions: ["zcut.json"] }] });
      if (typeof selected === "string") await switchTo(selected);
    });
  const actions = (
    <div className="zc-entry-actions">
      <Button icon="plus" onClick={() => newForm()} disabled={busy}>
        新建工程
      </Button>
      <Button icon="folder" onClick={() => void chooseOpen()} disabled={busy}>
        打开工程
      </Button>
    </div>
  );
  const rows = (
    <ul className="zc-entry-recents">
      {recent.map((row) => (
        <li key={row.path} className={row.exists ? "" : "is-missing"}>
          <Button disabled={!row.exists || busy} onClick={() => void run(() => switchTo(row.path))}>
            <Icon name="clip" />
            {row.exists && config ? (
              <img
                className="zc-entry-cover"
                alt=""
                src={`http://127.0.0.1:${config.port}/recent-thumb?token=${encodeURIComponent(config.token)}&path=${encodeURIComponent(row.path)}`}
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <Icon name="clip" />
            )}
            <span>
              {row.name}
              <small>
                {leaf(folder(row.path))} · {row.exists ? relativeTime(row.openedAt) : "文件已不存在"}
              </small>
            </span>
          </Button>
          <IconButton
            icon="trash"
            label={`移除${row.name}`}
            disabled={busy}
            onClick={() =>
              void run(async () => setRecent((await call("recent_remove", { path: row.path })) as Recent[]))
            }
          />
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <Button onClick={() => setMenu(!menu)} aria-expanded={menu}>
        {project?.name ?? "未打开工程"}
        <Icon name="down" />
      </Button>
      {menu && (
        <section className="zc-entry-menu zc-pad" aria-label="工程菜单">
          {actions}
          {rows}
          <Button disabled={busy} onClick={() => void run(() => switchTo(null))}>
            回到开始页
          </Button>
          <Button onClick={() => setMenu(false)}>关闭</Button>
        </section>
      )}
      {!project && (
        <section
          className="zc-start zc-pad"
          aria-label="开始页"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files)
              .map((file) => (file as File & { path?: string }).path)
              .filter((path): path is string => Boolean(path));
            const text = event.dataTransfer.getData("text/plain");
            if (files.length || text) newForm(files.length ? files : text.split("\n").filter(Boolean));
            else setFailure("浏览器无法读取本机路径，请输入素材路径");
          }}
        >
          <h1>庄Sir剪辑助手</h1>
          {actions}
          <p>拖入视频或音频，新建工程并导入素材</p>
          {!isTauri() && (
            <label>
              素材路径
              <textarea
                className="zc-input"
                aria-label="素材路径"
                placeholder="每行一个本机绝对路径"
                onChange={(event) => setPaths(event.target.value.split("\n").filter(Boolean))}
              />
              <Button disabled={!paths.length} onClick={() => newForm(paths)}>
                从素材新建
              </Button>
            </label>
          )}
          <h2>最近工程</h2>
          {rows}
          {(failure || error) && <p role="alert">{failure || error}</p>}
        </section>
      )}
      {project && failure && (
        <div className="zc-entry-menu zc-pad" role="alert">
          {failure}
          <Button onClick={() => setFailure(null)}>关闭</Button>
        </div>
      )}
      {confirmation && (
        <div className="zc-export-backdrop zc-entry-backdrop" ref={modal}>
          <section
            className="zc-entry-form zc-pad"
            onKeyDown={modalKeys}
            role="alertdialog"
            aria-modal="true"
            aria-label="停止 AI 并切换工程"
          >
            <p>AI 正在回复，切换工程会停止当前对话。</p>
            <Button
              onClick={() => {
                confirmation.resolve(true);
                setConfirmation(null);
              }}
            >
              停止并切换
            </Button>
            <Button
              onClick={() => {
                confirmation.resolve(false);
                setConfirmation(null);
              }}
            >
              取消
            </Button>
          </section>
        </div>
      )}
      {form && !confirmation && (
        <div className="zc-export-backdrop zc-entry-backdrop" ref={modal}>
          <form
            className="zc-entry-form zc-pad"
            onKeyDown={modalKeys}
            role="dialog"
            aria-modal="true"
            aria-label={form === "new" ? "新建工程" : "打开工程"}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (form === "open") {
                  await switchTo(path);
                  return;
                }
                await confirmSwitch();
                const [width, height] = size.split("×").map(Number);
                const video = paths.find((file) => /\.(mp4|mov|mkv|mxf|avi|webm|m4v)$/i.test(file));
                await call("create_project", {
                  project: path,
                  name,
                  timeline: match && video ? {} : { edit_rate: rate, width, height },
                  ...(match && video ? { match_media: video } : {}),
                  ...(language ? { subtitles: { language } } : {}),
                  author: { kind: "human" },
                  idempotency_key: crypto.randomUUID(),
                });
                await switchTo(path, true);
                if (paths.length) {
                  const brief = (await call("inspect", { project: path, view: "brief" })) as {
                    project: { revision: { id: string } };
                  };
                  await call("import_media", {
                    project: path,
                    paths,
                    base_revision: brief.project.revision.id,
                    author: { kind: "human" },
                    idempotency_key: crypto.randomUUID(),
                    label: `导入 ${paths.length} 个素材`,
                  });
                  changed(true);
                }
              });
            }}
          >
            <h2>{form === "new" ? "新建工程" : "打开工程"}</h2>
            {form === "new" && (
              <label>
                名称
                <input
                  className="zc-input"
                  required
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (path) setPath(`${folder(path)}/${event.target.value}.zcut.json`);
                  }}
                />
              </label>
            )}
            <label>
              {form === "new" ? "保存位置" : "工程路径"}
              <input className="zc-input" required value={path} onChange={(event) => setPath(event.target.value)} />
            </label>
            {form === "new" && (
              <>
                {isTauri() && (
                  <Button
                    onClick={() =>
                      void run(async () => {
                        const selected = await save({
                          defaultPath: path || `${name}.zcut.json`,
                          filters: [{ name: "剪辑工程", extensions: ["zcut.json"] }],
                        });
                        if (selected) setPath(selected);
                      })
                    }
                  >
                    选择保存位置
                  </Button>
                )}
                <label>
                  画面设置
                  <select
                    className="zc-input"
                    value={match ? "match" : "manual"}
                    onChange={(event) => setMatch(event.target.value === "match")}
                  >
                    <option
                      value="match"
                      disabled={!paths.some((file) => /\.(mp4|mov|mkv|mxf|avi|webm|m4v)$/i.test(file))}
                    >
                      跟随第一个素材
                    </option>
                    <option value="manual">手动设置</option>
                  </select>
                </label>
                {!match && (
                  <>
                    <label>
                      帧率
                      <select className="zc-input" value={rate} onChange={(event) => setRate(event.target.value)}>
                        {["24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"].map(
                          (value, index) => (
                            <option key={value} value={value}>
                              {["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"][index]} 帧/秒
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      画面尺寸
                      <select className="zc-input" value={size} onChange={(event) => setSize(event.target.value)}>
                        {["1920×1080", "3840×2160", "1280×720", "1080×1920", "1080×1080"].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  字幕语言
                  <select className="zc-input" value={language} onChange={(event) => setLanguage(event.target.value)}>
                    <option value="zh">中文</option>
                    <option value="en">英文</option>
                    <option value="">不建字幕轨</option>
                  </select>
                </label>
              </>
            )}
            {failure && <p role="alert">{failure}</p>}
            <div className="zc-entry-actions">
              <Button type="submit" disabled={busy || !path.endsWith(".zcut.json")}>
                确定
              </Button>
              <Button disabled={busy} onClick={() => setForm(null)}>
                取消
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
