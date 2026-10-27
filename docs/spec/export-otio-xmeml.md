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
├─ global_start_time   时间线起始时码，换成帧数（丢帧见 2.2）
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
| 源区间 | `source_range`：`start_time` 是源起始时码换成的帧数加 `source_start` 的帧数，按素材帧率；`duration` 是片段时长。倒放段的 `start_time` 取这一段源区间里**最小**的源时间（也就是倒放结束处），与 Resolve 21 原生导出一致；写成起点那一侧的源时间，Resolve 会取错帧 |
| 素材 | `media_references.DEFAULT_MEDIA` 是 `ExternalReference.1`，`target_url` 是**不编码的本地绝对路径**，不加 `file://`，空格、中文、`%` 原样保留，与 Resolve 21 原生导出一致。百分号编码的 `file://` 地址会让 Resolve 21.1 找不到全部素材。`available_range` 是素材全长；`active_media_reference_key` 为 `DEFAULT_MEDIA` |
| 恒定变速 | `effects` 里一个 `LinearTimeWarp.1`，`time_scalar` 是速度 |
| 定格 | `FreezeFrame.1` |
| 倒放 | `LinearTimeWarp.1`，`time_scalar` 为负数 |
| ID | `metadata.zsir`：`clip_id`、`occurrence_id`，拆段时加 `segment` |
| 画面变换 | 写 Resolve 的私有效果，见 2.5。原值同时保留在 `metadata.zsir` |
| 增益、声道选择 | OTIO 没有字段，原值写进 `metadata.zsir`，损失报告记 `unsupported`，原因 `R_FORMAT_NO_FIELD` |

**时间线起始时码**：`global_start_time.rate` 是时间线帧率。不丢帧时，`value` 是起始时码换成的帧数。丢帧时，`value` 按起始时码的**字面数字**用整数帧率（29.97 记 30）换算，例如 `01:00:00;00` 写 `108000`，不写真实帧数 `107892`。原因：Resolve 21.1 导入 OTIO 时按不丢帧解释这个数，写 107892 会得到 `00:59:56;12`（实测）；它自己导出时却写 107892，导入导出不对称。素材的 `source_range` 和 `available_range` 不受影响，仍用真实帧数（实测素材在线、取帧正确）。

### 2.3 转场与标记

- 叠化写成两个片段之间的 `Transition.1`，`transition_type` 为 `SMPTE_Dissolve`。`in_offset` 是剪点之前占用的时长，`out_offset` 是剪点之后占用的时长：`center` 各占一半，`start` 全在剪点之后，`end` 全在剪点之前。
- 时间线标记写在 `Stack.1` 的 `markers` 里，`Marker.2`：`marked_range` 是位置和时长，`name` 是文字，`metadata.zsir.kind` 是标记类型。

### 2.4 Resolve 21.1 实测（2026-10-27）

| 项 | 结果 |
|---|---|
| 起始时码 | 25 帧正确。丢帧按 2.2 写字面帧数后正确，写真实帧数会错成 00:59:56;12 |
| 媒体重链接 | 百分号编码的 `file://` 地址全部离线；改成不编码绝对路径后全部在线 |
| 普通片段、定格 | 帧号正确 |
| 倒放 | 起点写成起点一侧的源时间时取错帧，已按 2.2 改为最小源时间，待复测 |
| 画面变换 | 只写在 `metadata.zsir` 时 Resolve 不读，已按 2.5 改写，待复测 |
| 轨道结构 | 轨道名和分层保留；分段变速拆成多段，片段数比原工程多，属预期 |
| 混合帧率、标记、字幕 | 待复测 |

### 2.5 Resolve 私有效果（画面变换）

每个有 `transform` 的片段，在 `effects` 里追加 `Effect.1`，`effect_name` 为 `Resolve Effect`，参数放在 `metadata.Resolve_OTIO`，格式照 Resolve 21 原生导出：

