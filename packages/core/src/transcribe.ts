// biome-ignore-all lint/style/noNonNullAssertion: Project schema validates cue IDs and segmented token bounds before writeback.
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { newId, transcriptIds } from "./project/id.ts";
import { cueBreaks, segmentTokens, transcriptRules } from "./project/subtitle-rules.ts";
import type { Cue, Engine, Project, RawToken, Token, TranscriptSubtitleRules } from "./project/types.ts";
import { compare, parseRational, rational, sub } from "./rational.ts";

import { mergeHotwords, readTermLibrary } from "./term-library.ts";

const execute = promisify(execFile);
type WorkerToken = { text: string; start_ms: number; end_ms: number; conf: number | null };
type WorkerResult = {
  hotwords?: string[];
  schema: string;
  schema_version: string;
  input: { size_bytes: number; fingerprint: string; channels: number[]; start_ms: number; duration_ms: number };
  language: string;
  asr: { name: string; model: string; version: string | null; weights_digest?: string | null };
  align: { name: string; model: string; version: string | null; weights_digest?: string | null };
  tokens: WorkerToken[];
  warnings: (string | { code: string; count: number } | { code: "W_ASR_ALIGN_DEGRADED"; ratio: number })[];
};
export type TranscribeRequest = {
  project: string;
  media_id: string;
  source_channels?: number[];
  range?: { start: string; duration: string };
  language?: string;
  engine?: "local" | "cloud" | "auto";
  hotwords?: string;
  rules?: Record<string, unknown>;
};
export class AsrError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
const ms = (value: number) => rational(BigInt(value), 1000n);
export const workerMilliseconds = (value: string): bigint => {
  const time = parseRational(value, true);
  const numerator = time.numerator * 1000n;
  if (numerator % time.denominator !== 0n)
    throw new AsrError("E_VALIDATION", "ASR range must use whole milliseconds", false);
  return numerator / time.denominator;
};
const workerSeconds = (value: string) => {
  const amount = workerMilliseconds(value);
  const fraction = (amount % 1000n).toString().padStart(3, "0").replace(/0+$/u, "");
  return `${amount / 1000n}${fraction ? `.${fraction}` : ""}`;
};
const overlap = (
  start: ReturnType<typeof rational>,
  end: ReturnType<typeof rational>,
  a: ReturnType<typeof rational>,
  b: ReturnType<typeof rational>,
) => compare(start, b) < 0 && compare(a, end) < 0;
const engine = (value: WorkerResult["asr"]): Engine => ({
  name: value.name,
  model: value.model,
  version: value.version ?? "unknown",
  ...(value.weights_digest ? { weights_digest: value.weights_digest } : {}),
});
const rulesFromRequest = (language: string, value: Record<string, unknown>): TranscriptSubtitleRules => {
  const stored: TranscriptSubtitleRules = {
    profile:
      (value.profile as TranscriptSubtitleRules["profile"] | undefined) ??
      (language.startsWith("zh") ? "zh-talk" : "en-talk"),
  };
  for (const key of ["cpl", "max_lines", "cps", "strip_end_punct"] as const)
    if (value[key] !== undefined) (stored as unknown as Record<string, unknown>)[key] = value[key];
  for (const key of ["min_duration", "max_duration", "hard_pause", "soft_pause", "min_gap"] as const)
    if (value[key] !== undefined) stored[key] = parseRational(value[key] as string, true);
  return stored;
};

