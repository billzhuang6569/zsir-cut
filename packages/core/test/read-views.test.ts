// biome-ignore-all lint/style/noNonNullAssertion: Fixture entities are checked by the assertions below.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, openProject, type Project, parseProject, rational, serializeProject } from "../src/index.js";
import { readTranscript } from "../src/read-views.js";

const fixture = new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url);
let directory: string;
let path: string;
const result = async (verb: "inspect" | "read_transcript", input: Record<string, unknown>) => {
  const output = await dispatch(verb, { project: path, ...input });
  expect(output.status, JSON.stringify(output)).toBe("no_op");
  expect(output.receipt).toBeNull();
  return output;
};
const project = async (): Promise<Project> => {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error("Invalid fixture");
  return parsed.project;
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-read-"));
  path = join(directory, "project.zcut.json");
  await copyFile(fixture, path);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("read views", () => {
  it("returns all four inspect views with exact source and sequence timecodes", async () => {
    const brief = (await result("inspect", { view: "brief" })).result as Record<string, unknown>;
    expect(brief.project).toMatchObject({ id: "prj_std_25", revision: { seq: 1, id: "rev_fixture_1" } });
    expect(brief.media).toHaveLength(8);
    expect(brief.timelines).toHaveLength(1);
    expect(brief.transcripts).toHaveLength(2);
    expect(brief.issues).toBeTypeOf("object");
    const timeline = (await result("inspect", { view: "timeline", timeline_id: "tl_std" })).result as {
      tracks: { id: string; clips: Record<string, unknown>[]; transitions: unknown[] }[];
      markers: unknown[];
    };
    const clip = timeline.tracks.find((item) => item.id === "trk_v1")!.clips[0]!;
    expect(clip.timeline_in).toEqual({ t: "0s", tc: "01:00:00:00" });
    expect(clip.source_in).toEqual({ t: "278/25s", tc: "10:00:11:03" });
    expect(clip).toMatchObject({ id: "clp_v1", speed: "1", media_id: "med_A" });
    expect(timeline.markers.length).toBeGreaterThan(0);
    const ranged = (await result("inspect", { view: "timeline", range: { start: "10s", duration: "2s" } }))
      .result as typeof timeline;
    expect(ranged.tracks.find((item) => item.id === "trk_v1")!.clips.some((item) => item.id === "clp_v1")).toBe(false);
    expect(ranged.markers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "mrk_ch2" })]));
    expect(ranged.tracks.find((item) => item.id === "trk_v1")!.transitions).toEqual([]);
    const entity = (await result("inspect", { view: "entity", id: "clp_v1" })).result;
    expect(entity).toMatchObject({ parent_id: "trk_v1", entity: { id: "clp_v1" } });
    const history = (await result("inspect", { view: "history" })).result;
    expect(history).toEqual({ entries: [] });
  });

  it("uses 29.97 drop-frame sequence timecode", async () => {
    await copyFile(new URL("../../../fixtures/projects/std-2997-df.zcut.json", import.meta.url), path);
    const timeline = (await result("inspect", { view: "timeline" })).result as {
      tracks: { id: string; clips: { timeline_in: { tc: string }; source_in: { t: string; tc: string } }[] }[];
    };
    expect(timeline.tracks.find((item) => item.id === "trk_v1")!.clips[0]!.timeline_in.tc).toBe("01:00:00;00");
    expect(timeline.tracks.find((item) => item.id === "trk_v1")!.clips[2]!.source_in).toEqual({
      t: "1001/15s",
      tc: "10:01:06;22",
    });
  });

  it("reads journal entries newest first and honors before and limit", async () => {
    const store = openProject({ projectPath: path });
    const first = await store.commitWrite(
      {
        verb: "edit",
        request_id: "req_one",
        base_revision: "rev_fixture_1",
        idempotency_key: "one",
        author: { kind: "agent", name: "test" },
        ops: [],
      },
      (candidate) => {
        candidate.name = "First";
      },
    );
    if (!first.receipt?.after) throw new Error("Missing first revision");
    const second = await store.commitWrite(
      {
        verb: "edit",
        request_id: "req_two",
        base_revision: first.receipt.after,
        idempotency_key: "two",
        author: { kind: "agent", name: "test" },
        ops: [],
      },
      (candidate) => {
        candidate.name = "Second";
      },
    );
    if (!second.receipt?.after) throw new Error("Missing second revision");
    const history = (await result("inspect", { view: "history", limit: 1 })).result as {
      entries: { revision: string }[];
    };
    expect(history.entries.map((item) => item.revision)).toEqual([second.receipt.after]);
    const before = (await result("inspect", { view: "history", before: second.receipt.after }))
      .result as typeof history;
    expect(before.entries.map((item) => item.revision)).toEqual([first.receipt.after]);
  });

  it("includes active sessions in the brief", async () => {
    const opened = await dispatch("session_begin", {
      project: path,
      base_revision: "rev_fixture_1",
      idempotency_key: "read-session",
      author: { kind: "agent", name: "test" },
      approval: "manual",
      intent: "Review this cut",
    });
    expect(opened.status).toBe("no_op");
    const brief = (await result("inspect", { view: "brief" })).result as { sessions: Record<string, unknown>[] };
    expect(brief.sessions).toEqual([
      expect.objectContaining({ state: "open", approval: "manual", intent: "Review this cut" }),
    ]);
  });

  it("caps a brief with 2000 clips, 3000 media and 200 review markers", async () => {
    const large = await project();
    const timeline = large.timelines[0]!;
    const track = timeline.tracks.find((item) => item.id === "trk_v1")!;
    if (track.kind === "subtitle") throw new Error("Expected video track");
    track.clips = Array.from({ length: 2000 }, (_, index) => ({
      id: `clp_big_${index}`,
      occurrence_id: `occ_big_${index}`,
      media_id: "med_A",
      timeline_start: rational(BigInt(index + 100)),
      duration: rational(1n),
      source_start: rational(0n),
    }));
    const sample = large.media[0]!;
    large.media = Array.from({ length: 3000 }, (_, index) => ({ ...sample, id: `med_big_${index}` }));
    for (const clip of track.clips) clip.media_id = "med_big_0";
    timeline.markers = Array.from({ length: 200 }, (_, index) => ({
      id: `mrk_big_${index}`,
      at: rational(BigInt(index)),
      duration: rational(1n, 25n),
      kind: "review" as const,
      text: `Review ${index}`,
    }));
    await writeFile(path, serializeProject(large));
    const output = await result("inspect", { view: "brief" });
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(output.result).toMatchObject({ media_truncated: true });
    const brief = output.result as { timelines: { review_markers_truncated: boolean; review_markers: unknown[] }[] };
    expect(brief.timelines[0]!.review_markers_truncated).toBe(true);
    expect(brief.timelines[0]!.review_markers.length).toBeLessThanOrEqual(50);
  });

  it("packs source cues and projected jump-cut cue IDs", async () => {
    const source = (await result("read_transcript", { transcript_id: "trs_A_zh" })).result as {
      lines: number;
      text: string;
      truncated: boolean;
    };
    expect(source.lines).toBe(24);
    expect(source.truncated).toBe(false);
    expect(source.text.split("\n")[0]).toBe("[cue_zh_00 tok_000..tok_004] !approved 10:00:00:12 大家好我是庄Sir");
    const edited = await dispatch("edit", {
      project: path,
      base_revision: "rev_fixture_1",
      idempotency_key: "remove-first-words",
      author: { kind: "agent", name: "test" },
      ops: [
        {
          op: "remove_span",
          tokens: { transcript_id: "trs_A_zh", from_token: "tok_019", to_token: "tok_020", clip_id: "clp_a1" },
        },
      ],
    });
    expect(edited.status, JSON.stringify(edited)).toBe("applied");
    const projected = (await result("read_transcript", { timeline_id: "tl_std" })).result as { text: string };
    const lines = projected.text.split("\n").filter((line) => line.includes("cue_zh_03"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/@clp_a1\+clp_[^\]]+/u);
    expect(lines[0]).not.toContain("先把");
    const ranged = (
      await result("read_transcript", { transcript_id: "trs_A_zh", range: { start: "15s", duration: "4s" } })
    ).result as { lines: number };
    expect(ranged.lines).toBe(1);
  });

  it("uses milliseconds for source cues when media has no start timecode", async () => {
    const current = await project();
    const media = current.media.find((item) => item.id === "med_A");
    const cue = current.transcripts
      .find((item) => item.id === "trs_A_zh")
      ?.cues.find((item) => item.id === "cue_zh_01");
    if (!media || !cue?.timing) throw new Error("Missing fixture media or cue");
    delete media.start_timecode;
    cue.timing.start = rational(136n, 25n);
    await writeFile(path, serializeProject(current));
    const packed = (await result("read_transcript", { transcript_id: "trs_A_zh" })).result as { text: string };
    expect(packed.text.split("\n")[0]).toContain("00:00:00.500");
    expect(packed.text.split("\n")[1]).toContain("00:00:05.440");
    expect(packed.text).not.toContain("136/25s");
  });

  it("measures a 60-minute, 9000-word, 1200-cue transcript", async () => {
    const large = await project();
    const transcript = large.transcripts[0]!;
    transcript.tokens = Array.from({ length: 9000 }, (_, index) => ({
      id: `tok_${index.toString().padStart(4, "0")}`,
      text: "一",
      state: "auto" as const,
      align: {
        start: rational(BigInt(index * 2), 5n),
        end: rational(BigInt(index * 2 + 2), 5n),
        run: "run_truth_align",
      },
    }));
    transcript.cues = Array.from({ length: 1200 }, (_, index) => {
      const first = index < 600 ? index * 8 : 4800 + (index - 600) * 7;
      const last = first + (index < 600 ? 7 : 6);
      return {
        id: `cue_${index.toString().padStart(4, "0")}`,
        first_token: transcript.tokens[first]!.id,
        last_token: transcript.tokens[last]!.id,
        state: "auto" as const,
      };
    });
    const packed = readTranscript(large, { transcript_id: transcript.id });
    const bytes = Buffer.byteLength(packed.text, "utf8");
    expect(packed.lines).toBe(1200);
    expect(packed.truncated).toBe(false);
    expect(bytes).toBeGreaterThan(20 * 1024);
    expect(bytes).toBeLessThan(256 * 1024);
    for (const token of transcript.tokens) token.text = "长".repeat(25);
    const capped = readTranscript(large, { transcript_id: transcript.id });
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });
});
