# 桌面版第 3 版：界面反馈落地（U3）

状态：已定 · 2026-11-06（Bill 当天定了第 6 节的六件事）· 规格：`docs/spec/desktop-host.md`、ADR-0023 及第 3 节所列修改。规格和本文冲突时以规格为准 · 上位文档：`docs/plan.md` 第 3 步、`docs/product.md`、`docs/design.md`

来源：Bill 2026-11-04 到 11-06 在设计画布上的 10 轮反馈（F1 到 F10）。本轮的做法是先改设计稿，后端需求随手记下，最后统一出这份方案。反馈原文、画布上改了什么、后端需要什么，都记在 [UI 反馈与后端改动记录](https://claude.ai/artifact/YM2ULRLHoJQCFgsPqibset)。设计稿在 [设计画布](https://claude.ai/artifact/2cz57o7WFBCD2kcNpEA3n8)，变量和组件在 [设计系统](https://claude.ai/artifact/TSP7nbUeS5MgrfEEwNjse7)。

本轮所有任务归入一个新里程碑「桌面版 v3」。仓库现在没有里程碑，这是第一个。EPIC 和 ISSUE 在规格合并后建。

## 1. 一条架构原则

Bill 定的：**界面只接收和渲染，处理放在中间核心。** 落到代码上：

| 层 | 位置 | 管什么 | 本轮新增的东西放哪 |
|---|---|---|---|
| 内核 | `packages/core` | 工程文件、修订、投影、校验 | 章节树读视图、剪辑操作补齐、会话的步骤说明 |
| 宿主 | `packages/app-host` | 调内核；给界面的通道；给 Agent 的 MCP；启动本机 Agent | 应用级设置、Agent 管理、许可闸、预览缓存、修订事件推送、下一步建议 |
| 界面 | `packages/desktop` | 画出来，发请求 | 只有展示状态：折叠、缩放、选中的剪点 |

存放位置也按这个分：

| 数据 | 放哪 | 例子 |
|---|---|---|
| 工程内容 | 工程文件（进修订） | 章节标记的描述 |
| 和工程绑定、但不是工程内容 | `.zcut/<project_id>/`（不进修订，现有 `export-preferences.json`、会话、批次都在这） | 「这个工程里都允许」的许可、这个工程的预览缓存占用 |
| 应用级 | `~/Library/Application Support/zsir-cut/`（现有 `recent.json` 在这） | 快捷键习惯、默认 Agent、缓存位置和上限、界面偏好 |
| 纯界面状态 | 内存，关掉就没 | 正在悬停的位置、选中的剪点 |

宿主已有的单文件存储模式（`recent.ts`、`export-preferences.ts`：zod 校验、写临时文件再改名）本轮继续用。

## 2. 现状：代码里已经有什么

按反馈逐项对照代码，免得重做。

| 反馈 | 已有 | 缺 |
|---|---|---|
| F1 快捷键 | 快捷键写死在 `TimelinePreview.tsx` 的 `keydown` 里：`A` `B` `M` `K` 空格 `J` `L` 方向键 `⌘+` `⌘−` `⌘Z`，是 FCP 习惯 | 没有数据表，没有 Premiere 一套，没有应用级设置 |
| F1 剪辑操作 | `edit-ops.md`：`trim`（`ripple`）、`split`（`linked`）、`move`（`mode: insert`）、`remove`（不合拢）、`remove_span`（合拢，但会清空所有轨道的区间） | 移动剪点（滚动编辑）、删除并合拢（只删这一段、后面跟上来）；其他都能用现有操作拼出来 |
| F1 剪点 | 只能选片段；吸附已有（`timelineMove.ts` 的 `snapEdges`，`SNAP_DISTANCE` 8px） | 剪点选中 |
| F2 Agent 管理 | `agents.ts`：`detect()` 用 `--version` 探测 `claude`、`codex`；`selected` 只在内存里，启动时取第一个可用的 | 程序位置、登录状态、新版检查、安装和更新、持久化默认 |
| F2 方案数据 | `session_review` 已有 `timeline_changes`、`subtitle_changes`、`ops`、`decisions`；草稿日志每步有 `label` 和 `changes`；`inspect timeline` 支持 `session_id` 和 `at_revision`，宿主的工程视图也支持 `at_revision`（`index.ts` 506 行） | 每步的「理由」；审阅汇总里没有按步列出 |
| F2 批准 | `session_approve`、`W_DECISIONS_PENDING`，界面已做确认（`AiPanel.tsx` 267 行） | 无 |
| F2 过场 | 宿主在写入后只推一个 `project_changed`（没有内容） | 推修订内容（谁改的、改了什么），界面才能按步播 |
| F3 预览 | 两个 `<video>` 轮流播（P2.1）；`render_preview` 是逐帧合成再编码，只做整条时间线；媒体通道支持 Range 请求 | 分段缓存、连续流播放、缓存设置 |
| F4/F5 章节 | 标记有 `kind: chapter` 和 `level`；分组在界面算（`chapters.ts` 的 `chapterGroups`）；`ui_state.chapters` 存 `levels` 和 `timecodes` | 描述字段；结束时间、时长、颜色编号由内核给；时间轴视图 |
| F6/F8 历史 | `inspect history` 带 `label`、`batch`、`kind`；`restore`；历史面板占参数区（`product.md` 6.1 这么写的） | 顶栏入口和悬浮窗；草稿步骤跳到审方案 |
| F7 跳转 | `ui_seek` 已有 | 无 |
| F9 许可 | Claude Code 只开放 `mcp__zsir-cut__*`，Codex 用 `--sandbox read-only`，所以两家 CLI 自己不会弹权限 | 会碰到工程外面的动词（导出、写文件、联网）没有闸 |
| F10 下一步 | 系统提示在 `agents.ts` 的 `desktopInstructions` | 格式约定和解析 |

两处 Bill 定的规则和现有产品文档冲突，本轮一并改文档：历史面板从「占用参数区」改为顶栏悬浮窗（`product.md` 6.1、`command-protocol.md` 9.6 的 `ui_show_panel`）；Agent 的许可卡和方案批准都放右侧「决定」，不放对话里（`product.md` 第 4 节「对话里出现草稿卡片」）。

## 3. 规格与 ADR（Claude，先于所有代码任务）

| 编号 | 文件 | 改什么 |
|---|---|---|
| U3-S1 | `docs/adr/0023-preview-cache.md` | 预览缓存：每个片段一段 720p 代理（fMP4，H.264 硬件编码，关键帧 0.5 秒），播放时用 MSE 接成一条流；没备好的段退回 P2.1 的两个播放器。Claude 2026-11-06 用 Playwright WebKit 和合成素材初测：5 段接起来 `seeking` 0 次、`waiting` 0 次、最大帧间隔 67 毫秒，现在的做法剪点处停 366 到 400 毫秒。导出永远用原素材 |
| U3-S2 | `docs/spec/desktop-host.md`（新） | 桌面版宿主：应用级设置文件和界面偏好；快捷键数据表（两套默认，见附录 A）；Agent 管理动词和状态；许可闸（哪些动词要问、三种答复、存哪）；预览缓存的命名、位置、上限、清理、状态推送；下一步建议的格式；修订事件推送。这些都是宿主的事，不进 `command-protocol.md` 的内核动词表 |
| U3-S3 | `docs/spec/edit-ops.md` | `remove` 加 `ripple`（默认 false）：删掉后，所有轨道上 `[入点, 出点)` 里没有别的片段时，出点之后的内容整体前移，规则同 `move` 的 `insert` 第 2 条「原位置合拢」；有别的片段时不合拢并给 `W_RIPPLE_SKIPPED`。新增 `roll`：`clip_id`、`edge`、`to`，把一个剪点整体移动，前一段的出点和后一段的入点一起变，两段总时长不变，`to` 不能越过任一段的另一端；`linked` 同 `trim`。「剪点前后移 1 帧」「把剪点延到播放头」都是 `roll` |
| U3-S4 | `docs/spec/timeline-schema.md` 4.6 | 标记加可选 `description`（只用于 `chapter`，别的类带它报 `E_VALIDATION`）；加可选 `ext["zsir.user_edited"]`：人改过标题或描述后由内核写上，AI 重新分章时不覆盖（Skill 里写规则）。字段都是可选的新增，`schema_version` 不变（现为 `0.3`） |
| U3-S5 | `docs/spec/command-protocol.md` | 9.1 新增 `inspect` 的 `chapters` 视图：章节树，一级下面挂二级，每项 `id`、`level`、`start`、`end`、`duration`、`title`、`description`、`user_edited`、`hue`（按一级章节顺序从 0 起编号，二级跟一级）；结束时间到下一个同级或更高级的标题，最后一项到时间线结尾。6.1 写请求加可选 `reason`（一句理由，不超过 200 字，日志记下）。7.3 `session_review` 加 `steps[]`：草稿日志的每一步，`revision`、`label`、`reason`、`changes` 摘要（每类实体改了几个）。9.6：`ui_state` 加 `history.open`（悬浮窗）、`edit_point`（选中的剪点：`track_id`、`at`）、`chapters.view`（`outline` 或 `timeline`）；`ui_show_panel` 的 `chapters` 支持 `sub: "timeline"`。新错误码 `E_PERMISSION_DENIED`（`rejected`，用户拒绝了许可），只由宿主返回 |
| U3-S6 | `docs/spec/handoff-profile.md` | 章节描述：FCPXML 的 `<chapter-marker>` 有 `note`，写进去；OTIO、xmeml 写进损失报告 `marker_description`，状态近似 |
| U3-S7 | `docs/product.md` | 第 4 节：批准和许可都在右侧「决定」；6.1：历史面板改为顶栏悬浮窗；第 3 节加章节时间轴视图和设置对话框的页；路线图第 3 步加本轮 |
| U3-S8 | `design/` | 从设计系统 v3「黑底浮卡」同步 `tokens.json`、`reference/components.css`、图标；`docs/design.md` 更新链接和组件清单。给 U3.10 用 |

规格 PR 合并后才派代码任务。规格里的编号、错误码、字段名，代码必须一字不差。

## 4. 任务（Codex）

共同约定沿用 `step-3.md`「3.8 起的共同约定」和 `polish-1.md` 的移植规则。本步允许改 `schema/timeline.schema.json`、`schema/command.schema.json`、`schema/loss-report.schema.json`，按规格改。

### 4.1 内核

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| U3.1 | 章节：标记 `description` 和 `ext["zsir.user_edited"]`（`add_marker`、`update_marker` 读写，L1 校验，人改标题或描述时内核写 `user_edited`）；`inspect` 的 `chapters` 视图；三家导出器按 U3-S6 处理描述；示例工程和 golden 更新 | U3-S4、S5、S6 | 示例工程里 3 章 7 节，`chapters` 视图的 `end` 和 `duration` 与手算一致，最后一章到时间线结尾，第一个一级标题之前的二级单独成组；二级的 `hue` 等于所属一级；`note` 类标记带 `description` 报 `E_VALIDATION`；人用 `update_marker` 改标题后 `user_edited` 为 true，Agent 改不写；FCPXML 的 `<chapter-marker>` 带 `note`，OTIO 和 xmeml 的损失报告有 `marker_description`；CLI 和 MCP 对等 |
| U3.2 | 剪辑操作：`remove` 的 `ripple`、新增 `roll`；`schema/command.schema.json` 跟上 | U3-S3 | 三轨上删一段并合拢，三轨后面的内容都前移该段时长，标记和独立字幕条也前移；另一轨在该区间有片段时不合拢并有 `W_RIPPLE_SKIPPED`；`roll` 把剪点右移 1 帧后两段总时长不变、前段源出点和后段源入点都后移 1 帧；`roll` 越过后段末尾报 `E_VALIDATION`；联动的音频片段跟着滚；两种操作撤销后字节还原；用 `fixtures/` 的 J/L cut 工程验证只滚同一时刻的边 |
| U3.3 | 会话：写请求的 `reason`；`session_review` 的 `steps[]`；核对 `session_approve` 的日志条目带 `session_id`，没有就补上（F6-a：历史里的一步要能找回它的会话和决定） | U3-S5 | 一个 3 步的草稿，`steps` 按顺序列出 3 条，`label`、`reason`、`changes` 摘要齐全；批准后 `inspect history` 里那条的 `session_id` 能查到会话和它的决定；`reason` 超 200 字报 `E_VALIDATION`；CLI 和 MCP 对等 |

U3.1、U3.2、U3.3 改的文件不重叠（标记和读视图、剪辑操作、会话），可以并行。

### 4.2 宿主

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| U3.4 | 应用级偏好：按 `desktop-host.md` 第 2、3 节。文件是 `desktop.json`（内核的 `settings.json` 和 `settings_get`/`settings_set` 是语音设置，名字已被占用，不碰）；界面通道动词 `prefs_get`、`prefs_set`；快捷键表 `packages/app-host/src/keymap.ts` | U3-S2 | 改一项偏好后重启宿主仍在；文件损坏时回到默认并给界面一条警告，不崩；`keymap.ts` 里每个动作都有两套键，没有重复的键；界面通道外调不到这两个动词 |
| U3.5 | Agent 管理：找程序（PATH 加 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`）、版本、新版检查（查 npm registry，走 `HTTPS_PROXY`，结果缓存 24 小时，失败静默）、安装和更新（`npm install -g @anthropic-ai/claude-code`、`npm install -g @openai/codex`，输出逐行推给界面，没有 npm 时给出手动安装说明）、设默认（写 U3.4 的 `default_agent`，`agents.selected` 启动时读它）。界面通道动词 `agents_list`、`agents_install`、`agents_update`、`agents_set_default`；推送 `agents_changed` | U3.4 | 两家都没装时列表给出「没有找到」和安装按钮的数据；装了 Claude Code 的机器上版本号和程序位置正确；不查也不显示登录状态；新版检查断网时 3 秒内返回、不报错；安装过程的每行输出都到了界面；设默认后重启仍是它；测试不联网，npm 和 CLI 都用假命令 |
| U3.6 | 许可闸：Agent 通过宿主 MCP 调用会碰到工程外面的动词时，宿主先停下问界面。要问的动词：`export`、直接导出、`record_handoff_check`、`voice_generate`（花钱）、云端 `transcribe`，以及以后任何写工程目录以外文件的动词，清单在 U3-S2。流程：推 `permission_request`（`id`、`verb`、标题、说明、会写到哪、命令原文）给界面，等答复；`once` 放行一次；`project` 写进 `.zcut/<project_id>/permissions.json`，以后同动词不问；`deny` 给 Agent 返回 `rejected`、`E_PERMISSION_DENIED`，`details` 带用户的话（可选）。界面没连上时按 `deny` 处理。等待时 Agent 的调用挂着，不超时 | U3.4、U3-S2、U3-S5 | Agent 调 `export` 时界面收到请求，答 `once` 后导出照常；答 `project` 后再调不问；答 `deny` 后 Agent 收到 `E_PERMISSION_DENIED`，对话里能看到它换了办法；`edit`、`inspect` 这类不问；对等测试：同一动词从 CLI 调用不经过闸 |
| U3.7 | 下一步建议：系统提示里约定 Agent 每轮最后一行写 `【下一步】一句话`（没把握就不写）；`agent-events.ts` 解析成 `suggestion` 事件，不进正文；界面收到后放进输入框当灰字。两家 CLI 都要 | — | 带这一行的回复，正文里看不到它，`suggestion` 事件里有；不带时没有事件；一行里有多个「【下一步】」只取最后一个 |
| U3.8 | 修订事件：任何写入成功后（界面的、Agent 的、会话草稿的），`project_changed` 改为带内容：`revision`、`label`、`author`、`session_id`、`changes` 摘要（每类实体的增删改个数）和第一批 `changes` 的 `before`/`after` 位置（片段的轨道和起止，上限 50 条）。界面用它做过场和刷新历史 | U3.3 | Agent 一个 5 步的批次，界面按顺序收到 5 条；每条的 `changes` 和 `inspect history` 对得上；超过 50 条改动时摘要仍完整、明细截断并标 `truncated` |
| U3.9 | 预览缓存（宿主）：按 U3-S1、S2。每个视频片段一段缓存，键是 `hash(素材指纹 + 源入点 + 源出点 + 速度 + 画质)`，文件是 fMP4（`-movflags +frag_keyframe+empty_moov+default_base_moof`），视频 `h264_videotoolbox` 720p、关键帧间隔 0.5 秒，声音 AAC 48 kHz 单声道；没有 VideoToolbox 时退回 `libx264 -preset veryfast`。后台队列按播放头附近优先；写入后推 `preview_cache` 状态（每段 `ready` / `building` / `missing`，按工程的占用）；媒体通道按键提供分段，支持 Range；缓存目录不存在（外接盘拔了）时全部按 `missing`，不报错；上限满了先清最久没打开的工程；界面通道动词 `preview_cache_status`、`preview_cache_clear`（整个或某工程）。只改字幕、只挪片段位置不重做；`trim` 后只重做那一段 | U3.4、U3-S1、S2 | 合成素材工程：改一刀后只有被改的段重做，其他段的键和文件不变；拔掉缓存目录后状态全 `missing`，播放退回原素材；上限 1 GB、两个工程共 1.5 GB 时，最久没打开的那个被清掉；分段文件两次生成逐字节相同（不写时间戳）；测试里 ffmpeg 用假命令，真编码由 Claude 在本机验收 |

U3.4 先做；U3.5、U3.6、U3.7、U3.8 之间不重叠，可以并行；U3.9 单独一条线。

### 4.3 界面

界面任务都在 U3.10 换皮之后做，否则每个面板要改两遍。

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| U3.10 | 换皮到 v3「黑底浮卡」：把 `design/v3/` 换到 `design/tokens.json` 和 `design/reference/components.css`（见 `design/README.md`），`tokens.ts` 跟上（v3 没有 `size` 组、多了 `shadow` 组）；壳子改成顶栏 + 左侧图标栏 + 三块浮卡（左栏、预览加右栏、时间线），尺寸按画布的 `TopBar`、`Rail`、`Preview`、`Timeline` 部件；顶栏加历史图标（在导出左边）、撤销重做、命令面板占位；图标栏去掉历史；每个面板的类名换成设计系统的 `zc-*`，布局按画布。可以按面板拆成几个 PR，第一个 PR 先做壳子和 AI 面板 | U3-S8 | Claude 用画布的截图逐屏比对；每个颜色、字号、间距都引用变量，`grep` 不到写死的十六进制色；Bill 实机看 |
| U3.11 | 时间线：剪点显示（相接片段间 2px 缝、标尺下的剪点刻度、选中剪点的白条加三角，样式 `zc-seam`、`zc-cut-tick`）；剪点选中（点缝隙选中，`ui_state.edit_point`，`ui_select` 清空时一起清）；快捷键改为读 U3.4 的 `keymap`（两套习惯都能用、单键覆盖生效）；新动作：滚动编辑（拖剪点或 `,` `.` 一帧 → `roll`）、剪到播放头去掉前段/后段（`trim` 到播放头，`ripple` 跟磁性开关）、把剪点延到播放头（`roll`）、所有轨道一起切（一个 `edit` 里对横跨播放头的每个片段各一个 `split`）、删除并合拢（`remove` 带 `ripple: true`）、删除留空隙（`remove`）；磁性开关 = 一个界面偏好（U3.4 的 `ui.snap` 之外再加 `ui.magnetic`），决定拖动用 `move` 的哪个 `mode`、删除和修剪带不带 `ripple`；标尺上方的缓存细线（读 U3.9 的状态） | U3.10、U3.2、U3.4 | 切到 Premiere 习惯后 `V` 选择、`C` 切割、`⌘K` 切一刀、`⌥⌫` 删除并合拢；切回 FCP 后 `A` `B` `⌘B` `⌫`；改单个键后只有那一项变；选中剪点后按 `,` 发出 `roll` 且总时长不变；磁性开时拖动发 `mode: insert`、删除带 `ripple`，关时相反；三轨一起切后三轨各多一个片段且剪点在同一时刻；组件测试覆盖每个动作发出的操作 |
| U3.12 | 设置对话框：左边导航（通用、Agent、字幕识别、语音、预览与缓存、快捷键、关于），按画布的 `Settings`、`SettingsKeys`、`SettingsPreview`。Agent 页读写 U3.5；快捷键页读写 U3.4（两张习惯卡片、三组对照表、搜索、改单键、恢复默认）；预览与缓存页读写 U3.4 和 U3.9（位置、换位置、在访达中显示、剩余空间、用量和上限、全部清空、画质、自动准备、用电池时暂停、按工程的占用和状态） | U3.10、U3.4、U3.5、U3.9 | 每个控件改了都落到设置文件；Agent 页在没装 Codex 的机器上显示「没有找到」和一键安装，点安装能看到逐行输出；缓存页换位置后状态列表刷新；快捷键搜索「切」能找到切割和切一刀 |
| U3.13 | AI 面板：按画布 `Main`、`MainRunning` 和「Agent 工具调用」画板的 14 种情形画工具调用（读、看画面、改时间线、听、等待、失败、停止、计划、许可）；方案卡和「全部批准」「看对比」放右侧「决定」顶上，对话里只留「方案等你审 ›」；许可卡放「决定」顶上标「Agent 在等你」，对话里一行「等你许可 ›」，三个按钮和数字键 1 2 3 走 U3.6；输入框灰字建议（U3.7）：Tab 填入、回车发送、打字即消失；草稿改动下的链接「看方案」打开审方案 | U3.10、U3.6、U3.7 | 对照画板 14 种情形各有组件测试；许可卡答复后 Agent 继续；灰字在没有建议时不出现；Bill 实机看一次完整的「让 AI 剪开头」 |
| U3.14 | 审方案：按画布 `MainReview`、`TimelineDiff` 和「审方案：时间线改动不闪现」画板。数据：原来 = `inspect timeline` 带 `at_revision: base_revision`，方案 = 带 `session_id`，差异 = `inspect` 的 `review` 视图（内容同 `session_review`，不改会话状态）的 `timeline_changes`、`subtitle_changes`、`steps`；界面只按这三份画，不自己算差异。每条轨道上下对半，上半原来（灰、淡），下半方案；删的珊瑚框、加的绿框、改字的冰蓝框；右侧按 `steps` 列改动，点一行时间线跳过去；工具栏「对比 / 只看方案 / 只看原来」；上下箭头在改动间跳。过场：进入对比 320 毫秒展开，批准后 300 毫秒收起加滑动，交错 80 毫秒，`prefers-reduced-motion` 时改 150 毫秒淡入淡出；AI 边做边写时按 U3.8 的事件逐步播 | U3.10、U3.3、U3.8 | 用 `fixtures/` 的会话工程：删 2 段、加 1 段 B-roll、改 1 处字，界面上框的位置和 `timeline_changes` 逐条对得上；「只看原来」时和 `at_revision` 的视图一样；批准后收起动画结束时时间线和主工程一致；组件测试里过场用假时钟 |
| U3.15 | 章节：大纲视图按画布 `Chapters`（全部展开 ｜ 全部折叠；每章时间段、时长、一级标题；二级可折叠，灰字描述；播放头所在章底色）；时间轴视图按 `ChaptersTimeline` 和「章节时间轴」画板（色块按时长、一级 / 二级、同章同色系深浅、时长写在色块里、指引线连标题、标题挤时拐弯、白线播放头、上下缩放滑块右对齐、一级二级切换 250 毫秒过场）；两个视图都读 `inspect chapters`，颜色用 `hue` 编号映射，界面只做「播放头落在哪一段」的查找；点色块或标题 → `ui_seek`；吸附到章节和小节起点，跟时间线的吸附开关走，`⌘` 临时不吸；折叠状态和缩放存 U3.4 的 `ui.chapters`；左栏可以切换两个视图，「让 AI 重新分章」不变 | U3.10、U3.1、U3.4 | 两个视图的章节数、时间段、标题和 `chapters` 视图一致；改一个标题后两个视图同时变；点第二章第二节的色块后播放头在它的起点；吸附关掉后点在交界附近不再吸；折叠两个二级、重开 App 后仍折叠；界面里没有自己算结束时间的代码 |
| U3.16 | 历史：顶栏历史图标（`⌥⌘H`）打开悬浮窗（`zc-popover`，尖角指向按钮），列每一步（人或 Agent 图标、说明、时间、步数），底下「回到这一步」「回到最新」；选中一步后左栏显示「这一步改了什么」（沿用改动汇报的六种类型），右栏显示这一步所属会话的决定（U3.3 的 `session_id`）；还没批准的草稿那一行标「待审 ›」，点了打开审方案；图标栏和时间线工具栏的历史入口去掉；`ui_show_panel` 的 `history` 改为开关悬浮窗；`ui_state.history.open` | U3.10、U3.3、U3.14 | 打开悬浮窗不改右栏；点一步后预览和时间线停在那一步，顶栏显示「正在看」；草稿行点开的是审方案；Escape 关悬浮窗；Agent 调 `ui_show_panel` `history` 时悬浮窗打开 |
| U3.17 | 预览播放器改为连续流：MSE 按时间线顺序接 U3.9 的分段（`sequence` 模式），剪点处不跳转；某段 `missing` 或 `building` 时该剪点退回 P2.1 的两个播放器；播放头、字幕叠层、时码仍按现在的办法推算；暂停、拖动、倒放、`speed: "map"`、静帧和图片不变 | U3.9、U3.10 | 组件测试用假的 `MediaSource`；Claude 在 Bill 采访的副本上跑 `tools/acceptance/preview_seam.mjs`（扩展成能识别 MSE 模式）：每个剪点最大帧间隔不超过 2 帧、`seeking` 0 次、`waiting` 0 次；拔掉缓存目录后播放仍能继续，只是剪点处回到 P2.1 的水平；Bill 实机看 |
| U3.18 | 小改：导出面板的成片信息卡（缩略图压时长、标题、版本和保存状态、四个参数标签，对话框高 760px）；字幕样式面板「叠层导出」行加「在访达中显示」（沿用导出面板的 `revealItemInDir`）；章节视图和历史里不出现解释内部设计的提示文字 | U3.10 | 对照画布截图 |

U3.11、U3.12、U3.13、U3.15、U3.16、U3.18 改的文件不重叠，可以并行；U3.14 和 U3.16 共用审方案入口，U3.14 先做；U3.17 最后。

### 4.4 验收工具（Claude）

- `tools/acceptance/preview_seam.mjs`：识别 MSE 模式（上层只有一个 `<video>`，没有 `data-preroll`），统计 `waiting` 事件和 `sourceBuffer` 的间隙。
- 新增 `tools/acceptance/keymap_check.mjs`：读 `keymap.ts`，对照附录 A 逐项核对，报出重复的键和没有键的动作。
- 新增 `tools/acceptance/chapters_check.py`：读示例工程，手算章节树，和 `inspect chapters` 比。

## 5. 顺序

```text
第 0 段  Claude：U3-S1 到 S8（规格、ADR、design/ 同步）
第 1 段  并行：
         内核  U3.1 ‖ U3.2 ‖ U3.3
         宿主  U3.4 → (U3.5 ‖ U3.6 ‖ U3.7 ‖ U3.8)
         实测  Claude 在真 App（Tauri 的 WKWebView）和 Bill 的采访素材上重跑 MSE 初测（F3-e），
               结果写进 ADR-0023；不过关就不派 U3.9 和 U3.17
第 2 段  界面  U3.10（壳子和 AI 面板先，其余面板跟上）
第 3 段  并行：U3.11 ‖ U3.12 ‖ U3.13 ‖ U3.15 ‖ U3.16 ‖ U3.18；U3.14 在 U3.16 之前
第 4 段  U3.9 → U3.17
```

每段结束 Claude 验收一次；第 2 段和第 4 段结束请 Bill 实机看。

## 6. 已定的事（Bill 2026-11-06）

| 事 | 结论 |
|---|---|
| F2-f 方案能不能只批其中几条 | 本轮不做。协议只有整批批准或拒绝；用户不满意某条，在「决定」里告诉 AI 改 |
| 磁性开关管不管移动 | 管，模仿 FCP 的操作感觉。开着时拖动用 `move` 的 `insert`，删除和修剪带 `ripple`；关着时都不带 |
| 预览画质默认 | 720p，上限 20 GB，缓存放 `~/Movies/庄Sir剪辑助手/预览缓存`；设置里能改位置和上限 |
| 章节颜色能不能自己改 | 不做，`hue` 按顺序给 |
| 登录状态查不到怎么办 | 不做登录状态。Agent 页只显示找到没有、版本、位置、新版；安装和更新照样能用 |
| 历史里人改的步骤要不要也有「理由」 | 不要。`reason` 只有 Agent 写；人的操作只有界面生成的 `label` |

## 7. 不做

- 自己做 Agent 循环或接云端模型：仍用本机的 Claude Code / Codex（Bill 2026-11-06）。
- 整条成片渲染成一个缓存文件：剪一刀全部重做，不如分段。
- 把界面状态（折叠、缩放、选中的剪点）写进工程文件。
- Windows 的程序路径和安装命令，到 Windows 兼容那一步再补。

## 附录 A：快捷键两套默认（已移到 `desktop-host.md` 3.1，以那里为准）

动作名就是 `keymap.ts` 里的键名。「◇」是本应用自己补的，两家都没有对应默认键。实现前用两家的官方快捷键表逐条核对，下面标「?」的还没在官方表里确认（F1-g）。

| 动作 | 名 | Premiere 习惯 | Final Cut Pro 习惯 |
|---|---|---|---|
| 水平放大 / 缩小 | `zoom_in` / `zoom_out` | `=` / `-` | `⌘=` / `⌘-` |
| 缩放到整条时间线 | `zoom_fit` | `\` | `⇧Z` |
| 轨道变高 / 变矮 | `track_taller` / `track_shorter` | `⌘=` / `⌘-` ? | `⌃⌥↑` / `⌃⌥↓` ? |
| 下一个 / 上一个剪点 | `next_edit` / `prev_edit` | `↓` / `↑` | `↓` / `↑` |
| 播放 · 停止 | `play_pause` | 空格 | 空格 |
| 倒放 / 停 / 快放 | `shuttle_back` / `shuttle_stop` / `shuttle_fwd` | `J` / `K` / `L` | `J` / `K` / `L` |
| 标入点 / 出点 | `mark_in` / `mark_out` | `I` / `O` | `I` / `O` |
| 下一个待审处 ◇ | `next_review` | `⌥↓` | `⌥↓` |
| 选择工具 | `tool_select` | `V` | `A` |
| 切割工具 | `tool_blade` | `C` | `B` |
| 在播放头切一刀 | `split_at_playhead` | `⌘K` | `⌘B` |
| 所有轨道一起切 | `split_all_at_playhead` | `⇧⌘K` | `⇧⌘B` |
| 移动剪点（滚动编辑） | `tool_roll` | `N` | `T` |
| 剪点前后移 1 帧 | `nudge_edit_back` / `nudge_edit_fwd` | `⌥←` / `⌥→` | `,` / `.` |
| 剪到播放头：去掉前段 / 后段 | `ripple_to_playhead_in` / `ripple_to_playhead_out` | `Q` / `W` | `⌥[` / `⌥]` |
| 把剪点延到播放头 | `extend_edit` | `E` | `⇧X` |
| 删除并合拢 | `ripple_delete` | `⌥⌫` ? | `⌫` |
| 删除留空隙 | `lift_delete` | `⌫` | `⇧⌫` |
| 吸附开关 | `toggle_snap` | `S` | `N` |
| 磁性开关 ◇（Pr 无） | `toggle_magnetic` | `⇧M` | `P` |
| 加标记 | `add_marker` | `M` | `M` |
| 撤销 / 重做 | `undo` / `redo` | `⌘Z` / `⇧⌘Z` | `⌘Z` / `⇧⌘Z` |
| 历史 ◇ | `toggle_history` | `⌥⌘H` | `⌥⌘H` |
