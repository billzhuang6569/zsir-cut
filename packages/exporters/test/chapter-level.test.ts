import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cuttingList, lossReport, type ProfileId, parseProject, validateLossReport } from "../../core/src/index.ts";
import exporter from "../src/index.ts";

const path = "fixtures/regressions/chapter-level.zcut.json";
const profiles: ProfileId[] = ["fcp-11-fcpxml-1.13", "resolve-18.5-otio", "premiere-25-xmeml-5"];

describe("chapter levels", () => {
  for (const profile of profiles) {
    it(`${profile} preserves cuts and reports flattened chapter levels against golden`, async () => {
      const parsed = parseProject(await readFile(path, "utf8"));
      if (!parsed.ok) throw new Error("Invalid fixture");
      const project = parsed.project;
      const timeline = project.timelines[0];
      if (!timeline) throw new Error("Missing timeline");
      const paths = new Map(project.media.map((media) => [media.id, `/__MEDIA_ROOT__/${media.id}.mov`]));
      const output = await exporter.generate(project, timeline, profile, paths);
      expect(await exporter.readBack(output.data, timeline)).toEqual(cuttingList(project, timeline, profile));
      expect((await exporter.generate(project, timeline, profile, paths)).data).toEqual(output.data);
      const report = await lossReport(
        project,
        profile,
        exporter,
        "exp_levels",
        "preview",
        timeline,
        "2026-10-29T00:00:00Z",
        path,
      );
      expect(validateLossReport(report)).toEqual({ valid: true, errors: [] });
      expect(report.items.filter((item) => item.feature === "marker_level").map((item) => item.entity_id)).toEqual([
        "mrk_parent",
        "mrk_child",
      ]);
      expect(`${JSON.stringify(report.items, null, 2)}\n`).toBe(
        await readFile(`fixtures/golden/chapter-level-${profile}.json`, "utf8"),
      );
      expect(output.data.toString()).toBe(
        await readFile(
          `fixtures/golden/chapter-level-${profile}.${profile.includes("otio") ? "otio" : profile.includes("xmeml") ? "xml" : "fcpxml"}`,
          "utf8",
        ),
      );
    });
  }
});
