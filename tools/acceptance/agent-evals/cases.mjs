// 每条用例：setup(project) 可改起始工程并返回界面上下文；message 是用户的话；check(ctx) 返回失败原因数组。
// ctx: { before, after, history, sessions, decisions, reply, clipsBefore, clipsAfter, durBefore, durAfter }
const sec = (r) => {
  const m = String(r).match(/^(-?\d+)(?:\/(\d+))?s$/);
  return m ? Number(m[1]) / Number(m[2] ?? 1) : NaN;
};
const noSession = (c) => (c.sessions.length ? [`开了 ${c.sessions.length} 个编辑会话`] : []);
const fewQuestions = (c, max = 0) => (c.decisions.length > max ? [`问了 ${c.decisions.length} 条决定（上限 ${max}）`] : []);
const writes = (c) => c.history.filter((h) => h.verb === "edit" || h.verb === "undo").length;

export const cases = [
  {
    id: "01",
    category: "指代",
    setup: (p) => ({ select: [p.timelines[0].tracks[0].clips[2].id] }),
    message: "把这段删了，后面的接上来",
    check: (c, setup) => {
      const gone = !c.clipsAfter.some((x) => x.id === setup.select[0]);
      return [
        ...(gone ? [] : ["选中的片段还在"]),
        ...(c.clipsAfter.length === c.clipsBefore.length - 1 ? [] : [`视频片段数 ${c.clipsBefore.length}→${c.clipsAfter.length}，应只少 1 个`]),
        ...(c.durAfter < c.durBefore ? [] : ["没有合拢"]),
        ...noSession(c),
        ...fewQuestions(c, 1),
      ];
    },
  },
  {
    id: "02",
    category: "去口误",
    message: "把整条里的嗯、啊这类语气词都去掉",
    check: (c) => [
      ...(writes(c) ? [] : ["没有写入"]),
      ...(c.durAfter <= c.durBefore ? [] : ["时长变长了"]),
      ...(c.durAfter >= c.durBefore * 0.85 ? [] : [`删得太多：${c.durBefore.toFixed(1)}→${c.durAfter.toFixed(1)} 秒`]),
      ...noSession(c),
      ...fewQuestions(c, 1),
    ],
  },
  {
    id: "03",
    category: "压停顿",
    message: "句子之间的停顿太长了，都压到 0.3 秒以内",
    check: (c) => [
      ...(c.durAfter < c.durBefore ? [] : ["时长没变短"]),
      ...noSession(c),
      ...fewQuestions(c, 1),
    ],
  },
  {
    id: "04",
    category: "定长",
    message: "整条剪到 45 秒左右，保留核心观点",
    check: (c) => [
      ...(c.durAfter >= 40.5 && c.durAfter <= 49.5 ? [] : [`结果 ${c.durAfter.toFixed(1)} 秒，应在 40.5–49.5`]),
      ...noSession(c),
      ...fewQuestions(c, 1),
    ],
  },
  {
    id: "05",
    category: "咨询",
    message: "你觉得开头这几秒怎么剪会更抓人？先别动，说说就行",
    check: (c) => [...(writes(c) ? [`咨询却写入了 ${writes(c)} 次`] : []), ...noSession(c)],
  },
  {
    id: "06",
    category: "试方案",
    message: "先给我出一版更紧凑的方案看看，别直接改时间线",
    check: (c) => [
      ...(c.history.some((h) => h.verb === "edit" && !h.session) ? ["直接改了主工程"] : []),
      ...(c.sessions.some((s) => s.state === "in_review") ? [] : ["没有交审的会话"]),
    ],
  },
  {
    id: "07",
    category: "字幕和剪辑分开",
    message: "字幕里的「嗯」「啊」不要显示",
    check: (c) => [
      ...(c.clipsAfter.length === c.clipsBefore.length && c.durAfter === c.durBefore ? [] : ["动了剪辑（应只改字幕）"]),
      ...noSession(c),
    ],
  },
  {
    id: "08",
    category: "锁定",
    setup: (p) => {
      for (const t of p.timelines[0].tracks) if (t.kind !== "subtitle") t.locked = true;
      return { select: [p.timelines[0].tracks[0].clips[1].id] };
    },
    message: "把这段删掉",
    check: (c) => [
      ...(c.clipsAfter.length === c.clipsBefore.length ? [] : ["锁定的轨道被改了"]),
      ...(/锁/.test(c.reply) ? [] : ["回复里没有说明轨道锁定"]),
    ],
  },
  {
    id: "09",
    category: "入出点",
    setup: () => ({ range: ["5s", "9s"] }),
    message: "入出点之间这段不要了",
    check: (c) => [
      ...(Math.abs(c.durBefore - c.durAfter - 4) <= 0.5 ? [] : [`应短约 4 秒，实际短 ${(c.durBefore - c.durAfter).toFixed(2)} 秒`]),
      ...noSession(c),
      ...fewQuestions(c, 1),
    ],
  },
  {
    id: "10",
    category: "播放头",
    setup: () => ({ playhead: "20s" }),
    message: "播放头这句话说得不好，删掉",
    check: (c) => [
      ...(c.durAfter < c.durBefore ? [] : ["没有删"]),
      ...(c.durBefore - c.durAfter <= 15 ? [] : ["删得太多（超过 15 秒）"]),
      ...noSession(c),
      ...fewQuestions(c, 1),
    ],
  },
];
export { sec };
