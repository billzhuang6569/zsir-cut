import type { ProjectView } from "./connection.js";
import type { CueView, StyleView } from "./timeline.js";

export const defaultStyle: StyleView = {
  id: "",
  font_family: "PingFang SC",
  font_weight: 600,
  font_size: 0.045,
  color: "#FFFFFF",
  outline: { color: "#000000", width: 0.06 },
  position: { anchor: "bottom", margin_v: 0.08, max_width: 0.8, offset_x: 0 },
  max_lines: 2,
  line_spacing: 1.2,
};
export function alignment(row: number, column: number, maxWidth: number) {
  return {
    anchor: (["top", "middle", "bottom"] as const)[row] ?? "bottom",
    offset_x: ((column - 1) * (1 - maxWidth)) / 2,
  };
}

// Preserve untouched tokens, including their alignment and approval state.
export function textEdit(cue: CueView, text: string) {
  const tokens = cue.tokens ?? [];
  if (!tokens.length || text === cue.text) return null;
  let prefix = 0;
  while (prefix < cue.text.length && prefix < text.length && cue.text[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < cue.text.length - prefix &&
    suffix < text.length - prefix &&
    cue.text[cue.text.length - 1 - suffix] === text[text.length - 1 - suffix]
  )
    suffix++;
  let cursor = 0;
  const spans = tokens.map((token) => {
    const locate = (value: string) => {
      const at = value ? cue.text.indexOf(value, cursor) : cursor;
      return at >= 0 && /^\s*$/.test(cue.text.slice(cursor, at)) ? at : -1;
    };
    let displayed = token.text;
    let start = locate(displayed);
    if (start < 0) {
      displayed = token.text.replace(/[。！？.!?，、；：,;:]+$/u, "");
      start = locate(displayed);
    }
    if (start < 0) return null;
    const end = start + displayed.length;
    cursor = end;
    return { token, start, end };
  });
  if (spans.some((span) => !span)) return null;
  const visible = spans.filter((span): span is NonNullable<typeof span> => span !== null && span.end > span.start);
  const first = visible.find((span) => span.end > prefix) ?? visible.at(-1);
  const last =
    visible.findLast((span) => span.start < cue.text.length - suffix && span.end >= (first?.end ?? 0)) ?? first;
  if (!first || !last) return null;
  return {
    op: "edit_text",
    transcript_id: cue.transcript_id,
    from_token: first.token.id,
    to_token: last.token.id,
    text:
      first.token.text.slice(0, Math.max(0, prefix - first.start)) +
      text.slice(prefix, text.length - suffix) +
      last.token.text.slice(Math.max(0, cue.text.length - suffix - last.start)),
  };
}

export function subtitleStyleOps(
  project: ProjectView,
  selected: string[],
  patch: Record<string, unknown>,
  selectedOnly: boolean,
) {
  const targets = selectedOnly ? project.cues.filter((cue) => selected.includes(cue.cue_id)) : project.cues;
  const used = new Set(targets.map((cue) => cue.style_id));
  const ops: Record<string, unknown>[] = [];
  for (const style of project.styles) {
    if (selectedOnly && !used.has(style.id)) continue;
    const changed = Object.fromEntries(
      Object.entries(patch)
        .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(style[key as keyof StyleView]))
        .map(([key, value]) => [key, value ?? null]),
    );
    if (!Object.keys(changed).length) continue;
    if (selectedOnly && project.cues.some((cue) => cue.style_id === style.id && !selected.includes(cue.cue_id))) {
      const { id: _id, version: _version, ext: _ext, ...fields } = style as StyleView & { ext?: unknown };
      const id = `sty_${crypto.randomUUID().replaceAll("-", "")}`;
      ops.push({
        op: "add_style",
        ...Object.fromEntries(Object.entries({ ...fields, ...changed }).filter(([, value]) => value != null)),
        name: style.name ?? "字幕样式",
        id,
      });
      for (const cueId of new Set(targets.filter((cue) => cue.style_id === style.id).map((cue) => cue.cue_id)))
        ops.push({ op: "set_cue", cue_id: cueId, style_id: id });
    } else ops.push({ op: "update_style", style_id: style.id, ...changed });
  }
  return ops;
}
