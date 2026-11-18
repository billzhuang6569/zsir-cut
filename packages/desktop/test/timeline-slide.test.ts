import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseProject } from "../../core/src/index.js";
import { applyEdit } from "../../core/src/project/edit.js";
import { inspect } from "../../core/src/read-views.js";
import type { ProjectView } from "../src/connection.js";
import { printRational } from "../src/timeline.js";
import { slideGesture } from "../src/timelineSlide.js";

const fixture = new URL("../../../fixtures/regressions/c1-offsets.zcut.json", import.meta.url);

it.each([
  ["slip", "clp_v2", 7, "max_by"],
  ["slip", "clp_v2", -3, "min_by"],
  ["slide", "clp_v2", 4, "max_by"],
  ["slide", "clp_v2", -2, "min_by"],
  ["slide", "clp_v3", 2, "max_by"],
  ["slide", "clp_v4", -2, "min_by"],
] as const)(
  "clamps %s on %s at %ss to the kernel boundary and matches its resulting windows",
  async (op, clip_id, seconds, bound) => {
    const parsed = parseProject(await readFile(fixture, "utf8"));
    if (!parsed.ok) throw new Error("Invalid fixture");
    const { project } = parsed;
    const view = async () =>
      ({
        ...(await inspect(project, fixture.pathname, { view: "timeline" })),
        media: project.media.map((media) => ({
          ...media,
          duration: printRational(media.duration, true),
          video: media.video && { ...media.video, rate: printRational(media.video.rate) },
        })),
      }) as ProjectView;
    const before = await view();
    const anchor = before.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clip_id);
    if (!anchor) throw new Error("Missing fixture clip");
    const preview = slideGesture(before, anchor, op)(seconds * 50, 50);
    const by = printRational(preview.by, true);
    expect(preview.blocked).toBe(true);
    expect(() => applyEdit(project, [{ op, clip_id, by: `${seconds}s` }], {}, "test")).toThrow(
      expect.objectContaining({ code: "E_VALIDATION", details: expect.objectContaining({ [bound]: by }) }),
    );
    applyEdit(project, [{ op, clip_id, by }], {}, "test");
    const after = await view();
    const actual = after.tracks.flatMap((track) => track.clips);
    for (const [id, clip] of preview.clips)
      expect(actual.find((item) => item.id === id)).toMatchObject({
        timeline_in: { t: clip.timeline_in.t },
        timeline_out: { t: clip.timeline_out.t },
        source_in: { t: clip.source_in.t },
        source_out: { t: clip.source_out.t },
      });
  },
);
