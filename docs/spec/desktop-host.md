# 桌面版宿主 v0.1

状态：草案 · 2026-11-07 · 依赖 ADR-0016（桌面版架构）、ADR-0023（预览缓存）、ADR-0024（素材缓存）、`command-protocol.md`、`docs/tasks/ui-3.md`

本文规定宿主进程（`packages/app-host`）自己的事：给界面的本机通道上的动词和推送、应用级偏好、快捷键表、Agent 管理、许可闸、预览缓存、下一步建议。这些都不是内核动词，不进 `command-protocol.md` 第 9 节的动词表，没有 CLI 命令。给 Agent 的界面动词仍在 `command-protocol.md` 9.6。

原则：**界面只接收和渲染，处理放在宿主和内核。** 界面不读写文件、不算章节结束时间、不算差异、不探测程序。

## 1. 本机通道

宿主和界面之间是 ADR-0016 的本机 WebSocket，消息是 JSON：

- 请求：`{id, verb, request}`；回复：`{type: "result", id, envelope}`，`envelope` 是结果信封（`command-protocol.md` 第 4 节），宿主自己的动词没有 `receipt`。
- 推送：`{type, ...}`，没有 `id`。

本文新增的通道动词和推送：

| 名 | 类型 | 节 |
|---|---|---|
| `prefs_get` / `prefs_set` | 动词 | 2 |
| `agents_list` / `agents_install` / `agents_update` / `agents_set_default` | 动词 | 4 |
| `agents_changed`、`agents_output` | 推送 | 4 |
| `permission_request` | 推送 | 5 |
| `permission_answer` | 动词 | 5 |
| `preview_cache_status` / `preview_cache_clear` / `preview_cache_move` | 动词 | 6（含 6.5 素材缓存） |
| `preview_cache` | 推送 | 6 |
| `project_changed` | 推送（改为带内容） | 7 |
| `chat_event` 的 `suggestion` 类型 | 推送 | 8 |

这些动词只在本机通道上有，宿主的 MCP 不暴露它们：Agent 不能改用户的偏好、不能自己答许可。

### 1.1 界面状态

`ui_state`（`command-protocol.md` 9.6）的 `edit_point`、`chapters`、`history` 由界面上报，宿主原样转给 Agent。宿主校验界面上报的状态时要认这三个字段（2026-11-06 补）。

## 2. 应用级偏好 `desktop.json`

放在 `~/Library/Application Support/zsir-cut/desktop.json`，和 `recent.json` 同目录，跟随 `HOME`。内核的 `settings.json`（`voice.md` 1.1）是另一个文件，宿主不写它，两个文件各有一个写入者。

写入：zod 校验，写临时文件再改名，键按字母序序列化。文件不存在时用默认值。读入按项宽容（2026-11-07 改：原来任何一项校验不过就整份换默认，旧版本 App 读到新版本加的键时把 Bill 的设置全丢了）：

- 不认识的键（新版本加的、或以后去掉的）原样保留，写回时照写，不报警告。
- 某一项的值校验不过（类型不对、超出范围），只把这一项换回默认值，其他项照用；给界面推一条 `{type: "warning", code: "W_PREFS_RESET", message}`，`message` 写出是哪几项；写回时这几项写默认值。
- `version` 比本版本认识的大时，照上面两条读，不降版本号，写回时保留原来的 `version`。
- 只有文件不是合法 JSON、或顶层不是对象时，才整份用默认值，推 `W_PREFS_RESET`，并把坏文件改名为 `desktop.json.broken`。都不崩。

```json
{
  "schema": "zsir-cut/desktop",
  "version": 1,
  "default_agent": null,
  "keymap": { "preset": "fcp", "overrides": {} },
  "preview_cache": {
    "directory": "~/Movies/庄Sir剪辑助手/预览缓存",
    "limit_gb": 20,
    "quality": "720p",
    "auto": true,
    "pause_on_battery": false
  },
  "ui": {
    "snap": true,
    "magnetic": true,
    "skimming": false,
    "timeline_zoom": null,
    "track_height": "m",
    "chapters": { "view": "outline", "zoom": 1, "folded": [] },
    "layout": { "left_width": null, "right_width": null, "timeline_height": null }
  }
}
```

| 字段 | 取值 |
|---|---|
| `default_agent` | `claude`、`codex` 或 null。null 时取第一个找到的 |
| `keymap.preset` | `fcp` 或 `premiere`，默认 `fcp` |
| `keymap.overrides` | 动作名（第 3 节）到键的映射，键写法见第 3 节；值为 null 表示这个动作不绑键 |
| `preview_cache.directory` | 绝对路径，`~` 开头时按 `HOME` 展开 |
| `preview_cache.limit_gb` | 1 到 2000 的整数 |
| `preview_cache.quality` | `540p`、`720p`、`1080p` |
| `preview_cache.auto` | 打开工程时自动在后台准备 |
| `preview_cache.pause_on_battery` | 用电池时暂停生成，默认 false（2026-11-07 改：原默认 true，Bill 用笔记本插不插电都要流畅播放，FCP 也不因电池停后台渲染）。`version` 1 的文件读入时把这一项改成 false 并升到 `version` 2，只做这一次 |
| `ui.snap` | 吸附开关，时间线和章节时间轴共用 |
| `ui.magnetic` | 磁性开关，见第 3.2 节。在设置里切换 `keymap.preset` 时，界面在同一次 `prefs_set` 里把它设成该习惯的默认：`fcp` 开，`premiere` 关（2026-11-08 补）；之后照常手动开关 |
| `ui.skimming` | 浏览条开关，默认 false，见第 3.3 节（2026-11-08 加）。文件里没有这一项时用默认值，不升 `version` |
| `asr.mode` | 字幕识别模式，`local` 或 `api`，默认 `local`，见第 9 节。缺项用默认，不升版本 |
| `asr.model` | 本地模型，`1.7b` 或 `0.6b`。缺项时内存大于 16 GB 用 `1.7b`，否则 `0.6b` |
| `network.proxy` | 网络代理地址，字符串，默认空。只接受 `http://主机:端口`，见第 10 节。缺项用默认，不升版本 |
| `ui.timeline_zoom` | 每秒多少像素，null 表示缩放到整条 |
| `ui.track_height` | `s`、`m`、`l` |
| `ui.chapters.view` | `outline` 或 `timeline` |
| `ui.chapters.zoom` | 章节时间轴的上下缩放，0.5 到 4 |
| `ui.chapters.folded` | 大纲里折叠起来的一级章节的标记 ID |
| `ui.layout.left_width` | 功能区宽度，CSS 像素整数，200 到 560；null 用默认宽度（2026-11-07 补） |
| `ui.layout.right_width` | 参数区宽度，CSS 像素整数，240 到 600；null 用默认宽度 |
| `ui.layout.timeline_height` | 时间线区域高度占窗口内容区高度的比例，0.2 到 0.75，最多 3 位小数；null 用默认比例 |

