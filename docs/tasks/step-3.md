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
| 3.11 | 导出面板：节点图、三家去处、直接导出和字幕叠层 | 3.4、3.5、3.14 |
| 3.14 | 字幕渲染器与字幕叠层导出（`handoff-profile.md` 第 9 节）：独立的排版模块（只依赖 Canvas 2D 接口）；工程格式 0.3（`subtitle_overlays`、样式新字段、迁移）；`add_overlay` / `update_overlay` / `remove_overlay`；`export` 的 `subtitle-overlay`（PNG 序列加 ffmpeg 编码 ProRes 4444、原子替换、`last_export`）；本任务允许新增依赖 `@napi-rs/canvas`，Claude 联网安装 | 3.12 |
| 3.13 | 历史面板（工具栏「历史」按钮打开，占用参数区）：按 `history` 视图列出步骤，批次折叠成组；点一步预览（`at_revision`）；「回到这一步」调用 `restore`；批次进行中显示「AI 正在做第 x / n 步」 | 3.6、3.12 |

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

### 3.6 详细说明：时间线与预览

3.5 已合并（#87）。依据：设计系统的 `Clip`、`IconButton`、`Icon`（`design/reference/`），设计画布草稿 5 的时间线和预览区，`product.md` 第 3 节。本任务不新增依赖。

1. **媒体通道**（`packages/app-host`）
   - 宿主进程在同一个本机端口上提供 HTTP 媒体读取：只读、只能读工程 `media[]` 里登记的文件（按 `media_id` 请求，不接受任意路径），支持 Range 请求，必须带令牌。有代理文件时优先给代理。
   - 缩略图：按片段的源区间每隔一格（时间线上 96px 对应的时长）抽一帧，用 ffmpeg 子进程生成小 JPEG，缓存在 `.zcut/<project_id>/cache/thumbs/`，以素材指纹和源时间为键。
   - 波形：用 ffmpeg 读出音频，算每 10 毫秒的峰值，缓存在 `.zcut/<project_id>/cache/peaks/`。
2. **时间线**（`packages/desktop`）
   - 按 `inspect` 的 `timeline` 视图画：时间标尺、标记（`attention` 色下三角）、播放头，以及三类轨道。轨道高度用 `--track-video-h` 等变量。
   - 视频片段：胶片条缩略图，左上角是素材名；音频片段：素材名加波形；字幕条：一行文字。三者的样子和状态（选中时外框加左右把手、不在焦点时半透明）照设计系统的 `Clip`。
   - 轨道名列宽 `--track-label-w`，名字放不下就截断，悬停显示全名，不折行。空轨道只画一条浅色底。
   - 缩放（`⌘ +` / `⌘ −`、工具栏滑块）、横向滚动、吸附到剪点和标记。
3. **预览与播放**
   - 预览区播放时间线：按视频 A 轨（最上面一条有内容的视频轨）当前时刻对应的片段和源时间，切换 `<video>` 的源并跳到对应位置；声音跟着同一片段。一期不做转场混合和画面变换，变速按 `render_preview` 的同样规则近似，并在预览区角落标一个「近似」小图标（悬停说明）。
   - 字幕按投影结果画在画面上，样式取字幕轨的默认样式。
   - `空格` 播放 / 暂停，`J` `K` `L`，左右方向键逐帧；时码显示在预览区下方。
   - 点击标尺或拖动播放头跳转。界面动词 `ui_seek`、`ui_play`、`ui_pause` 改为真正生效。
4. **工具栏**：全部换成设计系统的 `IconButton`（选择 A、切割 B、加标记 M、撤销、重做、吸附、缩放），统计改成「图标 + 数字」。切割和加标记调用 `edit`（`split`、`add_marker`），撤销重做调用 `undo` / `redo`，写请求带 `label`（例如「在 00:00:09:14 切开」）。
5. **顺带修**：Final Cut Pro 图标从菜单栏拿掉，只留给以后的导出面板用。
6. **测试**：媒体通道拒绝未登记的路径和没有令牌的请求、Range 返回正确字节；缩略图和波形缓存命中时不再调用 ffmpeg（用假的 ffmpeg 计数）；jsdom 下时间线按示例工程画出正确数量的片段，切割按钮发出 `split` 请求；播放头时间换算用有理数，不用浮点表示时间。

