import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

const PATHS: Record<string, string> = {
  refresh: "M13 6a5 5 0 1 0 0 5M13 2v4H9",
  select: "M3 2l10 5.5-4.5 1.2L7 13z",
  blade: "M3 13 13 3M10 3h3v3",
  marker: "M4 14V2h8l-2 3 2 3H4",
  undo: "M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8H6",
  redo: "M11 3l3 3-3 3M14 6H7a4 4 0 0 0 0 8h3",
  snap: "M4 2v6a4 4 0 0 0 8 0V2M4 5h2.5M9.5 5H12",
  export: "M8 10V2M5 5l3-3 3 3M3 10v4h10v-4",
  search: "M10.5 10.5 14 14M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z",
  replace: "M2 4h8M7 1.5 10 4 7 6.5M14 12H6M9 9.5 6 12l3 2.5",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5",
  plus: "M8 3v10M3 8h10",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  chevron: "M6 3l5 5-5 5",
  prev: "M11 3 5 8l6 5",
  next: "M5 3l6 5-6 5",
  down: "M4 6l4 4 4-4",
  close: "M4 4l8 8M12 4l-8 8",
  spark: "M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12",
  "new-chat": "M8 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V8M12 2l2 2-5.5 5.5H6.5v-2z",
  copy: "M5 5h8.5v8.5H5zM3 10.5V3.5A1 1 0 0 1 4 2.5h6.5",
  audio: "M2 6h3l4-4v12l-4-4H2zM12 5q4 3 0 6",
  folder: "M2 4h5l2 2h5v7H2z",
  image: "M2 2h12v12H2zM2 11l4-4 3 3 2-2 3 3M10 5h.01",
  clip: "M1.5 4h13v8h-13zM5.5 4v8M10.5 4v8",
  subtitle: "M1.5 3h13v10h-13zM4 8.5h3M8.5 8.5H12M4 10.5h5",
  md: "M1.5 3.5h13v9h-13zM4 10V6l2 2 2-2v4M11 6v4M9.5 8.5 11 10l1.5-1.5",
  play: "M4 2.5v11l9-5.5z",
  stop: "M4 4h8v8H4z",
  check: "M3 8.5l3 3 7-7",
  send: "M2 8l12-5.5L9.5 14 7.5 9z M7.5 9 14 2.5",
  skip: "M3 3l6 5-6 5M12 3v10",
  ask: "M2.5 3h11v7.5h-6L4.5 13v-2.5h-2zM5.5 5.8h5M5.5 8h3",
};
export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg
      className="zc-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name] ?? ""} />
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
}: {
  kind: string;
  label: string;
  selected: boolean;
  dimmed: boolean;
  style: CSSProperties;
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`zc-clip zc-clip-${kind}${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
      style={style}
    >
      {children}
      {kind === "subtitle" ? label : <span className="zc-clip-name">{label}</span>}
    </button>
  );
}
