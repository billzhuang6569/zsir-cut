// biome-ignore-all lint/style/noNonNullAssertion: Regression fixture entities are fixed by setup.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dispatch, parseProject, printRational, serializeProject, validateProjectSemantics } from "../src/index.js";
import { newId, transcriptIds } from "../src/project/id.ts";
import { applySubtitleEdit } from "../src/project/subtitle-edit.ts";
import { readTranscript } from "../src/read-views.ts";

const load = async () => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/regressions/remove-span-pause.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.project;
};

it.each([
  { from: 2, to: 2, pause: "3/10s", snap: undefined, start: "179/25s", source: "196/25s", remaining: "108/25s" },
  { from: 2, to: 2, pause: "3/10s", snap: "out", start: "178/25s", source: "197/25s", remaining: "106/25s" },
  { from: 0, to: 3, pause: "3/10s", snap: undefined, start: "129/25s", source: "246/25s", remaining: "8/25s" },
  { from: 0, to: 3, pause: "0s", snap: undefined, start: undefined, source: undefined, remaining: "0s" },
])(
  "computes pause removal exactly, including clip boundaries: $from..$to, $pause, $snap",
  async ({ from, to, pause, snap, start, source, remaining }) => {
    // Clip [5,15], words [6,7], [9,10], [13,14]. Removing middle: [7+.15,13-.15].
    // Nearest at 25fps: [7.16,12.84]. With no neighbors: [5.16,14.84].
    const project = await load();
    const directory = await mkdtemp(join(tmpdir(), "zcut-pause-"));
    const path = join(directory, "project.zcut.json");
    try {
      await writeFile(path, serializeProject(project));
      const input = {
        project: path,
        base_revision: project.revision.id,
        idempotency_key: "pause",
        author: { kind: "agent", name: "test" },
        label: "Test edit",
        ops: [
          {
            op: "remove_span",
            tokens: {
              transcript_id: "trs_pause",
              from_token: `tok_pause_${from}`,
              to_token: `tok_pause_${to}`,
              clip_id: "clp_a1",
              pause,
            },
            ...(snap ? { snap } : {}),
          },
        ],
      };
      const dry = await dispatch("edit", { ...input, dry_run: true });
      expect(dry.status, JSON.stringify(dry)).toBe("dry_run");
      expect(await readFile(path, "utf8")).toBe(serializeProject(project));
      const output = await dispatch("edit", input);
      expect(output.status, JSON.stringify(output)).toBe("applied");
      expect(output.changes).toEqual(dry.changes);
      const parsed = parseProject(await readFile(path, "utf8"));
      if (!parsed.ok) throw new Error("Invalid edited fixture");
      const track = parsed.project.timelines[0]!.tracks.find((track) => track.id === "trk_a1")!;
      if (track.kind === "subtitle") throw new Error("Missing audio");
      const total = track.clips.reduce(
        (sum, clip) => sum + clip.duration.numerator * (25n / clip.duration.denominator),
        0n,
      );
      expect(printRational({ numerator: total, denominator: 25n }, true)).toBe(remaining);
      if (start) {
        expect(printRational(track.clips[1]!.timeline_start, true)).toBe(start);
        expect(printRational(track.clips[1]!.source_start, true)).toBe(source);
      } else expect(track.clips).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("warns for a language mismatch only when enabled carrier media has a transcript", async () => {
  const project = await load();
  project.transcripts[0]!.language = "zh";
  const warnings = () => validateProjectSemantics(project).filter((issue) => issue.code === "W_SUB_NO_TRANSCRIPT");
  expect(warnings()).toMatchObject([{ severity: "warning", ids: ["trk_sub", "clp_a1", "med_a"] }]);
  const audio = project.timelines[0]!.tracks.find((track) => track.id === "trk_a1")!;
  audio.enabled = false;
  expect(warnings()).toEqual([]);
  audio.enabled = true;
  project.transcripts = [];
  expect(warnings()).toEqual([]);
});

it("allocates stable tags, lengthens collisions, and continues base36 numbering without migrating long IDs", async () => {
  const project = await load();
  const item = project.transcripts[0]!;
  item.id = "trs_01a18207-20e0-7623-a37b-add676dec803";
  item.ext = { vendor: { keep: true }, zsir: { keep: "yes" } };
  const tokenId = transcriptIds(project, item, "tok_");
  expect(tokenId()).toBe("tok_dec803_0");
  item.tokens[0]!.id = "tok_dec803_z";
  expect(transcriptIds(project, item, "tok_")()).toBe("tok_dec803_10");
  expect(item.ext).toEqual({ vendor: { keep: true }, zsir: { keep: "yes", id_tag: "dec803" } });
  const second = structuredClone(item);
  second.id = "trs_01a18207-20e0-7623-a37b-add699dec803";
  delete second.ext;
  second.tokens = [];
  project.transcripts.push(second);
  expect(transcriptIds(project, second, "tok_")()).toBe("tok_99dec803_0");
  const third = structuredClone(second);
  third.id = "trs_01a18207-20e0-7623-a37b-add599dec803";
  delete third.ext;
  project.transcripts.push(third);
  expect(transcriptIds(project, third, "tok_")()).toBe("tok_d599dec803_0");
  expect(item.tokens[1]!.id).toBe("tok_pause_1");
});

it("uses short IDs for edit_text, resegment and split_cue, honoring explicit IDs", async () => {
  const project = await load();
  const timeline = project.timelines[0]!;
  const item = project.transcripts[0]!;
  const edit = (op: Record<string, unknown> & { op: string }) => applySubtitleEdit(project, timeline, op, newId);
  edit({
    op: "edit_text",
    transcript_id: item.id,
    from_token: "tok_pause_2",
    to_token: "tok_pause_2",
    text: "new words",
  });
  expect(item.tokens.slice(2, 4).map((token) => token.id)).toEqual(["tok_pause_4", "tok_pause_5"]);
  edit({ op: "split_cue", cue_id: "cue_pause_0", after_token: "tok_pause_0" });
  expect(item.cues[1]!.id).toBe("cue_pause_1");
  edit({ op: "split_cue", cue_id: "cue_pause_1", after_token: "tok_pause_4", new_id: "cue_explicit" });
  expect(item.cues[2]!.id).toBe("cue_explicit");
  edit({ op: "resegment", transcript_id: item.id });
  expect(item.cues.every((cue) => /^cue_pause_[0-9a-z]+$/u.test(cue.id) || cue.id === "cue_explicit")).toBe(true);
  edit({
    op: "edit_text",
    transcript_id: item.id,
    from_token: "tok_pause_4",
    to_token: "tok_pause_5",
    text: "explicit",
    new_ids: ["tok_explicit"],
  });
  expect(item.tokens.some((token) => token.id === "tok_explicit")).toBe(true);
});

it("prints clip headers once and source times for every visible word", async () => {
  const project = await load();
  const input = { timeline_id: project.timelines[0]!.id, with_times: true };
  const packed = readTranscript(project, input);
  expect(packed.text.split("\n")[0]).toBe("@clp_a1 00:00:05:00");
  expect(packed.text).toContain("前[1.00-2.00]");
  expect(packed.text).toContain("删[4.00-5.00]后[8.00-9.00]");
  expect(packed.text.match(/@clp_a1/gu)).toHaveLength(1);
  const source = readTranscript(project, { transcript_id: "trs_pause", with_times: true });
  expect(source.text).toContain("前[1.00-2.00]");
  expect(source.text).not.toContain("@clp");
});