export async function invokeAsr(
  project: Project,
  request: TranscribeRequest,
  out: string,
  python: string,
  workerDirectory: string,
): Promise<WorkerResult> {
  const media = project.media.find((item) => item.id === request.media_id);
  if (!media) throw new AsrError("E_NOT_FOUND", "Media not found", false);
  const channels = request.source_channels ?? [0];
  if (channels.length !== 1) throw new AsrError("E_UNSUPPORTED", "ASR worker accepts one source channel", false);
  if (!media.audio || channels[0]! >= media.audio.channels)
    throw new AsrError("E_ASR_INPUT", "Source channel is unavailable", false);
  const language = request.language ?? project.recognition?.language;
  if (language && language !== "auto" && !/^(zh|en)(-|$)/u.test(language))
    throw new AsrError("E_UNSUPPORTED", "ASR worker supports Chinese and English", false);
  const args = [
    "-m",
    "zsir_asr",
    "transcribe",
    "--input",
    resolve(dirname(request.project), media.path),
    "--channels",
    String(channels[0]),
    "--language",
    language?.startsWith("zh") ? "zh" : language?.startsWith("en") ? "en" : "auto",
    "--engine",
    request.engine ?? "auto",
    "--out",
    out,
  ];
  if (request.range)
    args.push("--start", workerSeconds(request.range.start), "--duration", workerSeconds(request.range.duration));
  const hotwordsPath = `${out}.hotwords.txt`;
  let fileTerms: string[] = [];
  if (request.hotwords) {
    try {
      fileTerms = (await readFile(resolve(dirname(request.project), request.hotwords), "utf8")).split(/\r?\n/u);
    } catch {
      throw new AsrError("E_ASR_INPUT", "Cannot read hotwords file", false);
    }
  }
  const hotwords = mergeHotwords(project.recognition?.terms ?? [], fileTerms, await readTermLibrary());
  if (hotwords.length) {
    await writeFile(hotwordsPath, hotwords.join("\n"));
    args.push("--hotwords", hotwordsPath);
  }
  let failed = false;
  try {
    await execute(python, args, { cwd: workerDirectory, maxBuffer: 1024 * 1024 });
  } catch {
    failed = true;
  } finally {
    await rm(hotwordsPath, { force: true });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(out, "utf8"));
  } catch {
    throw new AsrError("E_ASR_INTERNAL", "ASR worker did not write valid JSON", false);
  }
  if (!value || typeof value !== "object") throw new AsrError("E_ASR_INTERNAL", "Invalid ASR result", false);
  const result = value as Record<string, unknown>;
  if (result.schema === "zsir-cut/asr-error")
    throw new AsrError(String(result.code), String(result.message), result.retryable === true);
  if (failed || result.schema !== "zsir-cut/asr-result" || result.schema_version !== "0.1")
    throw new AsrError("E_ASR_INTERNAL", "Invalid ASR result", false);
  const output = value as WorkerResult;
  if (
    !output.input ||
    output.input.size_bytes !== media.size_bytes ||
    output.input.fingerprint !== media.fingerprint.value ||
    JSON.stringify(output.input.channels) !== JSON.stringify(channels) ||
    !Number.isSafeInteger(output.input.start_ms) ||
    !Number.isSafeInteger(output.input.duration_ms) ||
    output.input.start_ms < 0 ||
    output.input.duration_ms <= 0 ||
    !Number.isSafeInteger(output.input.start_ms + output.input.duration_ms) ||
    !Array.isArray(output.tokens) ||
    !Array.isArray(output.warnings) ||
    !["zh", "en"].includes(output.language)
  )
    throw new AsrError("E_ASR_INTERNAL", "ASR result does not match media or request", false);
  if (language && language !== "auto" && !language.startsWith(output.language))
    throw new AsrError("E_ASR_INTERNAL", "ASR language differs from request", false);
  if (
    request.range &&
    (compare(ms(output.input.start_ms), parseRational(request.range.start, true)) !== 0 ||
      compare(ms(output.input.duration_ms), parseRational(request.range.duration, true)) !== 0)
  )
    throw new AsrError("E_ASR_INTERNAL", "ASR result range differs from request", false);
  let end = -1;
  for (const [index, token] of output.tokens.entries()) {
    const reason =
      !token || typeof token.text !== "string" || !token.text
        ? "text must be nonempty"
        : !Number.isSafeInteger(token.start_ms) || !Number.isSafeInteger(token.end_ms)
          ? "times must be safe integer milliseconds"
          : token.end_ms <= token.start_ms
            ? "end_ms must be greater than start_ms (zero or negative width)"
            : token.start_ms < output.input.start_ms || token.end_ms > output.input.start_ms + output.input.duration_ms
              ? "time is outside input range"
              : token.start_ms < end
                ? "start_ms overlaps the previous token or is out of order"
                : token.conf !== null &&
                    (typeof token.conf !== "number" || !Number.isFinite(token.conf) || token.conf < 0 || token.conf > 1)
                  ? "conf must be null or a number in [0, 1]"
                  : undefined;
    if (reason) throw new AsrError("E_ASR_INTERNAL", `Invalid ASR token at index ${index}: ${reason}`, false);
    end = token.end_ms;
  }
  if (!output.tokens.length && !output.warnings.includes("W_ASR_EMPTY")) output.warnings.push("W_ASR_EMPTY");
  for (const value of [output.asr, output.align])
    if (
      !value ||
      typeof value.name !== "string" ||
      !value.name ||
      typeof value.model !== "string" ||
      !value.model ||
      (value.version !== null && typeof value.version !== "string")
    )
      throw new AsrError("E_ASR_INTERNAL", "Invalid ASR engine metadata", false);
  output.hotwords = hotwords;
  return output;
}

