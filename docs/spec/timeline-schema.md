# 时间线 Schema v0.1

状态：草案 · 2026-10-26 · 对应 `schema/timeline.schema.json`
依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「技术选型建议 · 时间线数据模型」与「字幕技术栈」两节。

本文定义 zsir-cut 工程文件的数据结构。Agent、CLI、未来的桌面 UI 和所有导出器都读写这一份文件，不另存私有状态。命令怎么改它见 `command-protocol.md`，怎么交给 NLE 见 `handoff-profile.md`。

## 1. 设计原则

1. **文本优先。** 一个工程就是一个 UTF-8 JSON 文件，扩展名 `.zcut.json`，可以 diff、进 git、被 Agent 直接阅读。
2. **按 ID 不按位置。** 所有实体都有稳定 ID，命令和导出都按 ID 寻址。导出时把 ID 写进目标格式的 metadata，以后导回时靠它重新匹配。
3. **时间精确。** 时间一律用有理数，不用浮点。
4. **字幕挂在源上。** 字幕的字词时间保存为源媒体时间，序列上的位置由剪辑投影得出，所以剪辑怎么动，字幕都跟着走。
5. **不认识的数据原样保留。** 每个实体都有 `ext` 扩展槽，读写时必须原样带回。

## 2. 时间

### 2.1 表示

| 类型 | 写法 | 例子 | 说明 |
|---|---|---|---|
| `Time` | 秒的有理数，后缀 `s` | `"0s"`、`"1001/100s"` | 非负。与 FCPXML 的写法相同 |
| `Duration` | 同上，必须大于 0 | `"1001/200s"` | |
| `Rate` | 每秒帧数或采样数的有理数 | `"25"`、`"30000/1001"`、`"48000"` | |
| `Timecode` | `HH:MM:SS:FF`，丢帧用 `;` | `"01:00:00;00"` | 只用于显示和交换，不参与计算 |

变速不用单独的速度值表示，而是用时间映射，见 4.5。

规范形式：分数必须是最简形式，分母为 1 时省略分母，零写作 `"0s"`。同一个时间只有一种写法，这样 diff 才稳定。实现内部可以换算成整数 tick（建议 254016000000 tick/s，能整除所有常见帧率和采样率），但写回文件时必须还原成规范形式。

### 2.2 四种时间坐标

- **源时间（source time）**：从媒体文件第一帧或第一个采样算起的秒数，从 0 开始。不是源时码。字幕 token、片段的 `source_start` 都用它。
- **序列时间（timeline time）**：从时间线第一帧算起的秒数，从 0 开始。片段的 `timeline_start` 用它。
- **显示时码**：`start_timecode` 加上序列时间或源时间换算出来，只给人看和给 NLE。丢帧（drop-frame）只是时码的编号规则，不是另一种帧率。
- **宿主 tick**：各家 NLE 内部的时间单位，只在导出器里出现，不进工程文件。

所有区间都是半开区间 `[start, start + duration)`。

### 2.3 对齐规则

- 视频片段的 `timeline_start`、`duration` 和时间映射关键点的 `at` 必须落在时间线帧网格上。
- 音频片段的边界必须落在时间线帧网格或 `audio_rate` 的采样网格上，两者满足其一即可。29.97 帧的一帧是 1601.6 个采样，所以帧边界上的音频剪点也合法。
- 字幕时间可以是任意有理数，导出时由交接 profile 量化到目标帧网格。

## 3. 身份：三层 ID

| ID | 指什么 | 何时产生 | 何时改变 |
|---|---|---|---|
| `media_id` | 一个媒体文件的内容 | 导入素材时 | 永不改变。移盘、改名、换代理都不变 |
| `occurrence_id` | 某段素材被放进时间线的「一次使用」 | 把素材放上时间线时 | 永不改变。这次使用拆出的视频、音频片段和后来切开的各段都共用它 |
| `clip_id` | 轨道上的一个具体片段 | 片段创建时 | 切开时，切出的新段拿新 ID，原段保留原 ID |

