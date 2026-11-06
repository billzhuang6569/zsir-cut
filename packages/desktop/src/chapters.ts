import { floor, parseRational } from "./timeline.js";

export interface Chapter {
  id: string | null;
  level: number;
  start: { t: string; tc?: string };
  end: { t: string; tc?: string };
  duration: { t: string; tc?: string };
  title: string | null;
  description: string | null;
  user_edited: boolean;
  hue: number;
}
export interface ChaptersView {
  chapters: (Chapter & { sections: Chapter[] })[];
  total: { t: string; tc?: string };
}
export function chapterTime(at: string) {
  const seconds = floor(parseRational(at, true));
  const tail = `${String((seconds / 60n) % 60n).padStart(2, "0")}:${String(seconds % 60n).padStart(2, "0")}`;
  return seconds >= 3600n ? `${seconds / 3600n}:${tail}` : `${seconds / 60n}:${String(seconds % 60n).padStart(2, "0")}`;
}
export function chapterMarkdown(markers: Chapter[]) {
  return markers.map((m) => `${m.level === 2 ? "  - " : ""}${chapterTime(m.start.t)} ${m.title}`).join("\n");
}
