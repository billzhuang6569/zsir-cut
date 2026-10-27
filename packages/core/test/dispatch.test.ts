import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatch,
  ffprobe,
  type Probe,
  type ProbeData,
  parseProject,
  printRational,
  validateCommand,
  validateEnvelope,
} from "../src/index.js";

const fixture = new URL("../../../examples/minimal.zcut.json", import.meta.url);
const author = { kind: "agent", name: "test" };
const video: ProbeData = {
  streams: [
    {
      index: 0,
      codec_type: "video",
      nb_read_packets: "4",
      r_frame_rate: "25/1",
      time_base: "1/25",
      width: 1920,
      height: 1080,
      sample_aspect_ratio: "1:1",
      tags: { timecode: "10:00:00:00", reel_name: "A001" },
    },
    { index: 1, codec_type: "audio", sample_rate: "48000", channels: 2, duration_ts: "96000", time_base: "1/48000" },
  ],
  packets: [0, 1, 4, 5].map((value) => ({ stream_index: 0, pts: String(value), duration: "1" })),
};
const image: ProbeData = {
  streams: [{ index: 0, codec_type: "video", nb_read_packets: "1", r_frame_rate: "25/1", width: 800, height: 600 }],
  packets: [{ stream_index: 0, pts: 0, duration: 1 }],
};
const audio: ProbeData = {
  streams: [
    {
      index: 0,
      codec_type: "audio",
      sample_rate: "48000",
      channels: 1,
      duration_ts: "48000",
      time_base: "1/48000",
      tags: { time_reference: "48000" },
    },
  ],
};
const data: Record<string, ProbeData> = { "video.mov": video, "still.png": image, "voice.wav": audio };
const probe: Probe = async (path) => {
  const result = data[basename(path)];
  if (!result) throw new Error("Unexpected probe request");
  return result;
};
let directory: string;
let project: string;
const read = async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid project");
  return parsed.project;
};
const request = (key: string, extra: Record<string, unknown>, base_revision = "rev_example_1") => ({
  project,
  base_revision,
  idempotency_key: key,
  author,
  ...extra,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-import-"));
  project = join(directory, "project.zcut.json");
  await copyFile(fixture, project);
  await writeFile(join(directory, "video.mov"), "video bytes");
  await writeFile(join(directory, "still.png"), "image bytes");
  await writeFile(join(directory, "voice.wav"), "audio bytes");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("dispatcher import_media", () => {
  it("returns E_IO with a clear message when ffprobe is missing", async () => {
    const before = await readFile(project, "utf8");
    vi.stubEnv("PATH", directory);
    const output = await dispatch("import_media", request("missing-ffprobe", { paths: ["video.mov"] }));
    expect(output.status).toBe("failed");
    expect(output.error).toMatchObject({ code: "E_IO", message: expect.stringContaining("ffprobe not found") });
    expect(validateEnvelope(output).valid).toBe(true);
    expect(await readFile(project, "utf8")).toBe(before);
  });

  it("maps video, VFR, image and audio metadata; skips duplicate content", async () => {
    const input = request("import-all", { paths: ["video.mov", "still.png", "voice.wav"] });
    expect(validateCommand("import_media", input).valid).toBe(true);
    const output = await dispatch("import_media", input, { probe });
    expect(validateEnvelope(output).valid).toBe(true);
    expect(output.status).toBe("applied");
    const imported = (await read()).media.slice(1);
    const [videoMedia, imageMedia, audioMedia] = imported;
    if (!videoMedia || !imageMedia || !audioMedia) throw new Error("Missing imported media");
    expect(imported.map((item) => item.kind)).toEqual(["video", "image", "audio"]);
    expect(imported[0]).toMatchObject({
      start_timecode: "10:00:00:00",
      reel: "A001",
      video: { vfr: true, width: 1920 },
      audio: { channels: 2 },
    });
    expect(printRational(videoMedia.duration, true)).toBe("6/25s");
    expect(printRational(imageMedia.duration, true)).toBe("3600s");
    expect(printRational(audioMedia.duration, true)).toBe("1s");
    expect(audioMedia.start_timecode).toBe("00:00:01:00");
    const second = request("import-again", { paths: ["video.mov"] }, output.receipt?.after ?? "");
    const skipped = await dispatch("import_media", second, {
      probe: async () => {
        throw new Error("Duplicate was probed");
      },
    });
    expect(skipped.status).toBe("no_op");
    expect(skipped.result).toEqual({ imported: [], skipped: [{ media_id: videoMedia.id }] });
    expect(validateEnvelope(skipped).valid).toBe(true);
  });

  it("relinks a moved file through the write path", async () => {
    const first = await dispatch("import_media", request("import-one", { paths: ["video.mov"] }), { probe });
    expect(first.status).toBe("applied");
    const media = (await read()).media.at(-1);
    if (!media) throw new Error("Missing imported media");
    await mkdir(join(directory, "moved"));
    await rename(join(directory, "video.mov"), join(directory, "moved", "renamed.mov"));
    const relink = request(
      "relink-one",
      {
        relink: { search_roots: ["moved"], media_ids: [media.id] },
      },
      first.receipt?.after ?? "",
    );
    expect(validateCommand("import_media", relink).valid).toBe(true);
    const output = await dispatch("import_media", relink);
    expect(output.status).toBe("applied");
    expect(output.result).toEqual({
      relinked: [{ media_id: media.id, old_path: "video.mov", new_path: "moved/renamed.mov", other_candidates: [] }],
      not_found: [],
      skipped: [],
    });
    expect((await read()).media.at(-1)).toMatchObject({
      id: media.id,
      path: "moved/renamed.mov",
      original_path: media.original_path,
    });
    expect(validateEnvelope(output).valid).toBe(true);
  });

  it("uses the last frame display time and duration for VFR media", async () => {
    await writeFile(join(directory, "screen.mp4"), "screen bytes");
    const variable: ProbeData = {
      streams: [
        {
          index: 0,
          codec_type: "video",
          nb_read_packets: "4",
          r_frame_rate: "60/1",
          time_base: "1/60",
          width: 1080,
          height: 1920,
        },
      ],
      packets: [
        { stream_index: 0, pts: 0, duration: 1 },
        { stream_index: 0, pts: 5, duration: 3 },
        { stream_index: 0, pts: 1, duration: 3 },
        { stream_index: 0, pts: 4, duration: 1 },
      ],
    };
    const output = await dispatch("import_media", request("import-vfr", { paths: ["screen.mp4"] }), {
      probe: async () => variable,
    });
    expect(output.status).toBe("applied");
    const imported = (await read()).media.at(-1);
    if (!imported) throw new Error("Missing imported media");
    expect(imported.video?.vfr).toBe(true);
    expect(printRational(imported.duration, true)).toBe("2/15s");
    expect(validateEnvelope(output).valid).toBe(true);
  });

  it("rounds WAV bext timecode down while preserving exact start samples", async () => {
    const bext: ProbeData = {
      streams: [
        {
          index: 0,
          codec_type: "audio",
          sample_rate: "48000",
          channels: 1,
          duration_ts: "48000",
          time_base: "1/48000",
          tags: { time_reference: "48001" },
        },
      ],
    };
    const output = await dispatch("import_media", request("import-bext", { paths: ["voice.wav"] }), {
      probe: async () => bext,
    });
    expect(output.status).toBe("applied");
    expect((await read()).media.at(-1)).toMatchObject({
      start_timecode: "00:00:01:00",
      ext: { zsir: { start_samples: 48001 } },
    });
    expect(validateEnvelope(output).valid).toBe(true);
  });

  it("constructs packet-only ffprobe commands", async () => {
    const commands: string[][] = [];
    const result = await ffprobe("fake.mov", async (args, onLine) => {
      commands.push(args);
      if (args.includes("-count_packets"))
        onLine(
          JSON.stringify({
            streams: [
              {
                index: 0,
                codec_type: "video",
                nb_read_packets: "1000",
                r_frame_rate: "1/1",
                time_base: "1/1",
                width: 1,
                height: 1,
              },
            ],
          }),
        );
      else {
        for (let pts = 0; pts < 1000; pts++) onLine(`stream_index=0|pts=${pts}|duration=1`);
      }
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("-count_packets");
    expect(commands[1]).toContain("-show_packets");
    expect(commands.flat()).not.toContain("-count_frames");
    expect(commands.flat()).not.toContain("-show_frames");
    expect(result.summaries?.get(0)?.count).toBe(1000);
    expect(result.summaries?.get(0)?.first300).toHaveLength(300);
    expect(result.summaries?.get(0)?.last?.pts).toBe(999n);
  });
});
