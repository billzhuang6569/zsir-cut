import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Clip, CutRow, Exporter, LossItem, Media, Rational } from "../../core/dist/index.js";

const {
  add,
  clipTimeMap,
  compare,
  div,
  floor,
  mul,
  printRational,
  projectSubtitles,
  rational,
  sub,
  timecodeToFrame,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

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
const resolveNumberKeys = ["Parameter Value", "Default Parameter Value", "minValue", "maxValue"];
function decimal(value: number) {
  // Node 24 supports rawJSON; TypeScript's ES2023 library does not declare it yet.
  return (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(
    String(value).replace(/^(-?\d+)(e|$)/, "$1.0$2"),
  );
}
function resolveEffects(transform: NonNullable<Clip["transform"]>) {
  const parameter = (id: string, value: number, defaultValue: number, min: number, max: number) => ({
    "Parameter ID": id,
    "Parameter Value": decimal(value),
    "Default Parameter Value": decimal(defaultValue),
    "Variant Type": "Double",
    "Key Frames": {},
    minValue: decimal(min),
    maxValue: decimal(max),
  });
  const effect = (name: string, label: string, type: number, parameters: ReturnType<typeof parameter>[]) => ({
    OTIO_SCHEMA: "Effect.1",
    name: "",
    effect_name: "Resolve Effect",
    metadata: {
      Resolve_OTIO: {
        "Effect Name": name,
        Name: label,
        Enabled: true,
        "Display Type": 1,
        Type: type,
        Parameters: parameters,
      },
    },
  });
  return [
    effect("Transform", "变换", 2, [
      parameter("transformationZoomX", transform.scale ?? 1, 1, 0, 100),
      parameter("transformationZoomY", transform.scale ?? 1, 1, 0, 100),
      parameter("transformationPan", transform.position?.[0] ?? 0, 0, -4, 4),
      parameter("transformationTilt", transform.position?.[1] ?? 0, 0, -4, 4),
      parameter("transformationRotationAngle", transform.rotation_deg ?? 0, 0, -100000, 100000),
    ]),
    effect("Cropping", "裁切", 3, [
      parameter("cropLeft", transform.crop?.left ?? 0, 0, -1, 1),
      parameter("cropRight", transform.crop?.right ?? 0, 0, -1, 1),
      parameter("cropTop", transform.crop?.top ?? 0, 0, -1, 1),
      parameter("cropBottom", transform.crop?.bottom ?? 0, 0, -1, 1),
    ]),
  ];
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
  kind?: "Video" | "Audio";
  metadata?: { zsir?: Record<string, unknown> };
  source_range?: OtioRange | null;
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
          const reverse = compare(last.source, first.source) < 0;
          const speed = div(
            reverse ? sub(first.source, last.source) : sub(last.source, first.source),
            sub(last.at, first.at),
          );
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
          const forward = {
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
              start_time: rt(
                sourceOrigin(media, mediaRate) +
                  count(mul(compare(first.source, last.source) < 0 ? first.source : last.source, mediaRate)),
                nativeRate,
              ),
              duration: rt(end - start, editRate),
            },
            effects: [...(effect ? [effect] : []), ...(clip.transform ? resolveEffects(clip.transform) : [])],
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
                target_url: path,
              },
            },
            active_media_reference_key: "DEFAULT_MEDIA",
          };
          children.push(
            reverse
              ? {
                  OTIO_SCHEMA: "Stack.1",
                  name: forward.name,
                  metadata: forward.metadata,
                  source_range: range(0, end - start, editRate),
                  effects: [
                    {
                      OTIO_SCHEMA: "LinearTimeWarp.1",
                      name: "",
                      effect_name: "",
                      metadata: {},
                      time_scalar: decimal(-1),
                    },
                  ],
                  markers: [],
                  enabled: forward.enabled,
                  children: [
                    {
                      OTIO_SCHEMA: "Track.1",
                      name: track.kind === "video" ? "Video" : "Audio",
                      kind: track.kind === "video" ? "Video" : "Audio",
                      metadata: {},
                      source_range: null,
                      effects: [],
                      markers: [],
                      enabled: true,
                      children: [forward],
                    },
                  ],
                }
              : forward,
          );
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
        // Resolve imports DF timeline origins as literal nominal frames; media origins remain true frames.
        Number(timecodeToFrame(timeline.start_timecode.replace(";", ":"), printRational(timeline.edit_rate))),
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
      const kind = track.kind === "Video" ? "video" : "audio";
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
        let clip = child;
        const reverse = child.OTIO_SCHEMA === "Stack.1";
        if (reverse) {
          const innerTrack = child.children?.[0];
          const innerClip = innerTrack?.children?.[0];
          if (
            source.start_time.value !== 0 ||
            Object.keys(child.metadata ?? {}).some((key) => key !== "zsir") ||
            child.effects?.length !== 1 ||
            child.effects[0]?.OTIO_SCHEMA !== "LinearTimeWarp.1" ||
            child.effects[0].time_scalar !== -1 ||
            child.children?.length !== 1 ||
            innerTrack?.OTIO_SCHEMA !== "Track.1" ||
            innerTrack.kind !== track.kind ||
            innerTrack.source_range !== null ||
            (innerTrack.effects?.length ?? 0) !== 0 ||
            innerTrack.children?.length !== 1 ||
            innerClip?.OTIO_SCHEMA !== "Clip.2" ||
            innerClip.source_range?.duration.value !== source.duration.value ||
            innerClip.source_range.duration.rate !== source.duration.rate
          )
            throw new Error("Invalid OTIO reverse compound");
          clip = innerClip;
          for (const key of ["clip_id", "occurrence_id", "media_id", "segment"])
            if (child.metadata?.zsir?.[key] !== clip.metadata?.zsir?.[key])
              throw new Error("Mismatched OTIO reverse compound identity");
        }
        if (clip.OTIO_SCHEMA !== "Clip.2" || !child.metadata?.zsir || !clip.source_range)
          throw new Error("Invalid OTIO child");
        const clipSource = clip.source_range;
        const zsir = child.metadata.zsir;
        const mediaRef = (
          clip as OtioChild & {
            media_references: {
              DEFAULT_MEDIA: { target_url: string; metadata: { zsir: { source_origin: number } } };
            };
          }
        ).media_references.DEFAULT_MEDIA;
        if (!isAbsolute(mediaRef.target_url)) throw new Error("OTIO media path must be a local absolute path");
        const origin = mediaRef.metadata.zsir.source_origin;
        const forwardSpeed =
          clip.effects?.find((effect) => effect.OTIO_SCHEMA === "LinearTimeWarp.1")?.time_scalar ??
          (clip.effects?.some((effect) => effect.OTIO_SCHEMA === "FreezeFrame.1") ? 0 : 1);
        if (forwardSpeed < 0 || (reverse && forwardSpeed === 0))
          throw new Error("OTIO reverse compound requires a forward clip");
        const speed = reverse ? -forwardSpeed : forwardSpeed;
        const delta = Math.round(
          (clipSource.duration.value * clipSource.start_time.rate * speed) / clipSource.duration.rate,
        );
        const first = clipSource.start_time.value - origin - Math.min(0, delta);
        const last = first + delta;
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
    for (const marker of timeline.markers)
      if (marker.kind === "chapter" && marker.level !== undefined)
        items.push(
          item(
            marker.id,
            "marker",
            "marker_level",
            "approximated",
            "warning",
            "R_FORMAT_NO_FIELD",
            "目标格式的章节标记不区分层级",
          ),
        );
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
    try {
      const invalidParameters = new WeakSet<object>();
      const parsed = JSON.parse(data.toString(), function (key, value, context?: { source?: string }) {
        if (resolveNumberKeys.includes(key) && (typeof value !== "number" || !context?.source?.includes(".")))
          invalidParameters.add(this);
        return value;
      }) as { tracks: OtioChild };
      const check = (node: OtioChild): boolean => {
        for (const effect of node.effects ?? []) {
          const resolve = (
            effect as { metadata?: { Resolve_OTIO?: { "Effect Name"?: string; Parameters?: object[] } } }
          ).metadata?.Resolve_OTIO;
          if (!resolve || !["Transform", "Cropping"].includes(resolve["Effect Name"] ?? "")) continue;
          if (
            !resolve.Parameters?.every(
              (parameter) =>
                !invalidParameters.has(parameter) && resolveNumberKeys.every((key) => Object.hasOwn(parameter, key)),
            )
          )
            return false;
        }
        return (node.children ?? []).every(check);
      };
      if (!check(parsed.tracks)) throw new Error("Resolve effect parameters must be JSON numbers with a decimal point");
    } catch (error) {
      this.validationNotes = `Resolve 私有效果数值格式校验失败：${String(error)}`;
      return false;
    }
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
      const script = [
        "import sys,json,opentimelineio as o",
        "def ranges(node):",
        " if node['OTIO_SCHEMA']=='Clip.2': yield node['source_range']",
        " for child in node.get('children',[]): yield from ranges(child)",
        "raw=json.load(open(sys.argv[1])); expected=list(ranges(raw['tracks']))",
        "clips=list(o.adapters.read_from_file(sys.argv[1]).tracks.find_clips())",
        "assert len(clips)==len(expected)",
        "assert all(c.source_range is not None and c.source_range.start_time.value==e['start_time']['value'] and c.source_range.start_time.rate==e['start_time']['rate'] and c.source_range.duration.value==e['duration']['value'] and c.source_range.duration.rate==e['duration']['rate'] for c,e in zip(clips,expected))",
        "print(len(clips))",
      ].join("\n");
      const { stdout } = await promisify(execFile)(python, ["-c", script, path]);
      this.validationNotes = `OpenTimelineIO 官方库加载 ${Number(stdout.trim())} 个 Clip 并读取 source_range；剪辑表读回零帧比对通过`;
      return true;
    } catch (error) {
      this.validationNotes = `OTIO 官方库加载失败：${String(error)}`;
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
