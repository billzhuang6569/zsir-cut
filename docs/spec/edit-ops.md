# 编辑操作语义 v0.1

状态：草案 · 2026-10-26 · 依赖 `timeline-schema.md`、`command-protocol.md` 第 8、10 节、`subtitle-rules.md`

`command-protocol.md` 第 10 节列出了 `edit` 的操作名和主要参数。本文规定每个操作精确做什么，供 1.6（剪辑域）和 1.7（字幕域）实现。操作的完整参数 schema 由实现按本文写进 `schema/command.schema.json`。

## 1. 通用规则

1. 一个 `edit` 请求里的操作按顺序在内存里执行，后面的操作看到前面操作的结果。任何一个操作失败，整个请求失败，工程不变。
2. 时间参数一律是序列时间（`place` 的 `source_start` 是源时间），有理数秒。请求里可以写非最简分数，例如 `"50/25s"`，内核读入时约分，工程文件、`changes` 和结果里一律是规范形式。剪辑域操作产生的视频片段边界必须落在帧网格上，不在网格上的参数返回 `E_VALIDATION`，不悄悄取整。例外是 `remove_span` 的 `snap` 和 `place` 的 `tokens`。
3. 创建实体的操作可以给出新 ID，不给就由内核生成。生成的 ID 在 `changes` 里返回。
4. 引用不存在的 ID 返回 `E_NOT_FOUND`。
5. 全部操作执行完后做 L1 校验，有错误就整个请求 `rejected`、`E_VALIDATION`。
6. **联动**（`linked`）：同一个 `occurrence_id` 的片段是一组。联动时，操作作用于这组里所有相关片段，规则见各操作。
7. **合拢**（`ripple`）：把某个时刻之后的内容整体前移或后移。合拢作用于所有视频和音频轨，以及标记和独立字幕条，所以各轨道保持同步。
9. **静帧片段**：素材是 `image` 的片段，每一帧都是同一张图，`source_start` 永远是 `0s`。`split`、`trim`、`remove_span`、`place` 的 `overwrite` 切出或修剪出的静帧片段，源入点都保持 `0s`，不随序列位置平移。
8. **级联清理**：任何操作删掉片段后，引用它的转场一并删除；某个 `occurrence_id` 的最后一个片段被删掉时，各字幕轨上键为这个 `occurrence_id` 的覆盖值一并删除。被级联删除的实体都列在 `changes` 里，`op` 填触发它的操作名。这样删除素材不会因为残留的引用而被拒绝。

## 2. 剪辑域

### `place`

参数：`media_id`、`source_start`、`duration`、`at`、`video_track`（可选）、`audio_track`（可选）、`mode`（`insert` 或 `overwrite`）、`source_channels`（可选）、`occurrence_id`、`video_clip_id`、`audio_clip_id`（均可选）。

`source_start` 加 `duration` 可以换成 `tokens`（`transcript_id`、`from_token`、`to_token`、`pause`），按字词选段，这是 Agent 做纸面剪辑的主要方式：

1. 母稿的 `media_id` 必须等于 `media_id`，否则 `E_VALIDATION`。`from_token` 不能在 `to_token` 之后。
2. 用两个字词的对齐时间（第 3 层，没有就用第 2 层）定源区间 `[from 起点, to 终点]`。
3. 给了 `pause` 时两端各留一点静音：前一个字词取母稿里 `from_token` 之前最近的 `text` 非空的字词，它的源终点为 `p`，没有时 `p` 为 `0s`；后一个字词同理，源起点为 `n`，没有时为素材时长。`L = from 起点 − p`，`R = n − to 终点`，都不小于 0。区间改为 `[from 起点 − min(L, pause/2), to 终点 + min(R, pause/2)]`。不给 `pause` 时贴着字边。
4. 取整：起点按素材的帧网格向下取整（纯音频素材按时间线帧网格），时长按时间线帧网格向上取整，结果不超出素材范围。
5. 之后与给了 `source_start`、`duration` 的情况完全相同。实际用的源区间写在 `changes` 的 `detail.source_start` 和 `detail.duration` 里。

`at` 可以写 `"end"`，表示时间线现有内容的末尾，即所有视频轨和音频轨上片段出点的最大值，空时间线为 `0s`。按字词选段时配合 `mode: insert` 和 `at: "end"`，按顺序逐段追加，就能搭出纸面剪辑的结构。

