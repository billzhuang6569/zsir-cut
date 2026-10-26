# 命令协议 v0.1

状态：草案 · 2026-10-26 · 依赖 `timeline-schema.md` v0.1 · 结果信封见 `schema/envelope.schema.json`
依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「Agent 控制剪辑的接口层」一节。

本文定义 Agent、CLI、MCP 和未来的桌面 UI 怎样读写工程。所有写入都走同一套动词和同一个内核，没有第二条写入路径。

## 1. 原则

1. **工程文件是唯一事实。** 聊天记录、Agent 的计划、UI 的内存状态都不是。
2. **内核保证硬约束。** 时间合法、ID 引用有效、批量要么全成要么全不成、批准过的字幕不被覆盖、字幕随剪辑映射，这些由内核检查，不靠提示词。Agent 只能提交命令。
3. **CLI 与 MCP 对等。** 同一个请求经 CLI 或 MCP 调用，得到同样的结果信封。用测试强制。
4. **每次写入可追溯、可撤销、可安全重试。**

## 2. 传输

**CLI**：`zcut <动词> <工程路径> --input <请求.json>`，也可以从标准输入读请求。标准输出永远是一个 JSON 结果信封，人读的日志只走标准错误。退出码：

| 退出码 | 状态 |
|---|---|
| 0 | `applied`、`dry_run`、`drafted`、`no_op`、`accepted` |
| 1 | `failed` |
| 2 | `rejected` |
| 3 | `conflict` |
| 4 | `committed_unverified` |

**MCP**：每个动词一个工具，名字是 `zcut_<动词>`。工具的输入 schema 就是请求，输出放在 `structuredContent`，内容就是结果信封。

**对等测试**：同一组请求分别经 CLI 和 MCP 执行，信封除了 `request_id` 和耗时字段，必须逐字节相同。

## 3. 请求公共字段

| 字段 | 读 | 写 | 说明 |
|---|---|---|---|
| `project` | 必填 | 必填 | 工程文件路径 |
| `base_revision` | — | 必填 | 调用方认为的当前修订 ID |
| `idempotency_key` | — | 必填 | 调用方生成，同一意图重试时不变 |
| `session_id` | — | 可选 | 写进编辑会话的草稿，而不是主工程 |
| `dry_run` | — | 可选 | 只演算，不写入。`export` 也接受它，只返回损失报告，不生成交接包 |
| `author` | 可选 | 必填 | `{kind, name}`，同 schema 里的 `revision.author` |

## 4. 结果信封

```json
{
  "ok": true,
  "status": "applied",
  "verb": "edit",
  "request_id": "req_0192a7f3",
  "receipt": {
    "before": "rev_41", "after": "rev_42",
    "idempotency_key": "agent-run-7-step-3", "replayed": false
  },
  "changes": [
    { "op": "remove_span", "entity": "clip", "id": "clp_v_2", "action": "trimmed" },
    { "op": "remove_span", "entity": "clip", "id": "clp_v_2b", "action": "created" }
  ],
  "verification": {
    "level": "L1", "passed": true,
    "issues": [{ "code": "W_SUB_UNPROJECTED", "severity": "warning", "message": "...", "ids": ["cue_3"] }]
  },
  "result": {},
  "error": null
}
```

`status` 取值：

| 状态 | 含义 | Agent 该做什么 |
|---|---|---|
| `applied` | 已写入主工程并通过校验 | 继续 |
| `drafted` | 已写入编辑会话的草稿 | 继续，最后提交审批 |
| `dry_run` | 只演算，`changes` 是预测结果 | 确认后去掉 `dry_run` 重发 |
| `no_op` | 请求合法，但没有任何改变 | 继续 |
| `accepted` | 长任务已入队，`result.job_id` 可查 | 用 `job_status` 查进度 |
| `rejected` | 请求不合法或违反硬约束，什么都没写 | 读 `error` 和 `issues`，改请求 |
| `conflict` | `base_revision` 不是当前修订 | 读最新状态，重新计算，用新的 `base_revision` 重发 |
| `failed` | 内部或 IO 错误，什么都没写 | 按 `error.retryable` 决定是否原样重试 |
| `committed_unverified` | 可能已经写入，但写后的校验或回读没有完成 | **不要直接重试。** 先 `inspect`，看 `receipt.after` 是否已是当前修订 |

