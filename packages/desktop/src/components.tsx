import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

import { ICONS } from "./icons.js";

const aliases: Record<string, string> = {
  human: "user",
  marker: "flag",
  snap: "magnet",
  spark: "ai",
  "new-chat": "filePlus",
  audio: "volume",
  image: "media",
  clip: "media",
  subtitle: "subtitles",
  md: "file",
  chevron: "right",
  prev: "left",
  next: "right",
  skip: "fwd",
  ask: "info",
  "align-left": "alignLeft",
  "align-center": "alignCenter",
  "align-right": "alignRight",
  anchor: "target",
};
const textPaths: Record<string, ReactNode> = {
  bold: (
    <>
      <path d="M7 3h6a4.5 4.5 0 0 1 0 9H7zm0 9h6a4.5 4.5 0 0 1 0 9H7z" />
    </>
  ),
  italic: (
    <>
      <path d="M10 3h9M5 21h9M15 3L9 21" />
    </>
  ),
  underline: (
    <>
      <path d="M6 3v9a6 6 0 0 0 12 0V3M4 21h16" />
    </>
  ),
};
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      className="zc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[aliases[name] ?? name] ?? textPaths[name]}
    </svg>
  );
}
export function IconButton({
  icon,
  label,
  pressed,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; pressed?: boolean }) {
  return (
    <button type="button" className="zc-ibtn" title={label} aria-label={label} aria-pressed={pressed} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
export function Clip({
  kind,
  label,
  selected,
  dimmed,
  style,
  children,
  onClick,
  selectionId,
  onDoubleClick,
  onContextMenu,
  cueKey,
}: {
  kind: string;
  label: string;
  selected: boolean;
  dimmed: boolean;
  style: CSSProperties;
  children?: ReactNode;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  selectionId?: string;
  cueKey?: string;
  onDoubleClick?: React.MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      data-selection-id={selectionId}
      data-cue-key={cueKey}
      title={label}
      aria-label={label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={`zc-clip zc-clip-${kind}${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
      style={style}
    >
      {children}
      {kind === "subtitle" ? label : <span className="zc-clip-name">{label}</span>}
    </button>
  );
}
