// biome-ignore-all lint/style/noNonNullAssertion: Synthetic fixture indices are fixed in each test.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatch,
  type Envelope,
  type Project,
  parseProject,
  rational,
  serializeProject,
  type Transcript,
} from "../../core/src/index.ts";
import {
  type AgentRunner,
  SUBTITLE_PASS_PROMPT,
  SUBTITLE_PROOFREAD_PROMPT,
  SUBTITLE_SUMMARY_PROMPT,
  SubtitlePass,
} from "../src/subtitle-pass.js";
import { proofreadLines, proofreadOps } from "../src/subtitle-proofread.js";

const managers: SubtitlePass[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((pass) => pass.stop()));
  vi.useRealTimers();
});
const ok = (): Envelope => ({
  ok: true,
  verb: "edit",
  status: "no_op",
  request_id: "req_test",
  receipt: null,
  result: null,
  error: null,
  changes: [],
  verification: { level: "none", passed: true, issues: [] },
});
const fixes = (items: { id: string; text: string }[] = []) =>
  JSON.stringify({ fixes: items.map((f) => ({ ...f, why: "错字" })) });
const input = (prompt: string) => JSON.parse(prompt.slice(SUBTITLE_PROOFREAD_PROMPT.length).trim().split("\n")[0]!);
function transcript(lines = ["我们今天工部了消息"], words?: string[][]): Transcript {
  const tokens: Transcript["tokens"] = [];
  const cues = lines.map((text, i) => {
    const first = tokens.length;
    for (const word of words?.[i] ?? Array.from(text)) {
      const n = tokens.length;
      tokens.push({
        id: `tok_${n}`,
        text: word,
        state: "auto",
        align: {
          start: rational(BigInt(n), 10n),
          end: rational(BigInt(n + 1), 10n),
          run: "run_test",
        },
      });
    }
    return { id: `cue_${i}`, first_token: `tok_${first}`, last_token: tokens.at(-1)!.id, state: "auto" as const };
  });
  return { id: "trs_test", media_id: "med_a", language: "zh-Hans", source_channels: [0], raw_runs: [], tokens, cues };
}
async function setup(t = transcript(), runner: AgentRunner = async () => fixes()) {
  const parsed = parseProject(await readFile("examples/interview.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("fixture");
  const project = parsed.project;
  project.transcripts = [t];
  project.recognition = { terms: [], remove_fillers: true };
  const run = vi.fn(runner);
  const kernel = vi.fn(async (_verb: string, _request: unknown): Promise<Envelope> => ok());
  const detect = vi.fn(async () => [
    { agent: "claude" as const, available: true },
    { agent: "codex" as const, available: true },
  ]);
  const changed = vi.fn();
  const pass = new SubtitlePass({
    project: "/project.zcut.json",
    load: async () => structuredClone(project),
    transcribed: async () => [t.id],
    dispatch: kernel,
    detect,
    selected: () => undefined,
    run,
    changed,
  });
  managers.push(pass);
  return { pass, project, run, kernel, detect, changed };
}
async function finish(f: Awaited<ReturnType<typeof setup>>, params = {}) {
  const result = await f.pass.start("subtitle_proofread", params);
  expect(result).toHaveProperty("pass_id");
  await vi.waitFor(() => expect(f.pass.latest?.state).not.toBe("running"));
}
const edits = (f: Awaited<ReturnType<typeof setup>>, call = 0) =>
  f.kernel.mock.calls[call]![1] as {
    base_revision: string;
    author: unknown;
    label: string;
    ops: Record<string, unknown>[];
  };

describe("proofread checks with a fake agent", () => {
  it.each([false, true])("partial proofread never marks even when every cue is selected (fixes: %s)", async (fix) => {
    const f = await setup(transcript(), async () => fixes(fix ? [{ id: "cue_0", text: "我们今天公布了消息" }] : []));
    await f.pass.start("subtitle_proofread", { cue_ids: ["cue_0"] });
    const result = await f.pass.run("trs_test");
    expect(f.pass.latest?.state).toBe("done");
    if (fix) {
      expect(edits(f).ops).toEqual([
        { op: "edit_text", transcript_id: "trs_test", from_token: "tok_4", to_token: "tok_5", text: "公布" },
      ]);
    } else {
      expect(f.kernel).not.toHaveBeenCalled();
      expect(result.status).toBe("no_op");
    }
  });
  it("appends a mark for every whole transcript in one batch", async () => {
    const f = await setup();
    const other = transcript(["这里也是工部的消息"]);
    other.id = "trs_other";
    other.cues[0]!.id = "cue_other";
    for (const token of other.tokens) token.id += "_other";
    other.cues[0]!.first_token += "_other";
    other.cues[0]!.last_token += "_other";
    f.project.transcripts.push(other);
    await finish(f);
    expect(edits(f)).toMatchObject({
      label: "AI 校对字幕（没有要改的字）",
      ops: [
        { op: "mark_proofread", transcript_id: "trs_test" },
        { op: "mark_proofread", transcript_id: "trs_other" },
      ],
    });
  });
  it.each([
    ["empty", "", "改后文字为空"],
    ["punctuation", "我们今天公布了消息。", "标点"],
    ["edit distance", "大家明天一起去玩吧", "只能改错字"],
    ["lost term", "我们今天工部了消喜", "丢了名词「消息」"],
  ])("rejects %s after exactly one revision round", async (_name, text, problem) => {
    const f = await setup(transcript(), async () => fixes([{ id: "cue_0", text }]));
    f.project.recognition!.terms = ["消息"];
    await finish(f);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]![1]).toContain(problem);
    expect(f.run.mock.calls[1]![1]).toContain('"上一次的结果":{"fixes":');
    expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
    expect(f.pass.latest).toMatchObject({ state: "done", done: 1, total: 1 });
  });
  it("counts skipped lines in the envelope and retains the already-valid fixes during revision", async () => {
    const t = transcript(["我们今天工部了消息", "这里也是工部的消息", "这个消息工部得很快"]);
    let call = 0;
    const f = await setup(t, async () =>
      ++call === 1
        ? fixes([
            { id: "cue_0", text: "我们今天公布了消息" },
            { id: "cue_1", text: "换个完全不同的说法" },
            { id: "cue_2", text: "这个消息公布得很快。" },
          ])
        : fixes([
            { id: "cue_0", text: "别动已经有效的改动" },
            { id: "cue_1", text: "这里也是公布的消息" },
            { id: "cue_2", text: "这个消息公布得很快。" },
          ]),
    );
    await finish(f);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(edits(f)).toMatchObject({
      author: { kind: "agent", name: "字幕校对" },
      label: "AI 校对字幕",
      ops: [
        { op: "edit_text", from_token: "tok_4", to_token: "tok_5", text: "公布" },
        { op: "edit_text", from_token: "tok_13", to_token: "tok_14", text: "公布" },
        { op: "mark_proofread", transcript_id: "trs_test" },
      ],
    });
    // The automatic entry exposes warnings in its envelope as well as the panel state.
    t.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
    f.project.transcripts[0]!.ext = t.ext;
    const result = await f.pass.run(t.id);
    expect(result.result?.warnings).toContainEqual(
      expect.objectContaining({ code: "W_SUB_PROOFREAD_SKIPPED", count: 2 }),
    );
  });
  it("uses Unicode code points and allows exactly max(1, ceil(len * .3)) edits", async () => {
    const f = await setup(transcript(["𠮷字", "工部消息", "工部消息好"]), async () =>
      fixes([
        { id: "cue_0", text: "吉字" },
        { id: "cue_1", text: "公布消息" },
        { id: "cue_2", text: "公布消息好" },
      ]),
    );
    await finish(f);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(edits(f).ops).toHaveLength(4);
  });
  it("ignores unknown, locked, approved cues and approved tokens", async () => {
    const t = transcript(Array(5).fill("我们今天工部了消息"));
    t.cues[1]!.timing = { locked: true };
    t.cues[2]!.state = "approved";
    t.tokens[27]!.state = "approved";
    const f = await setup(t, async () =>
      fixes(["cue_0", "cue_1", "cue_2", "cue_3", "missing"].map((id) => ({ id, text: "我们今天公布了消息" }))),
    );
    await finish(f, { cue_ids: ["cue_0", "cue_3"] });
    expect(input(f.run.mock.calls[0]![1]).lines.map((l: { id: string }) => l.id)).toEqual(["cue_0"]);
    expect(edits(f).ops).toHaveLength(1);
  });
  it.each(["bad JSON", '{"fixes":{}}', '{"fixes":[{"id":"cue_0","text":"错"}]}'])(
    "retries invalid output once, then switches agent: %s",
    async (output) => {
      const f = await setup(transcript(), async (agent) =>
        agent === "claude" ? output : fixes([{ id: "cue_0", text: "我们今天公布了消息" }]),
      );
      await finish(f);
      expect(f.run.mock.calls.map(([agent]) => agent)).toEqual(["claude", "claude", "codex"]);
      expect(f.pass.latest?.state).toBe("done");
    },
  );
  it("retries a call failure once and succeeds", async () => {
    const f = await setup();
    f.run.mockRejectedValueOnce(new Error("启动失败"));
    await finish(f);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
  });
  it("reports a readable failure and writes nothing if a block fails", async () => {
    const f = await setup(transcript(), async () => {
      throw new Error("Not logged in");
    });
    await finish(f);
    expect(f.run.mock.calls.map(([agent]) => agent)).toEqual(["claude", "codex"]);
    expect(f.pass.latest).toMatchObject({ state: "failed", reason: expect.stringContaining("Codex 未登录") });
    expect(f.kernel).not.toHaveBeenCalled();
  });
  it("times out at 120 seconds, retries once, and reports W_SUB_PROOFREAD_FAILED", async () => {
    vi.useFakeTimers();
    const t = transcript();
    t.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
    const f = await setup(t, async (_agent, prompt) =>
      prompt.startsWith(SUBTITLE_SUMMARY_PROMPT) ? '{"summary":"测试","terms":[]}' : new Promise(() => {}),
    );
    f.detect.mockResolvedValue([{ agent: "claude", available: true }]);
    const task = f.pass.run(t.id);
    await vi.advanceTimersByTimeAsync(240000);
    const result = await task;
    expect(f.run.mock.calls.filter(([, p]) => p.startsWith(SUBTITLE_PROOFREAD_PROMPT))).toHaveLength(2);
    expect(result.result?.warnings).toContainEqual(
      expect.objectContaining({ code: "W_SUB_PROOFREAD_FAILED", reason: expect.stringContaining("超时") }),
    );
    expect(f.kernel).not.toHaveBeenCalled();
  });
  it("skips an entire fix whose minimal changed region crosses a hidden token", async () => {
    const t = transcript(["我们今天工部了消息"], [["我们今天", "工", "", "部", "了消息"]]);
    const f = await setup(t, async () => fixes([{ id: "cue_0", text: "我们今天公布了消息" }]));
    t.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
    f.project.transcripts[0]!.ext = t.ext;
    f.run.mockImplementation(async (_a, p) =>
      p.startsWith(SUBTITLE_SUMMARY_PROMPT)
        ? '{"summary":"测试","terms":[]}'
        : fixes([{ id: "cue_0", text: "我们今天公布了消息" }]),
    );
    const result = await f.pass.run(t.id);
    expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
    expect(result.status).toBe("no_op");
    expect(result.result?.warnings).toEqual([expect.objectContaining({ code: "W_SUB_PROOFREAD_SKIPPED", count: 1 })]);
  });
  it("recomputes on revision conflict, drops changed cues and never calls the agent again", async () => {
    const f = await setup(transcript(["我们今天工部了消息", "这里也是工部的消息"]), async () =>
      fixes([
        { id: "cue_0", text: "我们今天公布了消息" },
        { id: "cue_1", text: "这里也是公布的消息" },
      ]),
    );
    f.kernel.mockImplementationOnce(async () => {
      f.project.transcripts[0]!.tokens[0]!.text = "你";
      f.project.revision.id = "rev_new";
      return {
        ...ok(),
        ok: false,
        status: "failed",
        error: { code: "E_CONFLICT", message: "conflict", retryable: true, details: {} },
      };
    });
    await finish(f);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.kernel).toHaveBeenCalledTimes(2);
    expect(edits(f, 1)).toMatchObject({
      base_revision: "rev_new",
      ops: [
        { from_token: "tok_13", to_token: "tok_14", text: "公布" },
        { op: "mark_proofread", transcript_id: "trs_test" },
      ],
    });
  });
  it("retries with only the mark when every cue changed during a whole-transcript conflict", async () => {
    const t = transcript();
    t.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
    const f = await setup(t, async (_a, p) =>
      p.startsWith(SUBTITLE_SUMMARY_PROMPT)
        ? '{"summary":"测试","terms":[]}'
        : fixes([{ id: "cue_0", text: "我们今天公布了消息" }]),
    );
    f.kernel.mockImplementationOnce(async () => {
      f.project.transcripts[0]!.tokens[0]!.text = "你";
      return {
        ...ok(),
        ok: false,
        status: "failed",
        error: { code: "E_CONFLICT", message: "conflict", retryable: true, details: {} },
      };
    });
    const result = await f.pass.run(t.id);
    expect(result.status).toBe("no_op");
    expect(result.ok).toBe(true);
    expect(f.kernel).toHaveBeenCalledTimes(2);
    expect(edits(f, 1)).toMatchObject({
      label: "AI 校对字幕（没有要改的字）",
      ops: [{ op: "mark_proofread", transcript_id: "trs_test" }],
    });
  });
  it("does not overwrite a cue locked or changed while the agent was running", async () => {
    const f = await setup(transcript(["我们今天工部了消息", "这里也是工部的消息"]), async () => {
      f.project.transcripts[0]!.cues[0]!.timing = { locked: true };
      f.project.transcripts[0]!.tokens[9]!.text = "你";
      return fixes([
        { id: "cue_0", text: "我们今天公布了消息" },
        { id: "cue_1", text: "这里也是公布的消息" },
      ]);
    });
    await finish(f);
    expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
  });
  it("chunks <=80 cues, runs six at once, and switches queued chunks to the replacement agent", async () => {
    const f = await setup(transcript(Array(561).fill("我们今天工部了消息")), async (agent, prompt) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (agent === "claude") throw new Error("Not logged in");
      expect(input(prompt).lines.length).toBeLessThanOrEqual(80);
      return fixes(input(prompt).lines.map((line: { id: string }) => ({ id: line.id, text: "我们今天公布了消息" })));
    });
    let active = 0,
      max = 0;
    await finish(f);
    expect(max).toBe(6);
    expect(f.run.mock.calls.filter(([a]) => a === "claude")).toHaveLength(6);
    expect(f.run.mock.calls.filter(([a]) => a === "codex")).toHaveLength(8);
    expect(f.pass.latest).toMatchObject({ done: 8, total: 8, state: "done" });
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(edits(f).ops).toHaveLength(562);
    expect(edits(f).ops[0]!.from_token).toBe("tok_4");
  });
  it("limits the selected cue span, merges terms, and includes user requirements in JSON and prompt", async () => {
    const f = await setup(transcript(Array(5).fill("我们今天工部了消息")));
    f.project.recognition!.terms = ["消息", "消息"];
    await finish(f, { cue_ids: ["cue_1", "cue_3"], request: "只校对错字" });
    expect(input(f.run.mock.calls[0]![1])).toEqual({
      terms: ["消息"],
      lines: [1, 2, 3].map((i) => ({ id: `cue_${i}`, text: "我们今天工部了消息" })),
      request: "只校对错字",
    });
    expect(f.run.mock.calls[0]![1]).toContain("用户的额外要求：只校对错字");
  });
});