`ui.layout` 由界面在拖完边界（松开鼠标）时用 `prefs_set` 写一次，拖动中不写；双击边界恢复默认时写 null。窗口变小时界面按最小尺寸临时压缩显示，不改写偏好里的值。

`prefs_get`：无参数，`result.prefs` 是整个对象（`directory` 展开后的路径另给 `result.preview_cache_directory`）。`prefs_set`：`patch`，按字段深合并，数组整体替换，`keymap.overrides` 给了就整体替换（`{}` 即恢复默认，2026-11-06 补）；写入后返回 `applied` 和新的整个对象，内容不变返回 `no_op`；校验不过返回 `rejected`、`E_VALIDATION`，文件不变。

## 3. 快捷键

动作表放在 `packages/app-host/src/keymap.ts`，导出两套默认和合并函数；界面通过 `prefs_get` 拿到合并后的表（`result.keymap`：动作名到键），不自己存一份。

键的写法：修饰键按 `⌃⌥⇧⌘` 的顺序在前，后面是一个键名：字母大写、数字、`=` `-` `\` `,` `.` `[` `]`、`Space`、`Delete`（⌫）、`ForwardDelete`、`Left` `Right` `Up` `Down`。例如 `⇧⌘K`、`⌥Delete`、`Space`。

### 3.1 动作与两套默认

「◇」是本应用补的键，两家没有对应的默认。合并后同一个键绑了两个动作时，`overrides` 里的那个生效，另一个变为不绑键，`prefs_set` 的结果里 `result.unbound` 列出被挤掉的动作。`overrides` 里有多个动作争同一个键时，按 3.1 表里动作的顺序处理，后面的生效。

| 动作名 | 做什么 | `premiere` | `fcp` |
|---|---|---|---|
| `play_pause` | 播放 · 停止 | `Space` | `Space` |
| `shuttle_back` / `shuttle_stop` / `shuttle_fwd` | 倒放 / 停 / 快放 | `J` / `K` / `L` | `J` / `K` / `L` |
| `step_back` / `step_fwd` | 前后一帧 | `Left` / `Right` | `Left` / `Right` |
| `prev_edit` / `next_edit` | 上一个 / 下一个剪点 | `Up` / `Down` | `Up` / `Down` |
| `next_review` ◇ | 下一个待审处 | `⌥Down` | `⌥Down` |
| `mark_in` / `mark_out` | 标入点 / 出点 | `I` / `O` | `I` / `O` |
| `zoom_in` / `zoom_out` | 水平放大 / 缩小 | `=` / `-` | `⌘=` / `⌘-` |
| `zoom_fit` | 缩放到整条 | `\` | `⇧Z` |
| `track_taller` / `track_shorter` | 轨道变高 / 变矮 | `⌘=` / `⌘-` | `⌃⌥Up` / `⌃⌥Down` ◇ |
| `tool_select` | 选择工具 | `V` | `A` |
| `tool_blade` | 切割工具 | `C` | `B` |
| `tool_roll` | 移动剪点（滚动编辑）工具 | `N` | `T` |
| `split_at_playhead` | 在播放头切一刀（选中片段，没选中时切最上面的视频轨和联动音频） | `⌘K` | `⌘B` |
| `split_all_at_playhead` | 所有轨道一起切 | `⇧⌘K` | `⇧⌘B` |
| `nudge_edit_back` / `nudge_edit_fwd` | 选中的剪点前后移 1 帧；选中片段时片段前后移 1 帧 | `⌥Left` / `⌥Right` | `,` / `.` |
| `trim_start_to_playhead` / `trim_end_to_playhead` | 剪到播放头：去掉前段 / 后段 | `Q` / `W` | `⌥[` / `⌥]` |
| `extend_edit` | 把选中的剪点延到播放头 | `E` | `⇧X` |
| `ripple_delete` | 删除并合拢 | `⌥Delete` | `Delete` |
| `lift_delete` | 删除留空隙 | `Delete` | `⇧Delete` |
| `toggle_snap` | 吸附开关 | `S` | `N` |
| `toggle_magnetic` ◇ | 磁性开关 | `⇧M` | `P` |
| `toggle_skimming` | 浏览条开关（2026-11-08 加） | `⇧S` ◇ | `S` |
| `add_marker` | 加标记 | `M` | `M` |
| `undo` / `redo` | 撤销 / 重做 | `⌘Z` / `⇧⌘Z` | `⌘Z` / `⇧⌘Z` |
| `toggle_history` ◇ | 历史悬浮窗 | `⌥⌘H` | `⌥⌘H` |
| `open_settings` | 设置 | `⌘,` | `⌘,` |

`keymap.ts` 的测试要保证：每个动作在两套里都有值；同一套里没有重复的键。

### 3.2 动作发出的编辑

界面按下面的表把动作翻成 `edit`，作者 `human`，带界面生成的 `label`。「磁性」指 `ui.magnetic`，模仿 Final Cut Pro 的磁性时间线（Bill 2026-11-06）：

| 动作 | 磁性开 | 磁性关 |
|---|---|---|
| 拖动片段 | `move`，`mode: insert` | `move`，`mode: place` |
| `ripple_delete` | `remove`，`ripple: true` | 同左（这个动作本身就是合拢） |
| `lift_delete` | `remove` | `remove` |
| 键盘 `Delete`（随习惯落到上面两个动作之一） | 按动作 | 按动作 |
| 拖片段边缘、`trim_start_to_playhead` / `trim_end_to_playhead` | `trim`，`ripple: true` | `trim`，`ripple: false` |
| 用滚动工具拖剪点、`nudge_edit_*`（选中剪点时）、`extend_edit` | `roll` | `roll` |
| `split_at_playhead` | `split` | `split` |
| `split_all_at_playhead` | 一个 `edit` 里，对所有轨道上横跨播放头的每个片段各一个 `split`，`linked: false` | 同左 |

`premiere` 习惯下多一条：拖片段或片段边缘时按住 `⌘`，这一次按磁性开关的反面发（开时发 `place` / `ripple: false`，关时发 `insert` / `ripple: true`），松开 `⌘` 后下一次拖动恢复。`fcp` 习惯没有这个修饰键。

剪点：两个片段相接处。选中剪点时界面记 `{track_id, at}`（`command-protocol.md` 9.6 的 `ui_state.edit_point`），`roll` 的 `clip_id` 取剪点左边的片段、`edge: "out"`。

### 3.3 工具和指针的手感

2026-11-08 Bill 定：对标 Final Cut Pro 和 Premiere Pro，手感跟着 `keymap.preset` 走；`overrides` 只改键，不改手感。下面没写习惯的条目两套一样。

**换工具和临时工具。** 按工具键（`tool_select`、`tool_blade`、`tool_roll`）只换工具，不做任何剪辑。按下工具键不放时就换过去；松开时，如果按住超过 300 毫秒，或者按住期间在时间线上按过鼠标，就回到按下前的工具（临时工具）；否则留在新工具上。工具栏的按钮跟着显示当前工具。切完一刀后仍是切割工具。

**切割工具。**

| 项 | 规则 |
|---|---|
| 指针 | 在视频、声音轨的片段上是剃刀形指针；在空白处、字幕轨、标尺上是禁止指针 |
| 落点线 | 指针在片段上移动时，从这条轨顶到底画一条 1px 虚线，位置是指针所在帧的开头（按帧取整）；同一组联动的片段所在的轨一起画。顶上贴一个时码小标签，写这一帧的时码。开着吸附时，线在吸附距离内吸到播放头、剪点、标记，吸住时虚线变实线 |
| 点一下 | 在落点线处切开：一个 `edit`，`split` 的 `at` 是落点线的时刻，`linked` 默认 true（视音频一起）。落点不在片段内部（正好在入点或出点上）时不切 |
| Shift 点 | 落点线贯穿所有视频、声音轨；点下去时对所有轨上横跨这一时刻的片段各一个 `split`，`linked: false`，规则同 `split_all_at_playhead` |
| Option 点 | 只切点到的这一个片段：`split` 带 `linked: false` |
| 不改的 | 不移动播放头；不改变选中；`split_at_playhead`、`split_all_at_playhead` 仍按 3.2 节在播放头处切 |

**选择工具拖片段边缘。** 指针放在片段边缘时边缘先高亮，指针按将要发的操作换形状：波纹修剪（磁性开，或 `premiere` 下按住 `⌘`）是带胶片方向的单括号，普通修剪是单括号；选择工具拖边缘只修剪，不滚动，相接处也一样（两家都是这样：滚动要换滚动工具）；要滚动就用滚动工具，或选中剪点后用 `nudge_edit_*`、`extend_edit`（2026-11-08 Claude 实测后改：原来剪点正中左右 4px 算滚动，和修剪手柄重叠，指针显示修剪、拖下去却是滚动）。

**滚动工具（`tool_roll`）。** 片段相接处和与另一段相接的边缘都显示滚动指针，拖动发 `roll`；旁边是空隙的边缘按选择工具的修剪规则；片段本身不能拖动，指针是箭头。

**拖动时的反馈。** 修剪、滚动、移动时，指针旁显示变化量时码（例如 `+00:00:00:12`、`−00:00:01:03`）和拖完后的片段时长；吸附线上不写像素距离。修剪或滚动到素材头尾、再拖不动时，那条边变成 `--attention` 色。

**点时间线。** `fcp`：用选择工具点片段或轨道空白处（按下后没有拖动），播放头跳到点的那一帧，点片段同时选中它。`premiere`：播放头不动，只改选中。两套点标尺都移动播放头，点剪点都选中剪点。

**浏览条（`ui.skimming`）。** 打开时，指针在时间线的轨道区或标尺上移动，画一条和播放头不同色的竖线（浏览条），预览区显示这一帧，按帧取整，开着吸附时同样吸附；指针离开时间线，预览回到播放头那一帧。播放中不浏览，浏览条隐藏。浏览条开着且指针在时间线上时，`split_at_playhead`、`trim_start_to_playhead`、`trim_end_to_playhead`、`extend_edit`、`add_marker` 用浏览条的位置代替播放头（同 FCP）；指针不在时间线上时仍用播放头。切割工具下浏览条和落点线合成一条。只显示画面，不播放声音。

## 4. Agent 管理

### 4.1 找程序和版本

依次在 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/.claude/local`、pnpm 全局目录（`$PNPM_HOME`，没有时 Mac 是 `~/Library/pnpm`，Windows 是 `%LOCALAPPDATA%\pnpm`）、`~/.volta/bin`、nvm 当前版本的 `bin`（`$NVM_BIN`，没有时取 `~/.nvm/versions/node/` 下版本号最大的一个）、fnm 默认版本的 `bin`（`~/.local/share/fnm/aliases/default/bin`，Mac 也查 `~/Library/Application Support/fnm/aliases/default/bin`）、一键安装目录（`~/.zsir-cut/agents/bin`，Windows 是 `~/.zsir-cut/agents`）里找 `claude` 和 `codex`。用 `--version` 取版本，3 秒超时。第一个能跑出版本号的就是它；可执行但跑不出版本号的（坏掉的包装脚本）跳过，继续找下一个，都跑不出时用第一个可执行的，`version` 为 null。启动 Agent 时用找到的绝对路径，不再靠 `PATH`。

