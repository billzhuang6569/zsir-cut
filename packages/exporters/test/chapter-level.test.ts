import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cuttingList, lossReport, type ProfileId, parseProject, validateLossReport } from "../../core/src/index.ts";
import exporter from "../src/index.ts";

const path = "fixtures/regressions/chapter-level.zcut.json";
const profiles: ProfileId[] = ["fcp-11-fcpxml-1.13", "resolve-18.5-otio", "premiere-25-xmeml-5"];

describe("chapter levels", () => {
  it("writes descriptions valid against the installed FCPXML 1.11 DTD too", async () => {
    const parsed = parseProject(await readFile(path, "utf8"));
    if (!parsed.ok || !parsed.project.timelines[0]) throw new Error("Invalid fixture");
    const project = parsed.project;
    const output = await exporter.generate(
      project,
      parsed.project.timelines[0],
      "fcp-10.6-fcpxml-1.11",
      new Map(project.media.map((media) => [media.id, `/__MEDIA_ROOT__/${media.id}.mov`])),
    );
    expect(output.data.toString()).toContain('value="第一章" note="起因 &amp; 背景"');
    expect(await exporter.validate(output.data)).toBe(true);
    if (existsSync("/Applications/Final Cut Pro.app")) expect(exporter.validationNotes).toContain("DTD 校验通过");
  });
  for (const profile of profiles) {
    it(`${profile} preserves cuts and reports flattened chapter levels against golden`, async () => {
      const parsed = parseProject(await readFile(path, "utf8"));
      if (!parsed.ok) throw new Error("Invalid fixture");
      const project = parsed.project;
      const timeline = project.timelines[0];
      if (!timeline) throw new Error("Missing timeline");
      const paths = new Map(project.media.map((media) => [media.id, `/__MEDIA_ROOT__/${media.id}.mov`]));
      const output = await exporter.generate(project, timeline, profile, paths);
      if (profile.includes("fcpxml")) {
        expect(output.data.toString()).toContain('value="第一章" note="起因 &amp; 背景"');
        expect(output.data.toString()).toContain('note="问题 &lt;起点&gt;"');
        expect(await exporter.validate(output.data)).toBe(true);
        if (existsSync("/Applications/Final Cut Pro.app")) expect(exporter.validationNotes).toContain("DTD 校验通过");
      } else if (profile.includes("otio")) {
        const root = JSON.parse(output.data.toString());
        expect(
          root.tracks.markers.find((marker: { name: string }) => marker.name === "第一章").metadata.zsir.description,
        ).toBe("起因 & 背景");
      } else {
        expect(output.data.toString()).toContain("<comment>第一章\n起因 &amp; 背景</comment>");
      }
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
        "mrk_orphan",
        "mrk_parent",
        "mrk_child",
        "mrk_s2",
        "mrk_s3",
        "mrk_s4",
        "mrk_third",
        "mrk_s5",
        "mrk_s6",
      ]);
      const descriptions = report.items.filter((item) => item.feature === "marker_description");
      if (profile.includes("fcpxml")) {
        expect(descriptions).toEqual([]);
        expect(report.summary.preserved_by_feature.marker_description).toBe(10);
      } else {
        expect(descriptions).toHaveLength(10);
        expect(descriptions.every((item) => item.status === "approximated")).toBe(true);
        expect(descriptions[0]?.timeline_range).toBeNull();
      }
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