it.each([
  [
    ["今天", "工部", "了", "消喜"],
    "今天公布了消息",
    [
      ["tok_1", "tok_1", "公布"],
      ["tok_3", "tok_3", "消息"],
    ],
  ],
  [["我们工部消息"], "我们公布消息", [["tok_0", "tok_0", "我们公布消息"]]],
  [["我们", "今天", "工", "部", "消息"], "我们今天公布消息", [["tok_2", "tok_3", "公布"]]],
  [["A", "bad", "word"], "A good word", [["tok_1", "tok_1", "good"]]],
  [["今", "公布", "消息"], "今天公布消息", [["tok_1", "tok_1", "天公布"]]],
  [["今天", "真", "公布", "消息"], "今天公布消息", [["tok_1", "tok_1", ""]]],
])("expands minimal character edits to whole tokens: %s", (words, replacement, expected) => {
  const t = transcript([""], [words as string[]]);
  const line = proofreadLines(t)[0]!;
  const ops = proofreadOps(t, { ...line, replacement: replacement as string });
  expect(ops?.map((op) => [op.from_token, op.to_token, op.text])).toEqual(expected);
});

it("keeps unchanged hidden tokens outside edit regions", () => {
  const t = transcript([""], [["我们", "", "工部", "消息"]]);
  expect(proofreadOps(t, { ...proofreadLines(t)[0]!, replacement: "我们公布消息" })).toEqual([
    { op: "edit_text", transcript_id: t.id, from_token: "tok_2", to_token: "tok_2", text: "公布" },
  ]);
});

