import type { ReactNode } from "react";
import type { EntityChange } from "../../core/dist/project/entities.js";
import type { Decision } from "./ai-components.js";
import { Icon } from "./components.js";
import type { HistoryEntry } from "./HistoryPanel.js";

export interface HistoryDecision extends Decision {
  answer?: { option_id?: string; text?: string };
}
const entities: Record<string, string> = {
  project: "工程",
  timeline: "时间线",
  media: "素材",
  track: "轨道",
  clip: "片段",
  transition: "转场",
  marker: "标记",
  transcript: "母稿",
  token: "字词",
  cue: "字幕",
  override: "字幕",
  free_cue: "字幕",
  style: "字幕样式",
  run: "识别",
};
const fields: Record<string, string> = {
  name: "名称",
  label: "说明",
  text: "文字",
  timeline_start: "位置",
  source_start: "素材入点",
  start: "开始",
  end: "结束",
  at: "位置",
  duration: "时长",
  gain_db: "音量",
  enabled: "启用",
  hidden: "隐藏",
  font: "字体",
  font_family: "字体",
  font_weight: "字重",
  italic: "斜体",
  underline: "下划线",
  align: "对齐",
  margin_v: "边距",
  offset_x: "横向偏移",
  max_width: "最大宽度",
  padding: "内边距",
  radius: "圆角",
  blur: "模糊",
  distance: "距离",
  angle: "角度",
  thickness: "粗细",
  line_spacing: "行距",
  letter_spacing: "字距",
  max_lines: "最多行数",
  time_map: "速度",
  source_channels: "声道",
  crop: "裁切",
  top: "顶部",
  bottom: "底部",
  left: "左侧",
  right: "右侧",
  anchor: "对齐位置",
  shadow: "阴影",
  glow: "发光",
  highlight: "高亮",
  font_size: "字号",
  size: "大小",
  color: "颜色",
  opacity: "透明度",
  width: "宽度",
  height: "高度",
  x: "横向位置",
  y: "纵向位置",
  scale: "缩放",
  rotation: "旋转",
  outline: "描边",
  box: "底色",
  position: "位置",
  transform: "变换",
  alignment: "对齐",
};
function value(input: unknown): string {
  if (input === null || input === undefined) return "无";
  if (typeof input === "boolean") return input ? "开" : "关";
  if (typeof input === "string")
    return (
      (
        {
          left: "左",
          center: "中",
          right: "右",
          top: "上",
          bottom: "下",
          middle: "中",
          cross_dissolve: "叠化",
        } as Record<string, string>
      )[input] ?? input
    );
  if (typeof input === "number") return String(input);
  if (Array.isArray(input)) return input.map(value).join("、");
  return "已调整";
}
const title = (change: EntityChange) => {
  const item = change.after ?? change.before;
  return String(item?.label ?? item?.name ?? item?.text ?? entities[change.entity] ?? "对象");
};
function Section({ kind, label, icon, rows }: { kind: string; label: string; icon: string; rows: ReactNode[] }) {
  if (!rows.length) return null;
  return (
    <section className="zc-history-report-section" data-change-type={kind}>
      <h3>
        <Icon name={icon} />
        {label}
        <small>{rows.length} 处</small>
      </h3>
      {rows.slice(0, 5)}
      {rows.length > 5 && (
        <details>
          <summary>还有 {rows.length - 5} 处</summary>
          {rows.slice(5)}
        </details>
      )}
    </section>
  );
}
function propertyRows(change: EntityChange, before = change.before, after = change.after, prefix = ""): ReactNode[] {
  return Object.entries(fields).flatMap(([field, label]) => {
    if (change.entity === "clip" && !prefix && ["timeline_start", "source_start", "duration"].includes(field))
      return [];
    if (field === "text" && ["token", "cue", "override", "free_cue"].includes(change.entity)) return [];
    const old = before?.[field];
    const next = after?.[field];
    if (JSON.stringify(old) === JSON.stringify(next)) return [];
    if (next && typeof next === "object" && !Array.isArray(next))
      return propertyRows(
        change,
        old as Record<string, unknown> | null,
        next as Record<string, unknown>,
        `${prefix}${label} · `,
      );
    return [
      <div className="zc-history-report-row" key={`${change.key}-${prefix}${field}`}>
        <span>
          {title(change)} · {prefix}
          {label}
        </span>
        <span>
          {value(old)} → {value(next)}
        </span>
      </div>,
    ];
  });
}
export function HistoryReport({ entry, decisions }: { entry: HistoryEntry | undefined; decisions: HistoryDecision[] }) {
  const rows: Record<string, ReactNode[]> = { edit: [], text: [], prop: [], items: [], files: [], ask: [] };
  for (const change of entry?.changes ?? []) {
    if (change.entity === "clip") {
      const timingChanged = ["timeline_start", "source_start", "duration", "time_map"].some(
        (key) => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key]),
      );
      if (!change.before || !change.after || timingChanged)
        rows.edit?.push(
          <div className="zc-history-report-row" key={change.key}>
            <span className="zc-chip is-sm">
              {!change.before
                ? "插入"
                : !change.after
                  ? "删除"
                  : change.before.timeline_start !== change.after.timeline_start
                    ? "移动"
                    : "修剪"}
            </span>
            <span>{title(change)}</span>
          </div>,
        );
      if (change.before && change.after) rows.prop?.push(...propertyRows(change));
    } else if (!change.before || !change.after) {
      rows.items?.push(
        <div className="zc-history-report-row" key={change.key}>
          <span className={`zc-chip is-sm ${change.after ? "is-approved" : "is-danger"}`}>
            {change.after ? "+" : "−"}
          </span>
          <span>
            {entities[change.entity]}「{title(change)}」
          </span>
        </div>,
      );
    } else if (
      ["token", "cue", "override", "free_cue"].includes(change.entity) &&
      change.before.text !== change.after.text
    ) {
      rows.text?.push(
        <div className="zc-history-report-row" key={change.key}>
          <del>{value(change.before.text)}</del>
          <span>→</span>
          <span>{value(change.after.text)}</span>
        </div>,
      );
      rows.prop?.push(...propertyRows(change));
    } else rows.prop?.push(...propertyRows(change));
    if (change.entity === "project") {
      const before = (change.before?.subtitle_overlays ?? []) as { id: string; last_export: unknown }[];
      const overlays = (change.after?.subtitle_overlays ?? []) as {
        id: string;
        name: string;
        output_path: string;
        last_export: unknown;
      }[];
      for (const overlay of overlays) {
        if (
          !overlay.last_export ||
          JSON.stringify(before.find((item) => item.id === overlay.id)?.last_export) ===
            JSON.stringify(overlay.last_export)
        )
          continue;
        rows.files?.push(
          <div className="zc-history-report-row" key={overlay.id}>
            <Icon name="file" />
            <span>
              {overlay.name}
              <small>{overlay.output_path}</small>
            </span>
          </div>,
        );
      }
    }
  }
  rows.ask = decisions
    .filter((item) => item.state === "pending")
    .map((item) => (
      <div className="zc-history-report-row is-attention" key={item.id}>
        <Icon name="ask" />
        {item.question}
      </div>
    ));
  return (
    <>
      <div className="zc-panel-head">
        <h2>这一步改了什么</h2>
      </div>
      {entry && (
        <div className="zc-history-report-heading">
          <strong>{entry.label ?? "工程修改"}</strong>
          <small>
            {entry.author?.name}
            <time dateTime={entry.at}>{new Date(entry.at).toLocaleString("zh-CN")}</time>
          </small>
          {entry.reason && <p>{entry.reason}</p>}
        </div>
      )}
      <Section kind="ask" label="需要你决定" icon="ask" rows={rows.ask ?? []} />
      <Section kind="edit" label="剪辑" icon="blade" rows={rows.edit ?? []} />
      <Section kind="text" label="改字" icon="subtitle" rows={rows.text ?? []} />
      <Section kind="prop" label="属性" icon="settings" rows={rows.prop ?? []} />
      <Section kind="items" label="增删" icon="list" rows={rows.items ?? []} />
      <Section kind="files" label="生成的文件" icon="file" rows={rows.files ?? []} />
    </>
  );
}
export function HistoryDecisions({ decisions }: { decisions: HistoryDecision[] }) {
  return (
    <>
      <h2>决定</h2>
      {decisions.map((decision) => (
        <section className="zc-q" key={decision.id}>
          <div className="zc-q-head">
            <span className="zc-q-title">
              {decision.state === "pending" ? "待定" : decision.state === "skipped" ? "已跳过" : "已定"}
            </span>
          </div>
          <h3 className="zc-q-question">{decision.question}</h3>
          <div className="zc-q-options">
            {decision.options.map((option) => (
              <div className={`zc-q-option${decision.answer?.option_id === option.id ? " is-on" : ""}`} key={option.id}>
                <span className="zc-q-label">
                  {option.label}
                  {option.note && <small className="zc-q-note">{option.note}</small>}
                </span>
              </div>
            ))}
          </div>
          {decision.answer?.text && <p>{decision.answer.text}</p>}
        </section>
      ))}
    </>
  );
}
