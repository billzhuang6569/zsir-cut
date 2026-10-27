// biome-ignore-all lint/style/noNonNullAssertion: Project schema and segment construction validate these indexed entries.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fingerprint } from "./fingerprint.js";
import { projectSubtitles } from "./project/projection.js";
import { clipTimeMap, mapSourceTimeToClip } from "./project/time-map.js";
import type { Project, Timeline } from "./project/types.js";
import {
  add,
  compare,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  type Rational,
  rational,
  sub,
} from "./rational.js";
import { validateLossReport, validateManifest } from "./schema.js";

export const PROFILES = {
  "fcp-11-fcpxml-1.13": { host: "final_cut_pro", min_host_version: "11", format: "fcpxml", format_version: "1.13" },
  "fcp-10.6-fcpxml-1.11": { host: "final_cut_pro", min_host_version: "10.6", format: "fcpxml", format_version: "1.11" },
  "resolve-18.5-otio": { host: "davinci_resolve", min_host_version: "18.5", format: "otio", format_version: "0.17" },
  "resolve-21-fcpxml-1.11": {
    host: "davinci_resolve",
    min_host_version: "21",
    format: "fcpxml",
    format_version: "1.11",
  },
  "premiere-25-xmeml-5": { host: "premiere_pro", min_host_version: "25", format: "xmeml", format_version: "5" },
} as const;
export type ProfileId = keyof typeof PROFILES;
export type CutRow = {
  track_type: "video" | "audio";
  track_number: number;
  clip_id: string;
  media_id: string;
  timeline_in: number;
  timeline_out: number;
  source_in: number;
  source_out: number;
  speed: string;
  timeline_in_exact?: string;
  timeline_out_exact?: string;
};
export type GridTolerance = { start: Rational; end: Rational; halfFrame: Rational };
export type LossItem = {
  entity_id: string;
  entity_kind: "media" | "track" | "clip" | "transition" | "marker" | "cue" | "style" | "timeline";
  feature: string;
  status: "approximated" | "baked" | "unsupported";
  severity: "info" | "warning" | "error";
  timeline_range: { start: string; duration: string } | null;
  reason_code: string;
  consequence: string;
  fallback_asset: string | null;
  editable_caption_track?: string | null;
  recoverable_from_source_project: boolean;
};
export interface Exporter {
  readonly version: string;
  readonly git_sha: string;
  validationNotes?: string;
  gitSha?(): Promise<string>;
  generate(
    project: Project,
    timeline: Timeline,
    profile: ProfileId,
    mediaPaths: ReadonlyMap<string, string>,
    exportId?: string,
  ): Promise<{ name: string; data: string | Uint8Array }>;
  readBack(data: string | Uint8Array, timeline: Timeline): Promise<CutRow[]>;
  losses(project: Project, timeline: Timeline, profile: ProfileId): LossItem[];
  validate(data: string | Uint8Array): Promise<boolean>;
  gridTolerances?(project: Project, timeline: Timeline): Map<string, GridTolerance>;
}
export type HostVersions = Partial<Record<"final_cut_pro" | "davinci_resolve" | "premiere_pro", string>>;
export type HostDetector = () => Promise<HostVersions>;
const zero = rational(0n);
const round = (value: Rational) => floor(add(value, rational(1n, 2n)));
const count = (value: Rational) => {
  const n = round(value);
  if (!Number.isSafeInteger(Number(n))) throw new RangeError("Frame count exceeds safe integer");
  return Number(n);
};
const max = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const min = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const j = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const version = (value: string) => value.split(".").map(Number);
const atLeast = (actual: string, needed: string) => {
  const left = version(actual),
    right = version(needed);
  for (let i = 0; i < right.length; i++) {
    if ((left[i] ?? 0) !== right[i]) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return true;
};

export async function detectHosts(): Promise<HostVersions> {
  const hosts: HostVersions = {};
  const applications = await readdir("/Applications").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const premiere = applications
    .filter((name) => /^Adobe Premiere Pro \d{4}$/.test(name))
    .sort()
    .at(-1);
  for (const [host, app] of [
    ["final_cut_pro", "Final Cut Pro.app"],
    ["davinci_resolve", "DaVinci Resolve.app"],
    ["premiere_pro", premiere ? `${premiere}/${premiere}.app` : ""],
  ] as const) {
    if (!app) continue;
    const path = join("/Applications", app, "Contents/Info.plist");
    try {
      const plist = await readFile(path, "utf8");
      const found = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      hosts[host] = found
        ? found[1]!
        : (
            await promisify(execFile)("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleShortVersionString", path])
          ).stdout.trim();
    } catch {
      /* Host is not installed. */
    }
  }
  return hosts;
}
export async function defaultProfile(
  detect: HostDetector = detectHosts,
  settings = join(homedir(), ".zsir-cut", "hosts.json"),
): Promise<ProfileId | undefined> {
  let hosts: HostVersions;
  try {
    hosts = JSON.parse(await readFile(settings, "utf8")) as HostVersions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hosts = await detect();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, j(hosts));
  }
  const order: ProfileId[] = ["fcp-11-fcpxml-1.13", "fcp-10.6-fcpxml-1.11", "resolve-18.5-otio", "premiere-25-xmeml-5"];
  return order.find(
    (id) => hosts[PROFILES[id].host] && atLeast(hosts[PROFILES[id].host]!, PROFILES[id].min_host_version),
  );
}