`changes` 按实体列出变化，用来让 Agent 自检和给人审阅。`verification.issues` 用 `timeline-schema.md` 第 8 节的规则编号。读动词的 `receipt` 为 null。

## 5. 并发与幂等

**修订检查**：写入前，内核核对 `base_revision` 等于当前修订。不等就返回 `conflict`，`result` 里给出当前修订和这之后改动过的实体 ID。人在 UI 里改过工程以后，Agent 的旧计划必须重新计算，不能覆盖人的修改。

**幂等**：内核记录每个 `idempotency_key` 对应的请求摘要和回执。

- 同一个键、同样的请求：不重复执行，原样返回第一次的信封，`receipt.replayed` 为 true。
- 同一个键、不同的请求：返回 `rejected`，错误码 `E_IDEMPOTENCY_MISMATCH`。
- 键至少保留 7 天或最近 1000 条，取较多者。

这两条保证「重发同一个请求不会把同一段素材删两次」。

**单写者**：同一个工程同一时刻只有一个写入。内核用锁文件串行化写入，读不加锁。

**写入步骤**：加锁，核对修订，在内存里应用全部操作，L1 校验，写临时文件，fsync，原子替换工程文件，追加日志，释放锁。L1 出现错误就整个请求 `rejected`，不写任何东西。原子替换之后的步骤失败，返回 `committed_unverified`。下次打开工程时，内核发现工程修订不在日志里，会补写日志。

## 6. 修订、历史与撤销

每个成功的写请求产生一个新修订，`seq` 加一。工程旁边有一个附属目录 `.zcut/<工程 ID>/`：

```text
.zcut/<project_id>/
├─ lock
├─ journal.jsonl        每个修订一行：修订、父修订、作者、动词、操作、反向操作、时间
├─ idempotency.jsonl
├─ snapshots/           定期全量快照，加速回放
├─ sessions/<session_id>/
└─ jobs/<job_id>/
```

**撤销粒度**：一个修订就是一步撤销。一个编辑请求或一个批准的编辑会话产生一个修订，所以撤销粒度和「用户的一条指令」一致。

**撤销方式**：`undo` 不删历史，而是把目标修订的反向操作作为一个新修订应用。默认撤销最近一个修订，也可以用 `target` 指定。如果目标修订之后，别的修订改过同样的实体，返回 `rejected`，错误码 `E_UNDO_CONFLICT`。`redo` 同理。

**可追溯**：被删的内容永远能从日志里找到：它来自哪个修订、哪个 `occurrence_id`、谁删的。

## 7. 编辑会话：Agent 剪完，人审批

这是「Agent 剪、人接手」的交接点。

1. `session_begin`：传入 `approval`（`manual` 或 `auto`）和一句意图说明。内核以当前修订为基础建一份草稿，返回 `session_id`。
2. Agent 带着 `session_id` 发写请求，结果都是 `drafted`，只改草稿。草稿有自己的修订链，可以在会话内撤销。
3. `session_review`：会话进入待审状态，返回汇总：剪辑改动和字幕改动分开列出，附预览渲染的任务 ID 和校验结果。
4. 人在 UI 或 CLI 里预览，然后 `session_approve` 或 `session_reject`。`approval` 为 `auto` 时，`session_review` 之后自动批准。
5. 批准时，草稿里的全部操作作为一个修订原子地应用到主工程。如果会话开始后主工程变了，内核按操作重放到新修订上；重放冲突就返回 `conflict`，会话保持待审，等 Agent 修正。

不进会话的动词：`import_media`、`transcribe`、`render_preview`、`view_timeline`、`export`、`record_handoff_check`、`job_status` 和所有读动词。它们要么只追加数据，要么不改工程。

## 8. 授权边界