- 新建一个 `occurrence_id`。素材有画面且给了 `video_track`，就在该轨上建视频片段；有声音且给了 `audio_track`，就建音频片段。两者都没建成返回 `E_VALIDATION`。
- `insert`：先在 `at` 处合拢后移 `duration`。所有视频、音频轨上横跨 `at` 的片段在 `at` 处切开，右半段拿新 ID，和 `at` 之后的内容一起后移。然后放入新片段。
- `overwrite`：只在目标轨上清空 `[at, at + duration)`，规则同 `remove_span` 的不合拢模式，然后放入新片段。其他轨不动。

### `remove`

参数：`clip_ids`、`linked`（默认 false）。

删除片段，原位置留下空隙，**不合拢**。`linked` 为 true 时同时删除这些片段所在组的全部片段。引用被删片段的转场一并删除。要合拢请用 `remove_span`。

### `remove_span`

参数：`range`（`start`、`duration`）或 `tokens`（`transcript_id`、`from_token`、`to_token`、`clip_id`、`pause`）二选一；`tracks`（`all` 或轨道 ID 列表，默认 `all`）；`ripple`（默认 true）；`snap`（`out`、`in`、`nearest`，默认 `out`）。

1. **定区间**：给 `range` 时直接使用。给 `tokens` 时，用 `timeline-schema.md` 5.2 节的投影把两个字词换算到序列时间：区间从 `from_token` 的序列起点到 `to_token` 的序列终点。这两个字词必须在 `clip_id` 指定的片段上都被投影；只出现在一个片段上时可以省略 `clip_id`，出现在多个片段上又没给，返回 `E_VALIDATION`。
   **停顿**：`tokens` 里给了 `pause`（规范时间字符串，例如 `"3/10s"`）时，区间不再贴着字词边缘，而是吃进两侧的静音，使剪点处只剩下不超过 `pause` 的停顿。设前一个字词为同一母稿里 `from_token` 之前最近的、`text` 非空且投影在同一片段上的字词，它的序列终点为 `p`；没有时 `p` 取片段的序列入点。设后一个字词同理在 `to_token` 之后，序列起点为 `n`；没有时取片段的序列出点。左侧静音 `L = from 起点 − p`，右侧 `R = n − to 终点`，都不小于 0。区间改为从 `p + min(L, pause/2)` 到 `n − min(R, pause/2)`。不给 `pause` 时行为不变。`pause` 为 `"0s"` 时删掉两侧全部静音。
2. **取整**：区间按 `snap` 落到时间线帧网格上。给了 `pause` 时 `snap` 默认改为 `nearest`，因为两端都在静音里。`out` 起点向下、终点向上取整，保证说过的字被完整删掉；`in` 相反；`nearest` 两端各取最近的帧。
3. **清空**：在 `tracks` 指定的轨道上，与区间相交的片段：完全在区间内的删除；横跨起点的修剪出点；横跨终点的修剪入点；横跨整个区间的在两端切开并删除中间，右半段拿新 ID。修剪入点时 `source_start` 相应后移；有时间映射的片段按映射切分。
4. 区间内的标记和独立字幕条删除；横跨区间边界的缩短。挂在被删除或被修剪剪点上的转场删除。
5. **合拢**：`ripple` 为 true 时，区间终点之后的内容整体前移区间长度。`tracks` 不是 `all` 时只合拢指定轨道，其他轨道的同步可能被破坏，L1 校验会报 `W_SYNC`。

### `trim`

参数：`clip_id`、`edge`（`in` 或 `out`）、`to`、`ripple`（默认 false）、`linked`（默认 true）。

- `out`：把出点移到 `to`。`in`：把入点移到 `to`，`source_start` 随之变化，变化量等于时长变化量。
- `linked` 为 true 时，同组里**同一边缘恰好在同一序列时刻**的片段一起修剪，变化量相同；边缘位置不同的片段，例如 J/L cut 的另一半，不动。
- `ripple` 为 true 时，修剪点之后的内容整体移动时长的变化量。修剪入点并合拢时，片段的 `timeline_start` 保持不变，片段自身和其后内容一起移动。
- 有 `time_map` 的片段一期不能修剪，返回 `E_UNSUPPORTED`。
- 修剪后片段时长必须大于 0，否则返回 `E_VALIDATION`，在操作层面直接拒绝。

### `split`

