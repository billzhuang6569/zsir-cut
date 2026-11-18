import type { ProjectView } from "./connection.js";
import type { UiState } from "./state.js";
import { add, parseRational, printRational, seekTarget, timecode } from "./timeline.js";
import { markedTimelineRange } from "./timelineActions.js";

export type ChatReference = { label: string; text: string };
export type DraftReference = ChatReference & { at: number };

export function referenceQuery(input: string, caret: number) {
  const prefix = input.slice(0, caret);
  const start = prefix.lastIndexOf("@");
  if (start < 0 || prefix.indexOf("\n", start) >= 0) return;
  return { query: prefix.slice(start + 1).trim(), start, end: caret };
}

export function chatReferences(project: ProjectView, state: UiState, query: string): ChatReference[] {
  const format = (at: string) => timecode(at, project);
  const range = (start: string, end: string) => `${format(start)}–${format(end)}`;
  const selected = project.tracks.flatMap((track) =>
    track.clips
      .filter(({ id }) => state.selected.includes(id))
      .map((clip) => `@片段 ${clip.id}（${track.name}，${range(clip.timeline_in.t, clip.timeline_out.t)}）`),
  );
  const marks =
    state.timelineMarks &&
    (state.timelineMarks.in || state.timelineMarks.out) &&
    markedTimelineRange(state.timelineMarks, project.duration.t);
  const at = seekTarget(project, project.cues, state.playhead);
  const candidates = [
    ...(selected.length ? [{ label: "选中的片段", text: selected.join(" ") }] : []),
    ...(marks
      ? [
          {
            label: "入出点区间",
            text: `@入出点区间 ${project.id}（${range(marks.start, printRational(add(parseRational(marks.start, true), parseRational(marks.duration, true)), true))}）`,
          },
        ]
      : []),
    { label: "播放头处", text: `@播放头处 ${project.id}（${format(at)}，${at}）` },
    ...[...new Map(project.cues.map((cue) => [cue.cue_id, cue])).values()].map((cue) => ({
      label: `字幕条 · ${cue.text}`,
      text: () => `@字幕条 ${cue.cue_id}（${cue.text}，${range(cue.start, cue.end)}）`,
    })),
    ...project.markers.map((marker) => ({
      label: `标记 · ${marker.text}`,
      text: () => `@标记 ${marker.id}（${marker.text}，${format(marker.at.t)}）`,
    })),
    ...project.media.map((media) => ({
      label: `素材 · ${media.name}`,
      text: () => `@素材 ${media.id}（${media.name}）`,
    })),
  ];
  const search = query.toLowerCase();
  return candidates
    .filter(({ label }) => label.toLowerCase().includes(search))
    .slice(0, 12)
    .map(({ label, text }) => ({ label, text: typeof text === "string" ? text : text() }));
}

export function moveReferences(references: DraftReference[], before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let newEnd = after.length;
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) {
    end--;
    newEnd--;
  }
  return references.map((reference) => ({
    ...reference,
    at: reference.at <= start ? reference.at : Math.max(newEnd, reference.at + newEnd - end),
  }));
}

export function expandChatReferences(input: string, references: DraftReference[]) {
  let start = 0;
  let text = "";
  for (const reference of [...references].sort((a, b) => a.at - b.at)) {
    text += `${input.slice(start, reference.at)} ${reference.text} `;
    start = reference.at;
  }
  return (text + input.slice(start)).trim();
}
