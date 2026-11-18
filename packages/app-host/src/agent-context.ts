import { win32 } from "node:path";
import type { Project, Rational } from "../../core/dist/index.js";
import type { UiState } from "./ui.js";

const {
  add,
  floor,
  frameToTimecode,
  mul,
  parseRational,
  printRational,
  projectSubtitles,
  timelineEnd,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

const panels = { ai: "AI", media: "素材", chapters: "章节", subtitles: "字幕", voice: "语音" };
const subpanels: Record<string, string> = {
  outline: "大纲",
  timeline: "时间轴",
  subtitles: "字幕",
  style: "样式",
  clone: "克隆",
  generate: "生成",
  results: "结果",
};
const oneLine = (text: string) =>
  text
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞");
const excerpt = (text: string) => Array.from(oneLine(text)).slice(0, 20).join("");
const field = (text: string, limit: number) => {
  const line = oneLine(text);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

export function agentContext(project: Project, state: UiState | null, pending: number): string {
  const timeline = project.timelines[0];
  const lines = ["<界面>"];
  const revision = `工程：${field(project.name, 400)}，修订 ${field(project.revision.id, 200)}（第 ${project.revision.seq} 步）`;
  const footer = `待你决定：${pending} 条\n</界面>`;
  const sub =
    state?.sub ??
    (state?.panel === "chapters"
      ? (state.chapters?.view ?? "outline")
      : state?.panel === "subtitles"
        ? "subtitles"
        : null);
  const subLabel = sub && field(Object.hasOwn(subpanels, sub) ? (subpanels[sub] ?? sub) : sub, 80);
  const panel = state ? `正在看：${panels[state.panel]}${subLabel ? `，${subLabel}` : ""}` : "界面没有打开";
  if (!timeline)
    return [
      ...lines,
      `${revision}，时间线 无，总长 无`,
      ...(state ? ["播放头：无", "入出点：无", "选中：无"] : []),
      panel,
      footer,
    ].join("\n");

  const rate = printRational(timeline.edit_rate);
  const timecode = (value: Rational, start?: string) =>
    frameToTimecode(floor(mul(value, timeline.edit_rate)), rate, timeline.drop_frame, start);
  const end = timelineEnd(timeline);
  lines.push(`${revision}，时间线 ${field(timeline.id, 200)}，总长 ${timecode(end)}`);
  if (!state) return [...lines, panel, footer].join("\n");

  const tc = (value: Rational) => timecode(value, timeline.start_timecode);
  const at = (value: string) => tc(parseRational(value, true));
  const marks = state.timelineMarks;
  const selected = state.selected;
  const clips = timeline.tracks.flatMap((track) =>
    track.kind === "subtitle" ? [] : track.clips.map((clip) => ({ clip, track })),
  );
  const playhead = state.playhead;
  const target = "id" in playhead ? playhead.id : undefined;
  const cues = selected.length || target ? projectSubtitles(project, timeline.id).cues : [];
  const position =
    "at" in playhead
      ? parseRational(playhead.at, true)
      : (clips.find(({ clip }) => clip.id === target)?.clip.timeline_start ??
        timeline.markers.find(({ id }) => id === target)?.at ??
        cues.find(({ cue_id }) => cue_id === target)?.start);
  lines.push(
    `播放头：${position ? `${tc(position)}（${field(printRational(position, true), 200)}）` : "无"}`,
    `入出点：${marks?.in || marks?.out ? `${at(marks.in ?? "0s")}–${marks.out ? at(marks.out) : tc(end)}` : "无"}`,
  );

  const selection = selected.slice(0, 10).map((id) => {
    const label = oneLine(id);
    const entry = clips.find(({ clip }) => clip.id === id);
    if (entry) {
      const { clip, track } = entry;
      const media = project.media.find(({ id }) => id === clip.media_id);
      const name = media?.name ?? (media ? win32.basename(media.path) : clip.media_id);
      return `片段 ${label}（${oneLine(track.name)}，${tc(clip.timeline_start)}–${tc(add(clip.timeline_start, clip.duration))}，素材「${oneLine(name)}」）`;
    }
    const cue = cues.find(({ cue_id }) => cue_id === id);
    if (cue) return `字幕条 ${label}（${excerpt(cue.text)}）`;
    const marker = timeline.markers.find((item) => item.id === id);
    return marker ? `标记 ${label}（${excerpt(marker.text)}）` : label;
  });
  const render = () => {
    const omitted = selected.length - selection.length;
    const items = [...selection, ...(omitted ? [`等 ${omitted} 个`] : [])];
    return [...lines, `选中：${items.join("；") || "无"}`, panel, footer].join("\n");
  };
  let context = render();
  while (context.length > 1500 && selection.length) {
    selection.pop();
    context = render();
  }
  return context;
}
