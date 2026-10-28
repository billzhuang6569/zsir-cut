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

**CLI**：`zcut <动词> <工程路径> --input <请求.json>`，也可以从标准输入读请求。标准输出永远是一个 JSON 结果信封，人读的日志只走标准错误。

- 没有写工程路径时，用请求里的 `project` 字段；两处都有且不同，返回 `rejected`、`E_VALIDATION`，`message` 写明两个路径。两处都没有时同样返回 `E_VALIDATION`，`message` 写「缺少工程路径」。请求文件读不了或不是 JSON 对象时返回 `E_VALIDATION`，`message` 写明原因，不能把请求当成空对象继续校验。
- `record_handoff_check` 不需要工程路径；`create_project` 的工程路径是要新建的文件。
- 请求里的时间和帧率可以写非最简分数，内核读入时约分，见 `edit-ops.md` 第 1 节第 2 条。结果信封里一律是规范形式。

退出码：

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
| `dry_run` | 只演算，`changes` 是预测结果。不写文件、不写日志、不记幂等，所以正式提交可以沿用同一个幂等键 | 确认后去掉 `dry_run` 重发 |
| `no_op` | 请求合法，但没有任何改变 | 继续 |
| `accepted` | 长任务已入队，`result.job_id` 可查 | 用 `job_status` 查进度 |
| `rejected` | 请求不合法或违反硬约束，什么都没写 | 读 `error` 和 `issues`，改请求 |
| `conflict` | `base_revision` 不是当前修订 | 读最新状态，重新计算，用新的 `base_revision` 重发 |
| `failed` | 内部或 IO 错误，什么都没写 | 按 `error.retryable` 决定是否原样重试 |
| `committed_unverified` | 可能已经写入，但写后的校验或回读没有完成 | **不要直接重试。** 先 `inspect`，看 `receipt.after` 是否已是当前修订 |

`changes` 按实体列出变化，用来让 Agent 自检和给人审阅。`verification.issues` 用 `timeline-schema.md` 第 8 节的规则编号。

读动词（`inspect`、`read_transcript`、`validate`、`diff`、`job_status`）成功时 `status` 为 `no_op`，`ok` 为 true，`receipt` 为 null，`changes` 为空，结果放在 `result` 里。`validate` 发现问题不算失败：问题列在 `verification.issues` 里，`verification.passed` 在没有错误级问题时为 true。

`request_id` 由内核生成，格式是 `req_` 加小写 UUIDv7。

## 5. 并发与幂等

**修订检查**：写入前，内核核对 `base_revision` 等于当前修订。不等就返回 `conflict`，`result` 里给出当前修订和这之后改动过的实体 ID。人在 UI 里改过工程以后，Agent 的旧计划必须重新计算，不能覆盖人的修改。

**幂等**：内核记录每个 `idempotency_key` 对应的请求摘要和回执。

- 同一个键、同样的请求：不重复执行，原样返回第一次的信封，`receipt.replayed` 为 true。
- 同一个键、不同的请求：返回 `rejected`，错误码 `E_IDEMPOTENCY_MISMATCH`。
- 键至少保留 7 天或最近 1000 条，取较多者。

这两条保证「重发同一个请求不会把同一段素材删两次」。

**单写者**：同一个工程同一时刻只有一个写入。读不加锁。

- 锁文件是 `.zcut/<project_id>/lock`，用「文件不存在才创建」的方式获取，内容是 JSON：`pid`、`hostname`、`acquired_at`、`request_id`。
- 锁已存在时，等待最多 10 秒，每 100 毫秒重试一次。仍拿不到就返回 `failed`，错误码 `E_IO`，`retryable` 为 true，`details.reason` 为 `busy`。
- 锁的主人进程已不存在，判断条件是同一主机且该 `pid` 不存在，就视为过期，删除后重新获取，并在 `.zcut/<project_id>/lock-events.jsonl` 里记一条：时间、被接管的锁内容、接管者。锁事件不是修订，不进 `journal.jsonl`。不同主机的锁不判断过期，按占用处理。

**写入步骤**：

