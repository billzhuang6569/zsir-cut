// biome-ignore-all lint/style/noNonNullAssertion: Synthetic fixture indexes are fixed by each test.
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatch,
  type Envelope,
  type Project,
  parseProject,
  rational,
  type Transcript,
  validateCommand,
} from "../../core/src/index.ts";
import { type AgentRunner, SUBTITLE_PASS_PROMPT, SubtitlePass, subtitleChunks } from "../src/subtitle-pass.js";

const managers: SubtitlePass[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  vi.useRealTimers();
});
const ok = (result: Record<string, unknown> | null = null): Envelope => ({
  ok: true,
  verb: "edit",
  request_id: "req_test",
  status: "no_op",
  receipt: null,
  changes: [],
  verification: { level: "none", passed: true, issues: [] },
  result,
  error: null,
});
function transcript(count = 10, hardEvery = 0): Transcript {
  return {
    id: "trs_test",
    media_id: "med_test",
    language: "zh-Hans",
    source_channels: [0],
    raw_runs: [],
    tokens: Array.from({ length: count }, (_, i) => ({
      id: `tok_${i}`,
      text: "字",
      state: "auto",
      align: {
        start: rational(BigInt(i + (hardEvery ? Math.floor(i / hardEvery) * 10 : 0)), 10n),
        end: rational(BigInt(i + 1 + (hardEvery ? Math.floor(i / hardEvery) * 10 : 0)), 10n),
        run: "run_test",
      },
    })),
    cues: [{ id: "cue_test", first_token: "tok_0", last_token: `tok_${count - 1}`, state: "auto" }],
  };
}
async function setup(t = transcript(), runner: AgentRunner = async () => '{"cut_after":[3],"hide":[0]}') {
  const parsed = parseProject(await readFile("examples/interview.zcut.json", "utf8"));
  if (!parsed.ok) throw new Error("fixture");
  const project = parsed.project;
  project.transcripts = [t];
  project.recognition = { remove_fillers: true, terms: [] };
  const run = vi.fn(runner);
  const kernel = vi.fn(async () => ok());
  const detect = vi.fn(async () => [
    { agent: "claude" as const, available: true },
    { agent: "codex" as const, available: true },
  ]);
  const selected = vi.fn((): "claude" | "codex" | undefined => undefined);
  const changed = vi.fn();
  const transcribed = vi.fn(async (_revision: string) => [t.id]);
  const manager = new SubtitlePass({
    project: "/project.zcut.json",
    load: async () => project,
    transcribed,
    dispatch: kernel,
    detect,
    selected,
    run,
    changed,
  });
  managers.push(manager);
  return { project, run, kernel, detect, selected, changed, transcribed, manager };
}
function request(f: Awaited<ReturnType<typeof setup>>) {
  return (f.kernel.mock.calls as unknown as [string, { ops: Record<string, unknown>[]; base_revision: string }][]).find(
    ([verb]) => verb === "edit",
  )![1];
}

