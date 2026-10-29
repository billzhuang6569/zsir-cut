import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { Icon } from "./components.js";

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
const TOOL_ACTIONS: Record<string, [string, string]> = {
  create_project: ["新建工程", "plus"],
  inspect: ["查看工程", "search"],
  read_transcript: ["读取字幕", "subtitle"],
  validate: ["检查工程", "check"],
  diff: ["比较改动", "replace"],
  import_media: ["导入素材", "clip"],
  edit: ["修改", "blade"],
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
export function StepRow({
  live,
  name,
  failed,
  failureCount = Number(failed),
  count = 1,
  detail,
}: {
  live: boolean;
  name: string;
  failed: boolean;
  failureCount?: number;
  count?: number;
  detail: unknown;
}) {
  const [label, icon] = TOOL_ACTIONS[toolVerb(name)] ?? ["工具调用", "spark"];
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={`zc-step${live ? " is-live" : ""}${failed ? " is-failed" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={failed ? "close" : icon} />
        <span className="zc-grow">
          {label}
          {count > 1 && ` ×${count}`}
          {failed && `（失败 ${failureCount} 次）`}
        </span>
        <Icon name="chevron" size={12} />
      </button>
      {expanded && (
        <pre className="zc-step-detail">{typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}</pre>
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
