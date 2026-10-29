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
            <span className="zc-q-label">{option.label}</span>
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
export function StepRow({ live, children, detail }: { live: boolean; children: ReactNode; detail: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={`zc-step${live ? " is-live" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="zc-step-dot" aria-hidden="true" />
        <span className="zc-grow">{children}</span>
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
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (++i < lines.length && !(lines[i] ?? "").startsWith("```")) code.push(lines[i] ?? "");
      blocks.push(
        <pre key={i}>
          <code>{code.join("\n")}</code>
        </pre>,
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
