import { transcriptIds } from "../../core/src/project/transcript-id.ts";
import type { ProjectView } from "./connection.js";
import type { CueView, StyleView, TranscriptView } from "./timeline.js";

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

export type SubtitleOp = Record<string, unknown> & { op: string };
export const cueKey = (cue: CueView) => `${cue.track_id}:${cue.cue_id}:${cue.piece}:${cue.start}`;
export const cueLocked = (cue: CueView) => cue.locked || cue.tokens?.some((token) => token.state === "approved");

// Offsets are DOM UTF-16 offsets; split_token converts them to Unicode code points.
export function tokenSpans(cue: CueView) {
  let cursor = 0;
  return (cue.tokens ?? []).map((token) => {
    let text = token.text;
    let start = text ? cue.text.indexOf(text, cursor) : cursor;
    if (start < 0 || !/^\s*$/.test(cue.text.slice(cursor, start))) {
      text = text.replace(/[。！？.!?，、；：,;:]+$/u, "");
      start = text ? cue.text.indexOf(text, cursor) : cursor;
    }
    if (start < 0 || !/^\s*$/.test(cue.text.slice(cursor, start))) throw new Error("字幕内容已变化，请刷新工程后重试");
    cursor = start + text.length;
    return { token, start, end: cursor, text };
  });
}

function charChanges(before: string, after: string) {
  const a = Array.from(before),
    b = Array.from(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++;
  const left = a.slice(prefix, a.length - suffix),
    right = b.slice(prefix, b.length - suffix);
  const cost = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length; i >= 0; i--)
    for (let j = right.length; j >= 0; j--) {
      const row = cost[i];
      if (!row) continue;
      row[j] =
        i === left.length
          ? right.length - j
          : j === right.length
            ? left.length - i
            : left[i] === right[j]
              ? (cost[i + 1]?.[j + 1] ?? 0)
              : 1 + Math.min(cost[i + 1]?.[j] ?? 0, row[j + 1] ?? 0, cost[i + 1]?.[j + 1] ?? 0);
    }
  const result: { start: number; end: number; text: string }[] = [];
  let i = 0,
    j = 0,
    offset = a.slice(0, prefix).join("").length;
  let change: (typeof result)[number] | undefined;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      if (change) result.push(change);
      change = undefined;
      offset += left[i]?.length ?? 0;
      i++;
      j++;
      continue;
    }
    change ??= { start: offset, end: offset, text: "" };
    const current = cost[i]?.[j] ?? 0;
    if (i < left.length && j < right.length && current === 1 + (cost[i + 1]?.[j + 1] ?? 0)) {
      offset += left[i]?.length ?? 0;
      change.end = offset;
      change.text += right[j];
      i++;
      j++;
    } else if (i < left.length && current === 1 + (cost[i + 1]?.[j] ?? 0)) {
      offset += left[i]?.length ?? 0;
      change.end = offset;
      i++;
    } else {
      change.text += right[j];
      j++;
    }
  }
  if (change) result.push(change);
  return result;
}

export function textEdits(cue: CueView, text: string): SubtitleOp[] {
  if (text === cue.text) return [];
  const spans = tokenSpans(cue);
  const visible = spans.filter((span) => span.end > span.start);
  const groups: {
    first: (typeof visible)[number];
    last: (typeof visible)[number];
    changes: ReturnType<typeof charChanges>;
  }[] = [];
  for (const change of charChanges(cue.text, text)) {
    let first = visible.find((span) => span.end > change.start) ?? visible.at(-1);
    if (first && change.start < first.start) first = visible[visible.indexOf(first) - 1] ?? first;
    let last = visible.findLast((span) => span.start < change.end && span.end >= (first?.end ?? 0)) ?? first;
    if (last && change.end > last.end) last = visible[visible.indexOf(last) + 1] ?? last;
    if (!first || !last) throw new Error("找不到字幕字词");
    const previous = groups.at(-1);
    if (previous && previous.last.end >= first.end) {
      previous.last = last;
      previous.changes.push(change);
    } else groups.push({ first, last, changes: [change] });
  }
  return groups.map(({ first, last, changes }) => {
    if (spans.some((span) => !span.token.text && span.start > first.start && span.end < last.end))
      throw new Error("修改跨过隐藏字词，请分开修改");
    let replacement = cue.text.slice(first.start, last.end);
    for (const change of [...changes].reverse())
      replacement =
        replacement.slice(0, change.start - first.start) + change.text + replacement.slice(change.end - first.start);
    return {
      op: "edit_text",
      transcript_id: cue.transcript_id,
      from_token: first.token.id,
      to_token: last.token.id,
      text: replacement + last.token.text.slice(last.text.length),
    };
  });
}

const textPieces = (text: string) =>
  text === ""
    ? [""]
    : text.includes(" ")
      ? text.trim().split(/\s+/u)
      : (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9]+|[^\s]/gu) ??
        []);

