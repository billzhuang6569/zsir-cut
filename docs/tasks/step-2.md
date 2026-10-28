# 第 2 步任务拆分：Skill 首发，真项目跑通

状态：草案 · 2026-10-28 · 上位文档：`docs/plan.md` 第 2 步

## 目标

写出 Claude Code Skill，用一个真实采访项目走完「素材、转写、Agent 粗剪、字幕校对、导出 FCP 接手版」，Resolve 和 Premiere 各导一份做对照。通过标准见 `docs/plan.md` 第 2 步。

## 第 1 步收尾

- 1.1 到 1.15 全部合并。FCP、Resolve 实机通过；Premiere 第三轮实测通过，第四轮复测由 Bill 决定跳过，按通过处理，见 `export-otio-xmeml.md` 3.4 节。
- 识别评测集（`fixtures.md` 第 7 节）还缺 Bill 的采访素材和正确稿，移到本步的真实项目里一起做。

## 演练发现的问题

2026-10-28 Claude 按 Agent 的用法从零走了一遍：新建工程、导入、识别、放上时间线、建字幕轨、按字词删句、导出 FCPXML。全流程能跑通，但有八个问题会挡住真实项目（P9 是之后用真实采访发现的）：

| 编号 | 问题 | 规格改动 |
|---|---|---|
| P1 | 时间线只支持 25 和 29.97。手机和网络摄像头常见的 30 帧素材一读就报「Unsupported timecode rate」 | `timeline-schema.md` 4.3 节：八种帧率；两份导出规格的帧率表 |
| P2 | 没有新建工程的动词，Agent 只能手写 JSON，绕过唯一写入路径 | `command-protocol.md` 9.4 节 `create_project` |
| P3 | 对齐器给出一个零宽字词，整次识别就报 `E_ASR_INTERNAL`；几乎静音的素材也会这样 | `asr-worker.md` 第 4、6 节 |
| P4 | CLI 不写工程路径时，请求被当成空对象，报一长串缺字段 | `command-protocol.md` 第 2 节 |
| P5 | 一个编辑操作写错，报错把所有操作类型的失败原因都列出来，约 9 KB，Agent 看不出错在哪 | `command-protocol.md` 第 11 节 `E_VALIDATION` |
| P6 | 母稿语言写 `zh`、字幕轨写 `zh-Hans` 时，投影静默为空，没有任何提示 | `timeline-schema.md` 第 8 节 `W_SUB_NO_TRANSCRIPT` |
| P7 | `read_transcript` 每行约 213 字节，其中文字只有 32 字节，其余是长 ID。一小时采访约 255 KB，会被截断 | `timeline-schema.md` 第 3 节短 ID；`command-protocol.md` 9.1 节片段头 |
| P8 | 按字词删句时区间贴着字边，两侧停顿都留下，剪点处停顿翻倍；Agent 也看不到字词时间，没法自己算 | `edit-ops.md` `remove_span` 的 `pause`；`read_transcript` 的 `with_times` |
| P9 | 19 分钟的真实采访整段对齐，3124 个字词里 3117 个零宽，逐字时间基本失效（识别文字是对的） | `asr-worker.md` 2.1 节长音频分段 |
| P10 | 2.5 校字幕时用 `hide_tokens` 隐藏口头语后，导出的字幕在每个被隐藏的字处断开，一句话变成几条 0.5 秒左右的闪字 | `timeline-schema.md` 5.2 节：`text` 为空的字词不断开分组 |
| P11 | 热词只给识别用，聚词时 jieba 不认识，「飞书」在物美采访里每次都被拆成「飞」「书」两个字词，字幕换行会从中间断开 | `asr-worker.md` 第 1 节：热词加入 jieba 词典 |

规格改动在同一个 PR 里，`schema/` 同步更新。

## 实现任务（Codex）