- **文字与剪辑分开。** `edit` 的操作分两个域：剪辑域和字幕域。一个请求里只能有一个域的操作，混用返回 `rejected`，错误码 `E_MIXED_DOMAIN`。「把字幕里的嗯改成呃」和「删掉音频里的语气词」必须是两个请求，一句自然语言不能悄悄变成剪辑。
- **批准过的不能被自动改。** 操作碰到 `state` 为 `approved` 的 token、`locked` 的字幕条时返回 `rejected`，错误码 `E_LOCKED`。加 `force: true` 可以越过，但只允许在 `manual` 审批的会话里使用，保证有人看过。
- **不删源文件。** 任何动词都不删除、移动或改写素材文件。

## 9. 动词

| 动词 | 类型 | 作用 |
|---|---|---|
| `inspect` | 读 | 按视图读工程：`brief`、`timeline`、`entity`、`history` |
| `read_transcript` | 读 | 读打包后的转写文本，可按时间线投影 |
| `validate` | 读 | 跑 L1 校验，`media: true` 时加跑 L2 |
| `diff` | 读 | 比较两个修订，输出实体级差异 |
| `import_media` | 写 | 探测素材、计算指纹，加入 `media[]`；`relink` 模式为离线素材找回文件，见 9.2 |
| `edit` | 写 | 应用一组有序操作，见第 10 节 |
| `undo` / `redo` | 写 | 见第 6 节 |
| `transcribe` | 写，长任务 | 跑识别和对齐，写入母稿第 1、3 层，并生成初始的第 2、4 层 |
| `session_begin` / `session_review` / `session_approve` / `session_reject` | 会话 | 见第 7 节 |
| `render_preview` | 长任务 | 渲染一段代理预览，不改工程 |
| `view_timeline` | 长任务 | 在每个剪点出胶片条 PNG 和波形，供 Agent 视觉自检 |
| `export` | 长任务 | 按交接 profile 生成交接包，见 `handoff-profile.md`。带 `dry_run` 时只返回损失报告；报告有 `error` 级记录时，除非带 `accept_losses: true`，否则返回 `rejected` |
| `record_handoff_check` | 写交接包 | 把 `host_import` 或 `host_render_comparison` 的检查结果写进交接包的 `manifest.json`，不改工程 |
| `job_status` | 读 | 查长任务进度与结果 |

共 18 个。新增动词要先改本文。

### 9.1 给 Agent 的读视图

- `inspect` 的 `brief` 视图是新 Agent 会话的上下文包：工程概况、素材目录、时间线摘要、母稿覆盖情况、未处理的 `review` 标记、最近几个修订。完整数据再按 ID 查，不把几小时的转写塞进上下文。
- 读视图里的每个时间同时给出规范形式和显示时码，例如 `{"t": "1001/200s", "tc": "01:00:05;00"}`。工程文件里只存规范形式。
- `read_transcript` 输出打包文本，每行一条字幕，形如 `[cue_1 tok_01..tok_06] 01:00:00;00 我们做zsir-cut的初衷很简单`。一小时素材约 12 KB。Agent 按 token ID 发剪辑命令，不按时间猜。

### 9.2 重链接

素材移盘或改名后，用 `import_media` 的 `relink` 模式找回，而不是重新导入。

请求：`relink: { search_roots: [目录…], media_ids: [可选，默认全部离线素材] }`，加上写请求的公共字段。

规则：

1. 只处理离线素材，也就是 L2 校验报 `E_MEDIA_MISSING` 或 `E_MEDIA_MISMATCH` 的。
2. 在 `search_roots` 下递归查找。先按 `size_bytes` 筛候选，再算 `sampled-sha256-v1` 指纹，两者都一致才算找到。**绝不按文件名匹配**，同名不同内容的文件不能被认成同一个。
3. 找到多个内容完全相同的副本时，取路径按字节排序的第一个，并在结果里注明其余候选。
4. 只改 `media[].path`，`original_path` 和 `media_id` 不变，所以所有引用这个素材的片段和字幕都不受影响。
5. 一个都没找回时返回 `no_op`。

`result` 包含三个数组：`relinked`（素材 ID、旧路径、新路径、其余候选）、`not_found`（素材 ID）、`skipped`（不是离线状态而跳过的素材 ID）。

## 10. `edit` 的操作

一个 `edit` 请求带一个有序的 `ops` 数组，整体原子执行。创建实体的操作可以由调用方指定新 ID，这样同一请求里后面的操作能引用它；不指定就由内核生成，并在 `changes` 里返回。

