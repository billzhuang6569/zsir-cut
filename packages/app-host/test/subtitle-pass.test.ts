// biome-ignore-all lint/style/noNonNullAssertion: Synthetic fixture indexes are fixed by each test.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  validateCommand,
} from "../../core/src/index.ts";
import {
  type AgentRunner,
  SUBTITLE_PASS_PROMPT,
  SUBTITLE_PROOFREAD_PROMPT,
  SUBTITLE_SUMMARY_PROMPT,
  SubtitlePass,
  subtitleChunks,
} from "../src/subtitle-pass.js";

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
async function setup(t = transcript(), runner: AgentRunner = async () => '{"lines":["字字字字","字字字字字字"]}') {
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
    run: async (agent, prompt, signal) => {
      if (prompt.startsWith(SUBTITLE_SUMMARY_PROMPT)) return '{"summary":"测试","terms":[]}';
      if (prompt.startsWith(SUBTITLE_PROOFREAD_PROMPT)) return '{"fixes":[]}';
      return run(agent, prompt, signal);
    },
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
        ops: [{ op: "resegment", transcript_id: "trs_test", cut_after: ["tok_3", "tok_9"] }],
      }),
    );
    expect(f.run.mock.calls[0]![1]).toContain(SUBTITLE_PASS_PROMPT);
    expect(SUBTITLE_PASS_PROMPT).toContain("需要、可能、就是、能够、可以、要、会、去、帮我们、给到、这么一个");
    expect(SUBTITLE_PASS_PROMPT).toContain("少于 4 个字");
    expect(SUBTITLE_PASS_PROMPT).toContain("不以「的、地、得");
    expect(SUBTITLE_PASS_PROMPT).toContain("是……的");
    expect(SUBTITLE_PASS_PROMPT).toContain("逐行检查一遍结尾和开头");
    expect(f.manager.state).toEqual({ running: false, warnings: [], progress: [] });
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
  ])("retries invalid output on both agents without writing: %s", async (output) => {
    const f = await setup(transcript(), async () => output);
    const result = await f.manager.run("trs_test");
    expect(f.run).toHaveBeenCalledTimes(4);
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
    f.detect.mockResolvedValue([{ agent: "claude", available: true }]);
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
  it("retries a timed out call and accepts the next result", async () => {
    vi.useFakeTimers();
    const f = await setup();
    f.run.mockImplementationOnce(async () => new Promise(() => {}));
    const task = f.manager.run("trs_test");
    await vi.advanceTimersByTimeAsync(120000);
    await task;
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[0]![2].aborted).toBe(true);
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(f.manager.state.warnings).toEqual([]);
  });
  it("hides filler words and accepts punctuation and slashes", async () => {
    const t = transcript();
    t.tokens[0]!.text = "呃";
    const f = await setup(t, async () => '{"lines":["字，字 / 字字","字字字字字"]}');
    await f.manager.run(t.id);
    expect(request(f).ops).toEqual([
      { op: "hide_tokens", transcript_id: t.id, tokens: ["tok_0"] },
      { op: "resegment", transcript_id: t.id, cut_after: ["tok_4", "tok_9"] },
    ]);
  });
  it.each(["changed", "too many", "term", "disabled"])("rejects invalid or unsafe skips: %s", async (kind) => {
    const t = transcript();
    t.tokens[0]!.text = "呃";
    t.tokens[1]!.text = "豆";
    t.tokens[2]!.text = "包";
    const output =
      kind === "changed"
        ? "改变"
        : kind === "too many"
          ? "字字字字字字字"
          : kind === "term"
            ? "呃包字字字字字字字"
            : "豆包字字字字字字字";
    const f = await setup(t, async () => JSON.stringify({ lines: [output] }));
    f.project.recognition = { remove_fillers: kind !== "disabled", terms: kind === "term" ? ["豆包"] : [] };
    const result = await f.manager.run(t.id);
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.kernel).not.toHaveBeenCalled();
    expect(result.verification.issues[0]?.code).toBe("W_SUB_PASS_FALLBACK");
  });
  it("writes nothing when a later chunk fails", async () => {
    const t = transcript(21);
    t.tokens[10]!.text = "锁";
    t.cues = [{ id: "cue_locked", first_token: "tok_10", last_token: "tok_10", state: "approved" }];
    t.tokens[11]!.text = "失败";
    const f = await setup(t, async (_agent, prompt) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      if (input.text.startsWith("失败")) throw new Error("登录过期");
      return JSON.stringify({ lines: ["字字字字", "字字字字字字"] });
    });
    const result = await f.manager.run(t.id);
    expect(f.kernel).not.toHaveBeenCalled();
    expect(result.result?.warnings).toEqual([expect.objectContaining({ chunk: 1, code: "W_SUB_PASS_FALLBACK" })]);
  });
  it("requests up to two revisions and retains the last legal result", async () => {
    const t = transcript(20);
    const f = await setup(t, async () => JSON.stringify({ lines: ["字".repeat(20)] }));
    f.run
      .mockResolvedValueOnce(JSON.stringify({ lines: ["字".repeat(20)] }))
      .mockResolvedValueOnce(JSON.stringify({ lines: ["字".repeat(10), "字".repeat(10)] }));
    await f.manager.run(t.id);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]![1]).toContain("宽度超限");
    expect(request(f).ops[0]).toMatchObject({ cut_after: ["tok_9", "tok_19"] });
    f.run.mockClear();
    f.kernel.mockClear();
    await f.manager.run(t.id);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(request(f).ops[0]).toMatchObject({ cut_after: ["tok_19"] });
    f.run.mockClear();
    f.kernel.mockClear();
    f.run.mockResolvedValueOnce(JSON.stringify({ lines: ["字".repeat(20)] })).mockResolvedValue("无效");
    await f.manager.run(t.id);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(request(f).ops[0]).toMatchObject({ cut_after: ["tok_19"] });
  });
  it("rejects hiding a term spanning a protected chunk boundary", async () => {
    const t = transcript(21);
    t.tokens[9]!.text = "豆";
    t.tokens[10]!.text = "包";
    t.cues = [{ id: "cue_locked", first_token: "tok_10", last_token: "tok_10", state: "approved" }];
    const f = await setup(t, async (_agent, prompt) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      return JSON.stringify({ lines: [input.text.includes("豆") ? "字".repeat(9) : "字".repeat(10)] });
    });
    f.project.recognition!.terms = ["豆包"];
    const result = await f.manager.run(t.id);
    expect(result.verification.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "W_SUB_PASS_FALLBACK" })]),
    );
    expect(f.kernel).not.toHaveBeenCalled();
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
    expect(f.manager.state.warnings[0]?.reason).toContain("没有检测到");
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
      {
        ...transcript(),
        id: "trs_marked",
        ext: { "zsir.subtitle_pass": { by: "字幕整理" }, "zsir.proofread": { by: "字幕校对" } },
      },
      { ...transcript(), id: "trs_empty", cues: [] },
    );
    const opened = f.manager.open();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const same = f.manager.run("trs_test");
    expect(f.manager.run("trs_test")).toBe(same);
    expect(f.manager.state.running).toBe(true);
    release('{"lines":["字字字字","字字字字字字"]}');
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
  it("switches concurrent chunks and uses the replacement for queued chunks", async () => {
    const t = transcript(87);
    t.cues = Array.from({ length: 7 }, (_, i) => ({
      id: `locked_${i}`,
      first_token: `tok_${i * 11 + 10}`,
      last_token: `tok_${i * 11 + 10}`,
      state: "approved" as const,
    }));
    for (let i = 0; i < t.tokens.length; i++) t.tokens[i]!.text = String.fromCharCode(0x4e00 + Math.floor(i / 11));
    let active = 0;
    let maxActive = 0;
    const f = await setup(t, async (agent, prompt) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (agent === "claude") throw new Error("Failed to authenticate: OAuth session expired");
      return JSON.stringify({ lines: [JSON.parse(prompt.split("\n").at(-1)!).text] });
    });
    await f.manager.run(t.id);
    const calls = f.run.mock.calls.map(([agent, prompt]) => ({
      agent,
      text: JSON.parse(prompt.split("\n").at(-1)!).text,
    }));
    expect(calls.filter(({ agent }) => agent === "claude")).toHaveLength(6);
    expect(new Set(calls.filter(({ agent }) => agent === "claude").map(({ text }) => text)).size).toBe(6);
    expect(calls.filter(({ agent }) => agent === "codex")).toHaveLength(8);
    expect(new Set(calls.filter(({ agent }) => agent === "codex").map(({ text }) => text)).size).toBe(8);
    expect(maxActive).toBe(6);
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(request(f).ops[0]).toMatchObject({
      cut_after: ["tok_9", "tok_20", "tok_31", "tok_42", "tok_53", "tok_64", "tok_75", "tok_86"],
    });
  });
  it("retries failures after an agent change or retry request", async () => {
    const f = await setup(transcript(), async (agent) => {
      if (agent === "claude") throw new Error("Failed to authenticate");
      return '{"lines":["字字字字","字字字字字字"]}';
    });
    f.detect.mockResolvedValue([{ agent: "claude", available: true }]);
    await f.manager.run("trs_test");
    expect(f.manager.state.warnings[0]?.reason).toContain("Claude Code 登录已过期");
    f.detect.mockResolvedValue([{ agent: "codex", available: true }]);
    f.selected.mockReturnValue("codex");
    await f.manager.retryFailed();
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(f.manager.state.warnings).toEqual([]);
  });
  it("queues a retry if the agent changes while a failing pass is running", async () => {
    let rejectFirst!: (error: Error) => void;
    const f = await setup(transcript(), async (agent) =>
      agent === "claude"
        ? new Promise((_, reject) => {
            rejectFirst = reject;
          })
        : '{"lines":["字字字字","字字字字字字"]}',
    );
    f.detect.mockResolvedValue([{ agent: "claude", available: true }]);
    const task = f.manager.run("trs_test");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    f.detect.mockResolvedValue([{ agent: "codex", available: true }]);
    f.selected.mockReturnValue("codex");
    const retry = f.manager.retryFailed();
    rejectFirst(new Error("Failed to authenticate"));
    await Promise.all([task, retry]);
    expect(f.kernel).toHaveBeenCalledTimes(1);
  });
  it("explains Codex login failure when it is the only agent", async () => {
    const f = await setup(transcript(), async () => {
      throw new Error("Not logged in");
    });
    f.detect.mockResolvedValue([{ agent: "codex", available: true }]);
    await f.manager.run("trs_test");
    expect(f.manager.state.warnings[0]?.reason).toContain("Codex 未登录");
    expect(f.kernel).not.toHaveBeenCalled();
  });
  it("cancels an active chunk on close without writing", async () => {
    const f = await setup(transcript(), async () => new Promise(() => {}));
    const task = f.manager.run("trs_test");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    await f.manager.stop();
    await task;
    expect(f.kernel).not.toHaveBeenCalled();
  });
});

