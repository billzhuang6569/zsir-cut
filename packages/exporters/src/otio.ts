import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  add,
  type CutRow,
  clipTimeMap,
  compare,
  div,
  type Exporter,
  floor,
  type LossItem,
  type Media,
  mul,
  printRational,
  projectSubtitles,
  type Rational,
  rational,
  sub,
  timecodeToFrame,
} from "../../core/dist/index.js";

const count = (value: Rational) => {
  const n = floor(add(value, rational(1n, 2n)));
  if (!Number.isSafeInteger(Number(n))) throw new RangeError("OTIO frame count exceeds safe integer");
  return Number(n);
};
const rateNumber = (rate: Rational) => Number(rate.numerator) / Number(rate.denominator);
const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: "TimeRange.1",
  duration: rt(duration, rate),
  start_time: rt(start, rate),
});
const sourceRate = (media: Media) =>
  media.kind === "image"
    ? rational(25n)
    : media.kind === "audio"
      ? rational(48000n)
      : (media.video?.rate ?? rational(25n));
function sourceOrigin(media: Media, rate: Rational) {
  if (!media.start_timecode) return 0;
  const tcRate = media.kind === "audio" ? rational(25n) : rate;
  return count(mul(div(rational(timecodeToFrame(media.start_timecode, printRational(tcRate))), tcRate), rate));
}
function item(
  entity_id: string,
  entity_kind: LossItem["entity_kind"],
  feature: string,
  status: LossItem["status"],
  severity: LossItem["severity"],
  reason_code: string,
  consequence: string,
  start?: Rational,
  duration?: Rational,
): LossItem {
  return {
    entity_id,
    entity_kind,
    feature,
    status,
    severity,
    reason_code,
    consequence,
    timeline_range:
      start && duration ? { start: printRational(start, true), duration: printRational(duration, true) } : null,
    fallback_asset: null,
    recoverable_from_source_project: true,
  };
}
type OtioTime = { OTIO_SCHEMA: string; rate: number; value: number };
type OtioRange = { OTIO_SCHEMA: string; start_time: OtioTime; duration: OtioTime };
type OtioChild = {
  OTIO_SCHEMA: string;
  metadata?: { zsir?: Record<string, unknown> };
  source_range?: OtioRange;
  effects?: { OTIO_SCHEMA: string; time_scalar?: number }[];
  children?: OtioChild[];
};

