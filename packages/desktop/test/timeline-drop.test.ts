import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dispatch, type Probe, type Verb } from "../../core/src/index.js";
import { DESKTOP_AUTHOR, type ProjectView } from "../src/connection.js";
import { placeMedia } from "../src/media.js";
import { initialState } from "../src/state.js";
import { timecode } from "../src/timeline.js";
import { dropMode, dropPosition, dropTime, dropTrack, orderedPaths } from "../src/timelineDrop.js";

import { importAndPlace } from "../src/useFileDrop.js";

const project: ProjectView = {
  id: "tl_one",
  name: "测试",
  revision: { id: "rev_one", seq: 1 },
  duration: { t: "0s" },
  edit_rate: "30000/1001",
  start_timecode: "01:00:00;00",
  drop_frame: true,
  tracks: [
    { id: "trk_v1", kind: "video", name: "视频 A", enabled: true, clips: [] },
    { id: "trk_v2", kind: "video", name: "视频 B", enabled: true, clips: [] },
    { id: "trk_a1", kind: "audio", name: "声音 A", enabled: true, clips: [] },
    { id: "trk_a2", kind: "audio", name: "声音 B", enabled: true, clips: [] },
  ],
  media: [],
  cues: [],
  styles: [],
  markers: [],
};

const video = {
  id: "med_video",
  kind: "video",
  duration: "1001/100s",
  video: { rate: "30000/1001", width: 1920, height: 1080 },
  audio: { sample_rate: "48000", channels: 2 },
};

it("converts DPR and horizontal scroll into the sequence grid with a non-zero DF start", () => {
  const point = dropPosition({ x: 428, y: 264 }, 2);
  expect(point).toEqual({ x: 214, y: 132 });
  const geometry = { x: point.x, left: 100, label: 40, scroll: 86, scale: 80 };
  const at = dropTime(project, initialState(), geometry, false, "0s");
  expect(at).toBe("1001/500s");
  expect(timecode(at, project)).toBe("01:00:02;00");
});

it("preserves the grab offset and snaps the trailing edge to an existing edit point", () => {
  const geometry = { x: 705, left: 100, label: 40, scroll: 0, scale: 80 };
  const cut = "3003/250s";
  expect(dropTime(project, initialState(), geometry, true, cut, video, 500)).toBe("1001/500s");
});

it("distinguishes the ruler, existing lanes, gaps and the region under the last lane", () => {
  const rows = [
    { id: "trk_v1", top: 128, bottom: 160 },
    { id: "trk_a1", top: 166, bottom: 198 },
  ];
  expect(dropTrack(127, 128, rows)).toBeNull();
  expect(dropTrack(132, 128, rows)?.target).toEqual({ track: "trk_v1" });
  expect(dropTrack(163, 128, rows)?.target).toEqual({ index: 1 });
  expect(dropTrack(220, 128, rows)?.target).toEqual({ index: 2 });
  expect(dropTrack(132, 128, [])?.target).toEqual({ index: 0 });
});

it.each([
  [true, "fcp", false, false, "insert"],
  [true, "fcp", false, true, "insert"],
  [true, "fcp", true, false, "overwrite"],
  [false, "fcp", true, false, "insert"],
  [false, "premiere", true, false, "overwrite"],
  [false, "premiere", false, true, "insert"],
  [true, "premiere", false, true, "overwrite"],
] as const)("uses the %s magnetic setting and %s modifier (%s, %s)", (magnetic, preset, altKey, metaKey, mode) => {
  expect(dropMode(magnetic, preset, { altKey, metaKey })).toBe(mode);
});

it("preserves native payload order and naturally sorts filenames for unordered input", () => {
  const paths = ["/a/镜头10.mov", "/b/镜头2.mov", "C:\\c\\镜头1.mov"];
  expect(orderedPaths(paths, true)).toEqual(paths);
  expect(orderedPaths(new Set(paths), false)).toEqual([paths[2], paths[1], paths[0]]);
});