export function cuttingList(project: Project, timeline: Timeline, profile: ProfileId): CutRow[] {
  const rows: CutRow[] = [];
  const numbers = { video: 0, audio: 0 };
  for (const track of timeline.tracks) {
    if (track.kind === "subtitle") continue;
    const number = ++numbers[track.kind];
    for (const clip of track.clips) {
      const media = project.media.find((item) => item.id === clip.media_id);
      if (!media) throw new Error(`Missing media ${clip.media_id}`);
      const points = clipTimeMap(clip);
      const split = PROFILES[profile].format !== "fcpxml" && points.length > 2;
      const parts = split
        ? points.slice(0, -1).map((point, i) => [point, points[i + 1]!] as const)
        : [[points[0]!, points.at(-1)!] as const];
      for (const [first, last] of parts) {
        const sourceRate =
          media.kind === "image"
            ? rational(25n)
            : media.kind === "audio"
              ? rational(48000n)
              : (media.video?.rate ?? rational(48000n));
        const source = (time: Rational) => count(mul(time, sourceRate));
        rows.push({
          track_type: track.kind,
          track_number: number,
          clip_id: clip.id,
          media_id: clip.media_id,
          timeline_in: count(mul(add(clip.timeline_start, first.at), timeline.edit_rate)),
          timeline_out: count(mul(add(clip.timeline_start, last.at), timeline.edit_rate)),
          source_in: source(first.source),
          source_out: source(last.source),
          speed: split
            ? "split"
            : points.length > 2
              ? "map"
              : printRational(div(sub(last.source, first.source), sub(last.at, first.at))),
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
}
export function compareCuttingLists(
  expected: CutRow[],
  actual: CutRow[],
  unsupported = new Set<string>(),
  gridTolerances = new Map<string, GridTolerance>(),
) {
  expected = expected.filter((row) => !unsupported.has(row.clip_id));
  actual = actual.filter((row) => !unsupported.has(row.clip_id));
  const differences: { row: number; expected: CutRow | null; actual: CutRow | null }[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const a = expected[i],
      b = actual[i];
    const grid = a && gridTolerances.get(a.clip_id);
    const within = (exact: string | undefined, target: Rational) => {
      if (!exact || !grid) return false;
      const difference = sub(parseRational(exact, true), target);
      return compare(difference, grid.halfFrame) <= 0 && compare(difference, mul(grid.halfFrame, rational(-1n))) >= 0;
    };
    if (
      !a ||
      !b ||
      (grid ? !within(b.timeline_in_exact, grid.start) : a.timeline_in !== b.timeline_in) ||
      (grid ? !within(b.timeline_out_exact, grid.end) : a.timeline_out !== b.timeline_out) ||
      a.source_in !== b.source_in ||
      a.source_out !== b.source_out
    )
      differences.push({ row: i + 1, expected: a ?? null, actual: b ?? null });
  }
  return { zero_frame_deviation: differences.length === 0, differences };
}

export function quantizeCue(start: Rational, end: Rational, rate: Rational, clipStart: Rational, clipEnd: Rational) {
  const frame = div(rational(1n), rate);
  let from = mul(rational(round(mul(start, rate))), frame);
  let to = mul(rational(round(mul(end, rate))), frame);
  if (compare(to, add(from, frame)) < 0) to = add(from, frame);
  from = max(from, clipStart);
  to = min(to, clipEnd);
  return compare(to, from) > 0 ? { start: from, end: to } : null;
}
const milliseconds = (time: Rational) => Number(round(mul(time, rational(1000n))));
const srtTime = (ms: number) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
export function subtitleFiles(project: Project, timeline: Timeline) {
  const projected = projectSubtitles(project, timeline.id);
  const files: { name: string; role: "subtitle" | "subtitle_words"; language: string; data: string }[] = [];
  const tracks = timeline.tracks.filter((track) => track.kind === "subtitle");
  for (const track of tracks) {
    const cues = projected.cues.filter((cue) => cue.track_id === track.id);
    const sameLanguage = tracks.filter((item) => item.language === track.language).length > 1;
    const stem = `${track.language}${sameLanguage ? `_${track.name.replaceAll(/[\\/]/g, "_")}` : ""}`;
    const words = [];
    const srt = [];
    for (const cue of cues) {
      const clips = timeline.tracks
        .flatMap((item) => (item.kind === "subtitle" ? [] : item.clips))
        .filter((clip) => cue.clip_ids.includes(clip.id));
      const boundaryStart = clips.length
        ? clips.slice(1).reduce((value, clip) => min(value, clip.timeline_start), clips[0]!.timeline_start)
        : zero;
      const boundaryEnd = clips.length
        ? clips
            .slice(1)
            .reduce(
              (value, clip) => max(value, add(clip.timeline_start, clip.duration)),
              add(clips[0]!.timeline_start, clips[0]!.duration),
            )
        : cue.end;
      const q = quantizeCue(cue.start, cue.end, timeline.edit_rate, boundaryStart, boundaryEnd);
      if (!q) continue;
      const visible = cue.token_ids.flatMap((id) => {
        const transcript = project.transcripts.find((item) => item.tokens.some((token) => token.id === id));
        const token = transcript?.tokens.find((item) => item.id === id);
        if (!token?.text) return [];
        for (const clip of clips.filter((item) => item.media_id === transcript?.media_id)) {
          const points = clipTimeMap(clip);
          for (let index = 0; index < points.length - 1; index++) {
            const first = points[index]!,
              last = points[index + 1]!;
            if (
              compare(last.source, first.source) <= 0 ||
              compare(token.align.end, first.source) <= 0 ||
              compare(token.align.start, last.source) >= 0
            )
              continue;
            const start = add(
              clip.timeline_start,
              mapSourceTimeToClip(max(token.align.start, first.source), first, last)!,
            );
            const end = add(clip.timeline_start, mapSourceTimeToClip(min(token.align.end, last.source), first, last)!);
            const clippedStart = max(start, cue.start),
              clippedEnd = min(end, cue.end);
            if (compare(clippedEnd, clippedStart) <= 0) continue;
            return [
              {
                token_id: id,
                text: token.text,
                start: printRational(clippedStart, true),
                end: printRational(clippedEnd, true),
              },
            ];
          }
        }
        return [];
      });
      words.push({
        cue_id: cue.cue_id,
        track_id: track.id,
        clip_ids: cue.clip_ids,
        start: printRational(q.start, true),
        end: printRational(q.end, true),
        start_ms: milliseconds(q.start),
        end_ms: milliseconds(q.end),
        text: cue.text,
        lines: cue.lines,
        words: visible,
      });
      srt.push(
        `${srt.length + 1}\n${srtTime(milliseconds(q.start))} --> ${srtTime(milliseconds(q.end))}\n${cue.text}\n`,
      );
    }
    files.push({ name: `${stem}.srt`, role: "subtitle", language: track.language, data: `${srt.join("\n")}\n` });
    files.push({ name: `${stem}.words.json`, role: "subtitle_words", language: track.language, data: j(words) });
  }
  return files;
}

export async function lossReport(
  project: Project,
  profile: ProfileId,
  exporter: Exporter,
  exportId: string,
  phase: "preview" | "final",
  timeline: Timeline,
  at: string,
  projectPath: string,
) {
  const items = [...exporter.losses(project, timeline, profile)];
  for (const media of project.media) {
    const path = resolve(dirname(projectPath), media.path);
    let online = false;
    try {
      const info = await stat(path);
      online =
        info.isFile() && info.size === media.size_bytes && (await fingerprint(path)).value === media.fingerprint.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!online)
      items.push({
        entity_id: media.id,
        entity_kind: "media",
        feature: "media",
        status: "unsupported",
        severity: "error",
        timeline_range: null,
        reason_code: "R_MEDIA_OFFLINE",
        consequence: "素材离线或指纹不符，请重链接后再导入",
        fallback_asset: null,
        recoverable_from_source_project: true,
      });
  }
  const summary = {
    approximated: 0,
    baked: 0,
    unsupported: 0,
    worst_severity: "none",
    preserved_by_feature: {} as Record<string, number>,
  };
  const severity = { none: 0, info: 1, warning: 2, error: 3 };
  for (const item of items) {
    summary[item.status]++;
    if (severity[item.severity] > severity[summary.worst_severity as keyof typeof severity])
      summary.worst_severity = item.severity;
  }
  const preserve = (id: string, feature: string) => {
    if (!items.some((item) => item.entity_id === id && item.feature === feature))
      summary.preserved_by_feature[feature] = (summary.preserved_by_feature[feature] ?? 0) + 1;
  };
  preserve(timeline.id, "timecode");
  for (const media of project.media) preserve(media.id, "media");
  for (const track of timeline.tracks) {
    if (track.kind === "subtitle") {
      for (const override of track.overrides) preserve(override.cue_id, "subtitle_override");
      continue;
    }
    for (const clip of track.clips) {
      for (const feature of ["clip_cut", "clip_enabled", "av_sync"]) preserve(clip.id, feature);
      if (clip.gain_db !== undefined) preserve(clip.id, "gain");
      if (clip.transform) preserve(clip.id, "transform");
      if (clip.ext) preserve(clip.id, "ext_data");
      const points = clipTimeMap(clip);
      preserve(clip.id, points.length > 2 ? "speed_segmented" : "speed_constant");
      if (points.some((point) => point.interp === "smooth")) preserve(clip.id, "speed_smooth");
      if (points.some((point, index) => index > 0 && compare(point.source, points[index - 1]!.source) < 0))
        preserve(clip.id, "reverse");
    }
    for (const transition of track.transitions) preserve(transition.id, "cross_dissolve");
  }
  for (const marker of timeline.markers) preserve(marker.id, "marker");
  for (const cue of projectSubtitles(project, timeline.id).cues) preserve(cue.cue_id, "subtitle_text_timing");
  for (const style of project.subtitle_styles) preserve(style.id, "subtitle_style");
  const report = {
    schema: "zsir-cut/loss-report",
    schema_version: "0.1",
    export_id: exportId,
    profile,
    source_revision: project.revision.id,
    generated_at: at,
    phase,
    summary,
    items,
  };
  const check = validateLossReport(report);
  if (!check.valid) throw new Error(`Invalid loss report: ${JSON.stringify(check.errors)}`);
  return report;
}

export interface ExportRequest {
  project: string;
  timeline_id?: string;
  profile?: ProfileId;
  output?: string;
  dry_run?: boolean;
  accept_losses?: boolean;
  overlay?: boolean;
  subtitle_languages?: string[];
}
export async function runExport(
  project: Project,
  input: ExportRequest,
  exporter: Exporter,
  exportId: string,
  at: string,
  profile: ProfileId,
) {
  const timeline = project.timelines.find((item) => item.id === (input.timeline_id ?? project.timelines[0]?.id));
  if (!timeline) throw new Error("Timeline not found");
  if (input.overlay) throw new Error("Overlay export is not implemented");
  const report = await lossReport(
    project,
    profile,
    exporter,
    exportId,
    input.dry_run ? "preview" : "final",
    timeline,
    at,
    input.project,
  );
  if (report.summary.worst_severity === "error" && !input.accept_losses) return { rejected: true as const, report };
  if (input.dry_run) return { rejected: false as const, report };
  const paths = new Map(project.media.map((media) => [media.id, resolve(dirname(input.project), media.path)]));
  const exchange = await exporter.generate(project, timeline, profile, paths, exportId);
  const cutCheck = compareCuttingLists(
    cuttingList(project, timeline, profile),
    await exporter.readBack(exchange.data, timeline),
    new Set(
      report.items
        .filter((item) => item.status === "unsupported" && item.entity_kind === "clip" && item.feature === "clip_cut")
        .map((item) => item.entity_id),
    ),
    PROFILES[profile].format === "fcpxml" ? exporter.gridTolerances?.(project, timeline) : undefined,
  );
  const formatValid = await exporter.validate(exchange.data);
  if (!formatValid || !cutCheck.zero_frame_deviation)
    throw new Error(
      `Exchange validation failed: ${[
        ...(!formatValid ? [`format: ${exporter.validationNotes ?? "validation returned false"}`] : []),
        ...(!cutCheck.zero_frame_deviation ? [`cutting list: ${JSON.stringify(cutCheck.differences)}`] : []),
      ].join("; ")}`,
    );
  let gitSha = exporter.git_sha;
  let gitShaUnavailable = false;
  if (exporter.gitSha) {
    try {
      gitSha = await exporter.gitSha();
      if (!/^[0-9a-f]{7,40}$/.test(gitSha) || /^0+$/.test(gitSha)) throw new Error("Invalid Git SHA");
    } catch {
      gitSha = "0000000";
      gitShaUnavailable = true;
    }
  }
  const safeName = (text: string) => text.replaceAll(/[\\/:*?"<>|]/g, "_");
  if (basename(exchange.name) !== exchange.name) throw new Error("Exchange file name must be a basename");
  const stamp = at.replaceAll(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const name = `${safeName(project.name)}_${safeName(timeline.name)}_${profile}_r${project.revision.seq}_${stamp}`;
  const root = resolve(input.output ?? dirname(input.project), name);
  await mkdir(input.output ?? dirname(input.project), { recursive: true });
  await mkdir(root);
  await mkdir(join(root, "timeline"));
  await mkdir(join(root, "subtitles"), { recursive: true });
  const files: { path: string; role: string; sha256: string; language?: string }[] = [];
  const put = async (path: string, role: string, data: string | Uint8Array, language?: string) => {
    await writeFile(join(root, path), data);
    files.push({ path, role, sha256: digest(data), ...(language ? { language } : {}) });
  };
  await put(`timeline/${exchange.name}`, "timeline", exchange.data);
  for (const file of subtitleFiles(project, timeline))
    if (!input.subtitle_languages || input.subtitle_languages.includes(file.language))
      await put(`subtitles/${file.name}`, file.role, file.data, file.language);
  await put("loss-report.json", "loss_report", j(report));
  const guide =
    "交接检查单\n1. 导入没有报错，离线素材数为零。\n2. 核对起始时码、总时长、帧率。\n3. 核对每条轨道的片段数。\n4. 抽查三个剪点的源帧号。\n5. 核对 J/L cut 的音频偏移。\n6. 核对叠化与变速。\n7. 核对字幕条数及首末条。\n8. 保存、关闭、重新打开后复查。\n";
  await put("接手说明.txt", "readme", guide);
  const media = [];
  for (const item of project.media) {
    const path = paths.get(item.id)!;
    let online = false;
    try {
      const info = await stat(path);
      online =
        info.isFile() && info.size === item.size_bytes && (await fingerprint(path)).value === item.fingerprint.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    media.push({
      media_id: item.id,
      path,
      size_bytes: item.size_bytes,
      fingerprint: item.fingerprint.value,
      online,
      proxy_used: false,
    });
  }
  const check = (status: string, notes: string) => ({ status, at, by: "zsir-cut", notes });
  const end = timeline.tracks
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .reduce((best, clip) => max(best, add(clip.timeline_start, clip.duration)), zero);
  const manifest = {
    schema: "zsir-cut/handoff-manifest",
    schema_version: "0.1",
    export_id: exportId,
    created_at: at,
    project: { id: project.id, name: project.name, path: resolve(input.project) },
    timeline_id: timeline.id,
    source_revision: project.revision.id,
    profile: { id: profile, ...PROFILES[profile] },
    exporter: { version: exporter.version, git_sha: gitSha },
    timebase: {
      edit_rate: printRational(timeline.edit_rate),
      drop_frame: timeline.drop_frame,
      start_timecode: timeline.start_timecode,
      audio_rate: "48000",
      duration: printRational(end, true),
    },
    options: {
      ...(input.overlay !== undefined ? { overlay: input.overlay } : {}),
      ...(input.subtitle_languages ? { subtitle_languages: input.subtitle_languages } : {}),
      accept_losses: input.accept_losses ?? false,
    },
    media,
    files,
    validation: {
      schema: check(
        formatValid && cutCheck.zero_frame_deviation ? "pass" : "fail",
        `${
          cutCheck.zero_frame_deviation
            ? (exporter.validationNotes ?? "格式校验与剪辑表读回通过")
            : JSON.stringify(cutCheck.differences)
        }${gitShaUnavailable ? "；无法读取仓库当前提交，git_sha=0000000" : ""}`,
      ),
      media_resolved: check(media.every((item) => item.online) ? "pass" : "fail", "素材路径、大小与指纹检查"),
      host_import: { status: "not_run" },
      host_render_comparison: { status: "not_run" },
    },
  };
  const valid = validateManifest(manifest);
  if (!valid.valid) throw new Error(`Invalid manifest: ${JSON.stringify(valid.errors)}`);
  await writeFile(join(root, "manifest.json"), j(manifest));
  return { rejected: false as const, report, package: root, manifest };
}

export async function recordHandoffCheck(
  packagePath: string,
  level: "host_import" | "host_render_comparison",
  value: Record<string, unknown>,
) {
  const path = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    validation: Record<string, unknown>;
  };
  manifest.validation[level] = value;
  const result = validateManifest(manifest);
  if (!result.valid) throw new Error(`Invalid handoff check: ${JSON.stringify(result.errors)}`);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, j(manifest));
  await rename(temp, path);
  return manifest;
}
