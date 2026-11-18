import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dispatch } from "../../core/src/index.js";
import { DESKTOP_AUTHOR, type ProjectView } from "../src/connection.js";
import { copyClips, pasteOps, planPaste } from "../src/timelineClipboard.js";

it.each([
  { magnetic: true, at: "64s", videoOut: "74s", audioOut: "368/5s", bRollAt: "68s" },
  { magnetic: false, at: "0s", videoOut: "10s", audioOut: "48/5s", bRollAt: "4s" },
  { magnetic: false, at: "1s", videoOut: "11s", audioOut: "53/5s", bRollAt: "5s" },
])(
  "round-trips uneven linked and overlapping copies through core at $at (magnetic $magnetic)",
  async ({ magnetic, at, videoOut, audioOut, bRollAt }) => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-clipboard-"));
    const project = join(directory, "test.zcut.json");
    try {
      await copyFile("fixtures/projects/std-25.zcut.json", project);
      const inspect = async () => {
        const result = await dispatch("inspect", { project, view: "timeline" });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        return { ...(result.result as ProjectView), media: [] };
      };
      const before = await inspect();
      const clipboard = copyClips(before, ["clp_v1", "clp_a1", "clp_b1"]);
      const plan = planPaste(before, clipboard, at, magnetic);
      if ("error" in plan) throw new Error(plan.error);
      const ops = pasteOps(plan);
      const placed = ops.filter(({ op }) => op === "place");
      expect(placed).toHaveLength(2);
      const result = await dispatch("edit", {
        project,
        base_revision: "rev_fixture_1",
        author: DESKTOP_AUTHOR,
        label: "粘贴 2 个片段",
        idempotency_key: "timeline-clipboard",
        ops,
      });
      expect(result.ok, JSON.stringify(result.error ?? result.verification)).toBe(true);
      const after = await inspect();
      const clips = after.tracks.flatMap((track) => track.clips);
      expect(clips.find((clip) => clip.id === placed[0]?.video_clip_id)).toMatchObject({
        timeline_in: { t: at },
        timeline_out: { t: videoOut },
        source_in: { t: "278/25s" },
      });
      expect(clips.find((clip) => clip.id === placed[0]?.audio_clip_id)).toMatchObject({
        timeline_out: { t: audioOut },
        source_out: { t: "518/25s" },
      });
      expect(clips.find((clip) => clip.id === placed[1]?.video_clip_id)).toMatchObject({
        timeline_in: { t: bRollAt },
        transform: { scale: 0.5, rotation_deg: 5 },
      });
      if (!magnetic) {
        const audio = after.tracks.find((track) => track.id === "trk_a1");
        expect(audio?.clips.find((clip) => clip.occurrence_id === "occ_2")?.timeline_in.t).toBe(audioOut);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