describe("manual subtitle verbs", () => {
  const finished = async (f: Awaited<ReturnType<typeof setup>>) => {
    await vi.waitFor(() => expect(f.manager.latest?.state).not.toBe("running"));
  };
  it("tidies only the span of three selected cues and appends the request", async () => {
    const t = transcript(50);
    t.cues = Array.from({ length: 5 }, (_, i) => ({
      id: `cue_${i}`,
      first_token: `tok_${i * 10}`,
      last_token: `tok_${i * 10 + 9}`,
      state: "auto",
    }));
    const f = await setup(t, async () => JSON.stringify({ lines: Array(6).fill("字".repeat(5)) }));
    const accepted = await f.manager.start("subtitle_tidy", {
      transcript_id: "trs_ignored_when_cues_supplied",
      cue_ids: ["cue_3", "cue_1", "cue_2"],
      request: "每行再短一点",
    });
    expect(accepted).toEqual({ pass_id: expect.stringMatching(/^job_/) });
    await finished(f);
    expect(f.run.mock.calls[0]![1]).toContain(`"text":"${"字".repeat(30)}"`);
    expect(f.run.mock.calls[0]![1]).toContain("用户的额外要求：每行再短一点");
    expect(f.kernel).toHaveBeenCalledExactlyOnceWith(
      "edit",
      expect.objectContaining({
        label: "AI 重新分行",
        ops: [
          {
            op: "resegment",
            transcript_id: t.id,
            range: { from_token: "tok_10", to_token: "tok_39" },
            cut_after: ["tok_14", "tok_19", "tok_24", "tok_29", "tok_34", "tok_39"],
          },
        ],
      }),
    );
    expect(f.manager.latest).toMatchObject({
      ...accepted,
      kind: "tidy",
      state: "done",
      done: 1,
      total: 1,
      reason: null,
    });
  });
  it("rejects a second tidy or proofread on the same transcript while accepting a different transcript", async () => {
    let release!: (value: string) => void;
    const f = await setup(
      transcript(),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.project.transcripts.push({
      ...transcript(),
      id: "trs_other",
      cues: [{ ...transcript().cues[0]!, id: "cue_other" }],
    });
    await f.manager.start("subtitle_tidy", { transcript_id: "trs_test" });
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    for (const verb of ["subtitle_tidy", "subtitle_proofread"] as const) {
      expect(await f.manager.start(verb, { cue_ids: ["cue_test"] })).toMatchObject({
        code: "E_SUB_PASS_RUNNING",
        retryable: true,
      });
      expect(await f.manager.start(verb, {})).toMatchObject({ code: "E_SUB_PASS_RUNNING" });
    }
    const other = await f.manager.start("subtitle_proofread", { transcript_id: "trs_other" });
    expect(other).toHaveProperty("pass_id");
    release('{"lines":["字字字字","字字字字字字"]}');
    await f.manager.run("trs_test");
    expect(f.kernel).toHaveBeenCalledTimes(1);
  });
  it("also reports busy while an automatic pass runs", async () => {
    const f = await setup(transcript(), async () => new Promise(() => {}));
    void f.manager.run("trs_test");
    expect(await f.manager.start("subtitle_tidy", {})).toMatchObject({ code: "E_SUB_PASS_RUNNING", retryable: true });
  });
  it("validates missing, mixed and empty selections before invoking an agent", async () => {
    const f = await setup();
    f.project.transcripts.push({
      ...transcript(),
      id: "trs_other",
      cues: [{ ...transcript().cues[0]!, id: "cue_other" }],
    });
    for (const params of [
      { cue_ids: [] },
      { cue_ids: ["missing"] },
      { cue_ids: ["cue_test", "cue_other"] },
      { transcript_id: "missing" },
    ])
      for (const verb of ["subtitle_tidy", "subtitle_proofread"] as const)
        expect(await f.manager.start(verb, params)).toMatchObject({ code: "E_VALIDATION" });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.kernel).not.toHaveBeenCalled();
  });
  it("makes one edit for all transcripts with cues and leaves a transcript without cues alone", async () => {
    const f = await setup();
    f.project.transcripts.push({ ...transcript(), id: "trs_other" }, { ...transcript(), id: "trs_empty", cues: [] });
    await f.manager.start("subtitle_tidy", {});
    await finished(f);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.kernel).toHaveBeenCalledTimes(1);
    expect(request(f).ops.map((op) => op.transcript_id)).toEqual(["trs_test", "trs_other"]);
    expect(request(f).ops.every((op) => op.range)).toBe(true);
    expect(f.manager.latest).toMatchObject({ done: 2, total: 2 });
  });
  it("writes nothing when any transcript fails and does not automatically retry manual failures", async () => {
    const f = await setup();
    f.project.transcripts.push({ ...transcript(), id: "trs_other" });
    let calls = 0;
    f.run.mockImplementation(async () => {
      if (++calls > 1) throw new Error("Not logged in");
      return '{"lines":["字字字字","字字字字字字"]}';
    });
    await f.manager.start("subtitle_tidy", {});
    await finished(f);
    expect(f.manager.latest).toMatchObject({ state: "failed", reason: expect.stringContaining("登录") });
    expect(f.kernel).not.toHaveBeenCalled();
    const count = f.run.mock.calls.length;
    await f.manager.retryFailed();
    expect(f.run).toHaveBeenCalledTimes(count);
    expect(f.manager.state.warnings).toEqual([]);
  });
  it("preserves protected cues in a manual range and completes proofread without unnecessary writes", async () => {
    const t = transcript();
    t.cues = [
      { id: "cue_locked", first_token: "tok_0", last_token: "tok_3", state: "auto", timing: { locked: true } },
      { id: "cue_free", first_token: "tok_4", last_token: "tok_9", state: "auto" },
    ];
    const f = await setup(t, async () => '{"lines":["字字字字字字"]}');
    await f.manager.start("subtitle_tidy", { transcript_id: t.id });
    await finished(f);
    expect(f.run.mock.calls[0]![1]).toContain('"text":"字字字字字字"');
    expect(request(f).ops[0]).toMatchObject({
      range: { from_token: "tok_0", to_token: "tok_9" },
      cut_after: ["tok_9"],
    });
    f.run.mockClear();
    f.kernel.mockClear();
    await f.manager.start("subtitle_proofread", { cue_ids: ["cue_free"] });
    await finished(f);
    expect(f.manager.latest).toMatchObject({
      kind: "proofread",
      state: "done",
      reason: null,
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.kernel).not.toHaveBeenCalled();
  });
});

