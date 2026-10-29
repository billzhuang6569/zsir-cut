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

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 3.12 | 步骤管理器内核（`command-protocol.md` 6.1）：写请求的 `label`（Agent 的 `edit` 必填）；`edit` 的 `batch` 参数、磁盘排队、按序号执行、失败与超时、`E_BATCH_OPEN` / `E_BATCH_SEQ_TAKEN` / `E_BATCH_CLOSED`；`batch_status`；`undo` 的 `batch_id`；`restore`；`inspect` 和 `render_preview`、`view_timeline` 的 `at_revision`；`history` 视图带 `label`、`batch`、`kind`；日志条目新字段；`schema/command.schema.json` 和 `schema/envelope.schema.json` 按规格改（本任务明确允许） | 3.2–3.4 | 一个 10 步的批次，用 10 个进程乱序并发发出（先发 6–10，再发 1–5），日志里的修订顺序严格是 1 到 10，每一步的 `batch.seq` 对得上；缺第 4 步时 5 以后都返回 `queued`，补上第 4 步那次请求连带执行 4–10；第 3 步校验失败时 4–10 作废、1–2 保留；缺序号超时后状态为 `expired`，之后再来的步骤返回 `E_BATCH_CLOSED`；批次打开时别的写入返回 `E_BATCH_OPEN`；整批撤销后工程与批次前逐字节相同（除修订）；`restore` 到 3 个修订以前再 `restore` 回来，两次都和对应修订逐字节相同（除修订）；CLI 与 MCP 对等 |

## 桌面版任务（Codex，等 Bill 验收设计稿后开始）

| 编号 | 内容 | 依赖 |
|---|---|---|
| 3.5 | 桌面壳、宿主进程和六个区域的空布局，详见下文 | 设计稿验收（2026-10-29 Bill 说「继续」） |
| 3.6 | 时间线和预览：三类轨道、片段、标记、字幕条、播放头；播放、`J` `K` `L`、缩放、吸附；工具栏的选择、切割、加标记、撤销重做 | 3.5 |
| 3.7 | AI 面板与决定：驱动本机 Claude Code / Codex 命令行，逐字渲染回复，草稿卡片；参数区的决定卡片，回答后自动发消息 | 3.2、3.5 |
| 3.8 | 素材面板：网格和列表、`I` / `O` / `Q`、拖到时间线、`⌘ +` / `⌘ −`；参数区的素材信息 | 3.1、3.6 |
| 3.9 | 章节面板：大纲视图，点击跳转，复制 Markdown | 3.1、3.6 |
| 3.10 | 字幕面板：识别设置、字幕列表（搜索、查找替换、逐条编辑）、样式 | 3.3、3.6 |
| 3.11 | 导出面板：节点图、三家去处和直接导出 | 3.4、3.5 |
| 3.13 | 历史面板：按 `history` 视图列出步骤，批次折叠成组；点一步预览（`at_revision`）；「回到这一步」调用 `restore`；批次进行中显示「AI 正在做第 x / n 步」 | 3.6、3.12 |

### 3.5 详细说明

依据：ADR-0016、`docs/product.md` 第 3 节、设计系统 https://claude.ai/artifact/15p6YuU4UfgJEGWU6tUDtX （变量在仓库的 `design/tokens.json`，参考组件在 `design/reference/`）、设计画布 https://claude.ai/artifact/6g8fzZAHD7GhqE4EeUyF9d 。本任务允许新增依赖：react、react-dom、vite、@vitejs/plugin-react、ws、@tauri-apps/api、@tauri-apps/cli、jsdom（测试用），以及 Rust 的 tauri；PR 里逐个列出版本和许可证。

1. **`packages/app-host`**（Node）
   - 启动参数：工程文件路径（可选）、端口（默认随机）、令牌。
   - 本机 WebSocket 通道，只监听 `127.0.0.1`，连接必须带令牌。消息：`{id, verb, request}` → 调用内核同一个 `dispatch` → `{id, envelope}`。结果信封与 CLI 完全相同。
   - MCP（stdio）：内核的 21 个动词，加上 9.6 节的界面动词。界面动词转给已连接的界面执行；没有界面连接时返回 `failed`、`E_APP_NOT_RUNNING`、`retryable: true`。
   - 检测本机安装的 Final Cut Pro，把它的图标转成 PNG 交给界面（读 `/Applications/Final Cut Pro.app` 的应用图标；没装返回空）。
2. **`packages/desktop`**（React + Vite）
   - 从 `design/tokens.json` 生成 CSS 变量（构建时生成，名字与设计系统一致，例如 `--attention`、`--space-6`、`--track-video-h`），界面里不写死颜色和尺寸。
   - 六个区域按 `product.md` 第 3 节和设计系统的布局尺寸：菜单栏 41、功能区 315（最小 280）、预览、参数区 417（最小 320）、工具栏 35、时间线 278。功能区四个标签（AI、素材、章节、字幕）切换时，参数区跟着换成对应的空白面板。
   - 打开工程后，菜单栏显示工程名和修订序号；时间线画出轨道名（按 `inspect` 的 `timeline` 视图）。本任务不画片段内容，留给 3.6。
   - 实现界面动词的接收端：`ui_state`、`ui_show_panel` 真正生效；`ui_seek`、`ui_select`、`ui_play`、`ui_pause` 先记录状态并在 `ui_state` 里反映，播放等 3.6 再接。
3. **`apps/desktop-tauri`**（Tauri 2）
   - 开一个 1440×900 的窗口，启动宿主进程（开发时用本机 `node`），把端口和令牌传给界面。
   - 根目录加脚本 `pnpm desktop:dev`，打开 `examples/interview.zcut.json`。
4. **测试**（CI 只跑 TypeScript，不编译 Rust）
   - 宿主进程：同一请求走 WebSocket 通道、走 CLI，结果信封逐字段相同（`request_id`、时间等非确定字段除外）；不带令牌连接被拒绝。
   - MCP：工具列表含 21 个内核动词和 6 个界面动词；没有界面时 `ui_seek` 返回 `E_APP_NOT_RUNNING`；用一个假界面客户端连上后，`ui_show_panel` 再 `ui_state` 能读回来。
   - 界面：jsdom 下渲染外壳，六个区域都在，功能区切到「字幕」后参数区换成字幕面板；CSS 变量文件包含 `tokens.json` 里每个颜色名。

验收：CI 通过；Claude 在本机运行 `pnpm desktop:dev`，截图核对布局尺寸和配色，确认打开示例工程后显示工程名和轨道名。

3.6 起的详细说明，在 3.5 合并后再写。验收方式：Claude 对照设计稿和 `design.md` 检查每个状态，Bill 验收界面效果；最后用一个非采访素材的项目走一遍（ADR-0013）。

## 需要 Bill 做的

| 时间 | 事项 |
|---|---|
| 3.5 开始前 | 在设计稿上确认六个画板，或继续提意见 |
| 3.11 完成后 | 用桌面版完整走一遍：导入、AI 粗剪、回答决定、校字幕、导出到 FCP |