export function cueEdit(cue: CueView, draft: string, splitAt?: number, transcripts: TranscriptView[] = []) {
  const flat = draft.replaceAll("\n", "");
  const base = { ...cue, text: cue.text.replaceAll("\n", "") };
  const ops = textEdits(base, flat);
  if (splitAt === undefined && !draft.includes("\n") && !cue.text.includes("\n")) return { ops, newCue: undefined };
  const copies = transcripts.map((item) => ({ ...item }));
  const transcript = copies.find((item) => item.id === cue.transcript_id);
  if (!transcript) throw new Error("找不到字幕母稿，请刷新工程后重试");
  const tokenId = transcriptIds({ transcripts: copies }, transcript, "tok_");
  const tokens = [...(cue.tokens ?? [])];
  for (const op of ops) {
    const first = tokens.findIndex((token) => token.id === op.from_token);
    const last = tokens.findIndex((token) => token.id === op.to_token);
    const next = textPieces(op.text as string).map((text) => ({ id: tokenId(), text }));
    op.new_ids = next.map((token) => token.id);
    tokens.splice(first, last - first + 1, ...next);
  }
  const boundary = (offset: number) => {
    const spans = tokenSpans({ ...cue, text: flat, tokens });
    const inside = spans.find((span) => span.start < offset && offset < span.end);
    if (inside) {
      const token = inside.token;
      const at = Array.from(inside.text.slice(0, offset - inside.start)).length;
      const id = tokenId();
      ops.push({ op: "split_token", transcript_id: cue.transcript_id, token_id: token.id, at, new_id: id });
      const chars = Array.from(token.text);
      tokens.splice(
        tokens.indexOf(token),
        1,
        { ...token, text: chars.slice(0, at).join("") },
        { ...token, id, text: chars.slice(at).join("") },
      );
      return token.id;
    }
    return spans.findLast((span) => span.token.text && span.end <= offset)?.token.id;
  };
  const shown = new Set(cue.tokens?.map((token) => token.id));
  const breaks: string[] = (cue.breaks ?? []).filter((id) => !shown.has(id));
  let offset = 0;
  for (const char of draft) {
    if (char === "\n") {
      const id = boundary(offset);
      if (id && offset > 0 && offset < flat.length && !breaks.includes(id)) breaks.push(id);
    } else offset += char.length;
  }
  if (draft.includes("\n") || cue.text.includes("\n")) ops.push({ op: "set_cue", cue_id: cue.cue_id, breaks });
  let newCue: string | undefined;
  if (splitAt !== undefined) {
    const at = draft.slice(0, splitAt).replaceAll("\n", "").length;
    const after = boundary(at);
    if (after && at > 0 && at < flat.length) {
      newCue = transcriptIds({ transcripts: copies }, transcript, "cue_")();
      ops.push({ op: "split_cue", cue_id: cue.cue_id, after_token: after });
    }
  }
  for (const [index, op] of ops.entries()) {
    const references = ops
      .slice(index + 1)
      .flatMap((later) => [
        later.from_token,
        later.to_token,
        later.token_id,
        later.after_token,
        ...((later.breaks as string[] | undefined) ?? []),
      ]);
    if (op.new_ids && !(op.new_ids as string[]).some((id) => references.includes(id))) delete op.new_ids;
    if (op.new_id && !references.includes(op.new_id)) delete op.new_id;
  }
  return { ops, newCue };
}

export function canMerge(rows: CueView[]) {
  return (
    rows.length > 1 &&
    rows.every(
      (cue, index) =>
        !cueLocked(cue) &&
        cue.transcript_id &&
        !cue.text_override &&
        (index === 0 ||
          (cue.transcript_id === rows[index - 1]?.transcript_id &&
            (rows[index - 1]?.next_cue_id === undefined || rows[index - 1]?.next_cue_id === cue.cue_id))),
    )
  );
}

export function editorText(node: HTMLElement): string {
  const read = (child: Node): string => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
    if (child.nodeName === "BR") return "\n";
    const text = [...child.childNodes].map(read).join("");
    return (child.nodeName === "DIV" || child.nodeName === "P") && child.nextSibling ? `${text}\n` : text;
  };
  return [...node.childNodes].map(read).join("").replaceAll("\u00a0", " ");
}
export function caretOffset(node: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !node.contains(selection.anchorNode)) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(node);
  range.setEnd(selection.anchorNode as Node, selection.anchorOffset);
  const fragment = document.createElement("div");
  fragment.append(range.cloneContents());
  return editorText(fragment).length;
}
export function placeCaret(node: HTMLElement, offset: number) {
  node.focus();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (text && offset > (text.textContent?.length ?? 0)) {
    offset -= text.textContent?.length ?? 0;
    text = walker.nextNode();
  }
  const range = document.createRange();
  if (text) range.setStart(text, Math.min(offset, text.textContent?.length ?? 0));
  else {
    range.selectNodeContents(node);
    range.collapse(false);
  }
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

export function caretLine(node: HTMLElement, text: string, offset: number) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const fallback = {
    first: !text.slice(0, offset).includes("\n"),
    last: !text.slice(offset).includes("\n"),
    column: Array.from(text.slice(lineStart, offset)).length,
  };
  const selection = window.getSelection();
  const rect = selection?.rangeCount ? selection.getRangeAt(0).getClientRects?.()[0] : undefined;
  if (!rect?.height) return fallback;
  const bounds = node.getBoundingClientRect(),
    css = getComputedStyle(node);
  const lineHeight = Number(css.lineHeight.replace("px", "")) || rect.height;
  let column = 0,
    position = 0;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let child = walker.nextNode();
  while (child && position < offset) {
    const chars = Array.from(child.textContent ?? "");
    let local = 0;
    for (const char of chars) {
      if (position >= offset) break;
      const range = document.createRange();
      range.setStart(child, local);
      range.setEnd(child, local + char.length);
      const box = range.getClientRects()[0];
      if (box && Math.abs(box.top - rect.top) < lineHeight / 2) column++;
      position += char.length;
      local += char.length;
    }
    child = walker.nextNode();
  }
  return {
    first: rect.top < bounds.top + Number(css.paddingTop.replace("px", "")) + lineHeight / 2,
    last: rect.bottom > bounds.bottom - Number(css.paddingBottom.replace("px", "")) - lineHeight / 2,
    column,
  };
}