验收：Claude 在本机打开物美工程（真实素材），截图核对胶片条、波形、字幕条和播放；把截图发给 Bill 看界面。

### 3.7 详细说明：AI 面板与决定

3.6 已合并（#92）。依据：ADR-0014、`product.md` 第 4 节、`command-protocol.md` 6.1（批次与 `label`）和 7.6（决定），设计系统的 `DecisionCard`、`DecisionProgress`、`StepRow`，设计画布草稿 5 的 AI 画板。本任务不新增依赖（MCP 的 HTTP 传输用已有的 `@modelcontextprotocol/sdk`）。

1. **给 Agent 的 MCP 入口**（`packages/app-host`）
   - 除了现有的 stdio，再在同一个本机端口上提供 MCP 的 HTTP 传输（`@modelcontextprotocol/sdk` 的 Streamable HTTP），路径 `/mcp`，必须带令牌。工具与 stdio 相同：23 个内核动词加 6 个界面动词。
   - 被启动的 Agent 用这个入口操作当前工程。宿主进程为每次对话生成一份临时 MCP 配置文件（权限 0600，对话结束删除）。
2. **启动本机 Agent**（`packages/app-host`）
   - 检测本机的 `claude`（Claude Code）和 `codex`（Codex CLI）是否可用及版本，界面里能选哪个。都没有时，对话区只显示一句说明和「安装说明」链接。
   - Claude Code：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --mcp-config <临时文件> --strict-mcp-config --allowedTools 'mcp__zsir-cut__*' --append-system-prompt-file skills/zsir-cut/SKILL.md`，继续对话用 `--resume <会话 ID>`。只放行本工程的 MCP 工具，不给 shell 和文件写入权限。
   - Codex：`codex exec --json`，用 `-c` 传入 MCP 服务器配置，沙箱 `read-only`；继续对话用 `codex exec resume <会话 ID>`。
   - 工作目录是工程文件所在目录。Agent 的输出逐行解析成统一的事件：文字增量、工具调用开始和结束、回合结束、出错。
   - 对话记录存在 `.zcut/<project_id>/chats/<chat_id>.jsonl`（不是工程数据，不产生修订），重新打开工程能看到历史对话。
   - 停止：结束子进程；正在执行的批次按 6.1 的超时规则处理。
3. **AI 面板**（`packages/desktop`）
   - 对话区按设计画布：用户消息气泡（引用的素材显示为 `info` 色小标签）；Agent 回复逐字出现，Markdown 渲染（标题、列表、粗体、代码）；每次工具调用显示为一行可折叠的 `StepRow`（进行中琥珀色、完成青绿色），折叠里是工具名和参数摘要；回复下方是复制按钮。
   - 输入框：多行，`↵` 发送、`⇧↵` 换行；`@` 弹出素材列表，选中后插入引用；左下角切换 Agent；生成时发送按钮变成停止。
   - 对话列表：新对话、历史对话（图标按钮）。
   - Agent 开了编辑会话、交出草稿时，对话里出现草稿卡片：修订数、片段和字幕的改动数，加「批准」（`approve` 按钮）。批准调用 `session_approve`。
4. **决定**（`packages/desktop`）
   - AI 标签下的参数区显示当前会话的决定，按设计系统的 `DecisionCard`：一次一件，头部是 `ask` 图标、标题「决定」和 `DecisionProgress` 进度环；选项带字母键；最后一行是「其他想法…」；底部是「跳过」和「下一件 ⌘↵」，最后一件写「发给 AI」。
   - 「下一件」调用 `session_answer`；最后一件答完，把这一轮全部回答拼成一条消息自动发进对话，例如「关于『其余 5 处跳剪怎么处理』：换到卡 A 机位」。
   - 每次 Agent 回合结束、或宿主进程收到 `session_ask` 时，刷新决定。
   - 批次进行中，参数区顶部显示「AI 正在做第 x / n 步」（按 `batch_status`）。
5. **测试**（不联网，不调用真的 Agent）
   - 用假的 `claude` 和 `codex` 脚本按真实格式输出一段 stream-json / json 事件，验证解析成统一事件、逐字增量、工具调用折叠行、出错和停止。
   - MCP HTTP 入口：没有令牌被拒绝；用 SDK 客户端连上后能列出 29 个工具并调用 `inspect`。
   - 决定：假会话里写入 3 件决定，界面一次只显示一件，答完自动发出的消息内容正确，`session_answer` 被调用 3 次。
   - 临时 MCP 配置文件权限是 0600，对话结束后被删除。

验收：Claude 在本机用真的 Claude Code 打开 std-25 工程对话一轮（让它加一个标记并写一件决定），截图核对对话区和决定卡片，发给 Bill 看界面。

### 3.8 起的共同约定

3.7 已合并（#95）。下面五个任务都只改 `packages/desktop`、`packages/app-host` 和 `apps/desktop-tauri`，不改内核动词。

- **样子**：照设计画布草稿 5 对应的画板和设计系统组件（`design/reference/`）。设计哲学：能用图标就不用文字；能用图形表达就不用文本；简约。界面文字全部中文，不出现任何内部 ID（`med_`、`ses_`、`sty_` 等）。
- **写入**：界面上每个改工程的操作都通过宿主进程调内核动词，写请求带人能读懂的 `label`（例如「给 C0001 加标签『采访』」），作者是 `human`。工程变了以后各面板跟着刷新（宿主进程已有的 `project_changed` 通知）。
- **界面动词**：每个面板的主要状态都能被 `ui_state` 读到，`ui_show_panel` 能切到它（含 `sub`）。
- **本机能力**：打开文件、选保存位置、在访达中显示，用 Tauri 官方插件 `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` 和 `@tauri-apps/plugin-opener` / `tauri-plugin-opener`（MIT 或 Apache-2.0），由第一个用到的任务引入；版本和 3.5 定下的 Tauri 2.12 系列一致。Claude 负责联网安装和更新锁文件。浏览器调试模式（没有 Tauri）下这些按钮隐藏或换成路径输入框，不报错。
- **测试**：jsdom 测试覆盖每个写入发出的请求（动词、ops、`label`），以及主要状态的渲染；时间一律用有理数换算。
- **验收**：Claude 在本机用 std-25 和物美工程截图核对每个状态，截图发给 Bill 看界面。3.11 合并后，用一个非采访素材的项目从导入走到导出（ADR-0013）。

### 3.8 详细说明：素材面板

依据：`product.md` 第 3 节，`timeline-schema.md` 4.2（`organize`），`command-protocol.md` 9.2（`import_media`）、第 10 节（`place`、`update_media`），设计画布的「素材」画板。

1. **左：素材列表**
   - 头部：当前范围的名字和个数（「全部 3」）、搜索图标按钮、网格 / 列表切换（`IconButton` 分段）、导入按钮（图标）。
   - 网格：每个素材一张卡片，胶片条缩略图（复用 3.6 的缩略图缓存），左上角「已用 n 段」或「未用」，右上角时长；下方是素材名和注释。`⌘ +` / `⌘ −` 改卡片大小。列表视图：图标、名称、时长、规格、评分、用了几段，一行一个。
   - 范围筛选：全部、按文件夹（`organize.folders` 的层级）、按标签，放在头部的下拉里；搜索匹配名称、注释、标签。
   - 导入：按钮打开系统文件选择（可多选），也可以把文件从访达拖进素材区；调用 `import_media`。导入是长任务时显示进度。
2. **预览素材**：点选素材，预览区切到「素材」模式播放它（标题显示素材名，时码是源时码），`I` / `O` 设入点出点，范围画在预览区下方的进度条和卡片缩略图上（`attention` 色）。`空格`、`J` `K` `L`、方向键照 3.6。再点时间线回到「时间线」模式。
3. **加到时间线**
   - `Q` 或参数区的「加到时间线」：把选中范围（没设就是整段）在播放头处用 `place` 的 `insert` 放到最上面一条视频轨和第一条声音轨（纯音频只放声音轨，图片默认 5 秒）。
   - 拖到时间线：拖到哪条轨道、哪个时刻，就用 `place` 的 `overwrite` 放在哪里；拖动时时间线上画出落点预览，吸附规则同 3.6。
4. **右：素材信息**（照画板）：封面（取素材中间一帧）、主色（从封面算 9 个色块，缓存在 `.zcut/<project_id>/cache/`，不进工程）、名称（只读，取文件名；工程格式没有素材改名字段）、注释、来源链接、标签（加、删）、文件夹（加、删）、评分（5 星，点同一颗清零）、规格（尺寸、帧率、时长、格式、卷名）、选中范围、时间线里用了几段。改动用 `update_media`，输入框失焦或回车时提交一次，不按键提交。底部：「加到时间线」「在访达中显示」。
5. **顺带修（3.7 遗留）**
   - 已进入审阅、没有未答问题的会话，不在「决定」的会话标签里出现。
   - 对话的 `end` 事件要在对话文件最后一次写入完成之后再发；`agents.test.ts` 的「按修改时间排序」用例在满载下不再偶发失败（`pnpm test` 同时跑两份时连续 5 次通过）。
6. **测试**：`import_media` 请求带对的路径；`Q` 发出的 `place` 参数（轨道、`at`、范围、`insert`）；拖放发出 `overwrite`；`update_media` 只在提交时发一次；主色缓存命中时不再算。

### 3.9 详细说明：章节面板

依据：`timeline-schema.md` 4.6（`chapter` 标记和 `level`），`product.md` 第 3 节，设计画布的「章节」画板。

1. **左**：视图三块横排图标（大纲；思维导图、时间地图灰掉并标「下个版本」）；「显示」里的标题层级（只看一级 / 一级加二级）和「显示时间码」开关；「生成」里的「让 AI 重新分章」和「复制 Markdown」。
2. **右：章节大纲**：头部「章节大纲」和统计（图标加数字：章、节、总长）。一级标题大字，前面是浅色 `#`；二级标题缩进，前面是 `##`，归组规则照 4.6；右侧时间码（序列时码）。当前播放头所在的那一节高亮。
3. **操作**
   - 点标题：播放头跳到那里（同 `ui_seek`）。
   - 双击改名、行尾菜单改层级或删除：`update_marker` / `remove_marker`。
   - 「在播放头加一节」（图标按钮）：`add_marker`，`kind: chapter`，层级默认 2。
   - 时间线上的章节标记和大纲同步，拖动标记（3.6 已有的交互）后大纲顺序跟着变。