describe("subtitle pass", () => {
  it("maps chunk indices and submits exactly one ordered edit/history step", async () => {
    const f = await setup();
    const result = await f.manager.run("trs_test");
    expect(result.ok).toBe(true);
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(f.kernel).toHaveBeenCalledWith(
      "edit",
      expect.objectContaining({
        author: { kind: "agent", name: "字幕整理" },
        label: "AI 整理字幕",
        base_revision: f.project.revision.id,
        ops: [
          { op: "hide_tokens", transcript_id: "trs_test", tokens: ["tok_0"] },
          { op: "resegment", transcript_id: "trs_test", cut_after: ["tok_3", "tok_9"] },
        ],
      }),
    );
    expect(f.run.mock.calls[0]![1]).toContain(SUBTITLE_PASS_PROMPT);
    expect(SUBTITLE_PASS_PROMPT).toContain("需要、可能、就是、能够、可以、要、会、去、帮我们、给到、这么一个");
    expect(SUBTITLE_PASS_PROMPT).toContain("少于 6 个字");
    expect(SUBTITLE_PASS_PROMPT).toContain("不以「是」结尾");
    expect(SUBTITLE_PASS_PROMPT).toContain("是……的");
    expect(SUBTITLE_PASS_PROMPT).toContain("逐条检查结尾和开头");
    expect(f.manager.state).toEqual({ running: false, warnings: [] });
  });
  it.each([
    "bad",
    '{"cut_after":[1.5],"hide":[]}',
    '{"cut_after":[2,1],"hide":[]}',
    '{"cut_after":[1,1],"hide":[]}',
    '{"cut_after":[10],"hide":[]}',
    '{"cut_after":[-1],"hide":[]}',
    '{"cut_after":[],"hide":["1"]}',
    '{"cut_after":[]}',
    '{"cut_after":[],"hide":[],"text":"rewrite"}',
  ])("retries invalid output twice then retains rules: %s", async (output) => {
    const f = await setup(transcript(), async () => output);
    const result = await f.manager.run("trs_test");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.kernel).not.toHaveBeenCalled();
    expect(result.verification.issues[0]?.code).toBe("W_SUB_PASS_FALLBACK");
  });
  it("retries once and accepts a corrected response", async () => {
    const f = await setup();
    f.run.mockRejectedValueOnce(new Error("临时失败"));
    await f.manager.run("trs_test");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.kernel).toHaveBeenCalledTimes(1);
  });
  it("times out each call at 120s, aborts both attempts and never writes a mark", async () => {
    vi.useFakeTimers();
    const f = await setup(transcript(), async () => new Promise(() => {}));
    const task = f.manager.run("trs_test");
    await vi.advanceTimersByTimeAsync(119999);
    expect(f.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[0]![2].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    await task;
    expect(f.run.mock.calls[1]![2].aborted).toBe(true);
    expect(f.manager.state.warnings[0]?.reason).toContain("超时");
    expect(f.kernel).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])("uses the filler setting in the prompt and edits (%s)", async (setting) => {
    const f = await setup();
    if (setting === undefined) delete f.project.recognition;
    else f.project.recognition = { remove_fillers: setting };
    await f.manager.run("trs_test");
    const input = JSON.parse(f.run.mock.calls[0]![1].split("\n").at(-1)!);
    expect(input.remove_fillers).toBe(setting ?? true);
    expect(request(f).ops.some((op) => op.op === "hide_tokens")).toBe(setting ?? true);
  });
  it.each([false, true])("drops unsafe hides but retains cuts (remove_fillers=%s)", async (enabled) => {
    const f = await setup(transcript(), async () => '{"cut_after":[4],"hide":[0,1,2]}');
    f.project.recognition!.remove_fillers = enabled;
    await f.manager.run("trs_test");
    expect(request(f).ops).toEqual([{ op: "resegment", transcript_id: "trs_test", cut_after: ["tok_4", "tok_9"] }]);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("drops hide touching even part of a multi-token project term; allows exactly 20% otherwise", async () => {
    const f = await setup(transcript(), async () => '{"cut_after":[4],"hide":[0,1]}');
    const tokens = f.project.transcripts[0]!.tokens;
    tokens[1]!.text = "豆";
    tokens[2]!.text = "包";
    f.project.recognition!.terms = ["豆包"];
    await f.manager.run("trs_test");
    expect(request(f).ops).toHaveLength(1);
    f.kernel.mockClear();
    f.project.recognition!.terms = [];
    await f.manager.run("trs_test");
    expect(request(f).ops[0]).toMatchObject({ tokens: ["tok_0", "tok_1"] });
  });
  it("puts the boundary on the last visible token when the chunk tail is hidden", async () => {
    const f = await setup(transcript(), async () => '{"cut_after":[9],"hide":[9]}');
    await f.manager.run("trs_test");
    expect(request(f).ops[1]).toMatchObject({ cut_after: ["tok_8"] });
  });
  it("uses chunk-end fallback for only failed chunks", async () => {
    const f = await setup(transcript(20, 10), async (_agent, prompt) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      if (input.tokens[0] === "失败") throw new Error("登录过期");
      return '{"cut_after":[3],"hide":[]}';
    });
    f.project.transcripts[0]!.tokens[10]!.text = "失败";
    const result = await f.manager.run("trs_test");
    expect(request(f).ops[0]).toMatchObject({ cut_after: ["tok_3", "tok_9", "tok_19"] });
    expect(result.result?.warnings).toEqual([
      expect.objectContaining({ code: "W_SUB_PASS_FALLBACK", chunk: 1, reason: "第 2 块：登录过期" }),
    ]);
  });
  it("all failed and no Agent never call edit", async () => {
    const f = await setup(transcript(20, 10), async () => {
      throw new Error("离线");
    });
    await f.manager.run("trs_test");
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.kernel).not.toHaveBeenCalled();
    f.detect.mockResolvedValue([]);
    f.run.mockClear();
    await f.manager.run("trs_test");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.kernel).not.toHaveBeenCalled();
    expect(f.manager.state.warnings[0]?.reason).toContain("没有可用");
  });
  it("chooses panel Agent, otherwise Claude first, otherwise Codex", async () => {
    const f = await setup();
    f.selected.mockReturnValue("codex");
    await f.manager.run("trs_test");
    expect(f.run.mock.calls[0]![0]).toBe("codex");
    f.selected.mockReturnValue(undefined);
    f.run.mockClear();
    await f.manager.run("trs_test");
    expect(f.run.mock.calls[0]![0]).toBe("claude");
    f.detect.mockResolvedValue([{ agent: "codex", available: true }]);
    f.run.mockClear();
    await f.manager.run("trs_test");
    expect(f.run.mock.calls[0]![0]).toBe("codex");
  });
  it("rereads and reruns the whole pass once on conflict", async () => {
    const f = await setup();
    f.kernel.mockImplementationOnce(async () => {
      f.project.revision.id = "rev_new";
      f.project.transcripts[0]!.tokens[3]!.id = "tok_new";
      return {
        ...ok(),
        ok: false,
        status: "conflict",
        error: { code: "E_CONFLICT", message: "conflict", retryable: true },
      };
    });
    await f.manager.run("trs_test");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.kernel).toHaveBeenCalledTimes(2);
    expect(f.kernel.mock.calls[1]).toEqual([
      "edit",
      expect.objectContaining({
        base_revision: "rev_new",
        ops: expect.arrayContaining([expect.objectContaining({ cut_after: ["tok_new", "tok_9"] })]),
      }),
    ]);
  });
  it("stops after a second revision conflict", async () => {
    const f = await setup();
    f.kernel.mockResolvedValue({
      ...ok(),
      ok: false,
      status: "conflict",
      error: { code: "E_CONFLICT", message: "conflict", retryable: true },
    });
    await f.manager.run("trs_test");
    expect(f.kernel).toHaveBeenCalledTimes(2);
    expect(f.manager.state.warnings[0]?.reason).toContain("持续变化");
  });
  it("opens only unmarked transcripts with cues, and deduplicates a concurrent run", async () => {
    let release!: (value: string) => void;
    const f = await setup(
      transcript(),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.project.transcripts.push(
      { ...transcript(), id: "trs_marked", ext: { "zsir.subtitle_pass": { by: "字幕整理" } } },
      { ...transcript(), id: "trs_empty", cues: [] },
    );
    const opened = f.manager.open();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const same = f.manager.run("trs_test");
    expect(f.manager.run("trs_test")).toBe(same);
    expect(f.manager.state.running).toBe(true);
    release('{"cut_after":[],"hide":[]}');
    await Promise.all([opened, same]);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each(["human", "agent"])("watches %s transcribe completion without a client poll", async (kind) => {
    vi.useFakeTimers();
    const f = await setup();
    f.kernel.mockResolvedValue(ok({ state: "succeeded", envelope: { ok: true, receipt: { after: "rev_asr" } } }));
    f.project.transcripts.push({ ...transcript(), id: "trs_other_language", language: "en" });
    const input = { project: "/project.zcut.json", media_id: "med_test", author: { kind } };
    f.manager.observe("transcribe", input, ok({ job_id: "job_test" }));
    f.manager.observe("transcribe", input, ok({ job_id: "job_test" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.transcribed).toHaveBeenCalledWith("rev_asr");
    expect(f.run).toHaveBeenCalledTimes(1);
    f.manager.observe(
      "job_status",
      { project: input.project, job_id: "job_test" },
      ok({ state: "succeeded", envelope: { ok: true, receipt: { after: "rev_asr" } } }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("does not trigger on failed jobs or jobs from another project", async () => {
    vi.useFakeTimers();
    const f = await setup();
    f.kernel.mockResolvedValue(ok({ state: "failed", envelope: { ok: false } }));
    f.manager.observe("transcribe", { project: "/other", media_id: "med_test" }, ok({ job_id: "job_other" }));
    f.manager.observe(
      "transcribe",
      { project: "/project.zcut.json", media_id: "med_test" },
      ok({ job_id: "job_test" }),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("caps concurrency at six and cancels queued work on project close", async () => {
    const releases: (() => void)[] = [];
    const f = await setup(
      transcript(100, 10),
      async () => new Promise<string>((resolve) => releases.push(() => resolve('{"cut_after":[],"hide":[]}'))),
    );
    const task = f.manager.run("trs_test");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(6));
    releases[0]!();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(7));
    await f.manager.stop();
    await task;
    expect(f.run.mock.calls.every((call) => call[2].aborted || call === f.run.mock.calls[0])).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(7);
    expect(f.kernel).not.toHaveBeenCalled();
  });
});

describe("chunking", () => {
  it("uses hard pauses and latest soft pause under 600, then falls back to 600", () => {
    expect(subtitleChunks(transcript(30, 10)).map((chunk) => chunk.length)).toEqual([10, 10, 10]);
    expect(subtitleChunks(transcript(1250)).map((chunk) => chunk.length)).toEqual([600, 600, 50]);
    const t = transcript(610);
    for (let i = 0; i < t.tokens.length; i++) {
      const shift = (i >= 400 ? 3 : 0) + (i >= 570 ? 3 : 0);
      t.tokens[i]!.align.start = rational(BigInt(i + shift), 10n);
      t.tokens[i]!.align.end = rational(BigInt(i + shift + 1), 10n);
    }
    expect(subtitleChunks(t).map((chunk) => chunk.length)).toEqual([570, 40]);
    for (let i = 600; i < t.tokens.length; i++) {
      t.tokens[i]!.align.start = rational(BigInt(i + 9), 10n);
      t.tokens[i]!.align.end = rational(BigInt(i + 10), 10n);
    }
    expect(subtitleChunks(t).map((chunk) => chunk.length)).toEqual([600, 10]);
  });
  it("excludes hidden tokens and every token in locked/approved cues", () => {
    const t = transcript();
    t.tokens[1]!.text = "";
    t.cues = [
      { id: "cue_lock", first_token: "tok_2", last_token: "tok_3", state: "auto", timing: { locked: true } },
      { id: "cue_approved", first_token: "tok_5", last_token: "tok_6", state: "approved" },
    ];
    expect(
      subtitleChunks(t)
        .flat()
        .map((t) => t.id),
    ).toEqual(["tok_0", "tok_4", "tok_7", "tok_8", "tok_9"]);
  });
});

// S2.1 integration gate: automatically enabled when the core accepts cut_after.
const supportsCutAfter = validateCommand("edit", {
  project: "x.zcut.json",
  base_revision: "rev_test",
  idempotency_key: "test",
  author: { kind: "agent", name: "字幕整理" },
  label: "AI 整理字幕",
  ops: [{ op: "resegment", transcript_id: "trs_test", cut_after: [] }],
}).valid;
it.skipIf(!supportsCutAfter)("S2.1 integration: one real history step, mark, and undo restoring rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-subpass-core-"));
  const path = join(directory, "project.zcut.json");
  try {
    await copyFile("examples/interview.zcut.json", path);
    const load = async (): Promise<Project> => {
      const parsed = parseProject(await readFile(path, "utf8"));
      if (!parsed.ok) throw new Error("fixture");
      return parsed.project;
    };
    const before = await load();
    const t = before.transcripts[0]!;
    const pass = new SubtitlePass({
      project: path,
      load,
      transcribed: async () => [],
      dispatch,
      detect: async () => [{ agent: "claude", available: true }],
      selected: () => undefined,
      run: async () => '{"cut_after":[],"hide":[]}',
      changed: () => {},
    });
    managers.push(pass);
    const result = await pass.run(t.id);
    expect(result.ok).toBe(true);
    const after = await load();
    expect(after.revision.seq).toBe(before.revision.seq + 1);
    expect(after.transcripts[0]!.ext?.["zsir.subtitle_pass"]).toEqual({ by: "字幕整理" });
    const history = await dispatch("inspect", { project: path, view: "history" });
    expect((history.result?.entries as { label: string }[])[0]?.label).toBe("AI 整理字幕");
    const undo = await dispatch("undo", {
      project: path,
      base_revision: after.revision.id,
      idempotency_key: "undo-pass",
      author: { kind: "human", name: "测试" },
    });
    expect(undo.ok).toBe(true);
    expect((await load()).transcripts).toEqual(before.transcripts);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("protects project terms crossing a chunk boundary and English terms with spaces", async () => {
  const f = await setup(transcript(20, 10), async () => '{"cut_after":[3],"hide":[0]}');
  f.project.recognition!.terms = ["豆包", "Open AI"];
  const tokens = f.project.transcripts[0]!.tokens;
  tokens[9]!.text = "豆";
  tokens[10]!.text = "包";
  tokens[0]!.text = "Open";
  tokens[1]!.text = "AI";
  await f.manager.run("trs_test");
  expect(request(f).ops).toHaveLength(1);
  expect(request(f).ops[0]).toMatchObject({ cut_after: ["tok_3", "tok_9", "tok_13", "tok_19"] });
});

it("uses stored pause rules and sends pauses in chunk-local indices", async () => {
  const t = transcript(6);
  t.subtitle_rules = { profile: "zh-talk", hard_pause: rational(2n), soft_pause: rational(1n, 2n) };
  for (const token of t.tokens.slice(3)) {
    token.align.start = rational((token.align.start.numerator * 10n) / token.align.start.denominator + 5n, 10n);
    token.align.end = rational((token.align.end.numerator * 10n) / token.align.end.denominator + 5n, 10n);
  }
  const f = await setup(t, async () => '{"cut_after":[],"hide":[]}');
  await f.manager.run(t.id);
  expect(JSON.parse(f.run.mock.calls[0]![1].split("\n").at(-1)!)).toEqual({
    tokens: Array(6).fill("字"),
    pauses: [2],
    remove_fillers: true,
    terms: [],
  });
});
