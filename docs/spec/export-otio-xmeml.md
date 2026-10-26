# OTIO 与 FCP7 XML 映射 v0.1

状态：草案 · 2026-10-26 · 依赖 `timeline-schema.md`、`handoff-profile.md`、`export-fcpxml.md`
适用 profile：`resolve-18.5-otio`、`premiere-25-xmeml-5`

本文定义怎样把一条时间线写成 OTIO JSON（给 Resolve）和 FCP7 XML（xmeml v5，给 Premiere）。两种格式都表达不了的东西写进损失报告，不静默丢弃。没有真实导出佐证的写法列在各自的「待实测」里，1.12、1.13 合并前核实。

## 1. 两种格式共同的规则

1. **时间换成整数计数。** 两种格式都不能直接写有理数秒。OTIO 的时间是「浮点帧率加数值」，xmeml 是「整数帧加时基」。所以导出器先把每个时间换成整数帧（视频）或整数采样（只在 OTIO 的音频里使用），再写出。帧率写法：25 帧写 `25`；29.97 在 OTIO 里写 `30000/1001` 的双精度值，在 xmeml 里写时基 `30` 加 `ntsc` 为 `TRUE`。
2. **落不到帧网格的时间要取整并报告。** 视频边界本来就在帧网格上。音频边界不在帧网格上时，xmeml 取最近的帧，并在损失报告里记一条 `av_sync`，`approximated`。
3. **分段变速拆成多个片段。** 两种格式都只支持恒定速度，所以有分段的 `time_map` 时，每段拆成一个片段，各自带恒定速度；`hold` 段写成定格；`smooth` 段按线性近似。拆出的片段都写同一个 `clip_id`，并在元数据里标明段号。损失报告记 `speed_segmented` 或 `speed_smooth`，原因 `R_SPLIT_FOR_RETIME`。
4. **字幕走旁路。** 两种格式里都不写字幕，字幕按 `handoff-profile.md` 3.2 节量化后写成 SRT，放在交接包的 `subtitles/` 里。损失报告记 `subtitle_text_timing`，原因 `R_SUB_MANUAL_IMPORT`。
5. **读回比对。** 和 FCPXML 一样，导出器测试要把生成的文件解析回剪辑表，与工程投影出的剪辑表逐条比较，零帧偏差。

## 2. OTIO（`resolve-18.5-otio`）

### 2.1 结构

写 OpenTimelineIO 0.17 的 JSON，`.otio` 文件：

```text
Timeline.1
├─ global_start_time   时间线起始时码，换成帧数
├─ metadata.zsir       工程 ID、修订、导出 ID
└─ tracks: Stack.1
   └─ children: 先视频轨（第一条在最下），再音频轨
      └─ Track.1 (kind: Video | Audio)
         └─ children: Clip.2 | Gap.1 | Transition.1，按时间顺序，空白用 Gap 填满
```

### 2.2 片段

| zsir-cut | OTIO |
|---|---|
| 片段 | `Clip.2`，`name` 取 `label`，没有就取素材名 |
| 源区间 | `source_range`：`start_time` 是源起始时码换成的帧数加 `source_start` 的帧数，按素材帧率；`duration` 是片段时长 |
| 素材 | `media_references.DEFAULT_MEDIA` 是 `ExternalReference.1`，`target_url` 是百分号编码的 `file://` 地址，`available_range` 是素材全长；`active_media_reference_key` 为 `DEFAULT_MEDIA` |
| 恒定变速 | `effects` 里一个 `LinearTimeWarp.1`，`time_scalar` 是速度 |
| 定格 | `FreezeFrame.1` |
| 倒放 | `LinearTimeWarp.1`，`time_scalar` 为负数 |
| ID | `metadata.zsir`：`clip_id`、`occurrence_id`，拆段时加 `segment` |
| 增益、声道选择、画面变换 | OTIO 没有字段，原值写进 `metadata.zsir`，损失报告记 `unsupported`，原因 `R_FORMAT_NO_FIELD` |

### 2.3 转场与标记