1. 获取锁。
2. 读工程文件，执行崩溃恢复检查（见下文）。
3. 查幂等记录，命中则释放锁并原样返回第一次的信封，`receipt.replayed` 为 true；同键不同请求返回 `rejected`、`E_IDEMPOTENCY_MISMATCH`。幂等必须在修订检查之前，否则一个已成功的请求重发时会因为修订已经前进而被当成冲突。
4. 核对 `base_revision`，不等则释放锁并返回 `conflict`。
5. 在内存里应用全部操作，做 L1 校验。有错误就释放锁并返回 `rejected`，错误码 `E_VALIDATION`。
6. 生成新修订：`seq` 加一，`id` 用新的 `rev_` ID，`parent` 是旧修订 ID，`created_at` 是当前时间，`author` 取自请求。
7. 按规范序列化写到同目录的临时文件，fsync 文件，原子替换工程文件，fsync 目录。
8. 追加日志条目，fsync 日志。追加幂等记录。
9. 释放锁，返回 `applied`。

第 7 步之前失败，工程文件不变，返回 `failed`。第 7 步完成之后、第 8 步完成之前失败，返回 `committed_unverified`，`receipt.after` 是新修订 ID。

日志和幂等记录是两个文件，第 8 步中间断掉时，可能有日志条目而没有幂等记录。这时同一请求重发查不到幂等记录，会走到第 4 步，因修订已经前进而返回 `conflict`，不会被重复执行。Agent 收到 `conflict` 后按规定重新读取工程。

**崩溃恢复**：每次加锁后读工程文件时，比较工程里的修订 ID 和日志最后一条。工程修订比日志新，说明上次在第 7、8 步之间中断。此时补写一条 `kind` 为 `recovered` 的日志条目，记录修订 ID、父修订和时间，不含实体快照；这个修订不能撤销。

## 6. 修订、历史与撤销

每个成功的写请求产生一个新修订，`seq` 加一。工程旁边有一个附属目录 `.zcut/<工程 ID>/`：

```text
.zcut/<project_id>/
├─ lock
├─ journal.jsonl        每个修订一行
├─ idempotency.jsonl    每个写请求一行
├─ snapshots/           定期全量快照，加速回放
├─ sessions/<session_id>/
└─ jobs/<job_id>/
```

**日志条目**（`journal.jsonl` 的一行）：

| 字段 | 说明 |
|---|---|
| `kind` | `write`、`undo`、`redo`、`recovered` |
| `revision` / `parent` / `seq` | 修订 ID、父修订 ID、序号 |
| `at` / `author` | 时间、作者 |
| `verb` / `request_id` / `idempotency_key` | 产生它的请求 |
| `ops` | 请求里的操作原文，用于审计和编辑会话重放 |
| `changes` | 实体级快照：每个改动的实体一条，含 `key`、`entity`、`before`、`after`、`before_parent`、`after_parent`、`before_index`、`after_index` |
| `target` | `undo`、`redo` 条目指向的修订 |

**实体与键**：

| 实体 | 键 | 快照内容 |
|---|---|---|
| 工程头 | `project` | 除 `revision`、`media`、`timelines`、`transcripts`、`subtitle_styles` 外的字段 |
| 媒体、片段、转场、标记、字幕条、字词、识别运行、样式、独立字幕条 | 它们自己的 ID | 整个对象 |
| 时间线 | 时间线 ID | 除 `tracks`、`markers` 外的字段 |
| 轨道 | 轨道 ID | 除 `clips`、`transitions`、`overrides`、`free_cues` 外的字段，加上它在 `tracks` 里的序号 |
| 母稿 | 母稿 ID | 除 `raw_runs`、`tokens`、`cues` 外的字段 |
| 覆盖值 | `override:<轨道ID>:<occurrence_id>:<cue_id>` | 整个对象 |

`before` 为 null 表示新建，`after` 为 null 表示删除。`*_parent` 是实体所在的上级：媒体、时间线、母稿、样式的上级是 `project`；轨道和标记是时间线 ID；片段、转场、覆盖值、独立字幕条是轨道 ID；识别运行、字词、字幕条是母稿 ID。

`*_index` 是实体在上级数组里的下标，只对不按规则排序的数组记录：`media`、`timelines`、`tracks`、`transitions`、`transcripts`、`raw_runs`、`cues`、`subtitle_styles`、`overrides`、`free_cues`。`clips`、`tokens`、`markers` 由规范序列化排序，下标记为 null。撤销恢复被删实体时插回 `before_index` 的位置，这样撤销后的工程文件与修订前逐字节相同，只有 `revision` 不同。