it("starts summary concurrently, writes breaking before summary finishes, then proofreads the new cues", async () => {
  let release!: (text: string) => void;
  const t = transcript();
  const f = await setup(t, async (_a, p) => {
    if (p.startsWith(SUBTITLE_SUMMARY_PROMPT))
      return new Promise((resolve) => {
        release = resolve;
      });
    if (p.startsWith(SUBTITLE_PASS_PROMPT)) return JSON.stringify({ lines: ["我们今天工部了消息"] });
    expect(input(p)).toEqual({
      summary: "新闻发布",
      terms: ["消息", "新闻"],
      lines: [{ id: "cue_new", text: "我们今天工部了消息" }],
    });
    return fixes([{ id: "cue_new", text: "我们今天公布了消息" }]);
  });
  f.project.recognition!.terms = ["消息"];
  f.kernel.mockImplementationOnce(async () => {
    f.project.transcripts[0]!.cues[0]!.id = "cue_new";
    return ok();
  });
  const task = f.pass.run(t.id);
  await vi.waitFor(() => expect(f.kernel).toHaveBeenCalledTimes(1));
  expect(f.run.mock.calls.map(([, p]) => (p.startsWith(SUBTITLE_SUMMARY_PROMPT) ? "summary" : "breaking"))).toEqual([
    "summary",
    "breaking",
  ]);
  expect(f.pass.state).toMatchObject({ running: true, phase: "proofread" });
  release('{"summary":"新闻发布","terms":["新闻","消息"]}');
  await task;
  expect(f.kernel).toHaveBeenCalledTimes(2);
  expect(edits(f).label).toBe("AI 整理字幕");
  expect(edits(f, 1).label).toBe("AI 校对字幕");
});