4. **复制 Markdown**：按当前层级设置生成，一级标题一行、二级标题前加两个空格和 `- `；时间码用相对时间线开头的 `m:ss`（一小时以上 `h:mm:ss`），可以直接贴进 B 站或 YouTube 的简介。写进剪贴板，按钮短暂变成「已复制」图标。
5. **让 AI 重新分章**：切到 AI 标签，在输入框里填好一句请求（「按现在的剪辑和字幕重新分章，一级标题不超过 5 个」）并发出；没有可用的 Agent 时按钮灰掉。
6. **测试**：大纲归组（含第一个一级标题之前的二级标题）；Markdown 输出逐字比对；改名、改层级、删除、新增发出的 ops 和 `label`。

### 3.10 详细说明：字幕面板

依据：`timeline-schema.md` 4.1（`recognition`）和第 5 节（样式），`command-protocol.md` 第 10 节字幕域，`handoff-profile.md` 9.2（字幕渲染器），设计画布的「字幕」和「字幕 · 样式」两张画板。

1. **左：识别设置**
   - 顶部状态条：上次识别的修订和字幕条数；没识别过时写「还没有识别」。
   - 语言、参考文本（多行）、专有名词（标签，可加可删，`×` 删除）、「去除水词」开关和水词表（展开编辑）。每项失焦时用 `set_recognition` 提交。
   - 「重新识别」：调用 `transcribe`，按长任务显示进度，完成后刷新。识别中按钮变成进度，不能重复点。
