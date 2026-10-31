// biome-ignore-all lint/style/noNonNullAssertion: Indexed tokens and lines are guarded by chunk and alignment bounds.
import type { Envelope, Project, Token, Transcript, Verb } from "../../core/dist/index.js";
import type { AgentKind } from "./agent-events.js";
import {
  type ProofreadFix,
  type ProofreadLine,
  proofreadLines,
  proofreadOps,
  proofreadProblem,
} from "./subtitle-proofread.js";
import type { SubtitleVerb } from "./ui.js";

const {
  compare,
  cueText,
  sub,
  transcriptRules,
  newId,
  textWidth,
  rationalNumber,
  mul,
  rational,
  badSubtitleBoundaries,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

export const SUBTITLE_PASS_PROMPT =
  '你在给一段中文口播或采访做短视频字幕。输入是语音识别的原文，没有标点。你的任务是把它切成一行一行的字幕：**只切，不改字**，不加标点，不调整顺序。\n\n输入里的「/」表示说话人停了一下，「//」表示停了较长时间。停顿只是参考：说话人常在半句中间停，也常一口气说完两句。断点按意思定。\n\n**一行字幕是一个意群**：观众只看这一行就能明白它在说什么，不用等下一行。\n\n1. 每行不超过 `max_chars` 个字，目标 8 到 14 个字。宁可短一点，也不要为了凑字数把下一句的开头拉进来。\n2. 在这些地方断：一句话说完的地方；主语说完、后面是一大段谓语的地方；「先……然后……」这样的并列动作之间；说话人自我纠正、改口的地方。\n3. 连接词放在下一行开头：但是、然后、所以、因为、如果、而且、就是说、比如、其实、那、好。口语里单独的「好」「对」「那」常常表示开始新的一句，例如「好这个词要这样说」应该是「好这个词要这样说」一行，前面的内容另成一行。\n4. 每行结尾必须是说完的：不以「的、地、得、和、与、在、是、把、被、给、对、让、很、都、也、就、这个、一个、需要、可能、就是、能够、可以、要、会、去、帮我们、给到、这么一个」结尾。「的」只有在「是……的」或句子真的说完时才能放结尾。\n5. 每行开头不能是「了、着、过、吗、呢、吧、们、上、里、时」。\n6. 不拆专有名词、人名、品牌、数字和单位：「抖音来客」「二十四小时」「两万多个」必须在同一行。`terms` 里的词都不能拆开。\n7. 少于 4 个字的行，除非它本身就是独立的一句（「对」「好的」），就和前一行或后一行合在一起。\n8. 切完后从头到尾逐行检查一遍结尾和开头，再输出。\n\n**去除水词**（`remove_fillers` 为 true 时）：单独出现的「呃、嗯、啊、哎」，以及紧挨着的重复（「上传上传」只留一个，「我我我」只留一个），直接不写进行里。有意义的语气词（「好啊」「对吧」）保留。专有名词不能去掉，去掉的字不超过两成。\n\n**例子一**\n\n输入：`所有的点位加起来可能有两万多个 / 很多的脏活全部让豆包工作去做了 // 是你要真正去使用之后你才能够去感受到`\n\n输出：`{"lines": ["所有的点位加起来", "可能有两万多个", "很多的脏活", "全部让豆包工作去做了", "是你要真正去使用之后", "你才能够去感受到"]}`\n\n**例子二**\n\n输入：`帮我根据商家的这个层级去出不同的内容和脚本然后分发给到他们他就会自己开始写脚本 / 好这个词要这样说这个文案好这个拍摄的场景建议是什么他都会写到这个里面`\n\n错误的切法（按字数切，不看意思）：`和脚本然后分发给到他们他就会自己`、`开始写脚本好这个词要这样说`\n\n正确的切法：`{"lines": ["帮我根据商家的这个层级", "去出不同的内容和脚本", "然后分发给到他们", "他就会自己开始写脚本", "好这个词要这样说", "这个文案", "好这个拍摄的场景建议是什么", "他都会写到这个里面"]}`\n\n**例子三**（去除水词）\n\n输入：`呃 / 这个上传上传其实难度并不高但是呢就是它需要不断的有人能够去盯着`\n\n输出：`{"lines": ["这个上传其实难度并不高", "但是呢就是它", "需要不断的有人能够去盯着"]}`\n\n只输出 JSON：`{"lines": ["…", "…"]}`，不要解释。\n\n**修改轮**：如果输入里有「上一次的结果」和「问题」，只改有问题的行和它们前后相邻的行，其余行一字不动，仍输出完整的 `lines`。';

export const SUBTITLE_SUMMARY_PROMPT =
  '你在帮视频剪辑师整理一段采访或口播的字幕。下面是语音识别出的全片文字，没有标点，可能有同音错字。\n\n读完后输出 JSON：`{"summary": "…", "terms": ["…"]}`。\n\n- `summary`：不超过 200 字，说清这段视频讲什么、谁在说（身份）、属于什么领域、口吻是正式还是随意。只写文字里能看出来的，不要猜。\n- `terms`：文字里出现的人名、品牌、产品、机构、地名和行业术语，写成正确的写法。识别错了的也按你判断的正确写法写，例如文字里是「豆宝」但上下文明显在说字节的大模型，写「豆包」。拿不准的不写。\n\n只输出 JSON，不要解释。';

export const SUBTITLE_PROOFREAD_PROMPT =
  '你是视频字幕的校对。下面每行是一条字幕，来自语音识别，常见错误是同音字、近音字和写错的名词。`summary` 是全片概要，`terms` 是这期视频的专有名词。\n\n规则：\n\n1. 只改识别错的字。不改说法，不换同义词，不润色，不调整语序。\n2. 不加标点，不合并也不拆分行，不删口语里的重复和口头禅。\n3. 名词按 `terms` 的写法改。`terms` 里没有、但上下文能确定的名词也可以改。\n4. 数字保持原来的写法。\n5. 拿不准的不改。宁可漏改，不要改错。\n6. 有 `request` 时照它做，但不能违反上面几条。\n\n输出 JSON：`{"fixes": [{"id": "…", "text": "改后的整行", "why": "…"}]}`，只列要改的行，`text` 是这一行改完后的完整文字，`why` 用十个字以内说明，例如「同音错字：工部→公布」。没有要改的输出 `{"fixes": []}`。只输出 JSON，不要解释。\n\n例子：\n\n输入：`{"summary": "字节跳动产品经理介绍豆包大模型在剪辑里的用法", "terms": ["豆包", "剪映"], "lines": [{"id": "c1", "text": "我们用豆宝来写脚本"}, {"id": "c2", "text": "然后再导到剪影里面"}, {"id": "c3", "text": "这个效果其实挺好的"}]}`\n\n输出：`{"fixes": [{"id": "c1", "text": "我们用豆包来写脚本", "why": "名词：豆宝→豆包"}, {"id": "c2", "text": "然后再导到剪映里面", "why": "名词：剪影→剪映"}]}`\n\n宿主把上一次的输出和问题列表发回，例如「c7 改了 6 个字，只能改错字，不要改写」。只重新给出列出的这几行，规则不变，输出格式不变。';

export interface PassWarning {
  code: "W_SUB_PASS_FALLBACK" | "W_SUB_PROOFREAD_FAILED" | "W_SUB_PROOFREAD_SKIPPED";
  reason: string;
  transcript_id: string;
  chunk?: number;
  count?: number;
}
export interface PassState {
  running: boolean;
  phase?: "breaking" | "proofread";
  warnings: PassWarning[];
  progress?: { transcript_id: string; done: number; total: number; phase?: "breaking" | "proofread" }[];
}
export interface SubtitlePassState {
  pass_id: string;
  kind: "tidy" | "proofread";
  state: "running" | "done" | "failed";
  done: number;
  total: number;
  reason: string | null;
}
export interface SubtitlePassParams {
  transcript_id?: string;
  cue_ids?: string[];
  request?: string;
}
type PassTarget = { id: string; range?: { from_token: string; to_token: string } };
type StartResult =
  | { pass_id: string }
  | { code: "E_VALIDATION" | "E_SUB_PASS_RUNNING"; message: string; retryable: boolean };
export type AgentRunner = (agent: AgentKind, prompt: string, signal: AbortSignal) => Promise<string>;
type Kernel = (verb: Verb, input: unknown) => Promise<Envelope>;

export function subtitleChunks(transcript: Transcript, range?: PassTarget["range"]): Token[][] {
  const protectedIds = new Set<string>();
  for (const cue of transcript.cues) {
    const start = transcript.tokens.findIndex((token) => token.id === cue.first_token);
    const end = transcript.tokens.findIndex((token) => token.id === cue.last_token);
    if (
      !cue.timing?.locked &&
      cue.state !== "approved" &&
      !transcript.tokens.slice(start, end + 1).some((token) => token.state === "approved")
    )
      continue;
    for (const token of transcript.tokens.slice(start, end + 1)) protectedIds.add(token.id);
  }
  const chunks: Token[][] = [];
  let available: Token[] = [];
  const flush = () => {
    while (available.length > 600) {
      let cut = 1;
      for (let i = 2; i <= 600; i++) {
        if (
          compare(
            sub(available[i]!.align.start, available[i - 1]!.align.end),
            sub(available[cut]!.align.start, available[cut - 1]!.align.end),
          ) >= 0
        )
          cut = i;
      }
      chunks.push(available.slice(0, cut));
      available = available.slice(cut);
    }
    if (available.length) chunks.push(available);
    available = [];
  };
  const first = range ? transcript.tokens.findIndex((token) => token.id === range.from_token) : 0;
  const last = range
    ? transcript.tokens.findIndex((token) => token.id === range.to_token)
    : transcript.tokens.length - 1;
  if (first < 0 || last < first) throw new Error("字幕范围的字词已变化，请重新选择字幕后重试");
  for (const token of transcript.tokens.slice(first, last + 1)) {
    if (protectedIds.has(token.id) || token.state === "approved") flush();
    else if (token.text !== "") available.push(token);
  }
  flush();
  return chunks;
}

const normalized = (text: string) => text.replace(/[\s。！？.!?，、；：,;:]/gu, "");
const normalizedLine = (text: string) => normalized(text.replaceAll("/", ""));
export function alignSubtitleLines(
  tokens: Token[],
  lines: string[],
): { hide: string[]; cuts: string[]; groups: Token[][] } {
  if (!lines.length || lines.some((line) => typeof line !== "string" || !normalizedLine(line)))
    throw new Error("字幕行为空");
  const targets = lines.map(normalizedLine);
  const words = tokens.map((token) => normalized(token.text));
  const memo = new Map<string, { skips: number; take: boolean }>();
  const solve = (i: number, line: number, offset: number): number => {
    if (i === words.length) return line === targets.length ? 0 : Infinity;
    const key = `${i},${line},${offset}`;
    const cached = memo.get(key);
    if (cached) return cached.skips;
    if (!words[i]) {
      const skips = solve(i + 1, line, offset);
      memo.set(key, { skips, take: true });
      return skips;
    }
    let best = 1 + solve(i + 1, line, offset);
    let take = false;
    const word = words[i]!;
    if (line < targets.length && word && targets[line]!.startsWith(word, offset)) {
      const end = offset + word.length;
      const complete = end === targets[line]!.length;
      const cost = solve(i + 1, complete ? line + 1 : line, complete ? 0 : end);
      if (cost < best) {
        best = cost;
        take = true;
      }
    }
    memo.set(key, { skips: best, take });
    return best;
  };
  if (!Number.isFinite(solve(0, 0, 0))) throw new Error("字幕文字无法对齐原文");
  const hide: string[] = [];
  const groups: Token[][] = targets.map(() => []);
  let line = 0;
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!memo.get(`${i},${line},${offset}`)?.take) {
      hide.push(tokens[i]!.id);
      continue;
    }
    if (!words[i]) {
      groups[offset === 0 && line > 0 ? line - 1 : line]!.push(tokens[i]!);
      continue;
    }
    groups[line]!.push(tokens[i]!);
    offset += words[i]!.length;
    if (offset === targets[line]!.length) {
      line++;
      offset = 0;
    }
  }
  return { hide, cuts: groups.map((group) => group.at(-1)!.id), groups };
}

