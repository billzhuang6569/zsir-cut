# 桌面版宿主 v0.1

状态：草案 · 2026-11-06 · 依赖 ADR-0016（桌面版架构）、ADR-0023（预览缓存）、`command-protocol.md`、`docs/tasks/ui-3.md`

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
| `preview_cache_status` / `preview_cache_clear` / `preview_cache_move` | 动词 | 6 |
| `preview_cache` | 推送 | 6 |
| `project_changed` | 推送（改为带内容） | 7 |
| `chat_event` 的 `suggestion` 类型 | 推送 | 8 |

这些动词只在本机通道上有，宿主的 MCP 不暴露它们：Agent 不能改用户的偏好、不能自己答许可。

## 2. 应用级偏好 `desktop.json`

放在 `~/Library/Application Support/zsir-cut/desktop.json`，和 `recent.json` 同目录，跟随 `HOME`。内核的 `settings.json`（`voice.md` 1.1）是另一个文件，宿主不写它，两个文件各有一个写入者。

写入：zod 校验，写临时文件再改名，键按字母序序列化。文件不存在时用默认值；文件损坏或校验不过时用默认值，给界面推一条 `{type: "warning", code: "W_PREFS_RESET", message}`，并把坏文件改名为 `desktop.json.broken`，不崩。

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
    "pause_on_battery": true
  },
  "ui": {
    "snap": true,
    "magnetic": true,
    "timeline_zoom": null,
    "track_height": "m",
    "chapters": { "view": "outline", "zoom": 1, "folded": [] }
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
| `preview_cache.pause_on_battery` | 用电池时暂停生成 |
| `ui.snap` | 吸附开关，时间线和章节时间轴共用 |
| `ui.magnetic` | 磁性开关，见第 3.2 节 |
| `ui.timeline_zoom` | 每秒多少像素，null 表示缩放到整条 |
| `ui.track_height` | `s`、`m`、`l` |
| `ui.chapters.view` | `outline` 或 `timeline` |
| `ui.chapters.zoom` | 章节时间轴的上下缩放，0.5 到 4 |
| `ui.chapters.folded` | 大纲里折叠起来的一级章节的标记 ID |

`prefs_get`：无参数，`result.prefs` 是整个对象（`directory` 展开后的路径另给 `result.preview_cache_directory`）。`prefs_set`：`patch`，按字段深合并，数组整体替换；写入后返回 `applied` 和新的整个对象，内容不变返回 `no_op`；校验不过返回 `rejected`、`E_VALIDATION`，文件不变。

## 3. 快捷键

动作表放在 `packages/app-host/src/keymap.ts`，导出两套默认和合并函数；界面通过 `prefs_get` 拿到合并后的表（`result.keymap`：动作名到键），不自己存一份。

键的写法：修饰键按 `⌃⌥⇧⌘` 的顺序在前，后面是一个键名：字母大写、数字、`=` `-` `\` `,` `.` `[` `]`、`Space`、`Delete`（⌫）、`ForwardDelete`、`Left` `Right` `Up` `Down`。例如 `⇧⌘K`、`⌥Delete`、`Space`。

### 3.1 动作与两套默认

「◇」是本应用补的键，两家没有对应的默认。合并后同一个键绑了两个动作时，`overrides` 里的那个生效，另一个变为不绑键，`prefs_set` 的结果里 `result.unbound` 列出被挤掉的动作。

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
| 拖剪点、`nudge_edit_*`（选中剪点时）、`extend_edit` | `roll` | `roll` |
| `split_at_playhead` | `split` | `split` |
| `split_all_at_playhead` | 一个 `edit` 里，对所有轨道上横跨播放头的每个片段各一个 `split`，`linked: false` | 同左 |

剪点：两个片段相接处。选中剪点时界面记 `{track_id, at}`（`command-protocol.md` 9.6 的 `ui_state.edit_point`），`roll` 的 `clip_id` 取剪点左边的片段、`edge: "out"`。

## 4. Agent 管理

### 4.1 找程序和版本

依次在 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/.claude/local` 里找 `claude` 和 `codex`，第一个可执行的就是它。用 `--version` 取版本，3 秒超时。启动 Agent 时用找到的绝对路径，不再靠 `PATH`。

不查也不显示登录状态（Bill 2026-11-06）。没登录时 Agent 的第一次回复会说明，界面照常显示。

### 4.2 新版检查

查 npm registry 的 `@anthropic-ai/claude-code` 和 `@openai/codex` 的 `latest`。请求走 `HTTPS_PROXY` 环境变量（没有就直连），3 秒超时，失败不报错，只是没有新版信息。结果缓存在内存 24 小时。

### 4.3 动词与推送

| 动词 | 参数 | 结果 |
|---|---|---|
| `agents_list` | `refresh`（可选，true 时重新探测并重查新版） | `result.agents`：每项 `id`（`claude`、`codex`）、`name`（「Claude Code」「Codex」）、`found`、`path`、`version`、`latest`（查不到为 null）、`update_available`、`default`（布尔）；`result.npm`：找到的 npm 路径或 null |
| `agents_install` | `id` | 用 `npm install -g <包名>` 安装，立即返回 `accepted` 和 `result.job_id`；没有 npm 时返回 `rejected`、`E_UNSUPPORTED`，`details.manual` 是一段手动安装说明 |
| `agents_update` | `id` | 同上，命令相同 |
| `agents_set_default` | `id` | 写 `desktop.json` 的 `default_agent`，返回 `applied`；对话面板之后默认用它 |

安装和更新期间每一行输出推 `{type: "agents_output", job_id, line, stream: "stdout" | "stderr"}`；结束推 `{type: "agents_output", job_id, done: true, ok}`，再推一次 `agents_changed`（内容同 `agents_list` 的结果）。同一时刻只跑一个安装任务，第二个返回 `failed`、`E_IO`、`retryable: true`。

测试不联网：npm、`claude`、`codex` 都用假命令，registry 用假地址。

## 5. 许可闸

Agent 通过宿主的 MCP 调用会碰到工程外面的动词时，宿主先停下来问用户（F9）。CLI 和内核自己的 MCP 不经过闸：许可是桌面版里「人在旁边看着」的约定，不是权限系统。

### 5.1 要问的动词

| 动词 | 原因 |
|---|---|
| `export`（不带 `dry_run`） | 往工程目录以外写文件 |
| `record_handoff_check` | 写交接包 |
| `voice_generate`、`voice_clone` | 花钱 |
| `transcribe`（工程的识别设置用云端引擎时） | 把声音传到外面 |
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
- 键：`sha256(素材指纹 + "|" + 源入点 + "|" + 源出点 + "|" + 速度 + "|" + 画质 + "|" + "v1")` 的前 32 个十六进制字符。源入点、源出点用规范时间字符串；速度无时间映射为 `"1"`，有时间映射为映射的规范 JSON。
- 文件：`<缓存目录>/<project_id>/<键>.mp4`，写临时文件再改名。
- 编码：`ffmpeg -ss <源入点> -t <时长> -i <素材>`，视频 `h264_videotoolbox`（没有时 `libx264 -preset veryfast`），短边按画质（540、720、1080），关键帧间隔 0.5 秒（`-g` 按素材帧率算），声音 AAC 48 kHz 单声道，`-movflags +frag_keyframe+empty_moov+default_base_moof`，`-map_metadata -1 -fflags +bitexact`，不写时间戳。变速和倒放按片段的映射生成，画面和预览看到的一致。
- 索引：`<缓存目录>/<project_id>/index.json`：`{project_path, last_opened, segments: {键: {bytes}}}`。

### 6.2 队列

- 打开工程且 `auto` 为 true 时开始；工程变了（`project_changed`）后重新算需要哪些键，已有的不重做。
- 顺序：播放头所在片段，然后往后，然后往前。同时只编码一段。
- `pause_on_battery` 为 true 且在用电池时暂停（用 `pmset -g batt` 判断，查不到按插电处理）。
- 缓存目录不存在或写不进去时不报错：所有段按 `missing`，队列停下，状态里 `directory_ok: false`。

### 6.3 上限与清理

写入后总量超过 `limit_gb` 时，按 `last_opened` 从旧到新整个工程删掉，直到降到上限以下；当前打开的工程最后删，删到它时按段的最近使用时间删。

### 6.4 动词与推送

| 动词 | 参数 | 结果 |
|---|---|---|
| `preview_cache_status` | 无 | 当前工程每个视频片段的 `{clip_id, key, state}`（`ready`、`building`、`missing`），`directory`、`directory_ok`、`free_bytes`、`used_bytes`、`limit_bytes`，以及 `projects`：每个工程的 `project_id`、`name`、`path`、`bytes`、`last_opened` |
| `preview_cache_clear` | `project_id`（可选，没给时全部清空） | 删文件，返回 `applied` |
| `preview_cache_move` | `directory` | 改 `desktop.json` 的目录；旧目录的文件不搬，返回 `applied` |

状态变化时推 `{type: "preview_cache", ...}`，内容同 `preview_cache_status` 的结果，最多每 500 毫秒一次。

媒体通道按键提供分段：`/cache/<project_id>/<键>.mp4`，带 ADR-0016 的令牌，支持 Range。

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