**Codex 用原生程序。** 找到的 `codex` 解析符号链接后，如果是 npm 包 `@openai/codex` 的 `bin/codex.js`，就在这个包的 `node_modules/@openai/codex-<平台>/vendor/<target>/bin/` 下找 `codex`（Windows 是 `codex.exe`）。`<平台>` 和 `<target>`：Mac M 芯片 `darwin-arm64` / `aarch64-apple-darwin`，Mac Intel `darwin-x64` / `x86_64-apple-darwin`，Windows `win32-x64` / `x86_64-pc-windows-msvc`。找到就用它取版本、启动对话，并像 `codex.js` 一样设环境变量 `CODEX_MANAGED_BY_NPM=1` 和 `CODEX_MANAGED_PACKAGE_ROOT=<@openai/codex 包目录>`。找不到时照旧用 `codex` 本身。`agents_list` 的 `path` 显示实际启动的程序。

不查也不显示登录状态（Bill 2026-11-06）。没登录时 Agent 的第一次回复会说明，界面照常显示。

### 4.2 新版检查

查 npm registry 的 `@anthropic-ai/claude-code` 和 `@openai/codex` 的 `latest`。请求走 `HTTPS_PROXY` 环境变量（没有就直连），3 秒超时，失败不报错，只是没有新版信息。结果缓存在内存 24 小时。

