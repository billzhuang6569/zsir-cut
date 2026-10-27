// biome-ignore-all lint/style/noNonNullAssertion: Parsed project and generated XML guarantee these indexed entries.
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  add,
  type Clip,
  type CutRow,
  compare,
  div,
  type Exporter,
  floor,
  type LossItem,
  type Media,
  type MediaTrack,
  mul,
  parseRational,
  printRational,
  projectSubtitles,
  type Rational,
  rational,
  sub,
  subtitleFiles,
  type Timeline,
} from "../../core/dist/index.js";

const zero = rational(0n);
const sec = (value: Rational) => printRational(value, true);
const r = (value: string) => parseRational(value, true);
const min = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const max = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const round = (value: Rational) => Number(floor(add(value, rational(1n, 2n))));
const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescapeXml = (value: string) =>
  value.replace(
    /&(?:amp|quot|lt|gt|#10);/g,
    (entity) => ({ "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#10;": "\n" })[entity] ?? entity,
  );
type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text?: string };
const node = (tag: string, attrs: Record<string, string> = {}, children: Node[] = [], text?: string): Node => ({
  tag,
  attrs,
  children,
  ...(text === undefined ? {} : { text }),
});
function xml(item: Node, level = 0): string {
  const pad = "  ".repeat(level);
  const head = `${pad}<${item.tag}${Object.entries(item.attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("")}`;
  if (!item.children.length && item.text === undefined) return `${head}/>`;
  if (!item.children.length) return `${head}>${escapeXml(item.text ?? "")}</${item.tag}>`;
  return `${head}>\n${item.children.map((child) => xml(child, level + 1)).join("\n")}\n${pad}</${item.tag}>`;
}
function parseXml(data: string): Node {
  // shortcut: readBack handles exporter-owned XML only; use a general parser if external FCPXML is accepted.
  const root = node("root");
  const stack = [root];
  for (const token of data.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<?") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const name = token.slice(2, -1);
      if (stack.at(-1)?.tag !== name) throw new Error(`Mismatched XML close: ${name}`);
      stack.pop();
    } else if (token.startsWith("<")) {
      const match = /^<([\w-]+)([\s\S]*?)\s*\/?>$/.exec(token);
      if (!match) throw new Error("Invalid XML tag");
      const attrs: Record<string, string> = {};
      for (const attr of match[2]?.matchAll(/([\w-]+)="([^"]*)"/g) ?? []) attrs[attr[1]!] = unescapeXml(attr[2]!);
      const item = node(match[1]!, attrs);
      stack.at(-1)!.children.push(item);
      if (!token.endsWith("/>")) stack.push(item);
    } else if (token.trim()) stack.at(-1)!.text = unescapeXml(token.trim());
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error("Invalid XML tree");
  return root.children[0]!;
}
const children = (item: Node, tag: string) => item.children.filter((child) => child.tag === tag);
const child = (item: Node, tag: string) => children(item, tag)[0];
const metadata = (clip: Clip, audio?: Clip) =>
  node("metadata", {}, [
    node("md", { key: "com.zsir-cut.clip-id", value: clip.id }),
    node("md", { key: "com.zsir-cut.occurrence-id", value: clip.occurrence_id }),
    ...(audio ? [node("md", { key: "com.zsir-cut.audio-clip-id", value: audio.id })] : []),
  ]);
const md = (item: Node, key: string) =>
  children(child(item, "metadata") ?? node("metadata"), "md").find((entry) => entry.attrs.key === key)?.attrs.value;