**撤销粒度**：一个修订就是一步撤销。一个编辑请求或一个批准的编辑会话产生一个修订，所以撤销粒度和「用户的一条指令」一致。

**撤销方式**：`undo` 不删历史。它取目标修订的 `changes`，逐个实体核对：当前内容必须等于该修订的 `after`。全部一致，就把每个实体恢复成 `before`，作为一个新修订写入，`kind` 为 `undo`。任何一个不一致，说明之后有别的修订改过它，返回 `rejected`，错误码 `E_UNDO_CONFLICT`，`details` 列出冲突的实体键。默认撤销最近一个未被撤销的 `write` 修订，也可以用 `target` 指定。`redo` 反过来：核对当前等于 `before`，恢复成 `after`。`recovered` 修订不能撤销。

**幂等记录**（`idempotency.jsonl` 的一行）：`idempotency_key`、`request_hash`（去掉 `request_id` 后按规范 JSON 计算的 SHA-256）、`at`、完整的结果信封。至少保留 7 天或最近 1000 条，取较多者，清理在写入时顺带进行。

**可追溯**：被删的内容永远能从日志里找到：它来自哪个修订、哪个 `occurrence_id`、谁删的。

## 7. 编辑会话：Agent 剪完，人审批

这是「Agent 剪、人接手」的交接点。

### 7.1 流程

1. `session_begin`：参数 `approval`（`manual` 或 `auto`）、`intent`（一句话说明这次要做什么），加上写请求的公共字段，`base_revision` 是主工程的当前修订，幂等键防止重发时开出两个会话。内核以这个修订为基础建一份草稿，不改主工程，返回 `no_op`，`result` 含 `session_id`、`base_revision`、`state`。
2. Agent 带着 `session_id` 发 `edit`、`undo`、`redo`，结果都是 `drafted`，只改草稿。草稿有自己的修订链和日志，可以在会话内撤销。`base_revision` 和幂等键都对草稿检查。
3. `session_review`：带写请求的公共字段，`base_revision` 是**草稿**的当前修订。会话进入待审状态，返回审阅汇总（见 7.3）。`approval` 为 `auto` 时，紧接着自动执行批准，批准的结果信封放在 `result.approval` 里。
4. 人在 UI 或 CLI 里看过之后，`session_approve` 或 `session_reject`。这两个动词带写请求的公共字段，`base_revision` 是**主工程**的当前修订。
5. 批准：见 7.4。拒绝：会话变为 `rejected`，主工程不变，草稿保留供查阅。

### 7.2 存储与状态

```text
.zcut/<project_id>/sessions/<session_id>/
├─ session.json        会话元数据：状态、approval、intent、作者、base_revision、创建与更新时间
├─ draft.zcut.json     草稿工程，格式与主工程相同
└─ .zcut/…             草稿自己的锁、日志、幂等记录，规则同第 5、6 节
```

| 状态 | 可以做的 | 进入下一个状态 |
|---|---|---|
| `open` | `edit`、`undo`、`redo`、`session_review`、`session_reject` | `session_review` → `in_review` |
| `in_review` | `session_approve`、`session_reject`；也可以继续 `edit`，会话回到 `open` | 批准 → `approved`；拒绝 → `rejected` |
| `approved`、`rejected` | 只读 | 终态 |

在不允许的状态下调用动词，返回 `rejected`、`E_SESSION_STATE`。

### 7.3 审阅汇总

`session_review` 的 `result`：

- `base_revision`、`draft_revision`。
- `timeline_changes` 和 `subtitle_changes`：从会话基础到草稿当前状态的实体级差异，分开列出。剪辑域包括媒体、时间线、轨道、片段、转场、标记；字幕域包括母稿、识别运行、字词、字幕条、覆盖值、独立字幕条、样式，以及字幕轨。
- `ops`：草稿日志里全部写入的操作原文，按顺序。
- `verification`：对草稿做 L1 校验的结果。
- `preview_job`：对草稿当前修订自动启动的 `render_preview` 任务 ID，输出到 `.zcut/<project_id>/sessions/<session_id>/preview/`。审阅的人可以直接看这段预览。

### 7.4 批准与合并

