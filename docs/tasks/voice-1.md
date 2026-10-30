# 语音第 1 轮：克隆音色与 AI 配音

依据：`docs/spec/voice.md`、ADR-0019。Bill 2026-10-30 定：语音面板分「克隆 · 生成 · 结果」三个子页；选多条字幕时每条一段还是合成一段，由用户在生成弹窗里选。

共同约定沿用 `step-3.md`「3.8 起的共同约定」（界面样子、写入、界面动词、本机能力、测试、验收）。另外：

- **不联网**：所有测试用可注入的假 fish.audio 客户端。真实调用只在 Claude 本机验收时用 Bill 的 Key 跑。
- **Key 安全**：Key 不进任何文件、日志、信封、错误信息、测试快照。
- **HTTP**：用 Node 24 自带的 `fetch`；按 `voice.md` 1.1 节走代理时用 `undici`（MIT）的 `ProxyAgent`。multipart 用自带的 `FormData` 和 `Blob`。新依赖按 AGENTS.md 列出。

## 任务

| 编号 | 内容 | 前置 | 验收 |
|---|---|---|---|
| V1.1 | 内核：设置与钥匙串、fish.audio 客户端、音色库、`settings_get` / `settings_set` / `voice_list` / `voice_edit` / `voice_clone`；补 `schema/command.schema.json` 里这些动词 | — | `voice.md` 第 9 节里设置、克隆、错误码三组测试；CLI 和 MCP 对等 |
| V1.2 | 内核：`voice_generate`，生成结果导入为素材（第 4、5 节）；补 `command.schema.json` | V1.1 | 第 9 节生成一组测试；`per_cue` 和 `merged` 各一个 golden 工程片段 |
| V1.3 | 桌面：设置页（齿轮图标）、语音面板「克隆」「生成」子页 | V1.1 | Key 存进钥匙串后只显示「已设置」；克隆、试听、改名、删除（二次确认）；生成后新素材出现在结果里 |
| V1.4 | 桌面：「结果」子页，`take_of` 历史折叠，过期标记和一键重新生成 | V1.2、V1.3 | 结果卡片复用素材面板；拖上时间线、在访达中显示 |
| V1.5 | 桌面：字幕面板配音选择状态和弹窗；时间线声音片段右键「克隆为新音色」；拖放时的推荐位置提示线和吸附 | V1.4 | 框选、Shift、Cmd 多选；弹窗选音色、模型、「每条一段 / 合成一段」；拖到推荐位置附近吸附 |
| V1.6 | Skill：`skills/zsir-cut/references/voice.md`，Agent 怎么用这些动词（Claude 写） | V1.2 | — |

V1.3 起的界面截图 Claude 发给 Bill 看。
