# 第 3 步任务拆分：桌面版 v1

状态：草案 · 2026-10-29 · 上位文档：`docs/plan.md` 第 3 步、`docs/product.md`、`docs/design.md`

## 目标

按 `product.md` 做出桌面版 v1：菜单栏、功能区（AI、素材、章节、字幕）、预览、参数区、工具栏、时间线，外加导出面板。界面只调用内核动词，不另写逻辑。

分两段：先补内核（3.1–3.4），让界面需要的每个动作都有动词；Bill 验收界面设计稿后，再做桌面版（3.5 起）。

## 规格修订（Claude，已合并）

本步新增或改动的规格：

- `timeline-schema.md`：版本 0.2；工程的 `recognition`、素材的 `organize`、章节标记的 `level`；轨道自动命名。
- `edit-ops.md`：`update_media`、`rename_track`、`replace_text`、`set_recognition`；`add_track`、`add_subtitle_track` 的名字可选；`add_marker` 加 `level`。
- `command-protocol.md`：决定（7.6）、`session_ask` 和 `session_answer`、`inspect` 的 `session` 视图、直接导出（9.5）、界面动词（9.6）、新的警告码和错误码。
- `asr-worker.md` 第 6 节：识别设置、自动去水词。
- `handoff-profile.md`：章节层级的损失记录、直接导出（第 8 节）。

## 内核任务（Codex）

本步的任务说明明确允许修改 `schema/timeline.schema.json`、`schema/command.schema.json`、`schema/loss-report.schema.json`，按对应规格改，其他 schema 文件仍只读。

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 3.1 | 工程格式 0.2：`schema_version` 升到 `"0.2"`，写 0.1 到 0.2 的迁移；`recognition`、`organize`、`level` 三组字段进 schema、读写和 L1 校验；轨道自动命名（`create_project`、`add_track`、`add_subtitle_track`）和 `rename_track`；`update_media`；`add_marker` 的 `level` 和章节以外带 `level` 报错；三家导出器对带 `level` 的章节写损失记录 `marker_level`；示例工程和 golden 按新版本更新 | 规格 PR | 0.1 的示例工程读入后写出为 0.2，除版本号外字节不变；`create_project` 新建的轨道名为「视频 A」「声音 A」「声音 B」「字幕 A」；连续 `add_track` 三条视频轨得到「视频 B」「视频 C」「视频 D」；`update_media` 只改 `organize`，撤销后字节还原 |
| 3.2 | 决定：`session_ask`、`session_answer`、`inspect` 的 `session` 视图；`brief` 的 `sessions` 带待定个数；`session_review` 返回决定；批准时 `W_DECISIONS_PENDING`；CLI 和 MCP 对等 | 3.1 | 一个会话里写 3 条决定、答 1 条、跳过 1 条，`inspect session` 与 `session_review` 的结果一致；改答后会话日志里有旧回答；`allow_other` 为 false 时用 `text` 回答报 `E_VALIDATION`；换一个进程重新打开工程，决定都在 |
| 3.3 | 字幕：`set_recognition`；`transcribe` 读 `recognition`（语言、`terms` 作热词、缓存键）；自动去水词和 `W_FILLERS_HIDDEN`；`replace_text` 和 `W_REPLACE_SKIPPED_LOCKED` | 3.1 | 合成母稿开启去水词后，默认表里的字词全部隐藏、`heard` 保留、字幕条不在隐藏处断开；「那个」不在默认表里时不隐藏；`replace_text` 把跨两个字词的「飞 书」替换成「飞书」后，显示文字正确、`heard` 不丢、锁定的字幕条被跳过并有警告 |
| 3.4 | 直接导出：`direct-srt`、`direct-audio-wav`（`handoff-profile.md` 第 8 节） | 3.1 | `direct-srt` 与同一修订交接包里的 SRT 逐字节相同；`direct-audio-wav` 用脉冲测试素材导出，每个脉冲落在对应白帧区间内，两次导出字节相同；削波时有 `W_AUDIO_CLIPPED` |

3.2、3.3、3.4 在 3.1 合并后可以并行，它们改的文件不重叠：3.2 在会话模块，3.3 在字幕域和识别，3.4 在导出器。

## 桌面版任务（Codex，等 Bill 验收设计稿后开始）

| 编号 | 内容 | 依赖 |
|---|---|---|
| 3.5 | Tauri + TS 桌面壳：六个区域的布局和尺寸按 `design.md` 第 5 节；设计变量；打开工程；界面动词（9.6）的 MCP 入口 | 设计稿验收 |
| 3.6 | 时间线和预览：三类轨道、片段、标记、字幕条、播放头；播放、`J` `K` `L`、缩放、吸附；工具栏的选择、切割、加标记、撤销重做 | 3.5 |
| 3.7 | AI 面板与决定：驱动本机 Claude Code / Codex 命令行，逐字渲染回复，草稿卡片；参数区的决定卡片，回答后自动发消息 | 3.2、3.5 |
| 3.8 | 素材面板：网格和列表、`I` / `O` / `Q`、拖到时间线、`⌘ +` / `⌘ −`；参数区的素材信息 | 3.1、3.6 |
| 3.9 | 章节面板：大纲视图，点击跳转，复制 Markdown | 3.1、3.6 |
| 3.10 | 字幕面板：识别设置、字幕列表（搜索、查找替换、逐条编辑）、样式 | 3.3、3.6 |
| 3.11 | 导出面板：节点图、三家去处和直接导出 | 3.4、3.5 |

每个桌面版任务的详细说明，等设计稿定稿后再写。验收方式：Claude 对照设计稿和 `design.md` 检查每个状态，Bill 验收界面效果；最后用一个非采访素材的项目走一遍（ADR-0013）。

## 需要 Bill 做的

| 时间 | 事项 |
|---|---|
| 3.5 开始前 | 在设计稿上确认六个画板，或继续提意见 |
| 3.11 完成后 | 用桌面版完整走一遍：导入、AI 粗剪、回答决定、校字幕、导出到 FCP |
