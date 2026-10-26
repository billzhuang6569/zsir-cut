# 编辑操作语义 v0.1

状态：草案 · 2026-10-26 · 依赖 `timeline-schema.md`、`command-protocol.md` 第 8、10 节、`subtitle-rules.md`

`command-protocol.md` 第 10 节列出了 `edit` 的操作名和主要参数。本文规定每个操作精确做什么，供 1.6（剪辑域）和 1.7（字幕域）实现。操作的完整参数 schema 由实现按本文写进 `schema/command.schema.json`。

## 1. 通用规则

1. 一个 `edit` 请求里的操作按顺序在内存里执行，后面的操作看到前面操作的结果。任何一个操作失败，整个请求失败，工程不变。
2. 时间参数一律是序列时间，规范有理数形式。剪辑域操作产生的视频片段边界必须落在帧网格上，不在网格上的参数返回 `E_VALIDATION`，不悄悄取整。唯一的例外是 `remove_span` 的 `snap`。
3. 创建实体的操作可以给出新 ID，不给就由内核生成。生成的 ID 在 `changes` 里返回。
4. 引用不存在的 ID 返回 `E_NOT_FOUND`。
5. 全部操作执行完后做 L1 校验，有错误就整个请求 `rejected`、`E_VALIDATION`。
6. **联动**（`linked`）：同一个 `occurrence_id` 的片段是一组。联动时，操作作用于这组里所有相关片段，规则见各操作。
7. **合拢**（`ripple`）：把某个时刻之后的内容整体前移或后移。合拢作用于所有视频和音频轨，以及标记和独立字幕条，所以各轨道保持同步。

## 2. 剪辑域

### `place`

参数：`media_id`、`source_start`、`duration`、`at`、`video_track`（可选）、`audio_track`（可选）、`mode`（`insert` 或 `overwrite`）、`source_channels`（可选）、`occurrence_id`、`video_clip_id`、`audio_clip_id`（均可选）。

- 新建一个 `occurrence_id`。素材有画面且给了 `video_track`，就在该轨上建视频片段；有声音且给了 `audio_track`，就建音频片段。两者都没建成返回 `E_VALIDATION`。
- `insert`：先在 `at` 处合拢后移 `duration`。所有视频、音频轨上横跨 `at` 的片段在 `at` 处切开，右半段拿新 ID，和 `at` 之后的内容一起后移。然后放入新片段。
- `overwrite`：只在目标轨上清空 `[at, at + duration)`，规则同 `remove_span` 的不合拢模式，然后放入新片段。其他轨不动。

### `remove`

参数：`clip_ids`、`linked`（默认 false）。

删除片段，原位置留下空隙，**不合拢**。`linked` 为 true 时同时删除这些片段所在组的全部片段。引用被删片段的转场一并删除。要合拢请用 `remove_span`。

### `remove_span`

参数：`range`（`start`、`duration`）或 `tokens`（`transcript_id`、`from_token`、`to_token`、`clip_id`）二选一；`tracks`（`all` 或轨道 ID 列表，默认 `all`）；`ripple`（默认 true）；`snap`（`out`、`in`、`nearest`，默认 `out`）。

1. **定区间**：给 `range` 时直接使用。给 `tokens` 时，用 `timeline-schema.md` 5.2 节的投影把两个字词换算到序列时间：区间从 `from_token` 的序列起点到 `to_token` 的序列终点。这两个字词必须在 `clip_id` 指定的片段上都被投影；只出现在一个片段上时可以省略 `clip_id`，出现在多个片段上又没给，返回 `E_VALIDATION`。
2. **取整**：区间按 `snap` 落到时间线帧网格上。`out` 起点向下、终点向上取整，保证说过的字被完整删掉；`in` 相反；`nearest` 两端各取最近的帧。
3. **清空**：在 `tracks` 指定的轨道上，与区间相交的片段：完全在区间内的删除；横跨起点的修剪出点；横跨终点的修剪入点；横跨整个区间的在两端切开并删除中间，右半段拿新 ID。修剪入点时 `source_start` 相应后移；有时间映射的片段按映射切分。
4. 区间内的标记和独立字幕条删除；横跨区间边界的缩短。挂在被删除或被修剪剪点上的转场删除。
5. **合拢**：`ripple` 为 true 时，区间终点之后的内容整体前移区间长度。`tracks` 不是 `all` 时只合拢指定轨道，其他轨道的同步可能被破坏，L1 校验会报 `W_SYNC`。

### `trim`

参数：`clip_id`、`edge`（`in` 或 `out`）、`to`、`ripple`（默认 false）、`linked`（默认 true）。

- `out`：把出点移到 `to`。`in`：把入点移到 `to`，`source_start` 随之变化，变化量等于时长变化量。
- `linked` 为 true 时，同组里**同一边缘恰好在同一序列时刻**的片段一起修剪，变化量相同；边缘位置不同的片段，例如 J/L cut 的另一半，不动。
- `ripple` 为 true 时，修剪点之后的内容整体移动时长的变化量。修剪入点并合拢时，片段的 `timeline_start` 保持不变，片段自身和其后内容一起移动。
- 有 `time_map` 的片段一期不能修剪，返回 `E_UNSUPPORTED`。

### `split`

参数：`clip_id`、`at`、`new_id`（可选）、`linked`（默认 true）。

`at` 必须严格在片段内部。左半段保留原 ID，右半段拿新 ID，两段同属一个 `occurrence_id`。有 `time_map` 时在 `at` 处按映射求出源时间，插入关键点，再把关键点分到两段，右段的点平移到从 0 开始。`from_clip` 指向原片段的转场改为指向右半段。`linked` 为 true 时，同组里所有横跨 `at` 的片段都在 `at` 处切开。