```json
{"Effect Name": "Transform", "Name": "变换", "Enabled": true, "Display Type": 1, "Type": 2,
 "Parameters": [{"Parameter ID": "transformationZoomX", "Parameter Value": 0.5, "Default Parameter Value": 1.0,
                 "Variant Type": "Double", "Key Frames": {}, "minValue": 0.0, "maxValue": 100.0}, ...]}
```

| zsir-cut | Transform 参数 | 默认值 |
|---|---|---|
| `scale` | `transformationZoomX`、`transformationZoomY` | 1.0 |
| `position[0]`（画面宽度的比例） | `transformationPan`，数值相同 | 0.0 |
| `position[1]`（画面高度的比例） | `transformationTilt`，数值相同 | 0.0 |
| `rotation_deg` | `transformationRotationAngle` | 0.0 |

裁切写第二个 `Effect.1`，`Effect Name` 为 `Cropping`、`Name` 为 `裁切`、`Type` 照原生导出：`cropLeft`、`cropRight` 取 `crop.left`、`crop.right`（源画面宽度的比例），`cropTop`、`cropBottom` 取 `crop.top`、`crop.bottom`（源画面高度的比例），默认值 0.0。

单位推导：Resolve 把我们的 FCPXML 导入后再导出 OTIO，Pan、Tilt、Crop 的值正好等于「像素偏移除以画面宽或高」，与本工程 `transform` 的比例单位相同。只有一个样本，待复测确认。

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
| `rate` | 序列帧率。`clipitem` 的计时一律用序列帧率，素材自身帧率只写在 `file/rate` |
| `start`、`end` | 序列入点、出点，帧 |
| `in`、`out` | 源入点、出点，按 `clipitem` 的 `rate`（即序列帧率）计的帧，从素材第一帧算起。纯音频素材同样用帧，不用采样数。源时间不在这个帧网格上时，四舍五入到最近一帧（正中间取较大），并记一条损失：`clip_cut`、`approximated`、`warning`、`R_GRID_ROUNDED` |
| `file` | 第一次出现时写完整的 `file`：`pathurl`（`file://localhost/` 加百分号编码路径）、`rate`、`duration`、`timecode`、`media`；以后只写 `<file id="..."/>` 引用 |
| `link` | 同一个 `occurrence_id` 的视频和音频片段互相写 `link`，保持 J/L cut 时的同步关系 |
| `logginginfo/lognote` | `zsir-cut clip=… occ=…` |
| 增益 | `filter` 里的 Audio Levels（`effectid` 为 `audiolevels`，参数 `level`） |
| 画面变换 | `filter` 里的 Basic Motion（`effectid` 为 `basic`：`scale`、`rotation`、`center`）和 Crop（`effectid` 为 `crop`：`left`、`right`、`top`、`bottom`）。参数单位待实测，先按 FCP7 惯例：`scale` 为百分比，`rotation` 为度，`center` 的 `horiz`、`vert` 以画面中心为原点、半个画面宽高为 1，`crop` 为百分比 |
| 恒定变速、倒放、定格 | `filter` 里的 Time Remap（`effectid` 为 `timeremap`：`speed` 百分比、`reverse`、`freeze`），分段时先按第 1 节拆片段 |
| 声道选择 | 音频片段的 `sourcetrack` 指明取哪个声道 |

空白不需要 gap 元素，`start` 不连续即可。

### 3.3 转场与标记

- 叠化写成 `transitionitem`：`start`、`end` 是占用的序列区间，`alignment` 按对齐方式直接写 `center`、`start` 或 `end`，不用 `start-black` 和 `end-black`；`effect` 名称和 ID 都是 `Cross Dissolve`。
- 时间线标记写在 `sequence` 的 `marker` 里：`name`、`comment`、`in`、`out`。

### 3.4 待实测（Premiere 25.5）

| 项 | 要核实的 |
|---|---|
| `clipitem` 计时 | `rate` 取序列帧率、`in`/`out` 按序列帧计，混合帧率素材（25 帧素材放进 29.97 序列、30 帧录屏放进 25 帧序列）取帧是否正确 |
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
