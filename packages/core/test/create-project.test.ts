import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatch,
  ffprobe,
  mediaFromProbe,
  openProject,
  type Probe,
  type Project,
  parseProject,
  printRational,
  projectEntitySnapshots,
  serializeProject,
  validateEnvelope,
  type WriteRequest,
} from "../src/index.ts";
import { buildProject, type CreateProjectRequest } from "../src/project/create.ts";

const author = { kind: "agent" as const, name: "test" };
let directory: string;
let project: string;
const input = (extra: Partial<CreateProjectRequest> = {}): CreateProjectRequest => ({
  project,
  name: "新工程",
  timeline: { edit_rate: "25", width: 1920, height: 1080 },
  author,
  idempotency_key: "create",
  ...extra,
});
const read = async (): Promise<Project> => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.project;
};
const rateOf = (project: Project) => {
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  return printRational(timeline.edit_rate);
};
const probeAt =
  (rate: string): Probe =>
  async () => ({
    streams: [{ index: 0, codec_type: "video", r_frame_rate: rate, width: 640, height: 360, time_base: "1/1000" }],
    packets: [0, 40].map((pts) => ({ stream_index: 0, pts, duration: 40 })),
  });
const expectCreateEnvelope = (output: Parameters<typeof validateEnvelope>[0]) => {
  expect(validateEnvelope(output)).toEqual({ valid: true, errors: [] });
};
const storedRequest = (request: CreateProjectRequest): WriteRequest => ({
  verb: "create_project",
  request_id: "req_create",
  base_revision: "",
  author,
  idempotency_key: request.idempotency_key,
  ops: [request],
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-create-"));
  project = join(directory, "new.zcut.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("create_project", () => {
  it("automatically names three successive video tracks B, C, D", async () => {
    await dispatch("create_project", input());
    for (let index = 0; index < 3; index++) {
      const result = await dispatch("edit", {
        project,
        author,
        base_revision: (await read()).revision.id,
        idempotency_key: `track-${index}`,
        ops: [{ op: "add_track", kind: "video" }],
      });
      expect(result.status).toBe("applied");
    }
    expect(
      (await read()).timelines[0]?.tracks.filter((track) => track.kind === "video").map((track) => track.name),
    ).toEqual(["视频 A", "视频 B", "视频 C", "视频 D"]);
  });
  it("creates the canonical empty project, tracks, style and first journal entry", async () => {
    const output = await dispatch("create_project", input({ subtitles: { language: "zh-Hans" } }));
    expect(output.status).toBe("applied");
    expect(output.receipt?.before).toBeNull();
    expectCreateEnvelope(output);
    const created = await read();
    const timeline = created.timelines[0];
    expect(created).toMatchObject({
      schema_version: "0.2",
      recognition: { language: "zh-Hans" },
      name: "新工程",
      media: [],
      transcripts: [],
      revision: { seq: 1, parent: null, author },
    });
    expect(timeline).toMatchObject({
      name: "主时间线",
      drop_frame: false,
      start_timecode: "00:00:00:00",
      tracks: [
        { id: "trk_v1", name: "视频 A", enabled: true, clips: [], transitions: [] },
        { id: "trk_a1", name: "声音 A" },
        { id: "trk_a2", name: "声音 B" },
        {
          id: "trk_sub1",
          name: "字幕 A",
          language: "zh-Hans",
          carrier_tracks: ["trk_a1"],
          default_style_id: "sty_default",
          overrides: [],
          free_cues: [],
        },
      ],
    });
    expect(created.subtitle_styles).toEqual([
      {
        id: "sty_default",
        name: "默认",
        version: 1,
        font_family: "PingFang SC",
        font_size: 0.05,
        color: "#FFFFFF",
        outline: { color: "#000000", width: 0.06 },
        position: { anchor: "bottom", margin_v: 0.08 },
      },
    ]);
    expect(output.result).toEqual({
      project_id: created.id,
      timeline_id: timeline?.id,
      revision: { seq: 1, id: created.revision.id },
      subtitle_track_id: "trk_sub1",
    });
    expect(await readFile(project, "utf8")).toBe(serializeProject(created));
    const rows = (await readFile(join(directory, ".zcut", created.id, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "write",
      verb: "create_project",
      parent: null,
      seq: 1,
      revision: created.revision.id,
      idempotency_key: "create",
    });
    const snapshots = projectEntitySnapshots(created);
    expect(rows[0].changes).toHaveLength(snapshots.size);
    for (const change of rows[0].changes)
      expect(change).toMatchObject({ before: null, after: snapshots.get(change.key)?.value });
    expect(output.changes.every((change) => change.action === "created")).toBe(true);
    expect(output.changes).toHaveLength(snapshots.size);
    const undo = await dispatch("undo", {
      project,
      author,
      base_revision: created.revision.id,
      idempotency_key: "undo-create",
    });
    expect(undo.error?.code).toBe("E_UNSUPPORTED");
    expect(await readFile(project, "utf8")).toBe(serializeProject(created));
  });

  it.each([1, 8])("honors names, %i audio tracks and default drop-frame timecode", async (count) => {
    const output = await dispatch(
      "create_project",
      input({
        timeline: {
          name: "片段",
          edit_rate: "30000/1001",
          width: 640,
          height: 360,
          audio_tracks: count,
          drop_frame: true,
        },
        subtitles: { name: "中文", language: "zh" },
      }),
    );
    expect(output.status).toBe("applied");
    const timeline = (await read()).timelines[0];
    expect(timeline?.name).toBe("片段");
    expect(timeline?.start_timecode).toBe("00:00:00;00");
    expect(timeline?.tracks.filter((track) => track.kind === "audio").map((track) => track.id)).toEqual(
      Array.from({ length: count }, (_, index) => `trk_a${index + 1}`),
    );
    expect(timeline?.tracks.at(-1)?.name).toBe("中文");
  });

  it("replays the original receipt after later edits and rejects a mismatched key", async () => {
    const request = input();
    const first = await dispatch("create_project", request);
    const before = await readFile(project, "utf8");
    const replay = await dispatch("create_project", request);
    expect(replay.receipt?.before).toBeNull();
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    expect(await readFile(project, "utf8")).toBe(before);
    const mismatch = await dispatch("create_project", { ...request, name: "不同" });
    expect(mismatch.error?.code).toBe("E_IDEMPOTENCY_MISMATCH");
    expectCreateEnvelope(mismatch);
    expect((await dispatch("create_project", { ...request, idempotency_key: "other" })).error?.code).toBe(
      "E_VALIDATION",
    );
    const changed = await openProject({ projectPath: project }).commitWrite(
      { ...storedRequest(request), verb: "edit", base_revision: first.receipt?.after ?? "", idempotency_key: "rename" },
      (candidate) => {
        candidate.name = "修改后的名称";
      },
    );
    expect(changed.status).toBe("applied");
    expect(await dispatch("create_project", request)).toEqual(replay);
    expect((await read()).name).toBe("修改后的名称");
  });

  it("serializes concurrent creates and replays the winner without probing again", async () => {
    let calls = 0;
    const probe: Probe = async (path) => {
      calls++;
      return probeAt("25")(path);
    };
    const request = input({ timeline: {}, match_media: "sample.mov" });
    const outputs = await Promise.all([
      dispatch("create_project", request, { probe }),
      dispatch("create_project", request, { probe }),
    ]);
    expect(outputs.map((output) => output.status)).toEqual(["applied", "applied"]);
    expect(outputs.filter((output) => output.receipt?.replayed)).toHaveLength(1);
    expect(new Set(outputs.map((output) => output.receipt?.after)).size).toBe(1);
    expect(calls).toBe(1);
  });

  it("rejects existing files, directories and symlinks without replacing them", async () => {
    await writeFile(project, "unrelated bytes");
    expect((await dispatch("create_project", input())).error?.code).toBe("E_VALIDATION");
    expect(await readFile(project, "utf8")).toBe("unrelated bytes");
    await rm(project);
    await mkdir(project);
    expect((await dispatch("create_project", input())).error?.code).toBe("E_VALIDATION");
    await rm(project, { recursive: true });
    await symlink(join(directory, "missing"), project);
    expect((await dispatch("create_project", input())).error?.code).toBe("E_VALIDATION");
  });

  it.each([
    { project: "bad.json" },
    { timeline: {} },
    { timeline: { edit_rate: "25", width: 1, height: 1, audio_tracks: 0 } },
    { timeline: { edit_rate: "25", width: 1, height: 1, drop_frame: true } },
    { session_id: "ses_no" },
  ])("rejects invalid creation settings %j", async (extra) => {
    const output = await dispatch("create_project", { ...input(), ...extra });
    expect(output.status).toBe("rejected");
    expect(output.error?.code).toBe("session_id" in extra ? "E_SESSION_STATE" : "E_VALIDATION");
    expectCreateEnvelope(output);
    await expect(readFile(project)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("requires the target parent to exist without creating it", async () => {
    const output = await dispatch("create_project", input({ project: join(directory, "missing", "new.zcut.json") }));
    expect(output.error?.code).toBe("E_IO");
    expectCreateEnvelope(output);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"])(
    "writes supported rate %s",
    async (rate) => {
      expect(
        (await dispatch("create_project", input({ timeline: { edit_rate: rate, width: 1, height: 1 } }))).status,
      ).toBe("applied");
      expect(rateOf(await read())).toBe(rate);
    },
  );

  it.each([
    ["49/2", "25"],
    ["27", "25"],
    ["120", "60"],
    ["1", "24000/1001"],
    ["2997/100", "30000/1001"],
  ])("matches %s to %s, including exact ties", async (rate, expected) => {
    const output = await dispatch("create_project", input({ timeline: {}, match_media: "sample.mov" }), {
      probe: probeAt(rate),
    });
    expect(output.status).toBe("applied");
    expect(rateOf(await read())).toBe(expected);
    expect((await read()).timelines[0]?.format).toMatchObject({ width: 640, height: 360 });
  });

  it("keeps explicitly supplied format fields when matching", async () => {
    const output = await dispatch(
      "create_project",
      input({ timeline: { edit_rate: "30", width: 1080 }, match_media: "sample.mov" }),
      { probe: probeAt("25") },
    );
    expect(output.status).toBe("applied");
    expect((await read()).timelines[0]).toMatchObject({ format: { width: 1080, height: 360 } });
    expect(rateOf(await read())).toBe("30");
  });

  it("reports probing failures as E_IO without creating the project", async () => {
    const output = await dispatch("create_project", input({ match_media: "missing.mov" }), {
      probe: async () => {
        throw new Error("ffprobe failed");
      },
    });
    expect(output).toMatchObject({
      status: "failed",
      error: { code: "E_IO", message: expect.stringContaining("ffprobe failed") },
    });
    await expect(readFile(project)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects audio and still images for match_media", async () => {
    const audio: Probe = async () => ({
      streams: [
        {
          index: 0,
          codec_type: "audio",
          sample_rate: "48000",
          channels: 1,
          duration_ts: "48000",
          time_base: "1/48000",
        },
      ],
    });
    expect((await dispatch("create_project", input({ match_media: "voice.wav" }), { probe: audio })).error?.code).toBe(
      "E_VALIDATION",
    );
    const image: Probe = async () => ({
      streams: [{ index: 0, codec_type: "video", r_frame_rate: "25", width: 10, height: 10, nb_read_packets: "1" }],
    });
    expect((await dispatch("create_project", input({ match_media: "still.png" }), { probe: image })).error?.code).toBe(
      "E_VALIDATION",
    );
  });

  it.each(["before_step_7", "after_step_7"] as const)("preserves transaction guarantees at %s", async (point) => {
    const request = input();
    const output = await openProject({
      projectPath: project,
      fault: (at) => {
        if (at === point) throw new Error("interrupted");
      },
    }).createProject(storedRequest(request), () => buildProject(request, probeAt("25")));
    expectCreateEnvelope(output);
    if (point === "before_step_7") {
      expect(output.status).toBe("failed");
      await expect(readFile(project)).rejects.toHaveProperty("code", "ENOENT");
    } else {
      expect(output.status).toBe("committed_unverified");
      expect(output.receipt?.before).toBeNull();
      expect((await read()).revision.id).toBe(output.receipt?.after);
    }
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["30", "30"],
    ["25", "25"],
    ["60", "30"],
  ])(
    "matches generated %s fps media to %s fps, then imports and places it",
    async (sourceRate, rate) => {
      const mediaPath = join(directory, `sample-${sourceRate}.mov`);
      const generated = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "lavfi",
          "-i",
          `color=c=blue:s=160x90:r=${sourceRate}:d=1`,
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=1",
          "-c:v",
          "ffv1",
          "-c:a",
          "pcm_s16le",
          "-threads",
          "1",
          "-y",
          mediaPath,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      if (generated.error) throw generated.error;
      expect(generated.status, generated.stderr).toBe(0);
      const metadata = mediaFromProbe(mediaPath, await ffprobe(mediaPath));
      expect(metadata.video).toMatchObject({ width: 160, height: 90 });
      expect(metadata.audio).toMatchObject({ channels: 1 });
      const created = await dispatch(
        "create_project",
        input({ timeline: sourceRate === rate ? {} : { edit_rate: rate }, match_media: mediaPath }),
      );
      expect(created.status).toBe("applied");
      const initial = await read();
      expect(rateOf(initial)).toBe(rate);
      expect(initial.timelines[0]?.format).toMatchObject({
        width: metadata.video?.width,
        height: metadata.video?.height,
      });
      expect(initial.media).toEqual([]);
      const imported = await dispatch("import_media", {
        project,
        author,
        base_revision: created.receipt?.after,
        idempotency_key: "import",
        paths: [mediaPath],
      });
      expect(imported.status).toBe("applied");
      const media = (await read()).media[0];
      const placed = await dispatch("edit", {
        project,
        author,
        base_revision: imported.receipt?.after,
        idempotency_key: "place",
        ops: [
          {
            op: "place",
            media_id: media?.id,
            source_start: "0s",
            duration: "1s",
            at: "0s",
            video_track: "trk_v1",
            audio_track: media?.audio ? "trk_a1" : undefined,
            mode: "insert",
          },
        ],
      });
      expect(placed.status).toBe("applied");
      if (rate === "25") {
        const exported = await dispatch(
          "export",
          {
            project,
            author,
            base_revision: placed.receipt?.after,
            idempotency_key: "export",
            output: directory,
            profile: "fcp-11-fcpxml-1.13",
            accept_losses: true,
          },
          { worker: true },
        );
        expect(exported.status, exported.error?.message).toBe("applied");
        const manifest = JSON.parse(await readFile(join(exported.result?.package as string, "manifest.json"), "utf8"));
        expect(manifest.validation.schema.status).toBe("pass");
        expect(manifest.files.some((file: { path: string }) => file.path.endsWith(".fcpxml"))).toBe(true);
      }
    },
    30000,
  );
});