### `move`

参数：`clip_ids`、`to`、`track_id`（可选）、`linked`（默认 true）。

把所列片段中最早的那个移到 `to`，其余按相同的位移移动。`linked` 为 true 时同组片段一起移动。`track_id` 只在移动单个片段（联动时为单个视频片段或单个音频片段）时可用，目标轨类型必须相同。不合拢；移动后重叠返回 `E_VALIDATION`。引用被移动片段的转场，如果两侧不再相接则删除。

### `set_clip`

参数：`clip_id`，以及要改的字段：`label`、`enabled`、`gain_db`、`source_channels`、`transform`、`time_map`、`sync_broken`。给 `null` 表示删除该可选字段。新的 `time_map` 末点必须等于当前时长，要改时长请先 `trim`。

### 转场、标记、轨道

- `add_transition`：`id`、`from_clip`、`to_clip`、`duration`、`alignment`。`remove_transition`：`transition_id`。
- `add_marker`：`id`、`at`、`duration`、`kind`、`text`。`update_marker`：`marker_id` 加要改的字段。`remove_marker`：`marker_id`。
- `add_track`：`id`、`kind`（`video` 或 `audio`）、`name`、`index`（插入位置，默认末尾）。`remove_track`：`track_id`，轨道必须是空的，并且不是任何字幕轨的承载轨。

## 3. 字幕域

### 锁定保护

操作碰到 `state` 为 `approved` 的字词、`locked` 或 `state` 为 `approved` 的字幕条，返回 `E_LOCKED`。`force: true` 可以越过，但只在 `manual` 审批的编辑会话里有效；不在这样的会话里带 `force`，返回 `E_SESSION_STATE`。

### `edit_text`

参数：`transcript_id`、`from_token`、`to_token`、`text`、`new_ids`（可选）。

1. 把 `from_token` 到 `to_token` 之间的字词换成新字词。新文字的切分：含空格的按空格切；中文不含空格时，每个连续的中文段落作为一个字词，连续的 ASCII 字母数字作为一个字词。
2. 原来这些字词实际听到的内容（每个字词的 `heard`，没有就取 `text`，按原顺序拼接）存进第一个新字词的 `heard`，其余新字词的 `heard` 为空串。这样听到的内容不丢。
3. 新字词的 `state` 为 `edited`。对齐时间先按显示宽度在原区间内等比分配，并新建一条 `kind` 为 `align`、引擎名为 `interpolate` 的识别运行作为来源，`conf` 不写。之后由 `transcribe` 或 worker 的 `align` 重新对齐。
4. 原字幕条的首尾字词如果被替换，改为指向对应的新字词。

### 其余字幕操作

| 操作 | 参数 | 做什么 |
|---|---|---|
| `hide_tokens` | `transcript_id`、`tokens` | `text` 设为空串；原 `heard` 没有时先把原 `text` 存进 `heard` |
| `set_token_state` | `transcript_id`、`tokens`、`state` | 设置状态 |
| `resegment` | `transcript_id`、`range`（可选，首尾字词）、`rules`（可选） | 按 `subtitle-rules.md` 重新生成范围内的字幕条，跳过锁定和已批准的。首尾字词与旧条相同的新条沿用旧 ID，其余拿新 ID |
| `set_cue` | `cue_id`、`breaks`、`timing`、`style_id`、`state` | 改字幕条 |
| `split_cue` | `cue_id`、`after_token`、`new_id` | 在某字词之后拆成两条，后一条拿新 ID |
| `merge_cues` | `cue_ids` | 合并相邻的字幕条，保留第一条的 ID |
| `set_override` / `remove_override` | `track_id`、`occurrence_id`、`cue_id`，以及 `hidden`、`text`、`style_id` | 序列层面的例外 |
| `add_free_cue` / `remove_free_cue` | `track_id`、`id`、`timeline_start`、`duration`、`text`、`style_id` | 独立字幕条 |
| `add_style` / `update_style` | 样式字段 | 新增或修改样式，修改时 `version` 加一 |
| `add_subtitle_track` | `id`、`name`、`language`、`carrier_tracks`、`default_style_id` | 新建字幕轨。删除用剪辑域的 `remove_track`，但字幕轨不要求为空 |

## 4. 验收例子

以下例子用 `fixtures/projects/std-25.zcut.json`，1.6、1.7 的测试应当覆盖。

1. 按字词删除 `cue_zh_03` 里的「先把」（`remove_span` 的 `tokens`，`clip_id` 为 `clp_a1`，默认合拢）：「先」的起点在序列第 117.5 帧，「把」的终点在第 128.5 帧，向外取整后删除第 117 到 129 帧共 12 帧。V1、V2、A1、A3 四条轨都有片段横跨这个区间，都被切开；之后所有内容前移 12 帧；`W_SYNC` 不出现；投影出的 `cue_zh_03` 文字变为「Agent粗剪和字幕做完」。
2. 在 `clp_v2` 中间 `split`，联动：`clp_v2` 和 `clp_a2` 都被切开，新的两段属于 `occ_2`；叠化 `trn_1` 挂在 `clp_v2` 的出点上，出点属于右半段，所以 `from_clip` 改为右半段的新 ID。
3. `trim` `clp_v1` 的出点，联动：`clp_a1` 的出点和 `clp_v1` 不在同一时刻，所以不动。
4. 对 `cue_zh_01` 所在字词 `edit_text`：返回 `E_LOCKED`，因为第一句的字词已批准。