- 叠化写成两个片段之间的 `Transition.1`，`transition_type` 为 `SMPTE_Dissolve`。`in_offset` 是剪点之前占用的时长，`out_offset` 是剪点之后占用的时长：`center` 各占一半，`start` 全在剪点之后，`end` 全在剪点之前。
- 时间线标记写在 `Stack.1` 的 `markers` 里，`Marker.2`：`marked_range` 是位置和时长，`name` 是文字，`metadata.zsir.kind` 是标记类型。

### 2.4 待实测（Resolve 21.1）

| 项 | 要核实的 |
|---|---|
| 起始时码 | `global_start_time` 是否被识别为时间线起始时码 |
| 混合帧率 | 25 帧素材在 29.97 时间线里是否按源帧率读取 `source_range` |
| 倒放 | 负的 `time_scalar` 是否生效 |
| 标记 | 栈上的标记是否导入为时间线标记 |
| 媒体重链接 | 中文、空格、百分号路径能否直接找到素材 |

## 3. FCP7 XML（`premiere-25-xmeml-5`）

### 3.1 结构

```text
xmeml version="5"
└─ sequence
   ├─ name、duration（帧）、rate（timebase、ntsc）
   ├─ timecode：rate、string（起始时码）、frame、displayformat（DF 或 NDF）
   └─ media
      ├─ video：format，再按轨道顺序的 track
      └─ audio：按轨道顺序的 track
```

### 3.2 片段

每个片段一个 `clipitem`：

| 元素 | 取值 |
|---|---|
| `start`、`end` | 序列入点、出点，帧 |
| `in`、`out` | 源入点、出点，按素材自身帧率的帧，从素材第一帧算起 |
| `file` | 第一次出现时写完整的 `file`：`pathurl`（`file://localhost/` 加百分号编码路径）、`rate`、`duration`、`timecode`、`media`；以后只写 `<file id="..."/>` 引用 |
| `link` | 同一个 `occurrence_id` 的视频和音频片段互相写 `link`，保持 J/L cut 时的同步关系 |
| `logginginfo/lognote` | `zsir-cut clip=… occ=…` |
| 增益 | `filter` 里的 Audio Levels |
| 画面变换 | `filter` 里的 Basic Motion（缩放、旋转、中心）和 Crop |
| 恒定变速、倒放、定格 | `filter` 里的 Time Remap，分段时先按第 1 节拆片段 |
| 声道选择 | 音频片段的 `sourcetrack` 指明取哪个声道 |

空白不需要 gap 元素，`start` 不连续即可。

### 3.3 转场与标记

- 叠化写成 `transitionitem`：`start`、`end` 是占用的序列区间，`alignment` 按对齐方式直接写 `center`、`start` 或 `end`，不用 `start-black` 和 `end-black`；`effect` 名称和 ID 都是 `Cross Dissolve`。
- 时间线标记写在 `sequence` 的 `marker` 里：`name`、`comment`、`in`、`out`。

### 3.4 待实测（Premiere 25.5）

| 项 | 要核实的 |
|---|---|
| Audio Levels | 参数是线性倍数还是分贝 |
| Basic Motion | 中心坐标的单位和原点 |
| Crop | 参数是百分比还是像素 |
| Time Remap | 恒定变速、倒放、定格的参数写法 |
| 丢帧时码 | 29.97 丢帧的起始时码是否正确 |
| 链接 | J/L cut 后视音频是否仍保持链接 |

## 4. 损失报告的固定条目

不论工程内容如何，下面的条目按实际出现的元素生成：

| 能力 | OTIO | xmeml |
|---|---|---|
| `subtitle_text_timing` | `approximated`，`R_SUB_MANUAL_IMPORT` | 同左 |
| `subtitle_style` | `approximated`，`R_STYLE_NOT_REPRESENTABLE` | 同左 |
| `gain` | `unsupported`，`R_FORMAT_NO_FIELD` | 保留，不记 |
| `transform` | `unsupported`，`R_FORMAT_NO_FIELD` | 保留，不记 |
| `speed_segmented` | `approximated`，`R_SPLIT_FOR_RETIME` | 同左 |
| `speed_smooth` | `approximated`，`R_SPLIT_FOR_RETIME` | 同左 |
| `ext_data` | 写进 `metadata.zsir`，不记 | `unsupported`，`R_EXT_DROPPED` |