it("uses at most 12000 Unicode characters for summary and falls back to project terms on summary failure", async () => {
  const t = transcript(["𠮷".repeat(12005)]);
  t.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
  const f = await setup(t, async (_a, p) => {
    if (p.startsWith(SUBTITLE_SUMMARY_PROMPT)) {
      expect(Array.from(p.slice(SUBTITLE_SUMMARY_PROMPT.length).trim())).toHaveLength(12000);
      throw new Error("summary failed");
    }
    expect(input(p)).not.toHaveProperty("summary");
    expect(input(p).terms).toEqual(["豆包"]);
    return fixes();
  });
  f.project.recognition!.terms = ["豆包"];
  const result = await f.pass.run(t.id);
  expect(result.result?.warnings).toEqual([]);
  expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
});

it("keeps the breaking write and exposes a proofread-only warning on proofread failure", async () => {
  const f = await setup(transcript(), async (_a, p) => {
    if (p.startsWith(SUBTITLE_SUMMARY_PROMPT)) return '{"summary":"新闻发布","terms":[]}';
    if (p.startsWith(SUBTITLE_PASS_PROMPT)) return '{"lines":["我们今天工部了消息"]}';
    throw new Error("Not logged in");
  });
  const written = {
    ...ok(),
    status: "applied" as const,
    receipt: { before: "rev_old", after: "rev_breaking", idempotency_key: "break", replayed: false },
  };
  f.kernel.mockResolvedValue(written);
  const result = await f.pass.run("trs_test");
  expect(f.kernel).toHaveBeenCalledTimes(1);
  expect(result.receipt?.after).toBe("rev_breaking");
  expect(result.result?.warnings).toEqual([
    expect.objectContaining({ code: "W_SUB_PROOFREAD_FAILED", reason: expect.stringContaining("登录") }),
  ]);
  expect(f.pass.state).toMatchObject({
    running: false,
    warnings: [expect.objectContaining({ code: "W_SUB_PROOFREAD_FAILED" })],
  });
});