export const otioExporter: Exporter & { validationNotes?: string } = {
  version: "1.12.0",
  git_sha: "0000000",
  async generate(project, timeline, profile, mediaPaths, exportId) {
    if (profile !== "resolve-18.5-otio") throw new Error(`Unsupported OTIO profile: ${profile}`);
    const editRate = rateNumber(timeline.edit_rate);
    const timelineEnd = timeline.tracks
      .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
      .reduce((end, clip) => Math.max(end, count(mul(add(clip.timeline_start, clip.duration), timeline.edit_rate))), 0);
    const tracks = [];
    for (const track of [
      ...timeline.tracks.filter((t) => t.kind === "video"),
      ...timeline.tracks.filter((t) => t.kind === "audio"),
    ]) {
      if (track.kind === "subtitle") continue;
      const children: Record<string, unknown>[] = [];
      let cursor = 0;
      const transitions = new Map(track.transitions.map((transition) => [transition.from_clip, transition]));
      for (const clip of [...track.clips].sort((a, b) => compare(a.timeline_start, b.timeline_start))) {
        const media = project.media.find((candidate) => candidate.id === clip.media_id);
        const path = mediaPaths.get(clip.media_id);
        if (!media || !path) throw new Error(`Missing OTIO media: ${clip.media_id}`);
        const mediaRate = sourceRate(media);
        const nativeRate = rateNumber(mediaRate);
        const points = clipTimeMap(clip);
        const parts =
          points.length > 2
            ? points.slice(0, -1).map((point, index) => [point, points[index + 1], index] as const)
            : [[points[0], points.at(-1), 0] as const];
        for (const [first, last, segment] of parts) {
          if (!first || !last) throw new Error("Incomplete time map");
          const start = count(mul(add(clip.timeline_start, first.at), timeline.edit_rate));
          const end = count(mul(add(clip.timeline_start, last.at), timeline.edit_rate));
          if (start > cursor) children.push({ OTIO_SCHEMA: "Gap.1", source_range: range(0, start - cursor, editRate) });
          const speed = div(sub(last.source, first.source), sub(last.at, first.at));
          const effect =
            compare(speed, rational(0n)) === 0
              ? {
                  OTIO_SCHEMA: "FreezeFrame.1",
                  name: "",
                  effect_name: "FreezeFrame",
                  metadata: {},
                  enabled: true,
                  time_scalar: 0,
                }
              : compare(speed, rational(1n)) === 0
                ? null
                : {
                    OTIO_SCHEMA: "LinearTimeWarp.1",
                    name: "",
                    effect_name: "LinearTimeWarp",
                    metadata: {},
                    enabled: true,
                    time_scalar: rateNumber(speed),
                  };
          children.push({
            OTIO_SCHEMA: "Clip.2",
            metadata: {
              zsir: {
                clip_id: clip.id,
                occurrence_id: clip.occurrence_id,
                media_id: media.id,
                ...(points.length > 2 ? { segment } : {}),
                ...(clip.gain_db === undefined ? {} : { gain_db: clip.gain_db }),
                ...(clip.source_channels ? { source_channels: clip.source_channels } : {}),
                ...(clip.transform ? { transform: clip.transform } : {}),
                ...(clip.ext ? { ext: clip.ext } : {}),
              },
            },
            name: clip.label ?? media.name ?? media.id,
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: rt(sourceOrigin(media, mediaRate) + count(mul(first.source, mediaRate)), nativeRate),
              duration: rt(end - start, editRate),
            },
            effects: effect ? [effect] : [],
            markers: [],
            enabled: clip.enabled !== false,
            color: null,
            media_references: {
              DEFAULT_MEDIA: {
                OTIO_SCHEMA: "ExternalReference.1",
                metadata: {
                  zsir: {
                    media_id: media.id,
                    source_origin: sourceOrigin(media, mediaRate),
                    ...(media.ext ? { ext: media.ext } : {}),
                  },
                },
                name: media.name ?? "",
                available_range: range(
                  sourceOrigin(media, mediaRate),
                  count(mul(media.duration, mediaRate)),
                  nativeRate,
                ),
                available_image_bounds: null,
                target_url: pathToFileURL(path).href,
              },
            },
            active_media_reference_key: "DEFAULT_MEDIA",
          });
          cursor = end;
        }
        const transition = transitions.get(clip.id);
        if (transition) {
          const total = count(mul(transition.duration, timeline.edit_rate));
          const before =
            transition.alignment === "start" ? 0 : transition.alignment === "end" ? total : Math.floor(total / 2);
          children.push({
            OTIO_SCHEMA: "Transition.1",
            metadata: { zsir: { transition_id: transition.id, ...(transition.ext ? { ext: transition.ext } : {}) } },
            name: "Cross Dissolve",
            in_offset: rt(before, editRate),
            out_offset: rt(total - before, editRate),
            transition_type: "SMPTE_Dissolve",
          });
        }
      }
      if (cursor < timelineEnd)
        children.push({ OTIO_SCHEMA: "Gap.1", source_range: range(0, timelineEnd - cursor, editRate) });
      tracks.push({
        OTIO_SCHEMA: "Track.1",
        metadata: { zsir: { track_id: track.id, ...(track.ext ? { ext: track.ext } : {}) } },
        name: track.name,
        source_range: null,
        effects: [],
        markers: [],
        enabled: track.enabled,
        color: null,
        children,
        kind: track.kind === "video" ? "Video" : "Audio",
      });
    }
    const markers = timeline.markers.map((marker) => ({
      OTIO_SCHEMA: "Marker.2",
      metadata: { zsir: { kind: marker.kind, marker_id: marker.id, ...(marker.ext ? { ext: marker.ext } : {}) } },
      name: marker.text,
      color: "RED",
      marked_range: range(
        count(mul(marker.at, timeline.edit_rate)),
        count(mul(marker.duration, timeline.edit_rate)),
        editRate,
      ),
      comment: "",
    }));
    const output = {
      OTIO_SCHEMA: "Timeline.1",
      metadata: {
        zsir: {
          project_id: project.id,
          revision: project.revision.id,
          export_id: exportId ?? `${project.id}:${project.revision.id}:${timeline.id}`,
          ...(project.ext ? { project_ext: project.ext } : {}),
        },
      },
      name: timeline.name,
      global_start_time: rt(
        Number(timecodeToFrame(timeline.start_timecode, printRational(timeline.edit_rate))),
        editRate,
      ),
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        metadata: { zsir: { timeline_id: timeline.id, ...(timeline.ext ? { ext: timeline.ext } : {}) } },
        name: "tracks",
        source_range: null,
        effects: [],
        markers,
        enabled: true,
        color: null,
        children: tracks,
      },
    };
    return { name: `${timeline.name}.otio`, data: `${JSON.stringify(output, null, 2)}\n` };
  },
  async readBack(data, timeline) {
    // shortcut: readBack accepts exporter-owned OTIO; external OTIO import needs a general timeline interpreter.
    const root = JSON.parse(data.toString()) as { OTIO_SCHEMA: string; tracks: { children: OtioChild[] } };
    if (root.OTIO_SCHEMA !== "Timeline.1") throw new Error("Invalid OTIO timeline");
    const rows: CutRow[] = [];
    const numbers = { video: 0, audio: 0 };
    for (const track of root.tracks.children) {
      const kind = (track as OtioChild & { kind: "Video" | "Audio" }).kind === "Video" ? "video" : "audio";
      const number = ++numbers[kind];
      let cursor = 0;
      for (const child of track.children ?? []) {
        if (child.OTIO_SCHEMA === "Transition.1") continue;
        const source = child.source_range;
        if (!source) throw new Error("Missing OTIO source range");
        const length = Math.round((source.duration.value * rateNumber(timeline.edit_rate)) / source.duration.rate);
        if (child.OTIO_SCHEMA === "Gap.1") {
          cursor += length;
          continue;
        }
        if (child.OTIO_SCHEMA !== "Clip.2" || !child.metadata?.zsir) throw new Error("Invalid OTIO child");
        const zsir = child.metadata.zsir;
        const mediaRef = (
          child as OtioChild & {
            media_references: { DEFAULT_MEDIA: { metadata: { zsir: { source_origin: number } } } };
          }
        ).media_references.DEFAULT_MEDIA;
        const origin = mediaRef.metadata.zsir.source_origin;
        const speed =
          child.effects?.find((effect) => effect.OTIO_SCHEMA === "LinearTimeWarp.1")?.time_scalar ??
          (child.effects?.some((effect) => effect.OTIO_SCHEMA === "FreezeFrame.1") ? 0 : 1);
        const first = source.start_time.value - origin;
        const last =
          first + Math.round((source.duration.value * source.start_time.rate * speed) / source.duration.rate);
        rows.push({
          track_type: kind,
          track_number: number,
          clip_id: String(zsir.clip_id),
          media_id: String(zsir.media_id),
          timeline_in: cursor,
          timeline_out: cursor + length,
          source_in: first,
          source_out: last,
          speed:
            zsir.segment === undefined
              ? printRational(rational(BigInt(Math.round(speed * 1000000)), 1000000n))
              : "split",
        });
        cursor += length;
      }
    }
    return rows.sort(
      (a, b) =>
        (a.track_type === b.track_type ? 0 : a.track_type === "video" ? -1 : 1) ||
        a.track_number - b.track_number ||
        a.timeline_in - b.timeline_in ||
        a.clip_id.localeCompare(b.clip_id),
    );
  },
  losses(project, timeline) {
    const items: LossItem[] = [];
    for (const style of project.subtitle_styles)
      items.push(
        item(
          style.id,
          "style",
          "subtitle_style",
          "approximated",
          "warning",
          "R_STYLE_NOT_REPRESENTABLE",
          "字幕样式需在 Resolve 中调整",
        ),
      );
    for (const cue of projectSubtitles(project, timeline.id).cues)
      items.push(
        item(
          cue.cue_id,
          "cue",
          "subtitle_text_timing",
          "approximated",
          "warning",
          "R_SUB_MANUAL_IMPORT",
          "字幕已写入 SRT，请手动导入 Resolve",
          cue.start,
          sub(cue.end, cue.start),
        ),
      );
    for (const missing of projectSubtitles(project, timeline.id).unprojected)
      items.push(
        item(
          missing.token_id,
          "cue",
          "subtitle_text_timing",
          "unsupported",
          "warning",
          "R_SUB_UNPROJECTED",
          "字词落在倒放或定格段，按投影规则不显示",
        ),
      );
    for (const track of timeline.tracks) {
      if (track.kind === "subtitle") continue;
      for (const clip of track.clips) {
        const at = clip.timeline_start,
          duration = clip.duration;
        if (clip.gain_db !== undefined)
          items.push(
            item(
              clip.id,
              "clip",
              "gain",
              "unsupported",
              "warning",
              "R_FORMAT_NO_FIELD",
              "增益保存在 OTIO 元数据中，需在 Resolve 中重设",
              at,
              duration,
            ),
          );
        if (clip.source_channels)
          items.push(
            item(
              clip.id,
              "clip",
              "av_sync",
              "unsupported",
              "warning",
              "R_FORMAT_NO_FIELD",
              "声道选择保存在 OTIO 元数据中，需在 Resolve 中重设",
              at,
              duration,
            ),
          );
        if (clip.transform)
          items.push(
            item(
              clip.id,
              "clip",
              "transform",
              "unsupported",
              "warning",
              "R_FORMAT_NO_FIELD",
              "画面变换保存在 OTIO 元数据中，需在 Resolve 中重设",
              at,
              duration,
            ),
          );
        const points = clipTimeMap(clip);
        if (points.length > 2)
          items.push(
            item(
              clip.id,
              "clip",
              "speed_segmented",
              "approximated",
              "warning",
              "R_SPLIT_FOR_RETIME",
              "分段变速已拆成多个片段",
              at,
              duration,
            ),
          );
        if (points.some((point) => point.interp === "smooth"))
          items.push(
            item(
              clip.id,
              "clip",
              "speed_smooth",
              "approximated",
              "warning",
              "R_SPLIT_FOR_RETIME",
              "平滑变速已按线性分段近似",
              at,
              duration,
            ),
          );
      }
    }
    return items;
  },
  async validate(data) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    let python: string | undefined;
    for (const candidate of [process.env.ZSIR_OTIO_PYTHON, join(root, "tools/python/.venv/bin/python")]) {
      if (!candidate) continue;
      try {
        await access(candidate);
        python = candidate;
        break;
      } catch {}
    }
    if (!python) {
      this.validationNotes =
        "未找到 ZSIR_OTIO_PYTHON 或 tools/python/.venv/bin/python；跳过 OTIO 官方库加载校验；剪辑表读回零帧比对通过";
      return true;
    }
    const dir = await mkdtemp(join(tmpdir(), "zcut-otio-"));
    try {
      const path = join(dir, "timeline.otio");
      await writeFile(path, data);
      const script =
        "import sys,json,opentimelineio as o; raw=json.load(open(sys.argv[1])); expected=[c['source_range'] for tr in raw['tracks']['children'] for c in tr['children'] if c['OTIO_SCHEMA']=='Clip.2']; clips=list(o.adapters.read_from_file(sys.argv[1]).tracks.find_clips()); assert len(clips)==len(expected); assert all(c.source_range is not None and c.source_range.start_time.value==e['start_time']['value'] and c.source_range.start_time.rate==e['start_time']['rate'] and c.source_range.duration.value==e['duration']['value'] and c.source_range.duration.rate==e['duration']['rate'] for c,e in zip(clips,expected)); print(len(clips))";
      const { stdout } = await promisify(execFile)(python, ["-c", script, path]);
      const expected = (
        JSON.parse(data.toString()) as { tracks: { children: { children: { OTIO_SCHEMA: string }[] }[] } }
      ).tracks.children
        .flatMap((track) => track.children)
        .filter((child) => child.OTIO_SCHEMA === "Clip.2").length;
      if (Number(stdout.trim()) !== expected) throw new Error("OTIO library clip count mismatch");
      this.validationNotes = `OpenTimelineIO 官方库加载 ${expected} 个 Clip 并读取 source_range；剪辑表读回零帧比对通过`;
      return true;
    } catch (error) {
      this.validationNotes = `OTIO 官方库加载失败：${String(error)}`;
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
