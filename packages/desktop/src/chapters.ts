import { compare, floor, parseRational, type TimelineView } from "./timeline.js";

export type Chapter = TimelineView["markers"][number];
export function chapterGroups(markers: Chapter[], levels: 1 | 2) {
  const groups: Chapter[][] = [];
  for (const marker of markers
    .filter((m) => m.kind === "chapter")
    .sort((a, b) => compare(parseRational(a.at.t, true), parseRational(b.at.t, true)))) {
    if (marker.level === 2 && levels === 1) continue;
    if (marker.level !== 2 || !groups.length) groups.push([]);
    groups[groups.length - 1]?.push(marker);
  }
  return groups;
}
export function chapterTime(at: string) {
  const seconds = floor(parseRational(at, true));
  const tail = `${String((seconds / 60n) % 60n).padStart(2, "0")}:${String(seconds % 60n).padStart(2, "0")}`;
  return seconds >= 3600n ? `${seconds / 3600n}:${tail}` : `${seconds / 60n}:${String(seconds % 60n).padStart(2, "0")}`;
}
export function chapterMarkdown(markers: Chapter[], levels: 1 | 2) {
  return chapterGroups(markers, levels)
    .flat()
    .map((m) => `${m.level === 2 ? "  - " : ""}${chapterTime(m.at.t)} ${m.text}`)
    .join("\n");
}