it("manual tidy changes only three cues' span, preserves the mark, and makes one undoable history step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-tidy-core-"));
  const path = join(directory, "project.zcut.json");
  try {
    const parsed = parseProject(await readFile("examples/interview.zcut.json", "utf8"));
    if (!parsed.ok) throw new Error("fixture");
    const project = parsed.project;
    const t = project.transcripts[0]!;
    t.ext = { "zsir.subtitle_pass": { by: "existing" } };
    t.cues = [
      t.cues[0]!,
      ...[6, 8, 10, 12].map((first, i) => ({
        id: i === 0 ? "cue_2" : `cue_manual_${i}`,
        first_token: t.tokens[first]!.id,
        last_token: t.tokens[i === 3 ? 14 : first + 1]!.id,
        state: "auto" as const,
      })),
    ];
    await writeFile(path, serializeProject(project));
    const load = async () => {
      const value = parseProject(await readFile(path, "utf8"));
      if (!value.ok) throw new Error("fixture");
      return value.project;
    };
    const before = await load();
    const pass = new SubtitlePass({
      project: path,
      load,
      transcribed: async () => [],
      dispatch,
      detect: async () => [{ agent: "claude", available: true }],
      selected: () => undefined,
      run: async () =>
        JSON.stringify({
          lines: [
            t.tokens
              .slice(6, 12)
              .map((token) => token.text)
              .join(""),
          ],
        }),
      changed: () => {},
    });
    managers.push(pass);
    await pass.start("subtitle_tidy", { cue_ids: ["cue_2", "cue_manual_1", "cue_manual_2"] });
    await vi.waitFor(() => expect(pass.latest?.state).not.toBe("running"));
    expect(pass.latest, JSON.stringify(pass.latest)).toMatchObject({ state: "done" });
    const after = await load();
    expect(after.transcripts[0]!.tokens).toEqual(before.transcripts[0]!.tokens);
    expect(
      after.transcripts[0]!.cues.filter((cue) => [before.transcripts[0]!.cues[0]!.id, "cue_manual_3"].includes(cue.id)),
    ).toEqual([before.transcripts[0]!.cues[0], before.transcripts[0]!.cues[4]]);
    expect(after.transcripts[0]!.ext?.["zsir.subtitle_pass"]).toEqual(
      before.transcripts[0]!.ext?.["zsir.subtitle_pass"],
    );
    expect(after.transcripts[0]!.cues).toHaveLength(3);
    const history = await dispatch("inspect", { project: path, view: "history" });
    expect((history.result?.entries as { label: string }[])[0]?.label).toBe("AI 重新分行");
    expect(after.revision.seq).toBe(before.revision.seq + 1);
    expect(
      (
        await dispatch("undo", {
          project: path,
          base_revision: after.revision.id,
          idempotency_key: "undo-tidy",
          author: { kind: "human", name: "测试" },
        })
      ).ok,
    ).toBe(true);
    expect((await load()).transcripts).toEqual(before.transcripts);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("chunking", () => {
  it("uses hard pauses and latest soft pause under 600, then falls back to 600", () => {
    expect(subtitleChunks(transcript(30, 10)).map((chunk) => chunk.length)).toEqual([30]);
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
    t.tokens[8]!.state = "approved";
    t.cues.push({ id: "cue_token_approved", first_token: "tok_7", last_token: "tok_8", state: "auto" });
    expect(
      subtitleChunks(t)
        .flat()
        .map((t) => t.id),
    ).toEqual(["tok_0", "tok_4", "tok_9"]);
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
      run: async () =>
        JSON.stringify({
          lines: subtitleChunks(t)[0]!
            .map((token) => token.text)
            .join("")
            .match(/.{1,10}/gu),
        }),
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

it("uses stored pause rules and sends text with pause markers", async () => {
  const t = transcript(6);
  t.subtitle_rules = { profile: "zh-talk", hard_pause: rational(2n), soft_pause: rational(1n, 2n) };
  for (const token of t.tokens.slice(3)) {
    token.align.start = rational((token.align.start.numerator * 10n) / token.align.start.denominator + 5n, 10n);
    token.align.end = rational((token.align.end.numerator * 10n) / token.align.end.denominator + 5n, 10n);
  }
  const f = await setup(t, async () => '{"lines":["字字字","字字字"]}');
  await f.manager.run(t.id);
  expect(JSON.parse(f.run.mock.calls[0]![1].split("\n").at(-1)!)).toEqual({
    text: "字字字 / 字字字",
    remove_fillers: true,
    terms: [],
    max_chars: 16,
  });
});