it("reopens unmarked transcripts for both steps, tidy-only transcripts for proofread, and skips completed ones", async () => {
  const f = await setup(transcript(), async (_a, p) => {
    if (p.startsWith(SUBTITLE_SUMMARY_PROMPT)) return '{"summary":"新闻发布","terms":[]}';
    if (p.startsWith(SUBTITLE_PASS_PROMPT)) return '{"lines":["我们今天工部了消息"]}';
    return fixes();
  });
  await f.pass.open();
  expect(f.run).toHaveBeenCalledTimes(3);
  expect(f.kernel).toHaveBeenCalledTimes(2);
  f.run.mockClear();
  f.kernel.mockClear();
  f.project.transcripts[0]!.ext = { "zsir.subtitle_pass": { by: "字幕整理" } };
  await f.pass.open();
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(edits(f).ops).toEqual([{ op: "mark_proofread", transcript_id: "trs_test" }]);
  expect(f.run.mock.calls.some(([, p]) => p.startsWith(SUBTITLE_PASS_PROMPT))).toBe(false);
  f.run.mockClear();
  f.project.transcripts[0]!.ext!["zsir.proofread"] = { by: "字幕校对" };
  await f.pass.open();
  expect(f.run).not.toHaveBeenCalled();
  f.kernel.mockClear();
  delete f.project.transcripts[0]!.ext!["zsir.subtitle_pass"];
  await f.pass.open();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.run.mock.calls[0]![1]).toContain(SUBTITLE_PASS_PROMPT);
  expect(f.kernel).toHaveBeenCalledTimes(1);
});