2. **右：两个标签**（`ui_show_panel` 的 `sub` 取 `subtitles`、`style`）
   - **字幕**：搜索框（只过滤列表）；查找替换（展开两栏输入、区分大小写开关、「全部替换」，调 `replace_text`，结果里跳过的锁定字幕条用 `attention` 色标出并给出个数）；字幕列表照画板：左边序号（居中），不显示时间码；点一条，播放头跳到它并在预览里显示；`↵` 或双击进入编辑，`⌘↵` 提交（按改动的字词范围调 `edit_text`），`Esc` 放弃；`↑` `↓` 上一条 / 下一条；行尾「在后面加一条」（`add_free_cue`）和「删除」（`hide_tokens` 删除这一条的字词，自由字幕条用 `remove_free_cue`）。被截得太短、超宽的字幕条，序号用 `attention` 色，悬停说明原因（来自校验警告）。
   - **样式**：照画板的分组：预设（三种：描边白字、黑底白字、黄字）、字体（字体族、字重、字号）、颜色、描边、底板（颜色、内边距、圆角）、位置（3×3 对齐格、上下边距、最大宽度）、行距、最多行数。改动用 `update_style`，拖动滑块时只在松手时提交。
   - 3×3 对齐格对应规格里的字段：行对应 `position.anchor` 的 `top`、`middle`、`bottom`；列对应 `position.offset_x`：左、中、右分别是 `-(1 - max_width) / 2`、`0`、`(1 - max_width) / 2`。不新增字段。
   - **样式预览**：参数区顶部有一块按时间线画面比例的小预览，背景是播放头处的画面，字幕用与导出共用的渲染器（`packages/exporters/src/subtitle-render.ts`）画在 Canvas 上。渲染器只依赖 Canvas 2D 接口，界面直接引用这个模块（需要时加一个子路径导出），不要把 `@napi-rs/canvas` 或 Node 模块打进界面。预览区里显示的字幕也换成同一个渲染器，做到所见即所得。