用法举例：同一条采访素材在时间线上用了三次，就是一个 `media_id`、三个 `occurrence_id`。其中一次用法的视频在 V1、音频在 A1，它们是两个 `clip_id`、同一个 `occurrence_id`。把这段音频从中间切开，又多一个 `clip_id`，`occurrence_id` 不变。

`occurrence_id` 有两个用途：一是让同一次使用的视音频保持同步关系，J/L cut 时也能认出它们是一组；二是让删掉的内容可追溯，任何一段都能回答「它来自哪一次使用」。

ID 格式是「类型前缀加下划线加 1–64 位 `[A-Za-z0-9_-]`」。新建实体默认用小写 UUIDv7 作为后缀，测试工程可以用可读后缀。

| 前缀 | 实体 | 前缀 | 实体 |
|---|---|---|---|
| `prj_` | 工程 | `trs_` | 转写母稿 |
| `tl_` | 时间线 | `run_` | 识别或对齐运行 |
| `trk_` | 轨道 | `tok_` | 字词 token |
| `med_` | 媒体 | `cue_` | 字幕条 |
| `occ_` | 一次使用 | `sty_` | 字幕样式 |
| `clp_` | 片段 | `rev_` | 修订 |
| `trn_` | 转场 | `mrk_` | 标记 |

## 4. 文件结构

```text
Project
├─ schema / schema_version / id / name / revision
├─ media[]            媒体资产
├─ timelines[]        时间线（一期通常只有一条）
│  ├─ tracks[]        video / audio / subtitle 三类轨道
│  │  ├─ clips[]      片段（video、audio 轨）
│  │  └─ transitions[]
│  └─ markers[]
├─ transcripts[]      字幕母稿：第 1–4 层
├─ subtitle_styles[]  字幕样式：第 5 层
└─ ext
```

### 4.1 工程头

- `schema`：固定为 `"zsir-cut/timeline"`。
- `schema_version`：`"主版本.次版本"`，当前 `"0.1"`。1.0 之前格式还会变，读取方只接受自己认识的版本：更旧的版本按迁移链升级后再读，更新的版本一律拒绝，并提示升级 zsir-cut。每次升版本都要在代码里写一条迁移，迁移链从任何旧版本都能走到当前版本。1.0 之后再放宽为「次版本更高时可以读」。
- `revision`：当前修订。`seq` 每次变更加一；`id` 是本次修订的 ID；`parent` 是上一次修订的 ID；`author.kind` 取 `human`、`agent` 或 `system`。命令带上 `base_revision`，写入前必须核对，规则见 `command-protocol.md`。修订历史存在工程旁边的日志里，不进工程文件。

### 4.2 媒体 `media[]`

一个媒体条目代表一份文件内容，不代表一个路径。

- `path`：相对工程文件所在目录的路径，用 `/` 分隔，原样保存 UTF-8 字符，不做 URL 编码。
- `original_path`：导入时的绝对路径，只用于提示和找回。
- `size_bytes` 加 `fingerprint`：内容身份。`sampled-sha256-v1` 的算法是：对「文件字节数的十进制字符串、换行、开头 4 MiB、中间 4 MiB、末尾 4 MiB」做 SHA-256。中间 4 MiB 从字节偏移 `floor((文件大小 − 4 MiB) / 2)` 开始。12 MiB 及以下的文件对全文做 SHA-256。
- `kind`：`video`、`audio` 或 `image`。`image` 的 `duration` 表示它允许被使用的最长时长，约定写 `"3600s"`；用它的片段 `source_start` 必须是 `"0s"`。
- `duration`、`start_timecode`、`reel`：源时长、源起始时码、卷名。
- `video`：`rate`、`width`、`height`、`pixel_aspect`、`vfr`。
- `audio`：`sample_rate`、`channels`。
- `proxy`：可选的代理文件，结构同 `path` 加 `fingerprint`。

重链接规则：只有 `size_bytes` 和 `fingerprint` 都匹配才算同一个文件。同名不同内容的文件绝不能自动认成同一个。`vfr` 为 true 的素材，校验时给警告，建议先转成恒定帧率或生成代理。

### 4.3 时间线 `timelines[]`