### 4.3 动词与推送

| 动词 | 参数 | 结果 |
|---|---|---|
| `agents_list` | `refresh`（可选，true 时重新探测并重查新版） | `result.agents`：每项 `id`（`claude`、`codex`）、`name`（「Claude Code」「Codex」）、`found`、`path`、`version`、`latest`（查不到为 null）、`update_available`、`default`（布尔）；`result.npm`：找到的 npm 路径或 null |
| `agents_install` | `id` | 发布版用应用自带的 Node 和 npm 运行 `npm install -g --prefix ~/.zsir-cut/agents <包名>`，不要求用户装 Node，也不要求管理员权限。开发版没有自带 npm，用 `PATH` 里的 npm，没有时返回 `rejected`、`E_UNSUPPORTED`，`details.manual` 是一段手动安装说明。立即返回 `accepted` 和 `result.job_id`。默认 registry 失败时，自动换 `https://registry.npmmirror.com` 再试一次 |
| `agents_update` | `id` | 同上，命令相同 |
| `agents_set_default` | `id` | 写 `desktop.json` 的 `default_agent`，返回 `applied`；对话面板之后默认用它 |

安装和更新期间每一行输出推 `{type: "agents_output", job_id, line, stream: "stdout" | "stderr"}`；结束推 `{type: "agents_output", job_id, done: true, ok}`，再推一次 `agents_changed`（内容同 `agents_list` 的结果）。同一时刻只跑一个安装任务，第二个返回 `failed`、`E_IO`、`retryable: true`。

**启动环境。** 发布版的宿主 `PATH` 依次是：应用的 `bin`（ffmpeg）、应用自带 Node 所在目录、`/opt/homebrew/bin`、`/usr/local/bin`（Windows 是对应的常用目录）、继承的 `PATH`。从 Finder 打开的应用继承不到终端的 `PATH`，这样 `npm`、`claude`、`codex` 这些靠 `#!/usr/bin/env node` 启动的程序才能跑。

测试不联网：npm、`claude`、`codex` 都用假命令，registry 用假地址。

### 4.4 启动对话

AI 面板对话和字幕整理都按本节启动 Agent。参数的其余部分不变。

**批准。** Codex 加 `-c approval_policy="never"`，盖过用户 `~/.codex/config.toml` 里的设置；`--sandbox read-only` 不变。Codex 请求批准时直接被拒，不会等。Claude Code 不变：只放行 `mcp__zsir-cut__*`。

**参数检查。** 某个程序（按路径和版本号）第一次启动对话前，先跑一次 `claude -p --help` 或 `codex exec --help`，5 秒超时，结果缓存在内存里，直到宿主退出。

| 参数 | 帮助里没有时 |
|---|---|
| Claude `--include-partial-messages` | 不传。回复不再逐字出现，整段出现 |
| Claude `--tools` | 不传 |
| Claude `--mcp-config`、`--strict-mcp-config`、`--allowedTools`、`--append-system-prompt-file` | 不启动，对话显示错误「Claude Code 版本太旧，缺少需要的功能。请在设置 · Agent 里更新。」 |
| Codex `--skip-git-repo-check`、`--json`、`--sandbox` | 不启动，对话显示错误「Codex 版本太旧，缺少需要的功能。请在设置 · Agent 里更新。」 |

帮助跑不起来或超时，按全都支持处理。最后的 stdin 参数 `-`：Codex 帮助里写了读 stdin 时用 `-` 的才传，否则不传，提示词照样从 stdin 写入。

**stderr。** 运行中的 stderr 不推给界面，只在内存里留最后 2000 字（先把 MCP 令牌和 `X-Api-Key` 一类的值换成 `[redacted]`）。正常结束时丢掉。退出码不是 0 且不是用户停止的，推两条 `error`：第一条是下表的原因，第二条是留下的最后 5 个非空行。原因按 stderr 里的关键词判断，不分大小写，从上往下第一条命中的为准：

