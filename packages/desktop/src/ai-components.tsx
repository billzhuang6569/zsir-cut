import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { Icon } from "./components.js";
import type { PermissionRequest } from "./connection.js";

export function Button({
  variant = "secondary",
  icon,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "approve" | "text";
  icon?: string;
}) {
  return (
    <button type="button" className={`zc-btn zc-btn-${variant} ${className}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
export function DecisionProgress({ done, total }: { done: number; total: number }) {
  const c = 2 * Math.PI * 6.5;
  return (
    <svg
      className="zc-ring"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      role="img"
      aria-label={`${done} / ${total} 已定`}
    >
      <title>
        {done} / {total} 已定
      </title>
      <circle cx="8" cy="8" r="6.5" className="zc-ring-track" />
      <circle
        cx="8"
        cy="8"
        r="6.5"
        className="zc-ring-done"
        strokeDasharray={`${((c * done) / Math.max(1, total)).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
export interface Decision {
  id: string;
  seq: number;
  question: string;
  tag?: string;
  options: { id: string; label: string; note?: string; recommended?: boolean }[];
  allow_other?: boolean;
  state: "pending" | "answered" | "skipped";
}
export function DecisionCard({
  decision,
  done,
  total,
  last,
  busy,
  answer,
}: {
  decision: Decision;
  done: number;
  total: number;
  last: boolean;
  busy: boolean;
  answer: (input: { option_id: string } | { text: string } | { skip: true }) => void;
}) {
  const [pick, setPick] = useState(-1);
  const [other, setOther] = useState("");
  const ready = pick >= 0 && (pick < decision.options.length || !!other.trim());
  const submit = () => {
    if (!ready || busy) return;
    const option = decision.options[pick];
    answer(option ? { option_id: option.id } : { text: other.trim() });
  };
  return (
    <section
      className="zc-q"
      aria-label={decision.question}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.target instanceof HTMLButtonElement && /^[a-j]$/i.test(event.key)) {
          const index = event.key.toUpperCase().charCodeAt(0) - 65;
          if (index < decision.options.length) setPick(index);
        }
      }}
    >
      <div className="zc-q-head">
        <span className="zc-q-badge">
          <Icon name="ask" />
        </span>
        <span className="zc-q-title">决定</span>
        <span className="zc-grow" />
        <DecisionProgress done={done} total={total} />
      </div>
      <h3 className="zc-q-question">{decision.question}</h3>
      {decision.tag && <p className="zc-q-context">{decision.tag}</p>}
      <div className="zc-q-options" role="radiogroup" aria-label={decision.question}>
        {decision.options.map((option, i) => (
          // biome-ignore lint/a11y/useSemanticElements: Match the design system button radio structure.
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={pick === i}
            className={`zc-q-option${pick === i ? " is-on" : ""}`}
            title={option.note}
            disabled={busy}
            onClick={() => setPick(i)}
          >
            <span className="zc-q-key" aria-hidden="true">
              {"ABCDEFGHIJ"[i]}
            </span>
            <span className="zc-q-label">
              {option.label}
              {option.note && <span className="zc-q-note">{option.note}</span>}
            </span>
            {option.recommended && (
              <span className="zc-q-rec" role="img" aria-label="AI 推荐">
                <Icon name="spark" size={12} />
              </span>
            )}
          </button>
        ))}
        {decision.allow_other !== false && (
          <label className={`zc-q-option zc-q-other${pick === decision.options.length ? " is-on" : ""}`}>
            <span className="zc-q-key">{"ABCDEFGHIJ"[decision.options.length]}</span>
            <input
              className="zc-q-other-input"
              placeholder="其他想法…"
              aria-label="其他想法"
              disabled={busy}
              value={other}
              onFocus={() => setPick(decision.options.length)}
              onChange={(event) => setOther(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  submit();
                }
              }}
            />
          </label>
        )}
      </div>
      <div className="zc-q-foot">
        <button type="button" className="zc-q-skip" disabled={busy} onClick={() => answer({ skip: true })}>
          跳过
        </button>
        <button type="button" className="zc-q-next" disabled={!ready || busy} onClick={submit}>
          {last ? "发给 AI" : "下一件"}
          <span className="zc-q-keys" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </span>
        </button>
      </div>
    </section>
  );
}
export function PermissionCard({
  request,
  answer,
}: {
  request: PermissionRequest;
  answer: (answer: "once" | "project" | "deny", message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = ["once", "project", "deny"] as const;
  const submit = async (value: (typeof choices)[number]) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await answer(value, message.trim());
    } catch {
      setError("答复没有送达，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="alertdialog"
      aria-label={request.title}
      aria-describedby={`${request.id}-detail`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus scopes number shortcuts to the permission card.
      tabIndex={0}
      className="zc-q zc-permission"
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.nativeEvent.isComposing
        )
          return;
        const value = choices[Number(event.key) - 1];
        if (value) {
          event.preventDefault();
          event.stopPropagation();
          void submit(value);
        }
      }}
    >
      <span className="zc-chip is-sm is-attention">Agent 在等你</span>
      <h3 className="zc-q-question">{request.title}</h3>
      <p id={`${request.id}-detail`} className="zc-q-context">
        {request.detail}
      </p>
      {request.target && <p className="zc-q-context">{request.target}</p>}
      <input
        aria-label="给 AI 留言（可选）"
        placeholder="给 AI 留言（可选）"
        value={message}
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
      />
      {choices.map((value, index) => (
        <Button
          key={value}
          variant={index === 0 ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void submit(value)}
        >
          {["允许这一次", "这个工程里都允许", "不允许"][index]}
          <span className="zc-grow" />
          <kbd>{index + 1}</kbd>
        </Button>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

const REVIEW_FIELDS: Record<string, string> = {
  name: "名称",
  text: "文字",
  timeline_start: "位置",
  source_start: "素材入点",
  duration: "时长",
  start: "开始",
  end: "结束",
  at: "位置",
};
export function ReviewValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="zc-review-value">
      <strong>{label}</strong>
      {value === null ? (
        <span>无</span>
      ) : (
        Object.entries(REVIEW_FIELDS).map(([key, title]) => {
          const field = (value as Record<string, unknown>)[key];
          return typeof field === "string" || typeof field === "number" ? (
            <span key={key}>
              {title}：{field}
            </span>
          ) : null;
        })
      )}
    </div>
  );
}

const TOOL_ACTIONS: Record<string, [string, string]> = {
  thinking: ["思考", "spark"],
  reasoning: ["思考", "spark"],
  Read: ["读了", "file"],
  read_file: ["读了", "file"],
  open: ["读了", "file"],
  Grep: ["查找", "search"],
  Glob: ["查找", "search"],
  search: ["查找", "search"],
  view_image: ["看了画面", "image"],
  listen: ["听了声音", "audio"],
  Task: ["派出助手", "bot"],
  spawn_agent: ["派出助手", "bot"],
  wait: ["等待", "history"],
  parallel: ["同时做几件事", "grid"],
  TodoWrite: ["计划", "list"],
  update_plan: ["计划", "list"],
  Bash: ["运行命令", "file"],
  exec_command: ["运行命令", "file"],
  shell_command: ["运行命令", "file"],
  permission_request: ["等待许可", "ask"],
  create_project: ["新建工程", "plus"],
  inspect: ["查看工程", "search"],
  read_transcript: ["读取字幕", "subtitle"],
  validate: ["检查工程", "check"],
  diff: ["比较改动", "replace"],
  import_media: ["导入素材", "clip"],
  edit: ["改了时间线", "blade"],
  edit_text: ["改了字幕", "subtitle"],
  remove_span: ["改了时间线", "blade"],
  place: ["改了时间线", "blade"],
  undo: ["撤销", "undo"],
  redo: ["重做", "redo"],
  restore: ["恢复步骤", "undo"],
  batch_status: ["查看批次", "list"],
  transcribe: ["识别字幕", "subtitle"],
  session_begin: ["开始会话", "new-chat"],
  session_review: ["提交审阅", "send"],
  session_approve: ["批准草稿", "check"],
  session_reject: ["拒绝草稿", "close"],
  session_ask: ["提问", "ask"],
  session_answer: ["回答决定", "ask"],
  render_preview: ["生成预览", "play"],
  view_timeline: ["查看时间线", "clip"],
  export: ["导出", "export"],
  record_handoff_check: ["记录交接检查", "check"],
  job_status: ["查看任务", "list"],
  ui_state: ["查看界面", "grid"],
  ui_show_panel: ["打开面板", "grid"],
  ui_seek: ["跳转位置", "marker"],
  ui_select: ["选中对象", "select"],
  ui_play: ["播放", "play"],
  ui_pause: ["暂停", "stop"],
};
export const toolVerb = (name: string) => name.replace(/^mcp__.+?__/, "").replace(/^zcut_/, "");
export const isReadTool = (name: string) =>
  ["inspect", "read_transcript", "open", "Read", "read_file", "ui_state"].includes(toolVerb(name));
export function StepRow({
  live,
  name,
  failed,
  failureCount = Number(failed),
  count = 1,
  detail,
  stopped = false,
  onReview,
}: {
  stopped?: boolean;
  onReview?: () => void;
  live: boolean;
  name: string;
  failed: boolean;
  failureCount?: number;
  count?: number;
  detail: unknown;
}) {
  const verb = toolVerb(name);
  const [label, icon] = TOOL_ACTIONS[verb] ?? ["工具调用", "spark"];
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={`zc-step${live ? " is-live" : ""}${failed ? " is-failed" : ""}${stopped ? " is-stopped" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={stopped ? "stop" : failed ? "close" : live ? icon : "check"} />
        <span className="zc-grow">
          {stopped ? "已停下" : label}
          {count > 1 && ` ×${count}`}
          {failed && `（失败 ${failureCount} 次）`}
        </span>
        <span className="zc-step-state">
          {stopped
            ? "已停止"
            : live
              ? verb === "permission_request"
                ? "等你许可"
                : "进行中"
              : failed
                ? "失败"
                : "完成"}
        </span>
        <Icon name={expanded ? "down" : "chevron"} size={12} />
      </button>
      {onReview && ["edit", "edit_text", "remove_span", "place"].includes(verb) && (
        <Button variant="text" onClick={onReview}>
          看方案
        </Button>
      )}
      {expanded && (
        <pre className="zc-step-detail">
          {typeof detail === "string"
            ? detail.replace(/\b(?:ses|rev|med|clp|occ|trk|dec|prm|req)_[A-Za-z0-9_-]+\b/g, "…")
            : JSON.stringify(
                detail,
                (key, value) =>
                  key === "id" || key.endsWith("_id") || key === "tool" || key === "project" || key.endsWith("revision")
                    ? undefined
                    : typeof value === "string"
                      ? value.replace(/\b(?:ses|rev|med|clp|occ|trk|dec|prm|req)_[A-Za-z0-9_-]+\b/g, "…")
                      : value,
                2,
              )}
        </pre>
      )}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") ? (
        <strong key={`${i}-${part}`}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") ? (
        <code key={`${i}-${part}`}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
// Only the requested Markdown subset; React escapes all agent-provided HTML.
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const source = line.trim();
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? "";
    if (char === "\\" && (source[i + 1] === "|" || source[i + 1] === "\\")) {
      cell += source[++i];
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  if (source.startsWith("|")) cells.shift();
  if (source.endsWith("|") && cell === "") cells.pop();
  return cells.map((cell) => cell.trim());
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const headers = tableCells(line);
    const separator = tableCells(lines[i + 1] ?? "");
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (++i < lines.length && !(lines[i] ?? "").startsWith("```")) code.push(lines[i] ?? "");
      blocks.push(
        <pre key={i}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (
      line.includes("|") &&
      headers.length > 0 &&
      separator.length === headers.length &&
      separator.every((cell) => /^:?-+:?$/.test(cell))
    ) {
      const rows: ReactNode[] = [];
      i++;
      while (
        i + 1 < lines.length &&
        (lines[i + 1] ?? "").includes("|") &&
        !(lines[i + 1] ?? "").trimStart().startsWith("```")
      ) {
        const cells = tableCells(lines[++i] ?? "");
        rows.push(
          <tr key={i}>
            {headers.map((_, column) => (
              <td key={`${column}-${headers[column]}`}>{inline(cells[column] ?? "")}</td>
            ))}
          </tr>,
        );
      }
      blocks.push(
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
        <section className="zc-markdown-table" key={i} aria-label="表格" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {headers.map((header, column) => (
                  <th key={`${column}-${headers[column]}`}>{inline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </section>,
      );
    } else if (/^#{1,6} /.test(line)) blocks.push(<h3 key={i}>{inline(line.replace(/^#+ /, ""))}</h3>);
    else if (/^(?:[-*] |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: ReactNode[] = [];
      do {
        items.push(<li key={i}>{inline((lines[i] ?? "").replace(/^(?:[-*] |\d+\. )/, ""))}</li>);
        i++;
      } while (i < lines.length && (ordered ? /^\d+\. / : /^[-*] /).test(lines[i] ?? ""));
      i--;
      blocks.push(ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>);
    } else blocks.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="zc-markdown">{blocks}</div>;
}