- `edit_rate`：时间线帧率，例如 `"25"` 或 `"30000/1001"`。
- `drop_frame`：显示时码是否丢帧。只在 `30000/1001` 和 `60000/1001` 下可以为 true。
- `start_timecode`：序列时间 0 对应的时码，可以非零，例如 `"01:00:00:00"`。
- `audio_rate`：一期固定 `"48000"`。
- `format`：`width`、`height`、`pixel_aspect`。
- `tracks[]`：轨道数组。视频轨按数组顺序从下往上叠，第一条视频轨是 V1；音频轨按顺序是 A1、A2。字幕轨不参与画面叠放。

### 4.4 轨道与片段

轨道有 `id`、`kind`、`name`、`enabled`。video 和 audio 轨有 `clips[]` 和 `transitions[]`。

片段字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `occurrence_id` / `media_id` | 是 | 三层身份 |
| `timeline_start` | 是 | 在序列上的入点 |
| `duration` | 是 | 在序列上的时长 |
| `source_start` | 是 | 对应的源入点 |
| `time_map` | 否 | 变速用的时间映射，不写就是原速，见 4.5 |
| `enabled` | 否 | 默认 true |
| `gain_db` | 否 | 音频恒定增益，只用于音频片段 |
| `source_channels` | 否 | 音频片段取源的哪几个声道，从 0 开始 |
| `transform` | 否 | 视频的缩放、旋转、位移、裁切 |
| `label` / `ext` | 否 | 显示名、扩展 |

`source_start` 是片段第一帧对应的源时间。没有时间映射时，源区间就是 `[source_start, source_start + duration)`。同一轨道上的片段区间不得重叠。片段之间的空白就是空隙，不需要显式的 gap 对象，导出 OTIO 时再生成。

同步规则：同一 `occurrence_id` 下的片段，同一个序列时刻必须对应同一个源时刻。都没有时间映射时，这等价于 `timeline_start − source_start` 相等。J/L cut 就是同一次使用的视频和音频起止点不同，但这个差值不变。有时间映射时，只在片段于序列上重叠的部分检查。确实要错开同步时，在片段上写 `"sync_broken": true`，校验只给提示。

转场 `transitions[]`：`id`、`type`（一期只有 `cross_dissolve`）、`from_clip`、`to_clip`、`duration`、`alignment`（`center`、`start`、`end`）。两段必须在同一轨道且首尾相接，两段素材在源上要有足够的余量（handles）覆盖转场。

### 4.5 变速与时间映射

`time_map` 描述片段内「序列时间到源时间」的对应关系，覆盖恒定变速、分段变速、倒放和定格。它是一组关键点，每个点有三个字段：

- `at`：片段内的序列时间，从片段第一帧算起。
- `source`：这一刻对应的源时间。
- `interp`：从这个点到下一个点之间怎么算。`linear` 是线性；`smooth` 是平滑过渡；`hold` 是定格，整段都停在这个点的 `source` 上。最后一个点的 `interp` 不起作用。

约束：至少两个点；`at` 严格递增；第一个点的 `at` 是 `"0s"`，`source` 等于片段的 `source_start`；最后一个点的 `at` 等于片段的 `duration`。

常见形态都是它的特例：

| 形态 | 写法 |
|---|---|
| 原速 | 不写 `time_map` |
| 恒定 200% | 两个点，`source` 增量是 `at` 增量的 2 倍 |
| 分段变速（FCP 切割速度） | 多个 `linear` 点，每段斜率不同 |
| 倒放 | `linear` 段里 `source` 递减 |
| 定格 | `hold` 段 |
| 速度坡度 | 段之间用 `smooth` |

片段的源区间是所有关键点 `source` 的最小值到最大值，`E_SOURCE_RANGE` 按它检查。

实现范围：一期的计算、预览和导出精确支持 `linear` 和 `hold`。`smooth` 原样保存，FCPXML 原样写出；其他地方按线性近似计算，并给出 `W_TIMEMAP_APPROX`。这样从 FCP 导入的速度坡度不会丢，只是一期不保证预览完全一致。

### 4.6 标记 `markers[]`