| 原因 | 关键词 | 文字 |
|---|---|---|
| 没登录 | `not logged in`、`login`、`unauthorized`、`401`、`invalid api key`、`authentication` | 「<Agent 名> 没有登录或登录过期。请在终端运行 `claude` 或 `codex login` 登录后再试。」 |
| 网络 | `ENOTFOUND`、`ECONNREFUSED`、`ETIMEDOUT`、`ECONNRESET`、`timed out`、`network`、`stream disconnected`、`reconnecting` | 「<Agent 名> 连不上服务。请在设置 · 通用里检查网络代理。」 |
| 版本 | `unexpected argument`、`unknown option`、`unrecognized`、`unknown flag` | 「<Agent 名> 不认识庄Sir 传的参数，可能版本太旧。请在设置 · Agent 里更新。」 |
| 其他 | 都没命中 | 「<Agent 名> 退出了（退出码 N）。」 |

`<Agent 名>` 是「Claude Code」或「Codex」。宿主日志照旧记下全部 stderr（同样换掉令牌）。

**没有输出就停止。** Agent 进程连续 10 分钟 stdout 和 stderr 都没有新内容，宿主先发 SIGTERM，5 秒后还在就发 SIGKILL（Mac 结束整个进程组，Windows 用 `taskkill /T /F`），推 `error`「Agent 10 分钟没有响应，已停止。」再推 `end`。等许可闸（第 5 节）回答的时间不算。

## 5. 许可闸

Agent 通过宿主的 MCP 调用会碰到工程外面的动词时，宿主先停下来问用户（F9）。CLI 和内核自己的 MCP 不经过闸：许可是桌面版里「人在旁边看着」的约定，不是权限系统。

### 5.1 要问的动词

| 动词 | 原因 |
|---|---|
| `export`（不带 `dry_run`） | 往工程目录以外写文件 |
| `record_handoff_check` | 写交接包 |
| `voice_generate`、`voice_clone` | 花钱 |
| `transcribe`（会用到云端识别时：请求指定云端引擎，或用 `auto` 且 `asr.mode` 是 `api`，或用 `auto` 且本机设置开了云端兜底） | 把声音传到外面 |
| `terms_edit`、`voice_edit` | 改全局库，影响别的工程 |

以后新增的会写工程目录以外文件、联网或花钱的动词，先加进这张表。读动词、`edit`、会话动词、界面动词都不问。

### 5.2 流程

1. Agent 调了表里的动词。宿主推 `{type: "permission_request", id, verb, title, detail, target, command}`：`id` 是 `prm_` 加随机串；`title` 一句话（例如「导出到「交接」文件夹」）；`detail` 一两句说明会发生什么；`target` 是会写到哪（路径）或会花多少（能算出时），没有为 null；`command` 是 Agent 请求的 JSON 原文。
2. 界面答 `permission_answer`：`id`、`answer`（`once`、`project`、`deny`）、`message`（可选，用户写的一句话）。
3. `once`：放行这一次。`project`：放行，并把动词写进 `.zcut/<project_id>/permissions.json`（`{"schema": "zsir-cut/permissions", "version": 1, "allow": ["export"]}`），这个工程以后同一个动词不再问。`deny`：给 Agent 返回 `rejected`、`E_PERMISSION_DENIED`，`details.message` 是用户的话。
4. 等待期间 Agent 的这次调用一直挂着，不超时；用户点了对话的「停止」时按 `deny` 处理。界面没连上时直接按 `deny` 处理，`details.message` 为「桌面版界面没有打开」。
5. 同时可以有多个请求在等，界面按到达顺序排在「决定」顶上。

`permissions.json` 写法同第 2 节。设置里能清掉某个工程的许可（以后的版本，本轮不做界面）。

## 6. 预览缓存

规则见 ADR-0023。本节规定命名、存放和状态。

### 6.1 一段缓存

- 每个**启用的视频片段**一段（纯音频片段和静帧图片不做缓存，播放时照旧）。
- 键：`sha256(素材指纹 + "|" + 源入点 + "|" + 源出点 + "|" + 速度 + "|" + 画质 + "|" + "v2")` 的前 32 个十六进制字符。源入点、源出点用规范时间字符串；速度无时间映射为 `"1"`，有时间映射为映射的规范 JSON。
- 文件：`<缓存目录>/<project_id>/<键>.mp4`，写临时文件再改名。
- 编码：`ffmpeg -ss <源入点> -t <时长> -i <素材>`，视频 `h264_videotoolbox`（没有时 `libx264 -preset veryfast`），短边按画质（540、720、1080），关键帧间隔 0.5 秒（`-g` 按素材帧率算），声音 AAC 48 kHz 单声道，**声音补静音到和画面一样长**（`-af apad`，再用 `-t` 截到画面时长），`-movflags +frag_keyframe+empty_moov+default_base_moof`，`-map_metadata -1 -fflags +bitexact`，不写时间戳。不要求两次编出的字节相同（硬件编码器做不到），只要求键相同。变速和倒放按片段的映射生成，画面和预览看到的一致。
- 键的版本从 `v1` 升到 `v2`（2026-11-07）：`v1` 的段声音比画面短一到两个 AAC 帧（约 20 到 30 毫秒），接起来每个剪点都留一个声音空隙，WebKit 在空隙处停下等声音。`v1` 的段不再使用，按第 6.3 节的清理规则被删掉。
- 界面接段（ADR-0023 第 3 条修订）：`SourceBuffer` 用 `segments` 模式，每段追加前设 `timestampOffset` = 这段在流里的起点（前面各段画面时长之和），`appendWindowStart` / `appendWindowEnd` = 这段的起点和起点加画面时长，让多出来的声音被截掉，段与段在流里严丝合缝。段的画面时长由宿主在 `preview_cache_status` 的每段里给出（`duration`，规范时间字符串），界面不自己解析文件。
- 索引：`<缓存目录>/<project_id>/index.json`：`{project_path, last_opened, segments: {键: {bytes}}}`。

### 6.2 队列