参数：`clip_id`、`at`、`new_id`（可选）、`linked`（默认 true）。

`at` 必须严格在片段内部。左半段保留原 ID，右半段拿新 ID，两段同属一个 `occurrence_id`。有 `time_map` 时在 `at` 处按映射求出源时间，插入关键点，再把关键点分到两段，右段的点平移到从 0 开始。`from_clip` 指向原片段的转场改为指向右半段。`linked` 为 true 时，同组里所有横跨 `at` 的片段都在 `at` 处切开。

### `move`

参数：`clip_ids`、`to`、`track_id`（可选）、`linked`（默认 true）。

把所列片段中最早的那个移到 `to`，其余按相同的位移移动。`linked` 为 true 时同组片段一起移动。`track_id` 只在移动单个片段（联动时为单个视频片段或单个音频片段）时可用，目标轨类型必须相同。不合拢；移动后重叠返回 `E_VALIDATION`。引用被移动片段的转场，如果两侧不再相接则删除。

### `set_clip`

参数：`clip_id`，以及要改的字段：`label`、`enabled`、`gain_db`、`source_channels`、`transform`、`time_map`、`sync_broken`。给 `null` 表示删除该可选字段。新的 `time_map` 末点必须等于当前时长，要改时长请先 `trim`。

### 素材整理

- `update_media`：`media_id`，加上要改的 `organize` 字段（`tags`、`folders`、`rating`、`note`、`link`），整字段替换。只改整理信息，不碰路径、指纹和规格；那些只能由 `import_media` 写。不改时间线，不产生片段变化。

### 转场、标记、轨道

- `add_transition`：`id`、`from_clip`、`to_clip`、`duration`、`alignment`。`remove_transition`：`transition_id`。
- `add_marker`：`id`、`at`、`duration`、`kind`、`text`、`level`（可选，只用于 `chapter`，取 1 或 2）。`update_marker`：`marker_id` 加要改的字段。`remove_marker`：`marker_id`。
- `add_track`：`id`、`kind`（`video` 或 `audio`）、`name`（可选，没给时按 `timeline-schema.md` 4.4 自动命名）、`index`（插入位置，默认末尾）。`rename_track`：`track_id`、`name`。它属于被改名轨道所在的域：视频、音频轨是剪辑域，字幕轨是字幕域。`remove_track`：`track_id`，轨道必须是空的，并且不是任何字幕轨的承载轨。

## 3. 字幕域

### 锁定保护

操作碰到 `state` 为 `approved` 的字词、`locked` 或 `state` 为 `approved` 的字幕条，返回 `E_LOCKED`。`force: true` 可以越过，但只在 `manual` 审批的编辑会话里有效；不在这样的会话里带 `force`，返回 `E_SESSION_STATE`。

### `edit_text`

参数：`transcript_id`、`from_token`、`to_token`、`text`、`new_ids`（可选）。

1. 把 `from_token` 到 `to_token` 之间的字词换成新字词。新文字的切分：含空格的按空格切；中文不含空格时，每个连续的中文段落作为一个字词，连续的 ASCII 字母数字作为一个字词。
2. 原来这些字词实际听到的内容（每个字词的 `heard`，没有就取 `text`，按原顺序拼接）存进第一个新字词的 `heard`，其余新字词的 `heard` 为空串。这样听到的内容不丢。
3. 新字词的 `state` 为 `edited`。对齐时间先按显示宽度在原区间内等比分配，并新建一条 `kind` 为 `align`、引擎名为 `interpolate` 的识别运行作为来源，`conf` 不写。之后由 `transcribe` 或 worker 的 `align` 重新对齐。
4. 原字幕条的首尾字词如果被替换，改为指向对应的新字词。

### `replace_text`

查找替换。参数：`find`（非空）、`replace`（可以为空串）、`transcript_ids`（可选，默认全部）、`cue_ids`（可选，只在这些字幕条里找）、`match_case`（默认 false，只影响拉丁字母）、`force`。

