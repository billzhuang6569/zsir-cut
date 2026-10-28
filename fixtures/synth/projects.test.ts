import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { add, compare, mul, parseProject, rational, validateProjectSemantics } from "../../packages/core/src/index.js";
import { convertFrameRate, frameRateProjects } from "./projects.js";

it.each(frameRateProjects)(
  "reproduces $name on its frame grid without changing source intervals",
  async ({ name, rate, drop }) => {
    const source = await readFile("fixtures/projects/std-2997-df.zcut.json", "utf8");
    const generated = convertFrameRate(source, name, rate, drop);
    expect(generated).toBe(await readFile(`fixtures/projects/${name}.zcut.json`, "utf8"));
    const before = parseProject(source),
      after = parseProject(generated);
    if (!before.ok || !after.ok) throw new Error("Invalid fixture");
    expect(validateProjectSemantics(after.project, after.issues).filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(after.project.media).toEqual(before.project.media);
    expect(after.project.transcripts).toEqual(before.project.transcripts);
    const oldClips = before.project.timelines.flatMap((timeline) =>
      timeline.tracks.flatMap((track) => (track.kind === "subtitle" ? [] : track.clips)),
    );
    for (const timeline of after.project.timelines) {
      expect(timeline.name).toBe(after.project.name);
      const halfFrame = rational(timeline.edit_rate.denominator, timeline.edit_rate.numerator * 2n);
      for (const track of timeline.tracks) {
        if (track.kind === "subtitle") continue;
        for (const clip of track.clips) {
          const old = oldClips.find((item) => item.id === clip.id);
          if (!old) throw new Error("Missing source clip");
          expect(clip.source_start).toEqual(old.source_start);
          expect(
            clip.time_map?.map((point) => point.source) ?? [clip.source_start, add(clip.source_start, clip.duration)],
          ).toEqual(
            old.time_map?.map((point) => point.source) ?? [old.source_start, add(old.source_start, old.duration)],
          );
          for (const [value, original] of [
            [clip.timeline_start, old.timeline_start],
            [add(clip.timeline_start, clip.duration), add(old.timeline_start, old.duration)],
          ]) {
            if (!value || !original) throw new Error("Missing boundary");
            expect(mul(value, timeline.edit_rate).denominator).toBe(1n);
            expect(compare(value, add(original, halfFrame))).toBeLessThanOrEqual(0);
            expect(compare(original, add(value, halfFrame))).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  },
);