it("keeps host prompts exactly synchronized with the Skill quoted blocks", async () => {
  const skill = await readFile("skills/zsir-cut/references/subtitles.md", "utf8");
  const quote = (name: string) =>
    skill
      .split(`### ${name}\n\n`)[1]!
      .split("\n\n##")[0]!
      .split("\n")
      .filter((line) => line.startsWith(">"))
      .map((line) => line.slice(2))
      .join("\n");
  expect(SUBTITLE_SUMMARY_PROMPT).toBe(quote("概要要求"));
  expect(SUBTITLE_PROOFREAD_PROMPT).toBe(`${quote("校对要求")}\n\n${skill.split("\n\n修改轮：")[1]!.split("\n\n")[0]}`);
});

it.each(["manual-fix", "manual-no-fix", "automatic-no-fix"])(
  "writes one undoable real core history step and skips proofread on reopen (%s)",
  async (mode) => {
    const fix = mode === "manual-fix";
    const directory = await mkdtemp(join(tmpdir(), "proofread-core-"));
    const path = join(directory, "project.zcut.json");
    try {
      const parsed = parseProject(await readFile("examples/interview.zcut.json", "utf8"));
      if (!parsed.ok) throw new Error("fixture");
      const project = parsed.project;
      const t = project.transcripts[0]!;
      t.tokens[1]!.text = "工部";
      for (const token of t.tokens) token.state = "auto";
      for (const cue of t.cues) {
        cue.state = "auto";
        delete cue.timing;
      }
      t.ext = { "test.keep": true, "zsir.subtitle_pass": { by: "字幕整理" } };
      await writeFile(path, serializeProject(project));
      const load = async (): Promise<Project> => {
        const p = parseProject(await readFile(path, "utf8"));
        if (!p.ok) throw new Error("fixture");
        return p.project;
      };
      const before = await load();
      const run = vi.fn<AgentRunner>(async (_a, p) =>
        fix
          ? fixes(
              input(p)
                .lines.map((l: { id: string; text: string }) => ({ id: l.id, text: l.text.replace("工部", "公布") }))
                .filter((l: { text: string }) => l.text.includes("公布")),
            )
          : fixes(),
      );
      const pass = new SubtitlePass({
        project: path,
        load,
        transcribed: async () => [],
        dispatch,
        detect: async () => [{ agent: "claude", available: true }],
        selected: () => undefined,
        run,
        changed: () => {},
      });
      managers.push(pass);
      if (mode === "automatic-no-fix") await pass.open();
      else {
        await pass.start("subtitle_proofread", { transcript_id: t.id });
        await vi.waitFor(() => expect(pass.latest?.state).not.toBe("running"));
        expect(pass.latest).toMatchObject({ state: "done" });
      }
      const after = await load();
      expect(after.revision.seq).toBe(before.revision.seq + 1);
      expect(after.transcripts[0]!.ext).toMatchObject({ "zsir.proofread": { by: "字幕校对" }, "test.keep": true });
      if (fix)
        expect(after.transcripts[0]!.tokens).toContainEqual(
          expect.objectContaining({ text: "公布", heard: "工部", state: "edited" }),
        );
      else
        expect(after.transcripts).toEqual(
          before.transcripts.map((t, i) =>
            i === 0
              ? {
                  ...t,
                  ext: { ...t.ext, "zsir.proofread": { by: "字幕校对" } },
                }
              : t,
          ),
        );
      const history = await dispatch("inspect", { project: path, view: "history" });
      expect((history.result?.entries as { label: string }[])[0]!.label).toBe(
        fix ? "AI 校对字幕" : "AI 校对字幕（没有要改的字）",
      );
      run.mockClear();
      const reopened = new SubtitlePass({
        project: path,
        load,
        transcribed: async () => [],
        dispatch,
        detect: async () => [{ agent: "claude", available: true }],
        selected: () => undefined,
        run,
        changed: () => {},
      });
      managers.push(reopened);
      await reopened.open();
      expect(run).not.toHaveBeenCalled();
      expect((await load()).revision).toEqual(after.revision);
      const undo = await dispatch("undo", {
        project: path,
        base_revision: after.revision.id,
        idempotency_key: "undo-proofread",
        author: { kind: "human", name: "测试" },
      });
      expect(undo.ok).toBe(true);
      expect((await load()).transcripts).toEqual(before.transcripts);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("keeps multiple changes within a token from consuming text from the next token", () => {
  const t = transcript([""], [["abcdef", "GH"]]);
  expect(proofreadOps(t, { ...proofreadLines(t)[0]!, replacement: "aXcde GH" })).toEqual([
    { op: "edit_text", transcript_id: t.id, from_token: "tok_0", to_token: "tok_0", text: "aXcde" },
  ]);
});

it("round-trips minimal token edits across short insertions, deletions and replacements", () => {
  const texts = ["甲", "乙", "甲乙", "乙甲", "甲甲", "甲乙甲", "乙甲乙", "甲丙乙甲"];
  for (const source of texts)
    for (const replacement of [...texts, ""]) {
      for (const words of [Array.from(source), [source], [source.slice(0, 1), source.slice(1)].filter(Boolean)]) {
        const t = transcript([source], [words]);
        const ops = proofreadOps(t, { ...proofreadLines(t)[0]!, replacement });
        expect(ops).not.toBeNull();
        let result = "";
        for (let i = 0; i < t.tokens.length; i++) {
          const op = ops!.find((op) => op.from_token === t.tokens[i]!.id);
          if (op) {
            result += op.text;
            i = t.tokens.findIndex((token) => token.id === op.to_token);
          } else result += t.tokens[i]!.text;
        }
        expect(result, JSON.stringify({ words, replacement, ops })).toBe(replacement);
      }
    }
});

it("discards unknown and protected IDs before checking their proposed text", async () => {
  const t = transcript(["我们今天工部了消息", "这里也是工部的消息"]);
  t.cues[1]!.timing = { locked: true };
  const f = await setup(t, async () =>
    JSON.stringify({
      fixes: [{ id: "missing" }, { id: "cue_1", text: null }, { id: "cue_0", text: "我们今天公布了消息", why: "错字" }],
    }),
  );
  await finish(f);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(edits(f).ops).toHaveLength(2);
});

it("does not let a pending summary occupy any of the six breaking slots", async () => {
  const t = transcript(Array(11).fill("字".repeat(10)));
  for (let i = 1; i < 11; i += 2) t.cues[i]!.timing = { locked: true };
  let summaryDone!: (value: string) => void;
  const breaking: ((value: string) => void)[] = [];
  const f = await setup(t, async (_a, prompt) => {
    if (prompt.startsWith(SUBTITLE_SUMMARY_PROMPT))
      return new Promise((resolve) => {
        summaryDone = resolve;
      });
    if (prompt.startsWith(SUBTITLE_PASS_PROMPT))
      return new Promise((resolve) => {
        breaking.push(resolve);
      });
    return fixes();
  });
  const task = f.pass.run(t.id);
  await vi.waitFor(() => expect(breaking).toHaveLength(6));
  for (const resolve of breaking) resolve(JSON.stringify({ lines: ["字".repeat(10)] }));
  await vi.waitFor(() => expect(f.kernel).toHaveBeenCalledTimes(1));
  summaryDone('{"summary":"测试","terms":[]}');
  await task;
});

it("writes no proofread edits if any block fails, even after another block has valid fixes", async () => {
  const f = await setup(transcript(Array(81).fill("我们今天工部了消息")), async (_a, prompt) => {
    const lines = input(prompt).lines as { id: string }[];
    if (lines[0]!.id === "cue_80") throw new Error("Not logged in");
    return fixes([{ id: "cue_0", text: "我们今天公布了消息" }]);
  });
  await finish(f);
  expect(f.pass.latest?.state).toBe("failed");
  expect(f.kernel).not.toHaveBeenCalled();
});

it("maps stripped end punctuation and line breaks back to whole tokens without losing unchanged punctuation", async () => {
  const parsed = parseProject(await readFile("fixtures/regressions/proofread-display-offsets.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("regression fixture");
  const t = parsed.project.transcripts[0]!;
  expect(proofreadLines(t)[0]!.text).toBe("我们工部\n消息");
  expect(proofreadOps(t, { ...proofreadLines(t)[0]!, replacement: "我们公布\n消息" })).toEqual([
    { op: "edit_text", transcript_id: t.id, from_token: "tok_0", to_token: "tok_0", text: "我们公布。" },
  ]);
  const f = await setup(t, async () => fixes([{ id: "cue_0", text: "我们公布\n消息" }]));
  await finish(f);
  expect(edits(f).ops[0]!.text).toBe("我们公布。");
});

it("allows existing punctuation while rejecting newly added punctuation", async () => {
  const f = await setup(transcript(["版本1.0工部消息"]), async () => fixes([{ id: "cue_0", text: "版本1.0公布消息" }]));
  await finish(f);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(edits(f).ops).toHaveLength(2);
});

it("keeps distinct corrections on opposite sides of a manual line break in separate token edits", () => {
  const t = transcript([""], [["我们工", "部消息"]]);
  t.cues[0]!.breaks = ["tok_0"];
  expect(proofreadOps(t, { ...proofreadLines(t)[0]!, replacement: "我们公\n布消息" })).toEqual([
    { op: "edit_text", transcript_id: t.id, from_token: "tok_0", to_token: "tok_0", text: "我们公" },
    { op: "edit_text", transcript_id: t.id, from_token: "tok_1", to_token: "tok_1", text: "布消息" },
  ]);
});