function insertBeforeMetadata(parent: Node, item: Node) {
  const trailing =
    item.tag === "marker" || item.tag === "chapter-marker"
      ? ["audio-channel-source", "metadata"]
      : ["marker", "chapter-marker", "audio-channel-source", "metadata"];
  const index = parent.children.findIndex((entry) => trailing.includes(entry.tag));
  parent.children.splice(index < 0 ? parent.children.length : index, 0, item);
}
const frameDuration = (rate: Rational) => sec(div(rational(1n), rate));
function sourceOrigin(media: Media): Rational {
  const rate = media.video?.rate ?? rational(25n);
  return media.start_timecode ? timecodeSeconds(media.start_timecode, rate) : zero;
}
function timecodeSeconds(value: string, rate: Rational): Rational {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid timecode: ${value}`);
  const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5]].map((part) => BigInt(part!));
  const nominal = BigInt(round(rate));
  const drop = match[4] === ";";
  const dropFrames =
    drop && compare(rate, rational(30000n, 1001n)) === 0
      ? 2n
      : drop && compare(rate, rational(60000n, 1001n)) === 0
        ? 4n
        : 0n;
  if (
    hours! > 23n ||
    minutes! > 59n ||
    seconds! > 59n ||
    frames! >= nominal ||
    (drop && (!dropFrames || (seconds === 0n && minutes! % 10n !== 0n && frames! < dropFrames)))
  )
    throw new Error(`Invalid timecode: ${value}`);
  const totalMinutes = hours! * 60n + minutes!;
  const count =
    (hours! * 3600n + minutes! * 60n + seconds!) * nominal + frames! - dropFrames * (totalMinutes - totalMinutes / 10n);
  return div(rational(count), rate);
}
function clipAttrs(clip: Clip, ref: string, offset: Rational, start: Rational, lane?: number, audio?: Clip) {
  return {
    ref,
    ...(lane === undefined ? {} : { lane: String(lane) }),
    offset: sec(offset),
    start: sec(start),
    duration: sec(clip.duration),
    srcEnable: audio ? "all" : lane !== undefined && lane < 0 ? "audio" : "video",
    ...(clip.label ? { name: clip.label } : {}),
    ...(clip.enabled === false ? { enabled: "0" } : {}),
    ...(audio &&
    (compare(audio.timeline_start, clip.timeline_start) !== 0 || compare(audio.duration, clip.duration) !== 0)
      ? { audioStart: sec(add(sub(start, clip.source_start), audio.source_start)), audioDuration: sec(audio.duration) }
      : {}),
  };
}
function properties(clip: Clip, media: Media, timelineHeight: number, audio?: Clip): Node[] {
  const result: Node[] = [];
  if (clip.transform?.crop) {
    const crop = clip.transform.crop;
    result.push(
      node("adjust-crop", { mode: "trim" }, [
        node("trim-rect", {
          ...(crop.left === undefined ? {} : { left: String((crop.left * 100) / (media.video?.width ?? 1)) }),
          ...(crop.top === undefined ? {} : { top: String((crop.top * 100) / (media.video?.height ?? 1)) }),
          ...(crop.right === undefined ? {} : { right: String((crop.right * 100) / (media.video?.width ?? 1)) }),
          ...(crop.bottom === undefined ? {} : { bottom: String((crop.bottom * 100) / (media.video?.height ?? 1)) }),
        }),
      ]),
    );
  }
  if (clip.transform) {
    const t = clip.transform;
    result.push(
      node("adjust-transform", {
        ...(t.scale === undefined ? {} : { scale: `${t.scale} ${t.scale}` }),
        ...(t.rotation_deg === undefined ? {} : { rotation: String(t.rotation_deg) }),
        ...(t.position === undefined
          ? {}
          : {
              position: `${(t.position[0] * 100) / timelineHeight} ${(t.position[1] * 100) / timelineHeight}`,
            }),
      }),
    );
  }
  const sound = audio ?? clip;
  if (sound.gain_db !== undefined) result.push(node("adjust-volume", { amount: `${sound.gain_db}dB` }));
  if (sound.source_channels)
    result.push(node("audio-channel-source", { srcCh: sound.source_channels.map((n) => n + 1).join(", ") }));
  return result;
}
function itemFor(
  clip: Clip,
  media: Media,
  ref: string,
  offset: Rational,
  timelineHeight: number,
  lane?: number,
  audio?: Clip,
): Node {
  const origin = sourceOrigin(media);
  const points = clip.time_map;
  if (!points)
    return node("asset-clip", clipAttrs(clip, ref, offset, add(origin, clip.source_start), lane, audio), [
      ...properties(clip, media, timelineHeight, audio),
      metadata(clip, audio),
    ]);
  const sources = points.map((point) => point.source);
  const low = sources.reduce(min),
    high = sources.reduce(max);
  const wrapper = node("clip", {
    ...(lane === undefined ? {} : { lane: String(lane) }),
    offset: sec(offset),
    duration: sec(clip.duration),
    ...(clip.label ? { name: clip.label } : {}),
    ...(clip.enabled === false ? { enabled: "0" } : {}),
  });
  wrapper.children.push(
    node(
      "timeMap",
      {},
      points.map((point) =>
        node("timept", {
          time: sec(point.at),
          value: sec(sub(point.source, low)),
          interp: point.interp === "smooth" ? "smooth2" : "linear",
        }),
      ),
    ),
  );
  wrapper.children.push(
    node(
      "asset-clip",
      {
        ref,
        offset: "0s",
        start: sec(add(origin, low)),
        duration: sec(sub(high, low)),
        srcEnable: audio ? "all" : lane !== undefined && lane < 0 ? "audio" : "video",
      },
      properties(clip, media, timelineHeight, audio),
    ),
  );
  wrapper.children.push(metadata(clip, audio));
  return wrapper;
}
function parentFor(items: { start: Rational; end: Rational; item: Node }[], at: Rational) {
  return items.find((entry) => compare(entry.start, at) <= 0 && compare(at, entry.end) < 0) ?? items.at(-1);
}
function extent(timeline: Timeline): Rational {
  return timeline.tracks
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .reduce((end, clip) => max(end, add(clip.timeline_start, clip.duration)), zero);
}
function loss(
  entity_id: string,
  entity_kind: LossItem["entity_kind"],
  feature: string,
  status: LossItem["status"],
  severity: LossItem["severity"],
  reason_code: string,
  consequence: string,
  range: { start: Rational; duration: Rational } | null = null,
): LossItem {
  return {
    entity_id,
    entity_kind,
    feature,
    status,
    severity,
    reason_code,
    consequence,
    timeline_range: range ? { start: sec(range.start), duration: sec(range.duration) } : null,
    fallback_asset: null,
    recoverable_from_source_project: true,
  };
}
const dtdDir = "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources";
export const fcpxmlExporter: Exporter & { validationNotes?: string } = {
  version: "1.11.0",
  git_sha: "0000000",
  async gitSha() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    await stat(join(root, ".git"));
    return (await promisify(execFile)("git", ["rev-parse", "--short", "HEAD"], { cwd: root })).stdout.trim();
  },
  async generate(project, timeline, profile, mediaPaths) {
    if (profile !== "fcp-11-fcpxml-1.13" && profile !== "fcp-10.6-fcpxml-1.11")
      throw new Error(`Unsupported FCPXML profile: ${profile}`);
    const version = profile.endsWith("1.13") ? "1.13" : "1.11";
    let next = 1;
    const resources = node("resources");
    const sequenceFormat = `r${next++}`;
    resources.children.push(
      node("format", {
        id: sequenceFormat,
        frameDuration: frameDuration(timeline.edit_rate),
        width: String(timeline.format.width),
        height: String(timeline.format.height),
      }),
    );
    const formats = new Map<string, string>();
    for (const media of project.media) {
      const id = `r${next++}`;
      formats.set(media.id, id);
      resources.children.push(
        node("format", {
          id,
          ...(media.video ? { frameDuration: frameDuration(media.video.rate) } : {}),
          ...(media.video ? { width: String(media.video.width), height: String(media.video.height) } : {}),
        }),
      );
    }
    const refs = new Map<string, string>();
    for (const media of project.media) {
      const ref = `r${next++}`;
      refs.set(media.id, ref);
      const path = mediaPaths.get(media.id);
      if (!path) throw new Error(`Missing media path: ${media.id}`);
      resources.children.push(
        node(
          "asset",
          {
            id: ref,
            name: media.name ?? basename(path),
            start: sec(sourceOrigin(media)),
            duration: media.kind === "image" ? "0s" : sec(media.duration),
            hasVideo: media.video || media.kind === "image" ? "1" : "0",
            hasAudio: media.audio ? "1" : "0",
            format: formats.get(media.id)!,
            ...(media.audio
              ? { audioSources: "1", audioChannels: String(media.audio.channels), audioRate: "48000" }
              : {}),
          },
          [
            node("media-rep", { kind: "original-media", src: pathToFileURL(path).href }),
            node("metadata", {}, [node("md", { key: "com.zsir-cut.media-id", value: media.id })]),
          ],
        ),
      );
    }
    const video = timeline.tracks.filter((track): track is MediaTrack => track.kind === "video");
    const audio = timeline.tracks.filter((track): track is MediaTrack => track.kind === "audio");
    const transitions = video[0]?.transitions ?? [];
    let effect: string | undefined;
    if (transitions.length) {
      effect = `r${next++}`;
      resources.children.push(
        node("effect", { id: effect, name: "Cross Dissolve", uid: "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265" }),
      );
    }
    const tcStart = timecodeSeconds(timeline.start_timecode, timeline.edit_rate);
    const end = extent(timeline);
    const spine = node("spine");
    const anchors: { start: Rational; end: Rational; item: Node }[] = [];
    const paired = new Set<string>();
    const primary = [...(video[0]?.clips ?? [])].sort((a, b) => compare(a.timeline_start, b.timeline_start));
    let cursor = zero;
    const gap = (start: Rational, stop: Rational) => {
      const offset = add(tcStart, start);
      const item = node("gap", { offset: sec(offset), start: sec(offset), duration: sec(sub(stop, start)) });
      spine.children.push(item);
      anchors.push({ start, end: stop, item });
    };
    for (const clip of primary) {
      if (compare(cursor, clip.timeline_start) < 0) gap(cursor, clip.timeline_start);
      const match = audio[0]?.clips.find(
        (candidate) =>
          candidate.occurrence_id === clip.occurrence_id &&
          candidate.media_id === clip.media_id &&
          (candidate.enabled !== false) === (clip.enabled !== false) &&
          JSON.stringify(candidate.time_map?.map((point) => [sec(point.at), sec(point.source), point.interp])) ===
            JSON.stringify(clip.time_map?.map((point) => [sec(point.at), sec(point.source), point.interp])) &&
          (candidate.time_map
            ? compare(candidate.timeline_start, clip.timeline_start) === 0 &&
              compare(candidate.duration, clip.duration) === 0
            : compare(
                sub(candidate.timeline_start, clip.timeline_start),
                sub(candidate.source_start, clip.source_start),
              ) === 0),
      );
      if (match) paired.add(match.id);
      const media = project.media.find((entry) => entry.id === clip.media_id)!;
      const item = itemFor(
        clip,
        media,
        refs.get(media.id)!,
        add(tcStart, clip.timeline_start),
        timeline.format.height,
        undefined,
        match,
      );
      spine.children.push(item);
      anchors.push({ start: clip.timeline_start, end: add(clip.timeline_start, clip.duration), item });
      cursor = add(clip.timeline_start, clip.duration);
      for (const transition of transitions.filter((entry) => entry.from_clip === clip.id)) {
        const cut = cursor;
        const offset =
          transition.alignment === "start"
            ? cut
            : transition.alignment === "end"
              ? sub(cut, transition.duration)
              : sub(cut, div(transition.duration, rational(2n)));
        spine.children.push(
          node(
            "transition",
            { name: "Cross Dissolve", offset: sec(add(tcStart, offset)), duration: sec(transition.duration) },
            [node("filter-video", { ref: effect!, name: "Cross Dissolve" })],
          ),
        );
      }
    }
    if (compare(cursor, end) < 0) gap(cursor, end);
    const attach = (at: Rational) => {
      const parent = parentFor(anchors, at);
      if (!parent) throw new Error("No primary story element for anchor");
      return { parent: parent.item, offset: add(r(parent.item.attrs.start ?? "0s"), sub(at, parent.start)) };
    };
    for (const [kind, tracks] of [
      ["video", video],
      ["audio", audio],
    ] as const) {
      for (let index = kind === "video" ? 1 : 0; index < tracks.length; index++) {
        const track = tracks[index]!;
        for (const clip of track.clips) {
          if (paired.has(clip.id)) continue;
          const { parent, offset } = attach(clip.timeline_start);
          const media = project.media.find((entry) => entry.id === clip.media_id)!;
          insertBeforeMetadata(
            parent,
            itemFor(
              clip,
              media,
              refs.get(media.id)!,
              offset,
              timeline.format.height,
              kind === "video" ? index : -index - 1,
            ),
          );
        }
      }
    }
    let style = 1;
    const subtitleTracks = timeline.tracks.filter((track) => track.kind === "subtitle");
    const quantized = new Map<string, { start: Rational; end: Rational }[]>();
    for (const file of subtitleFiles(project, timeline).filter((entry) => entry.role === "subtitle_words")) {
      for (const cue of JSON.parse(file.data) as {
        cue_id: string;
        track_id: string;
        clip_ids: string[];
        start: string;
        end: string;
      }[]) {
        const key = `${cue.track_id}:${cue.cue_id}:${cue.clip_ids.join(",")}`;
        quantized.set(key, [...(quantized.get(key) ?? []), { start: r(cue.start), end: r(cue.end) }]);
      }
    }
    for (const cue of projectSubtitles(project, timeline.id).cues) {
      const trackIndex = subtitleTracks.findIndex((track) => track.id === cue.track_id);
      const track = subtitleTracks[trackIndex]!;
      const q = quantized.get(`${cue.track_id}:${cue.cue_id}:${cue.clip_ids.join(",")}`)?.shift();
      if (!q) continue;
      const { parent, offset } = attach(q.start);
      const styleId = `ts${style++}`;
      insertBeforeMetadata(
        parent,
        node(
          "caption",
          {
            lane: String(video.length - 1 + trackIndex + 1),
            offset: sec(offset),
            duration: sec(sub(q.end, q.start)),
            start: "0s",
            role: `SRT?captionFormat=SRT.${track.language}`,
          },
          [
            node("text", {}, [node("text-style", { ref: styleId }, [], cue.text)]),
            node("text-style-def", { id: styleId }, [node("text-style")]),
            node("note", {}, [], `zsir-cut cue=${cue.cue_id}${cue.occurrence_id ? ` occ=${cue.occurrence_id}` : ""}`),
          ],
        ),
      );
    }
    for (const marker of timeline.markers) {
      const { parent, offset } = attach(marker.at);
      insertBeforeMetadata(
        parent,
        node(marker.kind === "chapter" ? "chapter-marker" : "marker", {
          start: sec(offset),
          ...(compare(marker.duration, zero) > 0 ? { duration: sec(marker.duration) } : {}),
          value: marker.text,
          ...(marker.kind === "todo" ? { completed: "0" } : {}),
        }),
      );
    }
    const sequence = node(
      "sequence",
      {
        format: sequenceFormat,
        duration: sec(end),
        tcStart: sec(tcStart),
        tcFormat: timeline.drop_frame ? "DF" : "NDF",
        audioLayout: "stereo",
        audioRate: "48k",
      },
      [spine],
    );
    const root = node("fcpxml", { version }, [
      resources,
      node("library", {}, [
        node("event", { name: "zsir-cut" }, [
          node("project", { name: `${project.name} · ${timeline.name}` }, [sequence]),
        ]),
      ]),
    ]);
    return {
      name: `${timeline.name}.fcpxml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${xml(root)}\n`,
    };
  },
  async readBack(data, timeline) {
    const root = parseXml(data.toString());
    const resources = child(root, "resources")!;
    const assets = new Map(children(resources, "asset").map((asset) => [asset.attrs.id!, asset]));
    const sequence = child(child(child(root, "library")!, "event")!, "project")!.children[0]!;
    const spine = child(sequence, "spine")!;
    const tcStart = r(sequence.attrs.tcStart ?? "0s");
    const rows: CutRow[] = [];
    const sourceRate = (asset: Node) => {
      const format = children(resources, "format").find((entry) => entry.attrs.id === asset.attrs.format);
      return format?.attrs.frameDuration
        ? div(rational(1n), r(format.attrs.frameDuration))
        : asset.attrs.hasAudio === "1"
          ? rational(48000n)
          : rational(25n);
    };
    const readItem = (
      item: Node,
      at: Rational,
      trackType: "video" | "audio",
      trackNumber: number,
      id: string,
      audioPair = false,
    ) => {
      const inside = item.tag === "clip" ? child(item, "asset-clip")! : item;
      const asset = assets.get(inside.attrs.ref!);
      if (!asset) throw new Error("Unknown FCPXML asset reference");
      const sourceOrigin = r(asset.attrs.start ?? "0s");
      const points = child(item, "timeMap") ? children(child(item, "timeMap")!, "timept") : [];
      const low = sub(r(inside.attrs.start ?? "0s"), sourceOrigin);
      const sourceIn =
        audioPair && item.attrs.audioStart
          ? sub(r(item.attrs.audioStart), sourceOrigin)
          : points.length
            ? add(low, r(points[0]!.attrs.value!))
            : low;
      const sourceOut =
        audioPair && item.attrs.audioDuration
          ? add(sourceIn, r(item.attrs.audioDuration))
          : points.length
            ? add(low, r(points.at(-1)!.attrs.value!))
            : add(sourceIn, r(item.attrs.duration!));
      const timelineIn =
        audioPair && item.attrs.audioStart
          ? add(at, sub(sourceIn, sub(r(inside.attrs.start ?? "0s"), sourceOrigin)))
          : at;
      const timelineOut = add(
        timelineIn,
        audioPair && item.attrs.audioDuration ? r(item.attrs.audioDuration) : r(item.attrs.duration!),
      );
      const rate = sourceRate(asset);
      rows.push({
        track_type: trackType,
        track_number: trackNumber,
        clip_id: id,
        media_id: md(asset, "com.zsir-cut.media-id") ?? "",
        timeline_in: round(mul(timelineIn, timeline.edit_rate)),
        timeline_out: round(mul(timelineOut, timeline.edit_rate)),
        source_in: round(mul(sourceIn, rate)),
        source_out: round(mul(sourceOut, rate)),
        speed:
          points.length > 2 ? "map" : sec(div(sub(sourceOut, sourceIn), sub(timelineOut, timelineIn))).slice(0, -1),
      });
    };
    const walk = (item: Node, seqAt: Rational, parentStart: Rational, primary = false) => {
      if (item.tag === "asset-clip" || item.tag === "clip") {
        const id = md(item, "com.zsir-cut.clip-id");
        if (!id) throw new Error("Missing clip ID metadata");
        const lane = Number(item.attrs.lane ?? 0);
        const kind = primary || lane > 0 ? "video" : "audio";
        readItem(item, seqAt, kind, primary ? 1 : lane > 0 ? lane + 1 : -lane, id);
        const pair = md(item, "com.zsir-cut.audio-clip-id");
        if (pair) readItem(item, seqAt, "audio", 1, pair, true);
      }
      for (const anchored of item.children.filter(
        (entry) => (entry.tag === "asset-clip" || entry.tag === "clip") && entry.attrs.lane !== undefined,
      )) {
        walk(anchored, add(seqAt, sub(r(anchored.attrs.offset ?? "0s"), parentStart)), r(anchored.attrs.start ?? "0s"));
      }
    };
    for (const item of spine.children)
      if (item.tag === "asset-clip" || item.tag === "clip" || item.tag === "gap") {
        const at = sub(r(item.attrs.offset ?? "0s"), tcStart);
        walk(item, at, r(item.attrs.start ?? "0s"), item.tag !== "gap");
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
        loss(
          style.id,
          "style",
          "subtitle_style",
          "approximated",
          "warning",
          "R_STYLE_NOT_REPRESENTABLE",
          "FCP 字幕使用默认外观，请在宿主中调整样式",
        ),
      );
    for (const missing of projectSubtitles(project, timeline.id).unprojected) {
      const cue = project.transcripts
        .flatMap((transcript) => transcript.cues.map((entry) => ({ transcript, entry })))
        .find(({ transcript, entry }) => {
          const ids = transcript.tokens.map((token) => token.id);
          const index = ids.indexOf(missing.token_id);
          return index >= ids.indexOf(entry.first_token) && index <= ids.indexOf(entry.last_token);
        });
      items.push(
        loss(
          cue?.entry.id ?? missing.token_id,
          "cue",
          "subtitle_text_timing",
          "unsupported",
          "warning",
          "R_SUB_UNPROJECTED",
          "字词落在定格或倒放区间，按规则不显示；请人工核对",
        ),
      );
    }
    let videoIndex = 0;
    for (const track of timeline.tracks) {
      if (track.kind === "subtitle") continue;
      if (track.kind === "video") videoIndex++;
      if (track.kind === "audio" || videoIndex > 1)
        for (const transition of track.transitions)
          items.push(
            loss(
              transition.id,
              "transition",
              "cross_dissolve",
              "unsupported",
              "error",
              "R_FORMAT_NO_FIELD",
              "非 V1 轨道的转场未导出，请在 FCP 中重建",
            ),
          );
    }
    for (const track of timeline.tracks) {
      if (track.ext)
        items.push(
          loss(track.id, "track", "ext_data", "unsupported", "warning", "R_EXT_DROPPED", "轨道扩展数据未写入 FCPXML"),
        );
      if (track.kind === "subtitle") {
        for (const cue of track.free_cues)
          if (cue.ext)
            items.push(
              loss(cue.id, "cue", "ext_data", "unsupported", "warning", "R_EXT_DROPPED", "字幕扩展数据未写入 FCPXML"),
            );
        continue;
      }
      for (const clip of track.clips) {
        if (clip.ext)
          items.push(
            loss(clip.id, "clip", "ext_data", "unsupported", "warning", "R_EXT_DROPPED", "片段扩展数据未写入 FCPXML", {
              start: clip.timeline_start,
              duration: clip.duration,
            }),
          );
        if (
          track.kind === "audio" &&
          (mul(clip.timeline_start, timeline.edit_rate).denominator !== 1n ||
            mul(add(clip.timeline_start, clip.duration), timeline.edit_rate).denominator !== 1n)
        )
          items.push(
            loss(
              clip.id,
              "clip",
              "clip_cut",
              "approximated",
              "warning",
              "R_FORMAT_NO_FIELD",
              "音频边界不在时间线帧网格上，FCP 中可能吸附到相邻帧",
              { start: clip.timeline_start, duration: clip.duration },
            ),
          );
      }
      for (const transition of track.transitions)
        if (transition.ext)
          items.push(
            loss(
              transition.id,
              "transition",
              "ext_data",
              "unsupported",
              "warning",
              "R_EXT_DROPPED",
              "转场扩展数据未写入 FCPXML",
            ),
          );
    }
    for (const media of project.media)
      if (media.ext)
        items.push(
          loss(media.id, "media", "ext_data", "unsupported", "warning", "R_EXT_DROPPED", "素材扩展数据未写入 FCPXML"),
        );
    for (const marker of timeline.markers)
      if (marker.ext)
        items.push(
          loss(marker.id, "marker", "ext_data", "unsupported", "warning", "R_EXT_DROPPED", "标记扩展数据未写入 FCPXML"),
        );
    if (timeline.ext)
      items.push(
        loss(
          timeline.id,
          "timeline",
          "ext_data",
          "unsupported",
          "warning",
          "R_EXT_DROPPED",
          "时间线扩展数据未写入 FCPXML",
        ),
      );
    if (project.ext)
      items.push(
        loss(
          project.id,
          "timeline",
          "ext_data",
          "unsupported",
          "warning",
          "R_EXT_DROPPED",
          "工程扩展数据未写入 FCPXML",
        ),
      );
    return items;
  },
  async validate(data) {
    const source = data.toString();
    const root = parseXml(source);
    const version = root.attrs.version;
    if (root.tag !== "fcpxml" || !["1.13", "1.11"].includes(version ?? "")) return false;
    const dtd = join(dtdDir, `FCPXMLv${version?.replace(".", "_")}.dtd`);
    try {
      await stat(dtd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.validationNotes = "本机未安装对应 FCP DTD；跳过 DTD 校验，剪辑表读回零帧比对通过";
      return true;
    }
    const dir = await mkdtemp(join(tmpdir(), "zcut-fcpxml-"));
    try {
      const path = join(dir, "timeline.fcpxml");
      await writeFile(
        path,
        source.replace("<!DOCTYPE fcpxml>", `<!DOCTYPE fcpxml SYSTEM "${pathToFileURL(dtd).href}">`),
      );
      await promisify(execFile)("xmllint", ["--noout", "--valid", path]);
      this.validationNotes = `FCPXML ${version} DTD 校验通过；剪辑表读回零帧比对通过`;
      return true;
    } catch (error) {
      this.validationNotes = `FCPXML ${version} DTD 校验失败：${String(error)}`;
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
export default fcpxmlExporter;
export type { CutRow, Exporter, LossItem, ProfileId } from "../../core/dist/index.js";