export function applyTranscription(project: Project, request: TranscribeRequest, result: WorkerResult): void {
  const configuredLanguage = request.language ?? project.recognition?.language;
  const language =
    configuredLanguage && configuredLanguage !== "auto"
      ? configuredLanguage
      : result.language === "zh"
        ? "zh-Hans"
        : "en";
  const channels = request.source_channels ?? [0];
  let transcript = project.transcripts.find(
    (item) =>
      item.media_id === request.media_id &&
      item.language === language &&
      JSON.stringify(item.source_channels) === JSON.stringify(channels),
  );
  if (!transcript) {
    transcript = {
      id: newId("trs_"),
      media_id: request.media_id,
      source_channels: channels,
      language,
      raw_runs: [],
      tokens: [],
      cues: [],
    };
    project.transcripts.push(transcript);
  }
  if (request.rules) transcript.subtitle_rules = rulesFromRequest(language, request.rules);
  const start = ms(result.input.start_ms);
  const end = ms(result.input.start_ms + result.input.duration_ms);
  const range = { start, duration: sub(end, start) };
  const raw: RawToken[] = result.tokens.map((token) => ({
    text: token.text,
    start: ms(token.start_ms),
    end: ms(token.end_ms),
    ...(token.conf === null ? {} : { conf: token.conf }),
  }));
  const asrId = newId("run_");
  const alignId = newId("run_");
  const created_at = new Date().toISOString();
  transcript.raw_runs.push(
    { id: asrId, kind: "asr", engine: engine(result.asr), created_at, range, tokens: raw },
    { id: alignId, kind: "align", engine: engine(result.align), created_at, range, tokens: raw },
  );
  const tokenId = transcriptIds(project, transcript, "tok_");
  const cueId = transcriptIds(project, transcript, "cue_");
  const oldTokens = transcript.tokens;
  const indexes = new Map(oldTokens.map((token, index) => [token.id, index]));
  const protectedCues = transcript.cues.filter(
    (cue) =>
      cue.timing?.locked ||
      cue.state === "approved" ||
      oldTokens
        .slice(indexes.get(cue.first_token)!, indexes.get(cue.last_token)! + 1)
        .some((token) => token.state === "approved"),
  );
  const protectedIds = new Set(
    protectedCues.flatMap((cue) =>
      oldTokens.slice(indexes.get(cue.first_token)!, indexes.get(cue.last_token)! + 1).map((token) => token.id),
    ),
  );
  const preserve = (token: Token) =>
    token.state !== "auto" || protectedIds.has(token.id) || !overlap(token.align.start, token.align.end, start, end);
  const retained = oldTokens.filter(preserve);
  const additions: Token[] = raw
    .filter((token) => !retained.some((old) => overlap(token.start, token.end, old.align.start, old.align.end)))
    .map((token) => ({
      id: tokenId(),
      text: token.text,
      state: "auto",
      align: {
        start: token.start,
        end: token.end,
        run: alignId,
        ...(token.conf === undefined ? {} : { conf: token.conf }),
      },
    }));
  if (project.recognition?.remove_fillers ?? true) {
    const fillers = new Set(project.recognition?.filler_words ?? ["嗯", "啊", "呃", "额", "哦", "唉", "哎", "诶"]);
    let count = 0;
    for (const token of additions) {
      if (!fillers.has(token.text.replace(/^\p{P}+|\p{P}+$/gu, ""))) continue;
      token.heard = token.text;
      token.text = "";
      count++;
    }
    if (count) result.warnings.push({ code: "W_FILLERS_HIDDEN", count });
  }
  transcript.tokens = [...retained, ...additions].sort((a, b) => compare(a.align.start, b.align.start));
  const affected = new Set(oldTokens.filter((token) => !preserve(token)).map((token) => token.id));
  const oldCues = transcript.cues;
  const keptCues = oldCues.filter(
    (cue) =>
      protectedCues.includes(cue) ||
      (!oldTokens
        .slice(indexes.get(cue.first_token)!, indexes.get(cue.last_token)! + 1)
        .some((token) => affected.has(token.id)) &&
        !overlap(
          oldTokens[indexes.get(cue.first_token)!]!.align.start,
          oldTokens[indexes.get(cue.last_token)!]!.align.end,
          start,
          end,
        )),
  );
  const covered = new Set(
    keptCues.flatMap((cue) => {
      const a = transcript!.tokens.findIndex((token) => token.id === cue.first_token);
      const b = transcript!.tokens.findIndex((token) => token.id === cue.last_token);
      return transcript!.tokens.slice(a, b + 1).map((token) => token.id);
    }),
  );
  const rules = transcriptRules(transcript);
  for (const timeline of project.timelines)
    for (const track of timeline.tracks)
      if (track.kind === "subtitle" && track.language === language) {
        const style = project.subtitle_styles.find((item) => item.id === track.default_style_id);
        if (style?.max_lines) rules.max_lines = Math.min(rules.max_lines, style.max_lines);
      }
  const cues: Cue[] = [];
  let group: Token[] = [];
  const flush = () => {
    for (const segment of segmentTokens(group, rules, undefined, project.recognition?.terms))
      cues.push({
        id: cueId(),
        first_token: segment[0]!.id,
        last_token: segment.at(-1)!.id,
        breaks: cueBreaks(segment, rules),
        state: "auto",
      });
    group = [];
  };
  for (const token of transcript.tokens) {
    if (covered.has(token.id)) flush();
    else group.push(token);
  }
  flush();
  delete transcript.ext?.["zsir.subtitle_pass"];
  transcript.cues = [...keptCues, ...cues].sort(
    (a, b) =>
      transcript!.tokens.findIndex((token) => token.id === a.first_token) -
      transcript!.tokens.findIndex((token) => token.id === b.first_token),
  );
  const keptIds = new Set(transcript.cues.map((cue) => cue.id));
  const removedIds = new Set(oldCues.filter((cue) => !keptIds.has(cue.id)).map((cue) => cue.id));
  for (const timeline of project.timelines)
    for (const track of timeline.tracks)
      if (track.kind === "subtitle") track.overrides = track.overrides.filter((item) => !removedIds.has(item.cue_id));
}