`id`、`at`、`duration`（可为 `"0s"`）、`kind`、`text`。`kind` 取 `note`、`todo`、`chapter`、`review`。`review` 用来标出待人工检查的片段，是校对台和交接复核的入口。

## 5. 字幕：五层数据

字幕不是 SRT 旁路，而是工程数据。每层可以单独修改和撤销，下层变化不冲掉上层的人工结果。

| 层 | 存在哪 | 内容 |
|---|---|---|
| 1 原始转录 | `transcripts[].raw_runs[]` | 模型实际识别出的字词、时间、置信度、引擎与权重版本。只追加，不修改 |
| 2 编辑文稿 | `tokens[].text` / `heard` / `state` | 人校正后的字词。`heard` 保存实际听到的内容，`text` 是要显示的内容 |
| 3 对齐数据 | `tokens[].align` | 字词在源媒体中的 `start`、`end`、`conf`，以及产生它的对齐运行 |
| 4 字幕编排 | `transcripts[].cues[]` | 断句、分组、换行、显示时长覆盖值 |
| 5 视觉样式 | `subtitle_styles[]` | 字体、字号、颜色、描边、底板、位置、模板版本 |

### 5.1 转写母稿 `transcripts[]`

一份母稿对应一个媒体的一组声道和一种语言：`id`、`media_id`、`source_channels`、`language`（BCP 47，例如 `zh-Hans`）。

`raw_runs[]` 每次识别或对齐运行一条：`id`、`kind`（`asr` 或 `align`）、`engine`（`name`、`model`、`version`、`weights_digest`）、`created_at`、`range`（识别覆盖的源区间）、`tokens[]`（`text`、`start`、`end`、`conf`）。

`tokens[]` 是编辑后的字词序列，按源时间排序：

- `id`、`text`、`heard`：`heard` 只在和 `text` 不同时写。人删掉了实际说过的半句话，就把这些 token 的 `text` 设为空串，保留 `heard`，这样听到的和显示的都不丢。
- `state`：`auto`、`edited`、`approved`。重新识别和重新对齐不得覆盖 `approved` 的 token。
- `align`：`start`、`end`、`conf`、`run`。对齐器的原始刻度（例如 80 ms）照原样保存，不在这里吸附到帧。

`cues[]` 是字幕条：

- `id`、`first_token`、`last_token`：覆盖的 token 范围，两端都包含。
- `breaks`：在哪些 token 之后换行。
- `timing`：可选的人工覆盖值 `start`、`end`（源时间），以及 `locked`。`locked` 为 true 时，自动重新断句不得修改这条。没有覆盖值时，显示时间从 token 对齐时间推出。
- `style_id`、`state`。

### 5.2 字幕轨与投影

字幕轨不保存每条字幕在序列上的位置，只保存投影规则和例外：

- `language`：这条轨显示哪种语言的母稿。
- `carrier_tracks`：哪些音频轨承载说话。J/L cut 时以实际承载说话的音频为准。
- `default_style_id`。
- `overrides[]`：序列层面的例外，按 `occurrence_id` 加 `cue_id` 定位，可设 `hidden`、`text`、`style_id`。同一段话在两次使用里可以显示不同的字。
- `free_cues[]`：序列上独立存在、不来自母稿的字幕条，带序列时间。

投影算法：对承载轨上每个启用的音频片段，找到同媒体、同语言的母稿；取 `text` 非空、对齐区间与片段源区间重叠至少一半的 token；按所属字幕条分组，再按片段的时间映射换算到序列时间。有时间映射时，逐段反算：源时间递增的 `linear` 段精确换算，`smooth` 段按线性近似。一条字幕被剪辑切断时，拆成几段分别显示；被剪掉的 token 不显示。投影结果不写回文件，导出和预览时现算。

有人工覆盖时间的字幕条同样要被片段边界截断，不能显示到片段之外。

落在倒放段、`hold` 定格段或静帧图片上的字幕不投影，并在校验和损失报告里列出。

## 6. 扩展与保留

工程、媒体、轨道、片段、字幕条都有 `ext` 对象，键名是命名空间，例如 `"fcpxml"`、`"resolve"`、`"zsir.review"`。读写时必须原样保留不认识的命名空间。导入外部工程时，翻译不了的属性放进对应命名空间，这样导出和损失报告都能看到它们。