1. 主工程当前修订等于会话的 `base_revision`：把草稿当前内容作为一个新修订写入主工程，日志条目的 `verb` 为 `session_approve`，`ops` 是草稿的全部操作，`changes` 是会话基础到草稿的实体差异。
2. 主工程已经前进：把草稿日志里的写入按顺序重放到主工程当前内容上（会话内被撤销的不重放），每个操作都按当时的请求参数执行。全部成功，就把结果作为一个新修订写入。任何一个失败，或结果 L1 校验有错误，返回 `conflict`，`result` 列出失败的操作和原因；会话保持 `in_review`，主工程不变，Agent 可以继续编辑草稿后再提交审阅。
3. 批准后的修订是一步撤销，撤销它就撤销整个会话。草稿相对主工程没有净改动时，批准不产生修订，返回 `no_op`，会话照常变为 `approved`。
4. 带 `force` 的字幕域操作只在 `approval` 为 `manual` 的会话里有效，规则见第 8 节。

不进会话的写动词：`create_project`、`import_media`、`transcribe`、`export`、`record_handoff_check`。带 `session_id` 调用它们返回 `rejected`、`E_SESSION_STATE`。

读动词（`inspect`、`read_transcript`、`validate`、`diff`）和 `render_preview`、`view_timeline` 可以带 `session_id`：这时读的、渲染的是该会话的草稿，而不是主工程。Agent 在会话里剪完后，要能自己读剪辑表、出胶片条和预览来自查。`job_status` 不受影响。

草稿里素材的相对路径一律按**主工程文件所在目录**解析，不按草稿文件所在目录。草稿存放在 `.zcut/` 深处，按草稿位置解析会找不到素材（2026-10-28 真实项目实测）。

### 7.5 修订对比 `diff`

参数 `from`、`to`（修订 ID，`to` 默认当前修订）。结果是两个修订之间的实体级差异，格式与日志的 `changes` 相同。计算方法：从当前工程出发，按日志倒序把每个修订的 `before` 快照还原回去，得到任意历史修订的内容，再比较。`recovered` 修订没有快照，跨越它的对比返回 `rejected`、`E_UNSUPPORTED`。

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
| `import_media` | 写 | 探测素材、计算指纹，加入 `media[]`；`relink` 模式为离线素材找回文件，见 9.2、9.3 |
| `edit` | 写 | 应用一组有序操作，见第 10 节 |
| `undo` / `redo` | 写 | 见第 6 节 |
| `transcribe` | 写，长任务 | 跑识别和对齐，写入母稿第 1、3 层，并生成初始的第 2、4 层 |
| `session_begin` / `session_review` / `session_approve` / `session_reject` | 会话 | 见第 7 节 |
| `render_preview` | 长任务 | 渲染整条时间线的代理预览，不改工程。参数：`timeline_id`（必填）、`output`（输出文件夹，必填）。一期只渲染整条时间线，不渲染转场混合和画面变换 |
| `view_timeline` | 长任务 | 在每个剪点出胶片条 PNG 和波形，供 Agent 视觉自检。参数：`timeline_id`（必填）、`output`（输出文件夹，必填） |
| `export` | 长任务 | 按交接 profile 生成交接包，见 `handoff-profile.md`。带 `dry_run` 时只返回损失报告；报告有 `error` 级记录时，除非带 `accept_losses: true`，否则返回 `rejected` |
| `create_project` | 写 | 新建工程文件和一条空时间线，见 9.4 |
| `record_handoff_check` | 写交接包 | 把 `host_import` 或 `host_render_comparison` 的检查结果写进交接包的 `manifest.json`，不改工程。参数：`package`（交接包目录）、`check`（两者之一）、`status`、`host_version`、`by`、`notes`、`items`（逐项的 `check`、`status`、`notes`）。不需要 `base_revision`，不写工程日志；同一项检查再次记录时整体覆盖，所以天然幂等 |
| `job_status` | 读 | 查长任务进度与结果 |

共 19 个。新增动词要先改本文。

### 9.1 给 Agent 的读视图

读视图里的每个时间都写成 `{"t": 规范形式, "tc": 显示时码}`。序列时间的时码按时间线的起始时码和帧率换算；源时间的时码按素材的起始时码和帧率换算；素材没有时码时只写 `t`。工程文件里只存规范形式。

**`inspect` 的 `view` 参数：**