| 编号 | 内容 | 依赖 | 专项验收 |
|---|---|---|---|
| 2.1 | 八种时间线帧率：时码换算、读视图、预览、三家导出器、校验；L1 对不在表里的帧率报 `E_TIME_FORM`（现有测试里用 4 帧之类非常规帧率的，改成表里的帧率）；生成器加 `std-2398` 和 `std-5994-df`，并加 golden | 规格 PR | 每种帧率的时码往返单元测试，含 59.94 丢帧逢 10 分钟边界；两个新标准工程三家导出读回逐切点零帧 |
| 2.2 | `create_project` 动词（CLI 和 MCP）；CLI 工程路径规则；`E_VALIDATION` 报错只列相关分支 | 规格 PR | 用 `match_media` 对 30 帧素材建工程后，导入、放置、导出 FCPXML 全部成功；写错一个 `place` 参数，报错不超过 1 KB 且指出那个参数 |
| 2.3 | 字幕链路：worker 零宽修正和空结果；短 ID；`read_transcript` 片段头和 `with_times`；`W_SUB_NO_TRANSCRIPT`；`remove_span` 的 `pause`；`workers/asr/README.md` 写清环境搭建 | 规格 PR | 一小时规模的合成母稿 `read_transcript` 不超过 128 KB；`pause` 的区间与手算一致；零宽字词的回归用例 |

| 2.7 | 识别 worker 长音频分段（`asr-worker.md` 2.1 节）和 `W_ASR_ALIGN_DEGRADED` | 2.3 | 合成一条 5 分钟的朗读素材（台词朗读拼接 3 次以上），零宽比例低于 1%，各段拼接处字词不重复、不丢失；切点选择有单元测试；Claude 用真实 19 分钟采访复测 |
| 2.8 | 会话内的读、预览和胶片条（`session_id`）；草稿素材路径按主工程目录解析；`session_review` 自动出预览；识别复读检查 `W_ASR_REPETITION` | 2.2–2.7 | 物美采访工程开会话后，`view_timeline` 带 `session_id` 直接成功；`session_review` 给出可播放的预览；全片识别不再出现几千个「哎」，`W_ASR_ALIGN_DEGRADED` 不再误报 |
| 2.9 | 投影时 `text` 为空的字词不断开字幕（P10）；热词加入 jieba 词典并升 worker 版本（P11） | 2.8 | 回归工程：一条字幕条中间隐藏一个字词，投影和三家导出的 SRT 都只有一条，起止取首末可见字词；隐藏首字词时起点后移。合成母稿带热词「飞书」时聚成一个字词。Claude 用物美工程复测：字幕校对后 SRT 不再出现几百毫秒的碎条 |
| 2.6 | `place` 按字词选段（`tokens`）和 `at: "end"`；请求里的非最简分数自动约分 | 2.3 | 用合成朗读素材按三段字词逆序追加，序列上三段首尾相接、源区间与手算一致；`"50/25s"` 被接受并写成 `2s` |

2.1 到 2.3 改的文件基本不重叠，可以并行，各用一个 worktree；后合并的负责变基。2.6 改的是编辑操作，等 2.3 合并后再做。

2.6 来自写 Skill 时的推演：采访剪三分钟，常要挑几段话重新排顺序，只靠删除做不到；而要 Agent 自己从字词时间算出最简分数的源区间，容易出错。

## Skill（Claude）

| 编号 | 内容 | 依赖 |
|---|---|---|
| 2.4 | `skills/zsir-cut/`：一个路由 `SKILL.md`，加粗剪、字幕、交接复核三份子说明。只调用 `zcut` CLI，不直接读写工程文件 | 2.1–2.3 |
| 2.5 | 真实采访项目跑通：Claude 用 Skill 完成粗剪、字幕、三家导出；Bill 验收剪辑效果和 FCP 接手体验 | 2.4、Bill 的素材 |

## 需要 Bill 做的

| 时间点 | 事情 |
|---|---|
| 2.5 开始前 | 给一个真实采访项目的素材目录（原始素材，不是成片），说明想剪成什么：时长、核心观点、客户词表（如有） |
| 2.5 结束时 | 在 FCP 里打开接手版，验收剪辑效果；顺带看 Premiere 对照版里第四轮跳过的几项 |