- 打开工程且 `auto` 为 true 时开始；工程变了（`project_changed`）后重新算需要哪些键，已有的不重做。
- 顺序：播放头所在片段，然后往后，然后往前。同时只编码一段。
- `pause_on_battery` 为 true 且在用电池时暂停（用 `pmset -g batt` 判断，查不到按插电处理）。暂停时状态里 `paused: "battery"`，界面在时间线的缓存条上说明（见下）。
- **改完马上重做。** `project_changed` 后立刻重算键并开始编码变了的段，不等空闲；正在编码的段如果已经不在新时间线上，中止它。
- **按下播放时插队。** 界面播放时用 `preview_cache_hint` 报播放头（现有），宿主把播放头所在段和后面两段排到队首。
- **缓存条（2026-11-07 补，仿 FCP）。** 时间线标尺上方、章节色条下面画一条 2 像素的细线，按片段在序列上的位置分段：`missing` 画虚线（`--attention` 色），`building` 画虚线并从左到右按进度变实，`ready` 不画。纯音频和静帧片段不需要缓存，不画。整条都 `ready` 时这一行什么都没有。悬停虚线显示「这段还没准备好，播放到这里可能卡顿」；暂停时显示「用电池时暂停了预览准备，可在设置里关掉」。
- 缓存目录不存在时先建它（含上级目录），建不了才算不可用。例外：路径在 `/Volumes/<卷名>/` 下而这个卷没挂上（外接盘拔了），不建，免得在启动盘上建出一个同名目录（2026-11-06 补）。
- 缓存目录不可用或写不进去时不报错：所有段按 `missing`，队列停下，状态里 `directory_ok: false`；卷重新挂上后下一次状态检查恢复。

### 6.3 上限与清理

写入后总量超过 `limit_gb` 时，按 `last_opened` 从旧到新整个工程删掉，直到降到上限以下；当前打开的工程最后删，删到它时按段的最近使用时间删。

### 6.4 动词与推送

| 动词 | 参数 | 结果 |
|---|---|---|
| `preview_cache_status` | 无 | 当前工程每个视频片段的 `{clip_id, key, state, duration}`（`duration` 是段的画面时长，`ready` 时才有）（`ready`、`building`、`missing`），`directory`、`directory_ok`、`free_bytes`、`used_bytes`、`limit_bytes`，以及 `projects`：每个工程的 `project_id`、`name`、`path`、`bytes`、`last_opened` |
| `preview_cache_clear` | `project_id`（可选，没给时全部清空） | 删文件，返回 `applied` |
| `preview_cache_move` | `directory` | 改 `desktop.json` 的目录；旧目录的文件不搬，返回 `applied` |

状态变化时推 `{type: "preview_cache", ...}`，内容同 `preview_cache_status` 的结果，最多每 500 毫秒一次。

媒体通道按键提供分段：`/cache/<project_id>/<键>.mp4`，带 ADR-0016 的令牌，支持 Range。

### 6.5 素材缓存：波形和缩略图

规则见 ADR-0024（2026-11-07 补）。和预览段不同，素材缓存**按素材文件**做，不按片段：同一个素材在几条片段、几个工程里用，只做一份。

**键和位置。** 素材键 = `sha256(素材指纹 + "|media-v1")` 的前 32 个十六进制字符（指纹见 `timeline-schema.md` 的 `fingerprint`）。文件放在 `<缓存目录>/media/<素材键>/`，和各工程的预览段同一个缓存目录：

| 文件 | 内容 |
|---|---|
| `peaks.bin` | 波形。单声道（各声道取绝对值最大），每秒 100 个值，每个值 1 字节：`round(峰值 × 255)`，峰值在 0 到 1。没有文件头；值的个数 = `ceil(时长秒数 × 100)` |
| `thumbs.json` | 缩略图索引：`{version: 1, interval, tile_width, tile_height, columns, rows, count, sheets}`。`interval` 是规范时间字符串，第 i 张缩略图取素材时间 `i × interval`；`sheets` 是拼图文件名数组 |
| `thumbs-<n>.jpg` | 拼图，n 从 0 起，三位数补零。每张 `columns × rows` 格，按行从左到右排；第 i 张在第 `floor(i / (columns × rows))` 张拼图的第 `i mod (columns × rows)` 格 |
| `frames/<时间键>.jpg` | 放大到一格比 `interval` 还细时按需取的单帧，`时间键 = sha256(规范时间字符串)` 前 32 位，规格同拼图里的一格 |
| `meta.json` | `{media_key, fingerprint, duration, bytes, last_used, peaks: "ready"|"missing", thumbs: "ready"|"missing"}` |

**规格。** 缩略图高 96 像素，宽按素材画面比例取偶数；`columns` 10、`rows` 10；`interval`：素材时长不到 10 分钟取 1 秒，不到 60 分钟取 2 秒，再长取 5 秒。纯音频素材只做 `peaks.bin`，静帧图片只做一张缩略图（`interval` 为 0，`count` 为 1）。

**生成。** 波形用一次 ffmpeg 解出整条单声道 PCM 算峰值；缩略图用一次 ffmpeg 按 `fps=1/interval` 抽帧、缩放、`tile` 拼图。不对每个可见位置单独起 ffmpeg。写临时文件再改名，`meta.json` 最后写，写完才算 `ready`。素材文件只读，不改、不移、不删（AGENTS.md 硬规则 5）。

**队列。** 和第 6.2 节的预览段共用一个后台队列，但素材缓存排在所有预览段前面（它便宜，而且界面马上要用）：先当前工程时间线上用到的素材（播放头附近的先），再素材面板里其余素材。导入素材后、打开工程时、`project_changed` 带来新素材时入队，已 `ready` 的不重做。同时最多 2 个素材缓存任务。`preview_cache.auto` 为 false 时也做素材缓存（它不是预览段）；`pause_on_battery` 不暂停素材缓存。