| 视图 | 内容 |
|---|---|
| `brief` | 新 Agent 会话的上下文包，见下文。无论工程多大，信封不超过 16 KB |
| `timeline` | 一条时间线的完整剪辑表。可选 `timeline_id`，可选 `range`（`start`、`duration`）只列与它相交的内容 |
| `entity` | 按 `id` 返回一个实体的原始 JSON，以及它的上级 ID |
| `history` | 日志条目，按修订序号倒序，可选 `limit`（默认 20，最大 200）和 `before`（从这个修订之前开始） |

**`brief` 的字段：**

- `project`：ID、名称、版本、当前修订的序号和 ID。
- `media`：每个素材的 ID、名称、类型、时长；最多 50 条，超出时 `media_truncated` 为 true。不跑 L2，不报在线状态。
- `timelines`：每条时间线的 ID、名称、帧率、是否丢帧、起始时码、总长；每条轨道的 ID、类型、名称、启用状态、片段数；`review` 类标记最多 50 条。
- `transcripts`：每份母稿的 ID、素材 ID、语言、字词数、字幕条数、各状态的字词数，以及字词覆盖的源时间范围。
- `recent_revisions`：最近 5 个日志条目的序号、修订 ID、作者、动词、时间、操作个数。
- `sessions`：未结束的编辑会话的 ID、状态、approval、intent。
- `issues`：L1 校验的问题编号和个数，不列明细。

**`timeline` 视图的片段字段**：`id`、`occurrence_id`、`media_id`、`label`、`enabled`、序列入点和出点、源入点和出点、`speed`（无时间映射为 `"1"`，有时为 `"map"`，并附关键点）、`gain_db`。另列转场和标记。

**`read_transcript`：**

参数二选一：`transcript_id` 按母稿输出；`timeline_id` 按时间线上投影后的结果输出。可选 `range` 限定范围。

输出打包文本放在 `result.text`，每行一条字幕：

```text
[cue_zh_03 tok_015..tok_021] 10:00:15:12 Agent先把粗剪和字幕做完
```

- 素材没有时码（例如没有 bext 的 WAV）时，这一列写成「时:分:秒.毫秒」形式的源时间，例如 `00:00:05.440`，不写分数。
- 按母稿输出时，时码是源时码；按时间线输出时，时码是序列时码。按时间线输出时，每当下一行来自另一个片段，先单独输出一行片段头 `@clp_a1 00:00:12:05`，即片段 ID 和它的序列入点时码；同一片段的后续行不再重复片段 ID。
- 只输出 `text` 非空的字词。字幕条状态不是 `auto` 时，在方括号后加 `!edited` 或 `!approved`。
- 一小时中文采访（约 9000 字、1200 条字幕）的输出约 110 KB，不超过 128 KB。中文每个字占 3 个字节，光文字就有约 27 KB，其余是每行的 ID 和时码；字词和字幕条用 `timeline-schema.md` 第 3 节的短 ID 才能做到。调研里「12 KB」的估算来自英文场景，不适用。Agent 按字词 ID 下剪辑命令，不按时间猜。
- 可选参数 `with_times: true` 时，每个字词后面加上它的源时间范围，供 Agent 判断停顿：`大家[0.48-0.72]好[0.72-0.90]`，单位秒，保留两位小数，只用于阅读，不能当规范时间回传。默认不带。

`result` 另含 `lines`（行数）和 `truncated`（超过 256 KB 时截断为 true）。

### 9.1.1 长任务

`transcribe`、`render_preview`、`view_timeline`、`export` 是长任务。

1. 请求先按普通规则检查（`dry_run` 的 `export` 除外，它同步返回损失报告）。检查通过后，内核在 `.zcut/<project_id>/jobs/<job_id>/` 下建任务目录，写 `job.json`，启动一个独立的子进程执行，然后立即返回 `accepted`，`result` 含 `job_id`。`job_id` 格式为 `job_` 加小写 UUIDv7。
2. `job.json` 字段：`job_id`、`verb`、`request`、`state`（`queued`、`running`、`succeeded`、`failed`）、`progress`（0 到 1）、`message`、`created_at`、`updated_at`、`envelope`（结束后的最终结果信封）。子进程每次更新都原子替换这个文件。
3. `job_status`：参数 `job_id`，读动词，`result` 就是 `job.json` 的内容。子进程已不存在而状态仍是 `running` 时，状态改报 `failed`，`message` 写明进程意外退出。
4. 长任务产生的工程写入（例如 `transcribe` 写母稿）在子进程里走第 5 节的写入流程，`base_revision` 用请求里的值，幂等键用请求里的键。
5. CLI 加 `--wait` 时，提交后每 500 毫秒查一次 `job_status`，结束后输出最终结果信封，退出码按最终状态。MCP 不等待，由 Agent 调用 `zcut_job_status`。