it("pairs matching track ordinals and sends both streams in the same place op", () => {
  const state = initialState();
  expect(placeMedia(project, video, state, "0s", { target: { track: "trk_v2" } })).toMatchObject({
    added: [],
    op: { video_track: "trk_v2", audio_track: "trk_a2", duration: "1001/100s" },
  });
  const picture = placeMedia(project, video, state, "0s", { placement: "video", mode: "overwrite" });
  expect(picture).toMatchObject({ op: { video_track: "trk_v1", mode: "overwrite" } });
  expect(picture).not.toHaveProperty("op.audio_track");
  const sound = placeMedia(project, video, state, "0s", { placement: "audio", target: { track: "trk_a2" } });
  expect(sound).toMatchObject({ op: { audio_track: "trk_a2" } });
  expect(sound).not.toHaveProperty("op.video_track");
  expect(placeMedia(project, video, state, "0s", { placement: "audio", target: { track: "trk_v2" } })).toHaveProperty(
    "error",
  );
});

it("creates both requested lanes in an empty timeline and quantizes a still to the nearest frame", () => {
  const state = initialState();
  expect(
    placeMedia({ ...project, tracks: [] }, video, state, "0s", {
      target: { index: 0 },
      trackId: (kind) => `trk_new_${kind}`,
    }),
  ).toMatchObject({
    added: [
      { op: "add_track", id: "trk_new_video", kind: "video", index: 0 },
      { op: "add_track", id: "trk_new_audio", kind: "audio", index: 1 },
    ],
    op: { video_track: "trk_new_video", audio_track: "trk_new_audio" },
  });
  expect(placeMedia(project, { kind: "image", id: "med_still", duration: "3600s" }, state, "0s")).toMatchObject({
    op: { duration: "1001/200s", video_track: "trk_v1", source_start: "0s" },
  });
  expect(placeMedia(project, { kind: "audio", id: "med_short", duration: "1/100s" }, state, "0s")).toMatchObject({
    error: "素材范围不足一帧",
  });
});

it("commits a real import and linked placement, then undoes the added tracks and clips together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcut-timeline-drop-"));
  try {
    const path = join(dir, "project.zcut.json");
    const source = join(dir, "source.mov");
    await copyFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), path);
    await writeFile(source, "source bytes");
    const original = JSON.parse(await readFile(path, "utf8"));
    const probe: Probe = async () => ({
      streams: [
        { index: 0, codec_type: "video", r_frame_rate: "25/1", time_base: "1/25", width: 1920, height: 1080 },
        { index: 1, codec_type: "audio", sample_rate: "48000", channels: 2, duration_ts: "3840", time_base: "1/48000" },
      ],
      packets: [0, 1].map((pts) => ({ stream_index: 0, pts, duration: 1 })),
    });
    const read = async () => JSON.parse(await readFile(path, "utf8"));
    const inspect = await dispatch("inspect", { project: path, view: "timeline" });
    const view = { ...project, ...inspect.result, revision: original.revision };
    const call = async (verb: string, request: Record<string, unknown>) => {
      const output = await dispatch(verb as Verb, request, { probe });
      if (!output.ok) throw new Error(output.error?.message);
      return { ...output.result, receipt: output.receipt };
    };
    const state = { ...initialState(), project: path };
    const messages: (string | null)[] = [];
    await importAndPlace(
      [source],
      view,
      state,
      { at: "10s", target: { index: view.tracks.length }, mode: "insert" },
      "av",
      call,
      () => true,
      (message) => messages.push(message),
    );
    expect(messages).toEqual([null]);
    const edited = await read();
    const added = edited.timelines[0].tracks.slice(original.timelines[0].tracks.length);
    expect(added.map((track: { kind: string }) => track.kind)).toEqual(["video", "audio"]);
    expect(added[0].clips[0]).toMatchObject({ timeline_start: "10s", duration: "2/25s" });
    expect(added[1].clips[0].occurrence_id).toBe(added[0].clips[0].occurrence_id);
    await call("undo", {
      project: path,
      base_revision: edited.revision.id,
      idempotency_key: "undo-timeline-drop",
      author: DESKTOP_AUTHOR,
      label: "撤销",
    });
    const undone = await read();
    expect(undone.timelines[0].tracks).toEqual(original.timelines[0].tracks);
    expect(undone.media).toEqual(edited.media);
    expect(undone.media).toHaveLength(original.media.length + 1);
    expect(await readFile(source, "utf8")).toBe("source bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