**界面怎么用。** 波形整条取一次 `peaks.bin`，按缩放在界面里取每像素最大值，不随缩放重新请求。缩略图按片段宽度算要画的格子，每格取最接近时间的那张拼图格（CSS 背景定位）；只有当相邻两格会落在同一张缩略图上（放大到比 `interval` 还细）时才按需请求 `frames/`。缓存还没好时，波形处画一条细中线，缩略图处用素材主色（`/palette`）铺底，好了以后直接换上，不闪白。

**媒体通道。** `/media-cache/<素材键>/peaks.bin`、`/media-cache/<素材键>/thumbs.json`、`/media-cache/<素材键>/thumbs-<n>.jpg`、`/media-cache/<素材键>/frame?at=<规范时间>`，带令牌。文件还没生成时，`peaks.bin`、`thumbs.json` 返回 404，界面等推送再取；`frame` 按需生成并存进 `frames/`。原来的 `/peaks`、`/thumb` 保留一个版本，内部改为读素材缓存，下一版删除。

**缓存目录不可用时**（第 6.2 节），素材缓存退回旧位置 `<工程目录>/.zcut/<project_id>/cache/`，按旧办法按需生成，界面照常显示。旧位置的文件宿主不迁移、不删除。

**状态和推送。** `preview_cache_status` 的结果加 `media`：当前工程用到和导入的每个素材 `{media_id, key, peaks, thumbs}`，取值 `ready`、`building`、`missing`；`used_bytes` 含素材缓存。某个素材的波形或缩略图变成 `ready` 时，`preview_cache` 推送里带 `media_ready: [{media_id, key}]`，界面据此去取。

**清理。** `preview_cache_clear` 带 `project_id` 时只删这个工程的预览段，不删素材缓存（别的工程可能在用）；不带参数时连素材缓存一起清空。超过 `limit_gb` 时（第 6.3 节），先按原规则删预览段；预览段删完仍超上限，才按 `meta.json` 的 `last_used` 从旧到新删素材缓存，当前工程用到的素材最后删。设置里「预览与缓存」一页多显示一行「波形和缩略图」：素材数、已就绪数、占用大小。

## 7. 修订事件 `project_changed`

任何写入成功后（界面发的、Agent 通过 MCP 发的、会话草稿的、长任务子进程完成的），宿主推：

```json
{
  "type": "project_changed",
  "target": "main",
  "session_id": null,
  "revision": { "seq": 14, "id": "rev_…" },
  "verb": "edit",
  "label": "删掉开拍前的沟通",
  "reason": null,
  "author": { "kind": "agent", "name": "claude" },
  "batch": { "id": "bat_…", "seq": 2, "count": 5 },
  "summary": { "clip": { "added": 0, "removed": 2, "changed": 3 } },
  "changes": [ { "key": "clp_…", "entity": "clip", "before": { "track_id": "trk_v1", "start": "…", "end": "…" }, "after": null } ],
  "truncated": false
}
```

- `target`：`main` 或 `session`；是会话草稿时 `session_id` 有值。
- `summary`：按实体类型数增删改个数，完整。
- `changes`：前 50 条；片段只给轨道和序列起止，其他实体只给 `key` 和 `entity`。超过 50 条时 `truncated` 为 true。
- 一次请求连带执行了批次里的多步（`command-protocol.md` 6.1），每步推一条，按序号。
- 撤销、重做、回到某一步同样推，`verb` 照实写。

界面用它刷新历史、播过场；不需要过场的面板只当作「工程变了」。

## 8. 下一步建议

宿主给 Agent 的系统提示（`agents.ts` 的 `desktopInstructions`）里加一条约定：

> 每次回复的最后一行，如果你有把握用户下一句最可能说什么，写成 `【下一步】` 加一句话（不超过 30 个字，用用户的口吻）。没把握就不写。

宿主解析 Agent 的正文：

- 回复结束时，正文最后一个非空行以 `【下一步】` 开头的，从正文里去掉这一行，推 `chat_event`，事件 `{type: "suggestion", text}`，`text` 是后面的话（去掉首尾空白，空的不推）。
- 一行里有多个 `【下一步】` 时取最后一个后面的话。不在最后一行的 `【下一步】` 当普通正文。
- 两家 CLI 都按这个规则；流式输出时宿主先扣住可能是这一行的尾巴，回复结束再决定。

界面把它放进输入框当灰字：Tab 填入，回车发送，用户打字时消失，新的一轮开始时清掉。

## 9. 字幕识别设置

界面按设计画布「设置 · 字幕识别」五张画板做。决策见 ADR-0026。

### 9.1 模型

| `asr.model` | 名字 | 下载内容 | 约 |
|---|---|---|---|
| `1.7b` | 高精度 | `mlx-community/Qwen3-ASR-1.7B-8bit` 和 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | 3.8 GB |
| `0.6b` | 省内存 | `mlx-community/Qwen3-ASR-0.6B-8bit` 和 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | 2.3 GB |

放在 `~/.zsir-cut/models/<仓库名>/`，和 worker 现有的路径一样。内存大于 16 GB 时「高精度」带「这台电脑推荐」，否则「省内存」带。

**下载。** 用 Hugging Face 的 `api/models/<仓库>/tree/main` 列文件，从 `huggingface.co` 下载，连不上或出错时换 `hf-mirror.com`。文件先写 `<仓库名>.partial/`，能续传，每个文件校验大小，LFS 文件再校验 sha256，全部通过后改名。取消时保留已下的部分。环境变量里有 `HTTPS_PROXY` 时走代理。同时只下一个模型，另一个排队。对齐模型已经有了就不再下，进度只算要下的部分。

**删除。** 删这个模型的识别权重。对齐模型只有在另一个模型也没下时才删。

### 9.2 动词与推送