function hidesTerm(tokens: Token[], hidden: Set<string>, terms: string[]) {
  const normalized = (text: string) => text.replace(/\s/gu, "").toLowerCase();
  const text = tokens.map((token) => normalized(token.text)).join("");
  const ranges: [number, number][] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + normalized(token.text).length;
    if (hidden.has(token.id)) ranges.push([offset, end]);
    offset = end;
  }
  return terms.some((term) => {
    const needle = normalized(term);
    if (!needle) return false;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      if (ranges.some(([start, end]) => start < at + needle.length && end > at)) return true;
    }
    return false;
  });
}

export class SubtitlePass {
  readonly states = new Map<string, PassState>();
  private running = new Map<string, Promise<Envelope>>();
  latest: SubtitlePassState | null = null;
  private jobs = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  private abort = new AbortController();
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private options: {
      project: string;
      load: () => Promise<Project>;
      transcribed: (revision: string) => Promise<string[]>;
      dispatch: Kernel;
      detect: () => Promise<{ agent: AgentKind; available: boolean }[]>;
      selected: () => AgentKind | undefined;
      run: AgentRunner;
      changed: () => void;
    },
  ) {}

  get state(): PassState {
    const states = [...this.states.values()];
    const active = states.filter((s) => s.running);
    const phase = active.length ? (active.some((s) => s.phase !== "proofread") ? "breaking" : "proofread") : undefined;
    return {
      ...(phase ? { phase } : {}),
      running: [...this.states.values()].some((state) => state.running),
      warnings: [...this.states.values()].flatMap((state) => state.warnings),
      progress: states.flatMap((state) =>
        (state.progress ?? []).map((p) => (state.phase === "proofread" ? { ...p, phase: "proofread" as const } : p)),
      ),
    };
  }

  async open() {
    const project = await this.options.load();
    if (this.abort.signal.aborted) return;
    await Promise.all(
      project.transcripts
        .filter(
          (t) =>
            t.cues.length && (t.ext?.["zsir.subtitle_pass"] === undefined || t.ext?.["zsir.proofread"] === undefined),
        )
        .map((t) => this.run(t.id)),
    );
  }

  async retryFailed() {
    const ids = new Set(
      [...this.states.entries()]
        .filter(([, state]) => state.warnings.some((w) => w.code !== "W_SUB_PROOFREAD_SKIPPED") || state.running)
        .map(([id]) => id),
    );
    await Promise.all(
      [...ids].map(async (id) => {
        await this.running.get(id);
        if (
          !this.abort.signal.aborted &&
          this.states.get(id)?.warnings.some((w) => w.code !== "W_SUB_PROOFREAD_SKIPPED")
        )
          await this.run(id);
      }),
    );
  }

  observe(verb: Verb, input: unknown, envelope: Envelope) {
    if (this.abort.signal.aborted) return;
    const request = input as Record<string, unknown>;
    if (request.project !== this.options.project) return;
    if (verb === "transcribe" && envelope.ok) {
      const jobId = (envelope.result as { job_id?: string } | null)?.job_id;
      if (jobId && !this.jobs.has(jobId)) {
        this.jobs.set(jobId, {});
        this.poll(jobId);
      }
    }
    if (verb === "job_status") this.completed(request.job_id as string, envelope);
  }

  private completed(id: string, envelope: Envelope) {
    const entry = this.jobs.get(id);
    if (!entry) return;
    const job = envelope.result as {
      state?: string;
      envelope?: { ok: boolean; receipt?: { after: string | null } };
    } | null;
    if (!envelope.ok || (job?.state !== "succeeded" && job?.state !== "failed")) return;
    clearTimeout(entry.timer);
    this.jobs.delete(id);
    if (job?.state === "succeeded" && job.envelope?.ok && job.envelope.receipt?.after) {
      this.options.changed();
      void this.options
        .transcribed(job.envelope.receipt.after)
        .then((ids) => (this.abort.signal.aborted ? undefined : Promise.all(ids.map((id) => this.run(id)))))
        .catch(() => {});
    }
  }

  private poll(id: string) {
    const entry = this.jobs.get(id);
    if (!entry || this.abort.signal.aborted) return;
    entry.timer = setTimeout(() => {
      void this.options
        .dispatch("job_status", { project: this.options.project, job_id: id })
        .then((envelope) => {
          this.completed(id, envelope);
          this.poll(id);
        })
        .catch(() => this.poll(id));
    }, 1000);
  }

  run(id: string): Promise<Envelope> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const task = this.automatic(id).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }

  private async agents() {
    const detected = await this.options.detect();
    const available = (["claude", "codex"] as const).filter((kind) =>
      detected.some((item) => item.agent === kind && item.available),
    );
    const selected = this.options.selected();
    const current = selected && available.includes(selected) ? selected : available[0];
    if (!current) throw new Error("没有检测到 Claude Code 或 Codex，请安装并登录后重试");
    return { available, current };
  }

  private async summary(transcript: Transcript) {
    try {
      const { current } = await this.agents();
      const text = Array.from(cueText(transcript.tokens, transcriptRules(transcript)).join(""))
        .slice(0, 12000)
        .join("");
      const value: unknown = JSON.parse(await this.attempt(current, `${SUBTITLE_SUMMARY_PROMPT}\n${text}`, false));
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const result = value as { summary?: unknown; terms?: unknown };
      if (
        typeof result.summary !== "string" ||
        Array.from(result.summary).length > 200 ||
        !Array.isArray(result.terms) ||
        result.terms.some((t) => typeof t !== "string")
      )
        return undefined;
      return { summary: result.summary, terms: result.terms as string[] };
    } catch {
      return undefined;
    }
  }

  private async automatic(id: string): Promise<Envelope> {
    const project = await this.options.load();
    const transcript = project.transcripts.find((t) => t.id === id);
    if (!transcript || this.abort.signal.aborted) return this.emptyEnvelope();
    const summary = this.summary(transcript);
    let breaking = this.emptyEnvelope();
    if (transcript.ext?.["zsir.subtitle_pass"] === undefined) {
      breaking = await this.organize([{ id }]);
      if (this.states.get(id)?.warnings.length || this.abort.signal.aborted) return breaking;
    }
    this.states.set(id, { running: true, phase: "proofread", warnings: [], progress: [] });
    this.options.changed();
    const result = await this.proofread([{ id }], undefined, undefined, await summary);
    return result.receipt
      ? result
      : {
          ...breaking,
          result: { ...breaking.result, ...result.result },
          verification: {
            ...breaking.verification,
            issues: [...breaking.verification.issues, ...result.verification.issues],
          },
        };
  }

  private async attempt(agent: AgentKind, prompt: string, limited = true) {
    if (limited && this.active >= 6) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else if (limited) this.active++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.abort.signal.aborted) throw new Error("整理已停止");
      return await Promise.race([
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("整理已停止")), { once: true });
          timer = setTimeout(() => {
            reject(new Error("Agent 超时（120 秒）"));
            controller.abort();
          }, 120000);
        }),
        this.options.run(agent, prompt, controller.signal),
      ]);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", cancel);
      if (limited) {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    }
  }

  private async segment(
    project: Project,
    target: PassTarget,
    agents: { available: AgentKind[]; current: AgentKind },
    warnings: PassWarning[],
    progresses: { transcript_id: string; done: number; total: number }[],
    update: () => void,
    request?: string,
  ) {
    const id = target.id;
    const transcript = project.transcripts.find((t) => t.id === id);
    if (!transcript) throw new Error("母稿已不存在，请重新打开工程后重试");
    const fallback = (reason: string, chunk: number) =>
      warnings.push({ code: "W_SUB_PASS_FALLBACK", transcript_id: id, reason, chunk });
    const chunks = subtitleChunks(transcript, target.range);
    const rules = transcriptRules(transcript);
    const terms = project.recognition?.terms ?? [];
    const removeFillers = project.recognition?.remove_fillers ?? true;
    const progress = { transcript_id: id, done: 0, total: chunks.length };
    progresses.push(progress);
    update();
    const results: { ok: boolean; hide: string[]; cuts: string[] }[] = [];
    let nextChunk = 0;
    const worker = async () => {
      while (nextChunk < chunks.length && !this.abort.signal.aborted) {
        const chunk = nextChunk++;
        const tokens = chunks[chunk]!;
        let chunkAgent = agents.current;
        const processChunk = async (agent: AgentKind) => {
          let text = "";
          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            const previous = tokens[i - 1];
            if (previous) {
              const gap = sub(token.align.start, previous.align.end);
              if (compare(gap, rules.hard_pause) >= 0) text += " // ";
              else if (compare(gap, rules.soft_pause) >= 0) text += " / ";
              else if (/[A-Za-z0-9]$/u.test(previous.text) && /^[A-Za-z0-9]/u.test(token.text)) text += " ";
            }
            text += token.text;
          }
          const input = { text, remove_fillers: removeFillers, terms, max_chars: rules.cpl * rules.max_lines };
          const base = `${SUBTITLE_PASS_PROMPT}\n${JSON.stringify(input)}${request ? `\n用户的额外要求：${request}` : ""}`;
          const ask = async (prompt: string) => {
            let reason = "Agent 调用失败";
            for (let retry = 0; retry < 2 && !this.abort.signal.aborted; retry++) {
              try {
                const output: unknown = JSON.parse(await this.attempt(agent, prompt));
                if (
                  !output ||
                  typeof output !== "object" ||
                  Array.isArray(output) ||
                  Object.keys(output).join() !== "lines" ||
                  !Array.isArray((output as { lines?: unknown }).lines)
                )
                  throw new Error("输出必须只有 lines 数组");
                const lines = (output as { lines: string[] }).lines;
                const aligned = alignSubtitleLines(tokens, lines);
                if (
                  (!removeFillers && aligned.hide.length) ||
                  aligned.hide.length * 5 > tokens.length ||
                  hidesTerm(transcript.tokens, new Set(aligned.hide), terms)
                )
                  throw new Error("隐藏字词超过限制或包含名词");
                return { lines, ...aligned };
              } catch (error) {
                reason = error instanceof Error ? error.message : "Agent 调用失败";
                if (/authenticat|oauth|log(?:ged)?[ -]?in|login|登录|unauthorized/i.test(reason)) break;
              }
            }
            throw new Error(reason);
          };
          let result = await ask(base);
          for (let round = 0; round < 2; round++) {
            const bad = badSubtitleBoundaries(
              tokens.filter((t) => !result.hide.includes(t.id)),
              terms,
              true,
            );
            const problems: string[] = [];
            result.groups.forEach((group, index) => {
              const first = group[0]!;
              const last = group.at(-1)!;
              if (
                compare(textWidth(group, rules), mul(rationalNumber(rules.cpl), rational(BigInt(rules.max_lines)))) > 0
              )
                problems.push(`第 ${index + 1} 行「${result.lines[index]}」宽度超限`);
              if (compare(sub(last.align.end, first.align.start), rules.max_duration) > 0)
                problems.push(`第 ${index + 1} 行「${result.lines[index]}」时长超限`);
              const next = result.groups[index + 1]?.[0];
              if (next && bad.has(last.id) && compare(sub(next.align.start, last.align.end), rules.soft_pause) < 0)
                problems.push(`第 ${index + 1} 行「${result.lines[index]}」与下一行之间是坏断点`);
            });
            if (!problems.length) break;
            try {
              result = await ask(`${base}\n${JSON.stringify({ 上一次的结果: result.lines, 问题: problems })}`);
            } catch {
              break;
            }
          }
          return { ok: true, hide: result.hide, cuts: result.cuts };
        };
        try {
          try {
            results[chunk] = await processChunk(chunkAgent);
          } catch (firstError) {
            const other = agents.available.find((kind) => kind !== chunkAgent);
            if (!other || this.abort.signal.aborted) throw firstError;
            agents.current = other;
            chunkAgent = other;
            results[chunk] = await processChunk(chunkAgent);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Agent 调用失败";
          const reason = /超时/i.test(message)
            ? "字幕整理超时，请检查网络和 Agent 后重试"
            : /authenticat|oauth|log(?:ged)?[ -]?in|login|登录|unauthorized/i.test(message)
              ? chunkAgent === "claude"
                ? "Claude Code 登录已过期，请在终端运行 claude 重新登录，或在 AI 面板换成 Codex"
                : "Codex 未登录，请在终端运行 codex 登录，或在 AI 面板换成 Claude Code"
              : `${chunkAgent === "claude" ? "Claude Code" : "Codex"} 字幕整理失败，请检查登录和 CLI 后重试`;
          fallback(reason, chunk);
        } finally {
          progress.done++;
          update();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, () => worker()));
    if (this.abort.signal.aborted || warnings.length || results.length !== chunks.length)
      throw new Error(warnings[0]?.reason ?? "整理已停止");

    const hide = results.flatMap((result) => result.hide);
    return [
      ...(hide.length ? [{ op: "hide_tokens", transcript_id: id, tokens: hide }] : []),
      {
        op: "resegment",
        transcript_id: id,
        ...(target.range ? { range: target.range } : {}),
        cut_after: results.flatMap((result) => result.cuts),
      },
    ];
  }

  async start(verb: SubtitleVerb, params: SubtitlePassParams): Promise<StartResult> {
    const invalid = (message: string): StartResult => ({ code: "E_VALIDATION", message, retryable: false });
    const project = await this.options.load();
    if (this.abort.signal.aborted) return invalid("工程已关闭，请重新打开后重试");
    let targets: PassTarget[];
    if (params.cue_ids !== undefined) {
      if (!params.cue_ids.length) return invalid("请选择至少一条字幕");
      const selected = params.cue_ids.map((id) => {
        const transcript = project.transcripts.find((t) => t.cues.some((cue) => cue.id === id));
        return { transcript, cue: transcript?.cues.find((cue) => cue.id === id) };
      });
      const transcript = selected[0]?.transcript;
      if (!transcript || selected.some((item) => !item.cue || item.transcript !== transcript))
        return invalid("选中的字幕必须存在且属于同一份母稿");
      const first = Math.min(
        ...selected.map(({ cue }) => transcript.tokens.findIndex((t) => t.id === cue!.first_token)),
      );
      const last = Math.max(...selected.map(({ cue }) => transcript.tokens.findIndex((t) => t.id === cue!.last_token)));
      targets = [
        {
          id: transcript.id,
          range: { from_token: transcript.tokens[first]!.id, to_token: transcript.tokens[last]!.id },
        },
      ];
    } else {
      const transcripts =
        params.transcript_id === undefined
          ? project.transcripts.filter((t) => t.cues.length)
          : project.transcripts.filter((t) => t.id === params.transcript_id);
      if (params.transcript_id !== undefined && !transcripts.length) return invalid("指定的母稿不存在");
      targets = transcripts
        .filter((t) => t.tokens.length)
        .map((t) => ({
          id: t.id,
          range: { from_token: t.tokens[0]!.id, to_token: t.tokens.at(-1)!.id },
        }));
    }
    if (targets.some((target) => this.running.has(target.id)))
      return { code: "E_SUB_PASS_RUNNING", message: "这份母稿已有 AI 整理或校对在运行，请完成后重试", retryable: true };
    const state: SubtitlePassState = {
      pass_id: newId("job_"),
      kind: verb === "subtitle_tidy" ? "tidy" : "proofread",
      state: "running",
      done: 0,
      total: 0,
      reason: null,
    };
    this.latest = state;
    const task = Promise.resolve()
      .then(async () => {
        if (state.kind === "proofread") return this.proofread(targets, state, params.request);
        return this.organize(targets, state, params.request);
      })
      .finally(() => {
        for (const target of targets) this.running.delete(target.id);
      });
    for (const target of targets) this.running.set(target.id, task);
    this.options.changed();
    return { pass_id: state.pass_id };
  }

  private emptyEnvelope(): Envelope {
    return {
      ok: true,
      status: "no_op",
      verb: "edit",
      request_id: newId("req_"),
      receipt: null,
      changes: [],
      verification: { level: "none", passed: true, issues: [] },
      result: null,
      error: null,
    };
  }

  private async organize(targets: PassTarget[], manual?: SubtitlePassState, request?: string): Promise<Envelope> {
    const warnings: PassWarning[] = [];
    let progresses: { transcript_id: string; done: number; total: number }[] = [];
    let envelope = this.emptyEnvelope();
    const update = () => {
      if (manual) {
        manual.done = progresses.reduce((sum, progress) => sum + progress.done, 0);
        manual.total = progresses.reduce((sum, progress) => sum + progress.total, 0);
      } else
        for (const target of targets)
          this.states.set(target.id, { running: true, phase: "breaking", warnings, progress: progresses });
      this.options.changed();
    };
    update();
    try {
      if (targets.length) {
        const agents = await this.agents();
        for (let revisionAttempt = 0; revisionAttempt < 2; revisionAttempt++) {
          progresses = [];
          const project = await this.options.load();
          const ops: Record<string, unknown>[] = [];
          for (const target of targets)
            ops.push(...(await this.segment(project, target, agents, warnings, progresses, update, request)));
          if (this.abort.signal.aborted) throw new Error("整理已停止");
          envelope = await this.options.dispatch("edit", {
            project: this.options.project,
            base_revision: project.revision.id,
            idempotency_key: newId("req_"),
            author: { kind: "agent", name: "字幕整理" },
            label: manual ? "AI 重新分行" : "AI 整理字幕",
            ops,
          });
          if (envelope.error?.code === "E_CONFLICT" && revisionAttempt === 0) continue;
          if (!envelope.ok)
            throw new Error(
              envelope.error?.code === "E_CONFLICT"
                ? "工程持续变化，整理未写入"
                : `整理未写入：${envelope.error?.message ?? "编辑失败"}`,
            );
          break;
        }
      }
      if (manual) manual.state = "done";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "字幕整理失败";
      if (!warnings.length) warnings.push({ code: "W_SUB_PASS_FALLBACK", transcript_id: targets[0]?.id ?? "", reason });
      if (manual) {
        manual.state = "failed";
        manual.reason = reason;
      }
    } finally {
      if (!manual) for (const target of targets) this.states.set(target.id, { running: false, warnings });
      this.options.changed();
    }
    return {
      ...envelope,
      result: { ...envelope.result, warnings },
      verification: {
        ...envelope.verification,
        issues: [
          ...envelope.verification.issues,
          ...warnings.map((w) => ({
            code: w.code,
            severity: "warning" as const,
            message: w.reason,
            ids: [w.transcript_id],
          })),
        ],
      },
    };
  }

  private async proofread(
    targets: PassTarget[],
    manual?: SubtitlePassState,
    request?: string,
    summary?: { summary: string; terms: string[] },
  ): Promise<Envelope> {
    const warnings: PassWarning[] = [];
    const progresses: { transcript_id: string; done: number; total: number }[] = [];
    let envelope = this.emptyEnvelope();
    const update = () => {
      if (manual) {
        manual.done = progresses.reduce((sum, p) => sum + p.done, 0);
        manual.total = progresses.reduce((sum, p) => sum + p.total, 0);
      } else
        for (const target of targets)
          this.states.set(target.id, { running: true, phase: "proofread", warnings, progress: progresses });
      this.options.changed();
    };
    const skip = (id: string, count: number) => {
      if (!count) return;
      const previous = warnings.find((w) => w.code === "W_SUB_PROOFREAD_SKIPPED" && w.transcript_id === id);
      if (previous) previous.count = (previous.count ?? 0) + count;
      else warnings.push({ code: "W_SUB_PROOFREAD_SKIPPED", transcript_id: id, count, reason: "" });
      const warning = previous ?? warnings.at(-1)!;
      warning.reason = `${warning.count} 条校对改动未通过检查，已跳过`;
    };
    update();
    let failedId = targets[0]?.id ?? "";
    try {
      const project = await this.options.load();
      const chunks: { lines: ProofreadLine[]; progress: (typeof progresses)[number] }[] = [];
      for (const target of targets) {
        const transcript = project.transcripts.find((t) => t.id === target.id);
        if (!transcript) throw new Error("母稿已不存在，请重新打开工程后重试");
        const lines = proofreadLines(transcript, target.range).filter((line) => !line.locked && line.text.trim());
        const progress = { transcript_id: target.id, done: 0, total: Math.ceil(lines.length / 80) };
        progresses.push(progress);
        for (let at = 0; at < lines.length; at += 80) chunks.push({ lines: lines.slice(at, at + 80), progress });
      }
      update();
      const fixes: ProofreadFix[] = [];
      if (chunks.length) {
        const agents = await this.agents();
        const terms = [...new Set([...(project.recognition?.terms ?? []), ...(summary?.terms ?? [])])];
        let next = 0;
        let failure: Error | undefined;
        const worker = async () => {
          while (next < chunks.length && !failure && !this.abort.signal.aborted) {
            const chunk = chunks[next++]!;
            let agent = agents.current;
            const process = async (kind: AgentKind) => {
              const input = {
                ...(summary ? { summary: summary.summary } : {}),
                terms,
                lines: chunk.lines.map(({ id, text }) => ({ id, text })),
                ...(request ? { request } : {}),
              };
              const base = `${SUBTITLE_PROOFREAD_PROMPT}\n${JSON.stringify(input)}${request ? `\n用户的额外要求：${request}` : ""}`;
              const ask = async (prompt: string) => {
                let reason = "Agent 调用失败";
                for (let retry = 0; retry < 2 && !this.abort.signal.aborted; retry++) {
                  try {
                    const output: unknown = JSON.parse(await this.attempt(kind, prompt));
                    if (
                      !output ||
                      typeof output !== "object" ||
                      Array.isArray(output) ||
                      Object.keys(output).join() !== "fixes" ||
                      !Array.isArray((output as { fixes?: unknown }).fixes)
                    )
                      throw new Error("输出必须只有 fixes 数组");
                    const items = (output as { fixes: { id: string; text: string; why: string }[] }).fixes;
                    if (items.some((item) => !item || typeof item.id !== "string"))
                      throw new Error("fixes 每项必须包含字幕条 id");
                    const relevant = items.filter((item) =>
                      chunk.lines.some((line) => line.id === item.id && !line.locked),
                    );
                    if (
                      relevant.some((item) => typeof item.text !== "string" || typeof item.why !== "string") ||
                      new Set(relevant.map((item) => item.id)).size !== relevant.length
                    )
                      throw new Error("fixes 每项必须包含 id、text、why，且 id 不能重复");
                    return relevant;
                  } catch (error) {
                    reason = error instanceof Error ? error.message : "Agent 调用失败";
                    if (/authenticat|oauth|log(?:ged)?[ -]?in|login|登录|unauthorized/i.test(reason)) break;
                  }
                }
                throw new Error(reason);
              };
              const initial = await ask(base);
              const valid: ProofreadFix[] = [];
              const problems: string[] = [];
              const invalid = new Map<string, ProofreadLine>();
              for (const item of initial) {
                const line = chunk.lines.find((line) => line.id === item.id);
                if (!line || line.locked) continue;
                const problem = proofreadProblem(line, item.text, terms);
                if (problem) {
                  problems.push(problem);
                  invalid.set(line.id, line);
                } else valid.push({ ...line, replacement: item.text });
              }
              if (problems.length) {
                const revised = await ask(
                  `${base}\n${JSON.stringify({ 上一次的结果: { fixes: initial }, 问题: problems })}`,
                );
                for (const item of revised) {
                  const line = invalid.get(item.id);
                  if (line && !proofreadProblem(line, item.text, terms)) {
                    valid.push({ ...line, replacement: item.text });
                    invalid.delete(line.id);
                  }
                }
              }
              return { valid, skipped: invalid.size };
            };
            try {
              let result: Awaited<ReturnType<typeof process>>;
              try {
                result = await process(agent);
              } catch (error) {
                const other = agents.available.find((kind) => kind !== agent);
                if (!other || this.abort.signal.aborted) throw error;
                agents.current = other;
                agent = other;
                result = await process(agent);
              }
              fixes.push(...result.valid);
              skip(chunk.progress.transcript_id, result.skipped);
            } catch (error) {
              failedId = chunk.progress.transcript_id;
              const message = error instanceof Error ? error.message : "Agent 调用失败";
              failure = new Error(
                /超时/u.test(message)
                  ? "字幕校对超时，请检查 Agent 后重试"
                  : /authenticat|oauth|log(?:ged)?[ -]?in|login|登录|unauthorized/i.test(message)
                    ? agent === "claude"
                      ? "Claude Code 登录已过期，请在终端运行 claude 重新登录，或在 AI 面板换成 Codex"
                      : "Codex 未登录，请在终端运行 codex 登录，或在 AI 面板换成 Claude Code"
                    : `字幕校对失败：${message}，请检查 Agent 后重试`,
              );
            } finally {
              chunk.progress.done++;
              update();
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, worker));
        if (failure) throw failure;
      }
      // Agent completion order must not change operation order or generated token IDs.
      const order = project.transcripts.flatMap((t) => t.cues.map((c) => c.id));
      fixes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const skipped = new Set<ProofreadFix>();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.abort.signal.aborted) throw new Error("校对已停止");
        const latest = await this.options.load();
        const ops: Record<string, unknown>[] = [];
        const lines = new Map(latest.transcripts.flatMap((t) => proofreadLines(t)).map((line) => [line.id, line]));
        for (const fix of fixes) {
          if (skipped.has(fix)) continue;
          const transcript = latest.transcripts.find((t) => t.id === fix.transcript_id);
          const line = lines.get(fix.id);
          if (!transcript || !line || line.locked || line.text !== fix.text) {
            skipped.add(fix);
            continue;
          }
          const edits = proofreadOps(transcript, fix);
          if (edits === null) {
            skipped.add(fix);
            skip(fix.transcript_id, 1);
          } else ops.push(...edits);
        }
        if (!ops.length) {
          envelope = this.emptyEnvelope();
          break;
        }
        envelope = await this.options.dispatch("edit", {
          project: this.options.project,
          base_revision: latest.revision.id,
          idempotency_key: newId("req_"),
          author: { kind: "agent", name: "字幕校对" },
          label: "AI 校对字幕",
          ops,
        });
        if (envelope.error?.code === "E_CONFLICT" && attempt === 0) continue;
        if (!envelope.ok)
          throw new Error(
            envelope.error?.code === "E_CONFLICT"
              ? "工程持续变化，校对未写入"
              : `校对未写入：${envelope.error?.message ?? "编辑失败"}`,
          );
        break;
      }
      if (manual) manual.state = "done";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "字幕校对失败";
      warnings.push({ code: "W_SUB_PROOFREAD_FAILED", transcript_id: failedId, reason });
      if (manual) {
        manual.state = "failed";
        manual.reason = reason;
      }
    } finally {
      if (!manual)
        for (const target of targets) this.states.set(target.id, { running: false, phase: "proofread", warnings });
      this.options.changed();
    }
    return {
      ...envelope,
      result: { ...envelope.result, warnings },
      verification: {
        ...envelope.verification,
        issues: [
          ...envelope.verification.issues,
          ...warnings.map((w) => ({
            code: w.code,
            severity: "warning" as const,
            message: w.reason,
            ids: [w.transcript_id],
          })),
        ],
      },
    };
  }

  async stop() {
    this.abort.abort();
    for (const entry of this.jobs.values()) clearTimeout(entry.timer);
    this.jobs.clear();
    await Promise.all(this.running.values());
  }
}