**剪辑域**

| 操作 | 主要参数 | 说明 |
|---|---|---|
| `place` | `media_id`、`source_start`、`duration`、`at`、`video_track`、`audio_track`、`mode` | 把一段素材放上时间线，新建一个 `occurrence_id` 和对应的视音频片段。`mode` 取 `insert` 或 `overwrite` |
| `remove` | `clip_ids`、`ripple` | 删片段。`ripple` 为 true 时后面的片段前移 |
| `remove_span` | `range` 或 `tokens`、`tracks`、`ripple`、`snap` | 删一段序列区间。可以用 token 范围指定，内核按投影换算成序列时间。`tracks` 默认全部轨道，保持同步。`snap` 取 `out`、`in`、`nearest`，默认 `out`，保证说过的字被完整删掉 |
| `trim` | `clip_id`、`edge`、`to`、`ripple`、`linked` | 改入点或出点。`linked` 为 true 时同一次使用的视音频一起改；J/L cut 就是只改其中一个 |
| `split` | `clip_id`、`at`、`new_id` | 在序列时刻切开，后半段拿新 ID |
| `move` | `clip_ids`、`to`、`track_id` | 移动片段 |
| `set_clip` | `clip_id`、`gain_db`、`enabled`、`transform`、`time_map`、`label`、`sync_broken` | 改片段属性 |
| `add_transition` / `remove_transition` | | |
| `add_marker` / `update_marker` / `remove_marker` | | |
| `add_track` / `remove_track` | | 只能删空轨道 |

**字幕域**

| 操作 | 主要参数 | 说明 |
|---|---|---|
| `edit_text` | `transcript_id`、`from_token`、`to_token`、`text` | 用新文字替换一段 token。新 token 继承原 token 的 `heard`，`state` 变为 `edited`，然后对这段重新对齐 |
| `hide_tokens` | `transcript_id`、`tokens` | 把 `text` 设为空，保留 `heard` |
| `set_token_state` | `transcript_id`、`tokens`、`state` | 例如批准一段字幕 |
| `resegment` | `transcript_id`、`range`、`rules` | 按断句规则重新生成字幕条，跳过 `locked` 的条 |
| `set_cue` / `split_cue` / `merge_cues` | | 改换行、时间覆盖、样式、状态 |
| `set_override` / `remove_override` | `track_id`、`occurrence_id`、`cue_id` | 序列层面的例外 |
| `add_free_cue` / `remove_free_cue` | | |
| `add_style` / `update_style` | | 样式改动时 `version` 加一 |

每个操作的完整参数 schema 在第 1 步由实现补进 `schema/command.schema.json`，补的时候以本文为准，有出入先改本文。

## 11. 错误码

| 错误码 | 状态 | 含义 |
|---|---|---|
| `E_CONFLICT` | `conflict` | 修订不匹配 |
| `E_IDEMPOTENCY_MISMATCH` | `rejected` | 同一幂等键对应了不同请求 |
| `E_VALIDATION` | `rejected` | 应用后 L1 校验有错误，`issues` 里列出 |
| `E_NOT_FOUND` | `rejected` | 引用的 ID 不存在 |
| `E_MIXED_DOMAIN` | `rejected` | 一个请求混用剪辑域和字幕域 |
| `E_LOCKED` | `rejected` | 想改批准过的 token 或锁定的字幕条 |
| `E_UNDO_CONFLICT` | `rejected` | 撤销目标之后有修订改过同样的实体 |
| `E_SESSION_STATE` | `rejected` | 会话状态不允许这个动作，例如批准一个未提交审阅的会话 |
| `E_UNSUPPORTED` | `rejected` | 请求了一期不支持的能力 |
| `E_IO` | `failed` | 读写文件失败，`retryable` 说明能否重试 |
| `E_INTERNAL` | `failed` | 内核错误 |

## 12. 一期不做

- 多人实时协作和合并。一期只有单写者加修订检查。
- 轨道锁定。需要时在 schema 里加字段，再加错误码。
- 外部 NLE 的实时桥接和回读。一期只做 `export`，回读属于第二期。