## 7. 序列化规则

写文件时必须保证同样的内容得到同样的字节：

- UTF-8，2 空格缩进，文件末尾一个换行。
- 对象键按 schema 里的声明顺序输出。
- `clips` 按 `timeline_start` 排序，`tokens` 按对齐的 `start` 排序，`markers` 按 `at` 排序，其余数组保持语义顺序。
- 时间和帧率一律写规范形式。

## 8. 校验分级

| 级别 | 检查什么 | 由谁执行 |
|---|---|---|
| L0 结构 | 符合 JSON Schema | `schema/timeline.schema.json`，CI 和 `validate` 都跑 |
| L1 语义 | 引用完整、对齐、重叠、同步、转场余量 | `validate` 命令 |
| L2 媒体 | 文件存在，大小和指纹匹配，代理可用 | `validate --media` |

L1 和 L2 的规则编号如下，`validate` 的输出和损失报告都用这些编号：

| 编号 | 级别 | 规则 |
|---|---|---|
| `E_REF` | 错误 | 引用的 ID 不存在，或片段的 `media_id` 与所属 `occurrence_id` 的其他片段不一致 |
| `E_ID_DUP` | 错误 | ID 在整个工程内不唯一 |
| `E_TIME_FORM` | 错误 | 时间、帧率或速度不是最简分数（JSON Schema 的正则查不出这一条） |
| `E_OVERLAP` | 错误 | 同一轨道片段区间重叠 |
| `E_GRID` | 错误 | 视频边界不在帧网格，或音频边界不在采样网格 |
| `E_SOURCE_RANGE` | 错误 | 片段源区间超出媒体时长 |
| `E_HANDLES` | 错误 | 转场余量不足，或两段不相接 |
| `E_TOKEN_RANGE` | 错误 | 字幕条的 token 范围无效或倒序 |
| `E_TIMEMAP` | 错误 | 时间映射不满足 4.5 的约束 |
| `W_SYNC` | 警告 | 同一次使用的片段同步差值不一致，且没有标 `sync_broken` |
| `W_VFR` | 警告 | 素材是可变帧率 |
| `W_TOKEN_TIME` | 警告 | token 零时长、时间倒序或与相邻 token 重叠 |
| `W_LOW_CONF` | 警告 | 对齐置信度低于阈值 |
| `W_TIMEMAP_APPROX` | 警告 | 片段含 `smooth` 段，预览和投影按线性近似 |
| `W_SUB_UNPROJECTED` | 警告 | 字幕落在倒放段、定格段或静帧上，没有投影 |
| `W_SUB_TOO_WIDE` | 警告 | 单个字词宽度超过一行上限，见 `subtitle-rules.md` |
| `W_SUB_SHORT` | 警告 | 字幕显示时长不足下限且无法延长，见 `subtitle-rules.md` |
| `W_SUB_CPS` | 警告 | 每秒字数超过上限且无法延长，见 `subtitle-rules.md` |
| `E_MEDIA_MISSING` | 错误（L2） | 文件找不到 |
| `E_MEDIA_MISMATCH` | 错误（L2） | 文件存在但大小或指纹不符 |

## 9. 示例

- `examples/minimal.zcut.json`：25 fps，一条素材，一个视频片段加一个音频片段。
- `examples/interview.zcut.json`：29.97 fps、丢帧显示、起始时码 01:00:00;00。同一素材用了三次且入出点不同；有 J cut、叠化转场；B 机位插入镜头做了分段变速（100%、50%、定格、200%）；字幕五层齐全，含一处「听到的和显示的不同」和一条跨切点的字幕条。

示例里的 `fingerprint` 是占位值，不对应真实文件。真实素材的指纹由第 0.8 步的测试工程生成器产生。

## 10. 有意不放进 v0.1 的

嵌套序列、多机位片段、调色、音频效果链、动态标题和 MG。速度坡度能保存，但一期只做近似计算，见 4.5。遇到这些输入时，导入器必须把它们放进 `ext` 并在损失报告里列出，不能静默丢弃。