| 动词 | 请求 | 结果 |
|---|---|---|
| `asr_status` | 无 | `{supported, memory_bytes, recommended, models: [{id, bytes_total, bytes_done, state, error}], api_key_set}`。`state` 是 `missing`、`queued`、`downloading`、`ready`。`supported` 只有 macOS Apple Silicon 是 true。不返回 Key |
| `asr_key_set` | `{key}`，`null` 表示清除 | 无 |
| `asr_model_download`、`asr_model_cancel`、`asr_model_delete` | `{model}` | 无 |
| `asr_test` | `{mode}` | `{ok: true, audio_seconds, used_seconds, text}` 或 `{ok: false, code, reason}` |

`asr.mode` 和 `asr.model` 走现有的 `prefs_set`。下载进度推 `{type: "asr_model_progress", id, state, bytes_done, bytes_total, error}`，一秒最多一次。这些动词和 `prefs_set` 一样，只有界面客户端能调。

**Key。** macOS 存钥匙串，服务名 `zsir-cut.volc-asr`，账号 `default`。任何日志、结果信封、推送、错误信息里都不能出现 Key。

**测试。** `asr_test` 用 macOS 的 `say -v Tingting` 现生成一段语音（「今天我们来试一下字幕识别，看看能不能听清楚这句话。」），走和正式识别一样的路径。识别出非空文字算通过。`say` 用不了时返回不通过和原因。测试不写工程，也不进缓存。

`reason` 的文字：

| 情况 | 文字 |
|---|---|
| `45000010` | API Key 不对。检查后再测一次。 |
| `45000030` | 这个账号没有开通豆包语音识别极速版。开通后再测一次。 |
| 网络失败 | 连不上火山引擎。检查网络后再测一次。 |
| 模型读取失败或内存不够 | 模型没能运行。可以换「省内存」或 API 识别。 |

### 9.3 Windows

`supported` 为 false。设置页这一节只显示「这个版本的 Windows 版不能识别字幕」。字幕面板里开始识别的入口不可用，点不了。`transcribe` 动词返回 `E_INTERNAL`，`details.code` 是 `E_ASR_MODEL_UNAVAILABLE`（和其他识别错误的写法一样），`message` 写同一句话。

## 10. 网络代理

界面按设计画布「设置 · 通用 · 代理通过」「设置 · 通用 · 代理没通过」两张画板做（Bill 2026-11-10 定）。从 Finder 或远程打开的应用拿不到终端里的代理变量，Agent 连不上服务就会反复重连。

### 10.1 作用范围

有代理时（来源见下面的「用哪个地址」），下面这些联网都走它：

- Claude Code、Codex 的进程：AI 面板对话、字幕整理、版本检查。
- 一键安装和更新 Agent（npm），以及查新版（npm registry）。
- 下载本地识别模型。

不走代理：豆包语音识别；宿主和界面、Agent 和宿主之间的本机连接。

**用哪个地址。** 按顺序取第一个有的：

1. `network.proxy`。
2. 宿主启动环境里的 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`（按这个顺序）。
3. 系统代理（10.4）。
4. 都没有就直连。

**怎么传。** 给上面这些子进程设 `HTTPS_PROXY`、`HTTP_PROXY`（大小写两种都设）为这个地址，再设 `NODE_USE_ENV_PROXY=1`，同时设 `NO_PROXY=127.0.0.1,localhost,::1`（用启动环境的代理时，再并上启动环境原有的 `NO_PROXY`），保证 Agent 连宿主 MCP 不经过代理。宿主自己发的请求（npm registry 查新版、模型下载）用同一个地址。直连时不设这几个变量。

**生效时机。** 保存后，新启动的 Agent 进程和新开始的下载立即使用；正在运行的不打断。

### 10.2 格式

只接受 `http://主机:端口`，主机是域名或 IP，端口 1 到 65535，不带路径。去掉首尾空白后为空表示不用代理。格式不对时不保存，输入框下面显示「地址格式不对，例如 http://127.0.0.1:7890」。

### 10.3 测试连接

动词 `network_test`，请求 `{proxy}`（可以是还没保存的输入），只有界面客户端能调。分别对 `https://api.anthropic.com` 和 `https://api.openai.com` 发一次 HEAD 请求，各 8 秒超时，任何 HTTP 状态都算「能连上」。结果 `{results: [{id: "claude" | "codex", ok, ms, reason}]}`。`reason` 的文字：

| 情况 | 文字 |
|---|---|
| 连不上代理本身（拒绝连接） | 连不上代理 主机:端口。检查代理软件有没有打开，端口对不对。 |
| 超时 | 8 秒内没有响应。检查代理是否能访问外网。 |
| 其他 | 连不上。错误：原始错误的第一行 |

`proxy` 为空时按 10.1 的顺序取启动环境或系统代理来测，都没有才测直连，文字同上；直连时「连不上代理」那一条不会出现。结果另带 `source`：`setting`、`environment`、`system` 或 `none`，以及实际用的 `proxy`（直连为 null）。界面这一版不显示它们。

### 10.4 系统代理

宿主只读系统设置，不改任何系统、代理或网络配置。

- **Mac**：运行 `scutil --proxy`，2 秒超时。`ProxyAutoConfigEnable` 是 1（用 PAC）时不取。否则 `HTTPSEnable` 是 1 时取 `http://<HTTPSProxy>:<HTTPSPort>`，不然 `HTTPEnable` 是 1 时取 `http://<HTTPProxy>:<HTTPPort>`。只开了 SOCKS 不取。
- **Windows**：运行 `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"`，2 秒超时。`ProxyEnable` 是 `0x1` 时读 `ProxyServer`：形如 `主机:端口` 的直接加 `http://`；形如 `http=a:1;https=b:2` 的先取 `https=`，再取 `http=`。设了 `AutoConfigURL` 时不取。

取到的值要通过 10.2 的格式检查才用；命令失败、超时或格式不对都当作没有系统代理。每次要用代理时重新读，最多缓存 30 秒，用户切换系统代理后不用重开应用。

测试不调真命令：`scutil` 和 `reg` 的输出用 fixture，覆盖只开 HTTPS、只开 HTTP、PAC、只开 SOCKS、都没开、命令失败。