1. 在每条字幕条的显示文字里找 `find`。显示文字是该条可见字词的 `text` 按顺序拼接，空格按字词原样保留。同一条里多处匹配从左到右依次处理，不重叠。
2. 每处匹配换算成「首字词、末字词、首字词里匹配前的部分、末字词里匹配后的部分」，然后按 `edit_text` 的规则执行：把首字词到末字词替换成「前缀 + `replace` + 后缀」。`heard`、对齐时间、字幕条首尾的处理全部沿用 `edit_text`。
3. 匹配跨过隐藏字词时，隐藏字词一起被替换，原来听到的内容照样存进 `heard`。
4. 匹配碰到锁定保护的字词或字幕条时跳过这一处，不中断其他处，`warnings` 加 `W_REPLACE_SKIPPED_LOCKED` 并列出跳过的字幕条。带 `force` 时按锁定保护的规则处理。
5. 一处都没找到时返回 `no_op`。

### 字幕叠层

- `add_overlay`：`id`（可选）、`name`、`timeline_id`、`subtitle_track_id`、`output_path`、`tail`（可选）。`output_path` 必须是绝对路径、以 `.mov` 结尾，所在目录要存在；同一工程里两个叠层不能用同一个 `output_path`。
- `update_overlay`：`overlay_id` 加要改的字段（不能改 `last_export`）。`remove_overlay`：`overlay_id`，只删设置，不删已经导出的文件。
- 这三个操作属于字幕域。

### `set_recognition`

参数：`recognition` 对象的任意字段，见 `timeline-schema.md` 4.1，按字段替换。`terms` 写入前去掉首尾空白、去掉空串、去重。只改设置，不重新识别；要按新设置识别，再调用 `transcribe`。

### 其余字幕操作

| 操作 | 参数 | 做什么 |
|---|---|---|
| `hide_tokens` | `transcript_id`、`tokens` | `text` 设为空串；原 `heard` 没有时先把原 `text` 存进 `heard` |
| `set_token_state` | `transcript_id`、`tokens`、`state` | 设置状态 |
| `resegment` | `transcript_id`、`range`（可选，首尾字词）、`rules`（可选） | 按 `subtitle-rules.md` 重新生成范围内的字幕条，跳过锁定和已批准的。首尾字词与旧条相同的新条沿用旧 ID，其余拿新 ID |
| `set_cue` | `cue_id`、`breaks`、`timing`、`style_id`、`state` | 改字幕条 |
| `split_cue` | `cue_id`、`after_token`、`new_id` | 在某字词之后拆成两条，后一条拿新 ID。原条的人工时间：起点留给前一条，终点留给后一条，拆分处两侧都不设人工值 |
| `merge_cues` | `cue_ids` | 合并相邻的字幕条，保留第一条的 ID。人工时间保留第一条的起点和最后一条的终点 |
| `set_override` / `remove_override` | `track_id`、`occurrence_id`、`cue_id`，以及 `hidden`、`text`、`style_id` | 序列层面的例外 |
| `add_free_cue` / `remove_free_cue` | `track_id`、`id`、`timeline_start`、`duration`、`text`、`style_id` | 独立字幕条 |
| `add_style` / `update_style` | 样式字段 | 新增或修改样式，修改时 `version` 加一 |
| `add_subtitle_track` | `id`、`name`（可选，没给时自动命名为「字幕 A」「字幕 B」……）、`language`、`carrier_tracks`、`default_style_id` | 新建字幕轨。删除用剪辑域的 `remove_track`，但字幕轨不要求为空 |

## 4. 验收例子

以下例子用 `fixtures/projects/std-25.zcut.json`，1.6、1.7 的测试应当覆盖。

1. 按字词删除 `cue_zh_03` 里的「先把」（`remove_span` 的 `tokens`，`clip_id` 为 `clp_a1`，默认合拢）：「先」的起点在序列第 117.5 帧，「把」的终点在第 128.5 帧，向外取整后删除第 117 到 129 帧共 12 帧。V1、V2、A1、A3 四条轨都有片段横跨这个区间，都被切开；之后所有内容前移 12 帧；`W_SYNC` 不出现；投影出的 `cue_zh_03` 文字变为「Agent粗剪和字幕做完」。
2. 在 `clp_v2` 中间 `split`，联动：`clp_v2` 和 `clp_a2` 都被切开，新的两段属于 `occ_2`；叠化 `trn_1` 挂在 `clp_v2` 的出点上，出点属于右半段，所以 `from_clip` 改为右半段的新 ID。
3. `trim` `clp_v1` 的出点，联动：`clp_a1` 的出点和 `clp_v1` 不在同一时刻，所以不动。
4. 对 `cue_zh_01` 所在字词 `edit_text`：返回 `E_LOCKED`，因为第一句的字词已批准。