3. **测试**：`set_recognition` 只发改了的字段；查找替换的请求和跳过提示；编辑一条字幕发出的 `edit_text` 范围正确；对齐格九个位置换算成的 `anchor` 和 `offset_x`；预览渲染器与导出渲染器是同一个函数（同样的输入画出同样的像素，用假的 Canvas 记录绘制调用比对）。

### 3.11 详细说明：导出面板

依据：`product.md` 第 5 节和 5.1，`handoff-profile.md` 第 8、9 节，`command-protocol.md` 9.5，设计画布的「导出」画板。

1. **形式**：点菜单栏「导出」打开一个覆盖层，`Esc` 或关闭图标退出。左边是成片预览，右边分出几个去处，用连线连起来（照画板的节点图）。
2. **成片预览**：显示时间线的画面；鼠标在画面上左右移动时快速浏览（按横向位置换算成序列时间，取 3.6 的缩略图）；下方是时长和规格。
3. **去处卡片**：每个去处一整张可点的卡片：左边软件图标（FCP 图标运行时从本机读取，见 ADR-0016），名称，用文件图标画出会得到什么（例如 FCPXML + 字幕），右边一个箭头。点卡片就导出。
   - Final Cut Pro、DaVinci Resolve、Premiere Pro：打开面板时对三家各跑一次 `export` 的 `dry_run`，有 `warn` 或 `error` 级损失时，卡片右上角一个 `attention` 色小圆标，悬停列出要点；`error` 时点卡片先弹确认，确认后带 `accept_losses: true`。
   - 直接导出：SRT 和音频 WAV 两个文件图标可以分别开关（至少开一个），点卡片按开着的导出。成片 MP4 画成灰的文件图标，标「二期」。
   - 字幕叠层：列出工程里的叠层（名称、上次导出时间、对应字幕轨），每个一行，点一行就按原路径覆盖导出；「新建叠层」选字幕轨和保存位置（系统保存对话框，`.mov`），用 `add_overlay`；行尾菜单改名、改尾长、删除（`update_overlay` / `remove_overlay`）。卡片上写一句注意：「剪辑线定稿后再出；改字幕后点这里覆盖同一个文件」。
