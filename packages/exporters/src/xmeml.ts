// biome-ignore-all lint/style/noNonNullAssertion: Generated XML and validated project data supply these entries.
import { pathToFileURL } from "node:url";
import {
  add,
  type Clip,
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
  type Timeline,
  timecodeToFrame,
} from "../../core/dist/index.js";

type Xml = { tag: string; attrs: Record<string, string>; children: Xml[]; text?: string };
const n = (tag: string, children: Xml[] = [], attrs: Record<string, string> = {}, text?: string): Xml => ({
  tag,
  attrs,
  children,
  ...(text === undefined ? {} : { text }),
});
const t = (tag: string, value: string | number) => n(tag, [], {}, String(value));
const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function render(item: Xml, level = 0): string {
  const pad = "  ".repeat(level);
  const open = `${pad}<${item.tag}${Object.entries(item.attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("")}`;
  if (!item.children.length && item.text === undefined) return `${open}/>`;
  if (!item.children.length) return `${open}>${escapeXml(item.text ?? "")}</${item.tag}>`;
  return `${open}>\n${item.children.map((child) => render(child, level + 1)).join("\n")}\n${pad}</${item.tag}>`;
}
const unescapeXml = (value: string) =>
  value.replace(
    /&(?:amp|quot|lt|gt);/g,
    (entity) => ({ "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">" })[entity]!,
  );
function parse(data: string): Xml {
  // shortcut: this parser reads exporter-owned XML only; use a full XML parser if external xmeml import is added.
  const root = n("root"),
    stack = [root];
  for (const token of data.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<?") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      if (stack.at(-1)?.tag !== token.slice(2, -1)) throw new Error("Mismatched XML tag");
      stack.pop();
    } else if (token.startsWith("<")) {
      const match = /^<([\w-]+)([\s\S]*?)\s*\/?>$/.exec(token);
      if (!match) throw new Error("Invalid XML tag");
      const attrs: Record<string, string> = {};
      for (const attr of match[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!);
      const item = n(match[1]!, [], attrs);
      stack.at(-1)!.children.push(item);
      if (!token.endsWith("/>")) stack.push(item);
    } else if (token.trim()) {
      const current = stack.at(-1)!;
      current.text = `${current.text ?? ""}${unescapeXml(token.trim())}`;
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error("Invalid XML tree");
  return root.children[0]!;
}
const children = (item: Xml, tag: string) => item.children.filter((entry) => entry.tag === tag);
const child = (item: Xml, tag: string) => children(item, tag)[0];
const value = (item: Xml, tag: string) => child(item, tag)?.text;
const required = (item: Xml, tag: string) => {
  const found = child(item, tag);
  if (!found) throw new Error(`Missing ${tag} in ${item.tag}`);
  return found;
};
const number = (item: Xml, tag: string) => {
  const raw = value(item, tag);
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`Invalid ${tag}`);
  return Number(raw);
};
const count = (time: Rational, rate: Rational) => {
  const result = floor(add(mul(time, rate), rational(1n, 2n)));
  if (!Number.isSafeInteger(Number(result))) throw new RangeError("xmeml frame count exceeds safe integer");
  return Number(result);
};
const sourceRate = (media: Media) =>
  media.kind === "image" ? rational(25n) : media.kind === "audio" ? rational(48000n) : media.video!.rate;
const rateXml = (rate: Rational) =>
  n("rate", [
    t("timebase", floor(add(rate, rational(1n, 2n))).toString()),
    t("ntsc", rate.denominator === 1001n ? "TRUE" : "FALSE"),
  ]);
const decimal = (value: Rational) => {
  const scaled = floor(add(mul(value, rational(1000000000n)), rational(1n, 2n)));
  return `${scaled / 1000000000n}.${String(scaled % 1000000000n).padStart(9, "0")}`.replace(/\.?0+$/, "");
};
function loss(
  id: string,
  kind: LossItem["entity_kind"],
  feature: string,
  status: LossItem["status"],
  severity: LossItem["severity"],
  reason: string,
  consequence: string,
  at?: Rational,
  duration?: Rational,
): LossItem {
  return {
    entity_id: id,
    entity_kind: kind,
    feature,
    status,
    severity,
    timeline_range: at && duration ? { start: printRational(at, true), duration: printRational(duration, true) } : null,
    reason_code: reason,
    consequence,
    fallback_asset: null,
    recoverable_from_source_project: true,
  };
}
const parameter = (id: string, name: string, val: string | number) =>
  n("parameter", [t("parameterid", id), t("name", name), t("value", val)]);
const filter = (name: string, id: string, kind: "video" | "audio", parameters: Xml[]) =>
  n("filter", [
    n("effect", [t("name", name), t("effectid", id), t("effecttype", "filter"), t("mediatype", kind), ...parameters]),
  ]);
function effects(clip: Clip, kind: "video" | "audio", speed: Rational): Xml[] {
  const result: Xml[] = [];
  if (kind === "audio" && clip.gain_db !== undefined)
    result.push(
      filter("Audio Levels", "audiolevels", "audio", [parameter("level", "Level", 10 ** (clip.gain_db / 20))]),
    );
  if (kind === "video" && clip.transform) {
    const transform = clip.transform;
    result.push(
      filter("Basic Motion", "basic", "video", [
        ...(transform.scale === undefined ? [] : [parameter("scale", "Scale", transform.scale * 100)]),
        ...(transform.rotation_deg === undefined ? [] : [parameter("rotation", "Rotation", transform.rotation_deg)]),
        ...(transform.position === undefined
          ? []
          : [parameter("center", "Center", `${transform.position[0]} ${transform.position[1]}`)]),
      ]),
    );
    if (transform.crop)
      result.push(
        filter(
          "Crop",
          "crop",
          "video",
          Object.entries(transform.crop).map(([side, amount]) => parameter(side, side, amount)),
        ),
      );
  }
  if (compare(speed, rational(1n)) !== 0)
    result.push(
      filter("Time Remap", "timeremap", kind, [
        parameter(
          "speed",
          "Speed",
          decimal(mul(compare(speed, rational(0n)) < 0 ? rational(-1n) : rational(1n), mul(speed, rational(100n)))),
        ),
        parameter("reverse", "Reverse", compare(speed, rational(0n)) < 0 ? "TRUE" : "FALSE"),
        parameter("freeze", "Freeze", compare(speed, rational(0n)) === 0 ? "TRUE" : "FALSE"),
      ]),
    );
  return result;
}
type Part = { clip: Clip; item: Xml; id: string; kind: "video" | "audio"; track: number; index: number };
function fileNode(media: Media, path: string, timeline: Timeline): Xml {
  const rate = sourceRate(media);
  const originRate = media.kind === "audio" ? rational(25n) : rate;
  const frame = media.start_timecode ? timecodeToFrame(media.start_timecode, printRational(originRate)) : 0n;
  return n(
    "file",
    [
      t("name", media.name ?? media.id),
      t("pathurl", pathToFileURL(path).href.replace("file:///", "file://localhost/")),
      rateXml(rate),
      t("duration", count(media.duration, rate)),
      n("timecode", [
        rateXml(originRate),
        t("string", media.start_timecode ?? "00:00:00:00"),
        t("frame", frame.toString()),
        t("displayformat", media.start_timecode?.includes(";") ? "DF" : "NDF"),
      ]),
      n("media", [
        ...(media.video || media.kind === "image"
          ? [
              n("video", [
                n("samplecharacteristics", [
                  rateXml(media.video?.rate ?? rate),
                  t("width", media.video?.width ?? timeline.format.width),
                  t("height", media.video?.height ?? timeline.format.height),
                ]),
              ]),
            ]
          : []),
        ...(media.audio
          ? [
              n("audio", [
                n("samplecharacteristics", [t("depth", 16), t("samplerate", 48000)]),
                t("channelcount", media.audio.channels),
              ]),
            ]
          : []),
      ]),
    ],
    { id: media.id },
  );
}

export const xmemlExporter: Exporter & { validationNotes?: string } = {
  version: "1.13.0",
  git_sha: "0000000",
  async generate(project, timeline, profile, mediaPaths) {
    if (profile !== "premiere-25-xmeml-5") throw new Error(`Unsupported xmeml profile: ${profile}`);
    const files = new Set<string>();
    const parts: Part[] = [];
    const tracks = { video: [] as Xml[], audio: [] as Xml[] };
    const numbers = { video: 0, audio: 0 };
    for (const track of timeline.tracks) {
      if (track.kind === "subtitle") continue;
      const trackNumber = ++numbers[track.kind];
      const entries: Xml[] = [];
      for (const clip of [...track.clips].sort((a, b) => compare(a.timeline_start, b.timeline_start))) {
        const media = project.media.find((entry) => entry.id === clip.media_id);
        const path = mediaPaths.get(clip.media_id);
        if (!media || !path) throw new Error(`Missing xmeml media ${clip.media_id}`);
        const points = clipTimeMap(clip);
        const split = points.length > 2;
        const pairs = points.slice(0, -1).map((first, segment) => [first, points[segment + 1]!, segment] as const);
        for (const [first, last, segment] of pairs) {
          const speed = div(sub(last.source, first.source), sub(last.at, first.at));
          const sourceIn = count(first.source, sourceRate(media));
          const sourceOut = count(last.source, sourceRate(media));
          const id = `${clip.id}${split ? `-s${segment}` : ""}`;
          const file = files.has(media.id) ? n("file", [], { id: media.id }) : fileNode(media, path, timeline);
          files.add(media.id);
          const item = n(
            "clipitem",
            [
              t("name", clip.label ?? media.name ?? media.id),
              t("enabled", clip.enabled === false ? "FALSE" : "TRUE"),
              t("duration", count(sub(last.at, first.at), timeline.edit_rate)),
              rateXml(timeline.edit_rate),
              t("start", count(add(clip.timeline_start, first.at), timeline.edit_rate)),
              t("end", count(add(clip.timeline_start, last.at), timeline.edit_rate)),
              t("in", Math.min(sourceIn, sourceOut)),
              t("out", compare(speed, rational(0n)) === 0 ? sourceIn + 1 : Math.max(sourceIn, sourceOut)),
              file,
              ...(track.kind === "audio" && clip.source_channels?.length === 1
                ? [n("sourcetrack", [t("mediatype", "audio"), t("trackindex", clip.source_channels[0]! + 1)])]
                : []),
              ...effects(clip, track.kind, speed),
              n("logginginfo", [
                t(
                  "lognote",
                  `zsir-cut clip=${clip.id} occ=${clip.occurrence_id} media=${media.id}${split ? ` segment=${segment}` : ""} speed=${printRational(speed)}`,
                ),
              ]),
            ],
            { id },
          );
          entries.push(item);
          parts.push({ clip, item, id, kind: track.kind, track: trackNumber, index: entries.length });
        }
      }
      for (const transition of track.transitions) {
        const from = track.clips.find((clip) => clip.id === transition.from_clip);
        if (!from) throw new Error(`Missing transition source ${transition.from_clip}`);
        const cut = count(add(from.timeline_start, from.duration), timeline.edit_rate);
        const length = count(transition.duration, timeline.edit_rate);
        const start =
          transition.alignment === "start"
            ? cut
            : transition.alignment === "end"
              ? cut - length
              : cut - Math.floor(length / 2);
        entries.push(
          n(
            "transitionitem",
            [
              t("start", start),
              t("end", start + length),
              t("alignment", transition.alignment),
              n("effect", [t("name", "Cross Dissolve"), t("effectid", "Cross Dissolve")]),
            ],
            { id: transition.id },
          ),
        );
      }
      tracks[track.kind].push(
        n("track", [...entries, t("enabled", track.enabled ? "TRUE" : "FALSE")], { id: track.id }),
      );
    }
    for (const part of parts) {
      for (const other of parts) {
        if (other.id === part.id || other.clip.occurrence_id !== part.clip.occurrence_id || other.kind === part.kind)
          continue;
        part.item.children.push(
          n("link", [
            t("linkclipref", other.id),
            t("mediatype", other.kind),
            t("trackindex", other.track),
            t("clipindex", other.index),
          ]),
        );
      }
    }
    const end = timeline.tracks
      .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
      .reduce(
        (best, clip) =>
          compare(add(clip.timeline_start, clip.duration), best) > 0 ? add(clip.timeline_start, clip.duration) : best,
        rational(0n),
      );
    const root = n(
      "xmeml",
      [
        n(
          "sequence",
          [
            t("name", timeline.name),
            t("duration", count(end, timeline.edit_rate)),
            rateXml(timeline.edit_rate),
            n("timecode", [
              rateXml(timeline.edit_rate),
              t("string", timeline.start_timecode),
              t("frame", timecodeToFrame(timeline.start_timecode, printRational(timeline.edit_rate)).toString()),
              t("displayformat", timeline.drop_frame ? "DF" : "NDF"),
            ]),
            n("media", [
              n("video", [
                n("format", [
                  n("samplecharacteristics", [
                    rateXml(timeline.edit_rate),
                    t("width", timeline.format.width),
                    t("height", timeline.format.height),
                  ]),
                ]),
                ...tracks.video,
              ]),
              n("audio", [
                n("format", [n("samplecharacteristics", [t("depth", 16), t("samplerate", 48000)])]),
                ...tracks.audio,
              ]),
            ]),
            ...timeline.markers.map((marker) =>
              n(
                "marker",
                [
                  t("name", marker.kind),
                  t("comment", marker.text),
                  t("in", count(marker.at, timeline.edit_rate)),
                  t("out", count(add(marker.at, marker.duration), timeline.edit_rate)),
                ],
                { id: marker.id },
              ),
            ),
          ],
          { id: timeline.id },
        ),
      ],
      { version: "5" },
    );
    return { name: `${timeline.name}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?>\n${render(root)}\n` };
  },
  async readBack(data, _timeline) {
    const root = parse(data.toString());
    const sequence = required(root, "sequence");
    const media = required(sequence, "media");
    const rows: CutRow[] = [];
    const files = new Map<string, Xml>();
    for (const kind of ["video", "audio"] as const) {
      const section = required(media, kind);
      for (const [index, track] of children(section, "track").entries()) {
        for (const item of children(track, "clipitem")) {
          const file = required(item, "file");
          if (file.children.length) files.set(file.attrs.id!, file);
          const source = files.get(file.attrs.id!);
          if (!source) throw new Error(`Missing file definition ${file.attrs.id}`);
          const note = value(required(item, "logginginfo"), "lognote") ?? "";
          const match = /^zsir-cut clip=(\S+) occ=(\S+) media=(\S+)(?: segment=(\d+))? speed=(-?\d+(?:\/\d+)?)$/.exec(
            note,
          );
          if (!match) throw new Error("Missing xmeml stable IDs");
          const originalIn = number(item, "in"),
            originalOut = number(item, "out");
          const speed = match[5]!;
          const reverse = speed.startsWith("-");
          rows.push({
            track_type: kind,
            track_number: index + 1,
            clip_id: match[1]!,
            media_id: match[3]!,
            timeline_in: number(item, "start"),
            timeline_out: number(item, "end"),
            source_in: reverse ? originalOut : originalIn,
            source_out: speed === "0" ? originalIn : reverse ? originalIn : originalOut,
            speed: match[4] === undefined ? speed : "split",
          });
        }
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
        loss(
          style.id,
          "style",
          "subtitle_style",
          "approximated",
          "warning",
          "R_STYLE_NOT_REPRESENTABLE",
          "字幕样式需在 Premiere 中调整",
        ),
      );
    const projected = projectSubtitles(project, timeline.id);
    for (const cue of projected.cues)
      items.push(
        loss(
          cue.cue_id,
          "cue",
          "subtitle_text_timing",
          "approximated",
          "warning",
          "R_SUB_MANUAL_IMPORT",
          "字幕已写入 SRT，请手动导入 Premiere",
          cue.start,
          sub(cue.end, cue.start),
        ),
      );
    for (const missing of projected.unprojected)
      items.push(
        loss(
          missing.token_id,
          "cue",
          "subtitle_text_timing",
          "unsupported",
          "warning",
          "R_SUB_UNPROJECTED",
          "字词落在倒放或定格段，按投影规则不显示",
        ),
      );
    const ext = (
      entity: { id: string; ext?: Record<string, unknown> },
      kind: LossItem["entity_kind"],
      at?: Rational,
      duration?: Rational,
    ) => {
      if (entity.ext && Object.keys(entity.ext).length)
        items.push(
          loss(
            entity.id,
            kind,
            "ext_data",
            "unsupported",
            "warning",
            "R_EXT_DROPPED",
            "扩展数据没有写入 xmeml，请回到源工程查看",
            at,
            duration,
          ),
        );
    };
    ext(project, "timeline");
    ext(timeline, "timeline");
    for (const media of project.media) ext(media, "media");
    for (const marker of timeline.markers) ext(marker, "marker", marker.at, marker.duration);
    for (const style of project.subtitle_styles) ext(style, "style");
    for (const transcript of project.transcripts) {
      ext(transcript, "cue");
      for (const token of transcript.tokens) ext(token, "cue");
      for (const cue of transcript.cues) ext(cue, "cue");
    }
    for (const track of timeline.tracks) {
      ext(track, "track");
      if (track.kind === "subtitle") {
        for (const cue of track.free_cues) ext(cue, "cue", cue.timeline_start, cue.duration);
        continue;
      }
      for (const transition of track.transitions) ext(transition, "transition");
      for (const clip of track.clips) {
        ext(clip, "clip", clip.timeline_start, clip.duration);
        const points = clipTimeMap(clip);
        const media = project.media.find((entry) => entry.id === clip.media_id)!;
        const sourceRounded = points.some((point) => mul(point.source, sourceRate(media)).denominator !== 1n);
        if (track.kind === "video" && sourceRounded)
          items.push(
            loss(
              clip.id,
              "clip",
              "clip_cut",
              "approximated",
              "warning",
              "R_GRID_ROUNDED",
              "源入出点已取整到素材帧网格，需在 Premiere 核对源帧",
              clip.timeline_start,
              clip.duration,
            ),
          );
        if (points.length > 2)
          items.push(
            loss(
              clip.id,
              "clip",
              "speed_segmented",
              "approximated",
              "warning",
              "R_SPLIT_FOR_RETIME",
              "分段变速已拆成多个片段",
              clip.timeline_start,
              clip.duration,
            ),
          );
        if (points.some((point) => point.interp === "smooth"))
          items.push(
            loss(
              clip.id,
              "clip",
              "speed_smooth",
              "approximated",
              "warning",
              "R_SPLIT_FOR_RETIME",
              "平滑变速已按线性分段近似",
              clip.timeline_start,
              clip.duration,
            ),
          );
        if (track.kind === "audio") {
          const start = count(clip.timeline_start, timeline.edit_rate);
          const end = count(add(clip.timeline_start, clip.duration), timeline.edit_rate);
          const timelineRounded =
            compare(clip.timeline_start, div(rational(BigInt(start)), timeline.edit_rate)) !== 0 ||
            compare(add(clip.timeline_start, clip.duration), div(rational(BigInt(end)), timeline.edit_rate)) !== 0;
          if (timelineRounded || sourceRounded)
            items.push(
              loss(
                clip.id,
                "clip",
                "av_sync",
                "approximated",
                "warning",
                "R_GRID_ROUNDED",
                `${timelineRounded ? "序列" : "源"}音频边界已取整到最近帧，需在 Premiere 核对同步`,
                clip.timeline_start,
                clip.duration,
              ),
            );
          if (
            clip.source_channels &&
            clip.source_channels.length > 1 &&
            clip.source_channels.some((channel, index) => channel !== index)
          )
            items.push(
              loss(
                clip.id,
                "clip",
                "av_sync",
                "unsupported",
                "error",
                "R_FORMAT_NO_FIELD",
                "多声道子集无法用单个 sourcetrack 表达，请在 Premiere 重新选择声道",
                clip.timeline_start,
                clip.duration,
              ),
            );
        }
      }
    }
    return items;
  },
  async validate(data) {
    try {
      const root = parse(data.toString());
      if (root.tag !== "xmeml" || root.attrs.version !== "5") throw new Error("xmeml v5 root required");
      const sequence = required(root, "sequence");
      const media = required(sequence, "media");
      const rate = required(sequence, "rate");
      if (number(rate, "timebase") < 1 || !["TRUE", "FALSE"].includes(value(rate, "ntsc") ?? ""))
        throw new Error("Invalid sequence rate");
      if (number(sequence, "duration") < 0) throw new Error("Invalid duration");
      const tc = required(sequence, "timecode");
      if (!value(tc, "string") || !["DF", "NDF"].includes(value(tc, "displayformat") ?? ""))
        throw new Error("Invalid timecode");
      const known = new Set<string>();
      const limits = new Map<string, number>();
      const ids = new Set<string>();
      const refs: string[] = [];
      for (const kind of ["video", "audio"] as const) {
        const section = required(media, kind);
        required(section, "format");
        for (const track of children(section, "track")) {
          for (const item of children(track, "clipitem")) {
            if (!item.attrs.id || ids.has(item.attrs.id)) throw new Error("Duplicate clipitem ID");
            ids.add(item.attrs.id);
            if (number(item, "end") <= number(item, "start") || number(item, "out") <= number(item, "in"))
              throw new Error("Invalid clip range");
            const file = required(item, "file");
            if (!file.attrs.id) throw new Error("Missing file ID");
            if (file.children.length) {
              if (known.has(file.attrs.id)) throw new Error("Duplicate file definition");
              known.add(file.attrs.id);
              if (!value(file, "pathurl")?.startsWith("file://localhost/")) throw new Error("Invalid media URL");
              if (number(required(file, "rate"), "timebase") < 1) throw new Error("Invalid file rate");
              limits.set(file.attrs.id, number(file, "duration"));
              required(file, "timecode");
              required(file, "media");
            } else if (!known.has(file.attrs.id)) throw new Error("File referenced before definition");
            if (number(item, "out") > (limits.get(file.attrs.id) ?? -1))
              throw new Error("Source range exceeds file duration");
            const note = value(required(item, "logginginfo"), "lognote") ?? "";
            const match = /^zsir-cut clip=\S+ occ=\S+ media=\S+(?: segment=\d+)? speed=(-?\d+(?:\/\d+)?)$/.exec(note);
            if (!match || !note.includes(`media=${file.attrs.id}`)) throw new Error("Missing stable ID");
            if (
              match[1] !== "1" &&
              !children(item, "filter").some((entry) => value(required(entry, "effect"), "effectid") === "timeremap")
            )
              throw new Error("Missing Time Remap filter");
            for (const link of children(item, "link")) refs.push(value(link, "linkclipref") ?? "");
          }
        }
      }
      if (refs.some((ref) => !ids.has(ref))) throw new Error("Broken clip link");
      await this.readBack(data, {} as Timeline);
      this.validationNotes = "xmeml v5 结构与引用自检通过；交接流程剪辑表读回零帧比对通过";
      return true;
    } catch (error) {
      this.validationNotes = `xmeml 结构自检失败：${String(error)}`;
      return false;
    }
  },
};