### 9.2 导入素材

`import_media` 的导入模式：`paths: [文件…]`，加上写请求的公共字段。对每个文件用 ffprobe 探测，在 `media[]` 末尾追加一条：

| 字段 | 取值 |
|---|---|
| `id` | 新的 `med_` ID |
| `kind` | 有非封面的视频流且帧数大于 1 为 `video`；只有一帧的图片格式为 `image`；只有音频为 `audio` |
| `name` | 文件名 |
| `path` | 相对工程文件所在目录的路径；`original_path` 是绝对路径 |
| `size_bytes`、`fingerprint` | 文件大小和 `sampled-sha256-v1` 指纹 |
| `video.rate` | 视频流的 `r_frame_rate`，写成规范有理数。可变帧率素材的这个值只是标称值，不能用来算时长。图片按约定写 `"25"`，并带上宽高，供导出使用 |
| `video.vfr` | 读前 300 帧的显示时间戳，相邻差值超过一种（容差为时间基的 1 个单位）即为 true |
| `duration` | 恒定帧率视频为帧数乘以帧时长；可变帧率视频为最后一帧的显示时间加该帧时长，按流的时间基精确计算；音频为采样数除以采样率；都是精确有理数。图片按约定写 `3600s` |
| `start_timecode` | 视频取时码轨的 `timecode` 标签。WAV 取 bext 的 `time_reference`（从午夜起的采样数）换算：纯音频没有帧率，统一按 25 帧不丢帧表示，不在帧边界上时向下取整，精确采样数另存在 `ext.zsir.start_samples`。没有就不写 |
| `audio` | 采样率和声道数 |
| `reel` | 有 `reel_name` 标签时写入 |

探测只读容器的数据包，不解码画面：帧数、可变帧率判断和时长都从数据包的显示时间戳和时长得出（按时间戳排序后使用）。一小时的 4K 素材，解码全部帧要几分钟，读数据包不到一秒。输出要边读边解析，不能因为素材长就超出缓冲上限。

同一个文件（大小和指纹都相同）已经在 `media[]` 里时不重复添加，在 `result.skipped` 里列出已有的 `media_id`。ffprobe 不可用或探测失败返回 `failed`，错误码 `E_IO`。

### 9.3 重链接

素材移盘或改名后，用 `import_media` 的 `relink` 模式找回，而不是重新导入。

请求：`relink: { search_roots: [目录…], media_ids: [可选，默认全部离线素材] }`，加上写请求的公共字段。

规则：

1. 只处理离线素材，也就是 L2 校验报 `E_MEDIA_MISSING` 或 `E_MEDIA_MISMATCH` 的。
2. 在 `search_roots` 下递归查找。先按 `size_bytes` 筛候选，再算 `sampled-sha256-v1` 指纹，两者都一致才算找到。**绝不按文件名匹配**，同名不同内容的文件不能被认成同一个。
3. 找到多个内容完全相同的副本时，取路径按字节排序的第一个，并在结果里注明其余候选。
4. 只改 `media[].path`，`original_path` 和 `media_id` 不变，所以所有引用这个素材的片段和字幕都不受影响。
5. 一个都没找回时返回 `no_op`。

`result` 包含三个数组：`relinked`（素材 ID、旧路径、新路径、其余候选）、`not_found`（素材 ID）、`skipped`（不是离线状态而跳过的素材 ID）。

### 9.4 新建工程

`create_project` 是唯一不需要已有工程文件的写动词。请求字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `project` | 是 | 要新建的工程文件路径，以 `.zcut.json` 结尾。所在目录必须已存在；文件已存在时返回 `rejected`、`E_VALIDATION` |
| `name` | 是 | 工程名 |
| `timeline` | 是 | `name`（默认「主时间线」）、`edit_rate`、`drop_frame`（默认 false）、`start_timecode`（默认 `00:00:00:00`，丢帧时 `00:00:00;00`）、`width`、`height`、`audio_tracks`（音频轨数，默认 2，1 到 8） |
| `match_media` | 否 | 一个素材文件路径。给了它时，`timeline` 里没写的 `edit_rate`、`width`、`height` 从这个素材取：帧率取 9.2 节的 `video.rate`，不在 `timeline-schema.md` 4.3 节的表里时取表里最接近的一个（差值相同取较大的）；`drop_frame` 仍默认 false。素材不是视频返回 `E_VALIDATION`。只探测，不导入 |
| `subtitles` | 否 | `language`、`name`（默认「字幕」）。给了时同时建一个默认字幕样式和一条字幕轨，承载轨是 A1 |
| `idempotency_key`、`author` | 是 | 同写请求。不需要 `base_revision` |

