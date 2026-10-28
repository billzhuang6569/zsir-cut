import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  compareCuttingLists,
  cuttingList,
  div,
  parseProject,
  parseRational,
  printRational,
  rational,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const rates = [
  ["24000/1001", 24, "2398"],
  ["24", 24, "24"],
  ["25", 25, "25"],
  ["30000/1001", 30, "2997"],
  ["30", 30, "30"],
  ["50", 50, "50"],
  ["60000/1001", 60, "5994"],
  ["60", 60, "60"],
] as const;

for (const [rate, nominal, preset] of rates) {
  for (const drop of rate === "30000/1001" || rate === "60000/1001" ? [false, true] : [false]) {
    it(`exports ${rate} ${drop ? "DF" : "NDF"} with native rates and zero-frame readback`, async () => {
      const parsed = parseProject(await readFile("fixtures/regressions/read-view-30.zcut.json", "utf8"));
      if (!parsed.ok) throw new Error("Invalid regression");
      const project = parsed.project,
        timeline = project.timelines[0];
      if (!timeline) throw new Error("Missing timeline");
      timeline.edit_rate = parseRational(rate);
      timeline.drop_frame = drop;
      timeline.start_timecode = drop ? "01:00:00;00" : "01:00:00:00";
      const track = timeline.tracks[0],
        media = project.media[0];
      if (track?.kind !== "video" || !track.clips[0] || !media?.video) throw new Error("Missing clip");
      // Source rates are independent of the eight supported sequence rates.
      media.video.rate = rational(120n);
      track.clips[0].duration = div(rational(48n), timeline.edit_rate);
      for (const profile of [
        "fcp-11-fcpxml-1.13",
        "fcp-10.6-fcpxml-1.11",
        "resolve-21-fcpxml-1.11",
        "resolve-18.5-otio",
        "premiere-25-xmeml-5",
      ] as const) {
        const { data } = await exporter.generate(project, timeline, profile, new Map([[media.id, "/media.mov"]]));
        const text = data.toString();
        expect(await exporter.validate(data)).toBe(true);
        expect(
          compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(data, timeline))
            .zero_frame_deviation,
        ).toBe(true);
        if (profile.includes("fcpxml")) {
          expect(text).toContain(
            `name="FFVideoFormat1080p${preset}" frameDuration="${printRational(div(rational(1n), timeline.edit_rate), true)}"`,
          );
          expect(text).toContain('frameDuration="1/120s"');
        } else if (profile.includes("otio")) {
          const root = JSON.parse(text);
          expect(root.global_start_time).toMatchObject({
            value: nominal * 3600,
            rate: Number(timeline.edit_rate.numerator) / Number(timeline.edit_rate.denominator),
          });
        } else {
          expect(text).toMatch(
            new RegExp(
              `<rate>\\s*<timebase>${nominal}</timebase>\\s*<ntsc>${rate.includes("/") ? "TRUE" : "FALSE"}</ntsc>`,
            ),
          );
          expect(text).toMatch(/<timebase>120<\/timebase>\s*<ntsc>FALSE<\/ntsc>/);
        }
      }
    });
  }
}