4. **输出位置**：交接包和直接导出第一次导出时问保存位置，之后记住（存在 `.zcut/<project_id>/` 下的界面偏好里，不进工程）；卡片上能改。
5. **进度和结果**：导出是长任务。卡片变成进度条；完成后卡片显示一个绿色勾、输出位置和「在访达中显示」；失败时显示原因。同时只允许一个导出在跑。
6. **测试**：三家 `dry_run` 的损失标记；`error` 级损失的确认流程带 `accept_losses`；直接导出两个开关的组合发出的 profile；叠层新建、覆盖导出、删除的请求；进度和完成状态的渲染。

### 3.13 详细说明：历史面板

依据：`product.md` 6.1，`command-protocol.md` 6.1（`history` 视图、`restore`、`at_revision`、`batch_status`），设计系统的 `StepRow`。

1. **入口**：工具栏撤销、重做旁边加一个「历史」图标按钮（时钟图标，快捷键 `⌘ Y`）。打开后参数区（右栏）换成历史面板，不管左边是哪个标签；再点一次或 `Esc` 回到原来的参数面板。`ui_show_panel` 的 `panel` 取 `history` 时也打开它（界面动词的参数里加这一个值）。
2. **列表**：按 `inspect` 的 `history` 视图倒序列出步骤，滚到底自动加载更早的（`before`）。每一步一行：作者图标（人 / Agent）、`label`、相对时间；当前修订那一行标为「现在」。同一批次的步骤折叠成一组，组头是批次的说明和「n 步」，可展开。`restore` 产生的步骤用不同图标，并写「回到了 …」。
3. **看某一步**：点一行，预览区和时间线显示那一步时的剪辑线（`inspect` 和预览用 `at_revision`），时间线上方出现一条提示条：「正在看：<label>」，右边两个按钮「回到这一步」「返回现在」。看历史时时间线只读，工具栏的编辑按钮灰掉。
4. **回到这一步**：调用 `restore`，`label` 写「回到：<那一步的 label>」。完成后列表顶部多一行，提示条消失。批次打开时（`E_BATCH_OPEN`）按钮灰掉并说明原因。
5. **批次进度**：有批次在跑时，列表顶部显示「AI 正在做第 x / n 步」和一个进度环（`batch_status`），完成或中止后变成普通的组。
6. **测试**：批次折叠和展开；点某一步后时间线请求带 `at_revision`、编辑按钮灰掉；「回到这一步」发出的 `restore` 和 `label`；批次打开时按钮不可用；分页加载。

**顺序**：3.8 → 3.9 → 3.10 → 3.11 → 3.13，一次只派一个，避免几个任务同时改外壳。3.9 和 3.13 改动小，可以在前一个审核期间开始。

## 需要 Bill 做的

| 时间 | 事项 |
|---|---|
| 3.5 开始前 | 在设计稿上确认六个画板，或继续提意见 |
| 3.11 完成后 | 用桌面版完整走一遍：导入、AI 粗剪、回答决定、校字幕、导出到 FCP |
