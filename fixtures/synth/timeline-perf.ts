import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function timelinePerfProject(minutes: 30 | 60) {
  const count = minutes === 30 ? 200 : 1000;
  const slots = count / 4;
  const seconds = BigInt(minutes) * 60n;
  const edge = (slot: number) => 120n + (BigInt(slot) * (seconds - 120n)) / BigInt(slots - 1);
  const video = { rate: "25", width: 960, height: 540, pixel_aspect: "1", vfr: false };
  const audio = { sample_rate: "48000", channels: 2 };
  const kinds = ["video", "video", "audio", "audio"] as const;
  const media = kinds.map((kind, i) => ({
    id: `med_perf_${i}`,
    kind,
    name: `素材 ${i + 1}`,
    path: `missing/perf-${i}.${kind === "video" ? "mov" : "wav"}`,
    size_bytes: 0,
    fingerprint: { algo: "sampled-sha256-v1", value: i.toString().repeat(64) },
    duration: "120s",
    ...(kind === "video" ? { video } : { audio }),
  }));
  const tracks = kinds.map((kind, i) => ({
    id: `trk_perf_${i}`,
    kind,
    name: `${kind === "video" ? "视频" : "声音"} ${(i % 2) + 1}`,
    enabled: true,
    transitions: [],
    clips: Array.from({ length: slots }, (_, j) => {
      const start = j === 0 ? 0n : edge(j - 1);
      const end = edge(j);
      return {
        id: `clp_perf_${i}_${j}`,
        occurrence_id: `occ_perf_${i}_${j}`,
        media_id: `med_perf_${i}`,
        source_start: "0s",
        timeline_start: `${start}s`,
        duration: `${end - start}s`,
        label: `片段 ${i + 1}-${j + 1}`,
      };
    }),
  }));
  return {
    schema: "zsir-cut/timeline",
    schema_version: "0.3",
    id: `prj_perf_${minutes}`,
    name: `时间线性能 ${minutes} 分钟 · ${count} 段`,
    revision: {
      seq: 1,
      id: "rev_perf_1",
      parent: null,
      created_at: "2026-11-18T00:00:00Z",
      author: { kind: "system", name: "fixtures" },
    },
    media,
    timelines: [
      {
        id: "tl_perf",
        name: "时间线性能",
        edit_rate: "25",
        start_timecode: "00:00:00:00",
        drop_frame: false,
        audio_rate: "48000",
        format: { width: video.width, height: video.height, pixel_aspect: video.pixel_aspect },
        tracks,
        markers: [],
      },
    ],
    transcripts: [],
    subtitle_styles: [],
  };
}

if (import.meta.main) {
  const output = resolve(process.argv[2] ?? ".tmp/timeline-perf");
  mkdirSync(output, { recursive: true });
  for (const minutes of [30, 60] as const) {
    const file = join(output, `perf-${minutes}m.zcut.json`);
    writeFileSync(file, `${JSON.stringify(timelinePerfProject(minutes), null, 2)}\n`);
    console.log(file);
  }
}