`timeline` 和 `match_media` 合起来仍缺 `edit_rate`、`width` 或 `height` 时返回 `E_VALIDATION`。

新工程的内容：

- `id` 为新的 `prj_` ID，`media`、`transcripts` 为空。
- 一条时间线，ID 为新的 `tl_` ID。轨道依次是 `trk_v1`（V1）、`trk_a1`（A1）、`trk_a2`（A2）……；给了 `subtitles` 时再加字幕轨 `trk_sub1`，`language` 照抄，`carrier_tracks` 为 `["trk_a1"]`，默认样式 `sty_default`。
- `sty_default`：`name` 为「默认」，`version` 1，`font_family` 为 `PingFang SC`，`font_size` 为 `0.05`（时间线高度的比例），`color` 为 `#FFFFFF`，`outline` 为黑色 `#000000`、宽 `0.06`（字号的比例），`position` 为 `bottom`、`margin_v` 为 `0.08`。
- 修订 `seq` 为 1，`parent` 为 null。日志写第一条，动词 `create_project`，`changes` 列出新建的工程、时间线、轨道和样式。

幂等：文件已存在、它的第一条日志的幂等键和请求摘要都与本次相同时，原样返回第一次的结果信封，不报错；幂等键相同但请求不同时返回 `E_IDEMPOTENCY_MISMATCH`。

`result` 含 `project_id`、`timeline_id`、`revision`（`seq` 和 `id`），给了 `subtitles` 时另含 `subtitle_track_id`。`receipt.before` 为 null，`receipt.after` 为第一个修订的 ID。

新建这一步不能撤销：对第一个修订 `undo` 返回 `rejected`、`E_UNSUPPORTED`。不想要这个工程，直接删掉文件和旁边的 `.zcut/` 目录。

## 10. `edit` 的操作

一个 `edit` 请求带一个有序的 `ops` 数组，整体原子执行。请求可以带 `timeline_id` 指定要编辑的时间线；工程里只有一条时间线时可以省略，有多条时省略返回 `E_VALIDATION`。新建片段时产生的 `occurrence_id` 写在该片段那条 `changes` 的 `detail.occurrence_id` 里。创建实体的操作可以由调用方指定新 ID，这样同一请求里后面的操作能引用它；不指定就由内核生成，并在 `changes` 里返回。

**剪辑域**

| 操作 | 主要参数 | 说明 |
|---|---|---|
| `place` | `media_id`、`source_start` 和 `duration` 或 `tokens`、`at`、`video_track`、`audio_track`、`mode` | 把一段素材放上时间线，新建一个 `occurrence_id` 和对应的视音频片段。`mode` 取 `insert` 或 `overwrite`。`tokens` 按字词选段，`at` 可写 `"end"` |
| `remove` | `clip_ids`、`linked` | 删片段，留下空隙，不合拢；要合拢用 `remove_span` |
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

每个操作的精确语义见 `docs/spec/edit-ops.md`。完整参数 schema 在第 1 步由实现按那份文档补进 `schema/command.schema.json`，有出入先改规格。

## 11. 错误码

| 错误码 | 状态 | 含义 |
|---|---|---|
| `E_CONFLICT` | `conflict` | 修订不匹配 |
| `E_IDEMPOTENCY_MISMATCH` | `rejected` | 同一幂等键对应了不同请求 |
| `E_VALIDATION` | `rejected` | 请求不符合 schema，或应用后 L1 校验有错误，`issues` 里列出。请求不符合 schema 时，`message` 只列与请求实际形状相关的错误：`ops` 里的每个操作按它的 `op` 值只对照该操作的 schema 报错，`op` 不认识时只报「未知操作」和可选值；动词的请求同理。不能把 `oneOf` 所有分支的失败原因全部列出 |
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
