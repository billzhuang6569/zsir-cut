import { readFile, writeFile } from "node:fs/promises";
import type { Rational } from "../../packages/core/src/index.ts";
import {
  add,
  compare,
  div,
  floor,
  mul,
  parseProject,
  parseRational,
  rational,
  serializeProject,
  sub,
} from "../../packages/core/src/index.ts";

export const frameRateProjects = [
  { name: "std-2398", rate: "24000/1001", drop: false },
  { name: "std-5994-df", rate: "60000/1001", drop: true },
] as const;

export function convertFrameRate(source: string, name: string, rate: string, drop: boolean): string {
  const parsed = parseProject(source);
  if (!parsed.ok || parsed.issues.length) throw new Error("Invalid source fixture");
  const project = parsed.project;
  project.id = `prj_${name.replaceAll("-", "_")}`;
  project.name = name;
  const editRate = parseRational(rate);
  const grid = (value: Rational) => div(rational(floor(add(mul(value, editRate), rational(1n, 2n)))), editRate);
  for (const timeline of project.timelines) {
    timeline.name = name;
    timeline.edit_rate = editRate;
    timeline.drop_frame = drop;
    timeline.start_timecode = drop ? "01:00:00;00" : "01:00:00:00";
    for (const track of timeline.tracks) {
      if (track.kind === "subtitle") {
        for (const cue of track.free_cues) {
          const end = grid(add(cue.timeline_start, cue.duration));
          cue.timeline_start = grid(cue.timeline_start);
          cue.duration = sub(end, cue.timeline_start);
        }
        continue;
      }
      for (const clip of track.clips) {
        const start = clip.timeline_start;
        const duration = clip.duration;
        clip.timeline_start = grid(start);
        clip.duration = sub(grid(add(start, duration)), clip.timeline_start);
        if (clip.time_map) {
          for (const point of clip.time_map) point.at = sub(grid(add(start, point.at)), clip.timeline_start);
        } else if (compare(duration, clip.duration) !== 0) {
          // Preserve the source interval when the sequence duration moves to the new grid.
          clip.time_map = [
            { at: rational(0n), source: clip.source_start, interp: "linear" },
            { at: clip.duration, source: add(clip.source_start, duration), interp: "linear" },
          ];
        }
      }
      for (const transition of track.transitions) transition.duration = grid(transition.duration);
    }
    for (const marker of timeline.markers) {
      const end = grid(add(marker.at, marker.duration));
      marker.at = grid(marker.at);
      marker.duration = sub(end, marker.at);
    }
  }
  return serializeProject(project);
}

export async function generateFrameRateProjects(): Promise<void> {
  const source = await readFile("fixtures/projects/std-2997-df.zcut.json", "utf8");
  for (const { name, rate, drop } of frameRateProjects)
    await writeFile(`fixtures/projects/${name}.zcut.json`, convertFrameRate(source, name, rate, drop));
}
