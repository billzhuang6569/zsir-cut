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
| 源区间 | `source_range`：`start_time` 是源起始时码换成的帧数加 `source_start` 的帧数，按素材帧率；`duration` 是片段时长。倒放段见下方「倒放」 |
| 素材 | `media_references.DEFAULT_MEDIA` 是 `ExternalReference.1`，`target_url` 是**不编码的本地绝对路径**，不加 `file://`，空格、中文、`%` 原样保留，与 Resolve 21 原生导出一致。百分号编码的 `file://` 地址会让 Resolve 21.1 找不到全部素材。`available_range` 是素材全长；`active_media_reference_key` 为 `DEFAULT_MEDIA` |
| 恒定变速 | `effects` 里一个 `LinearTimeWarp.1`，`time_scalar` 是速度 |
| 定格 | `FreezeFrame.1` |
| 倒放 | 写成复合片段：一个 `Stack.1`（`name` 取片段名，`metadata` 只放 `zsir`，`source_range` 起点 0、时长为片段时长，`effects` 里一个 `time_scalar` 为 -1.0 的 `LinearTimeWarp.1`），里面一条同类 `Track.1`，放一个**正向**的 `Clip.2`，源区间从这一段最小的源时间开始。Resolve 21.1 对直接加负速度的 `Clip` 会从素材末尾倒着取帧，起点写在哪一侧都不生效；复合片段写法实测取帧与 timeline-schema 4.5 一致 |
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
| 倒放 | 直接给 `Clip` 加负速度时取错帧（25 帧工程在 01:00:52:00 显示 002199），改起点也无效。改为 2.2 的复合片段后，25 帧显示 1099、1049、1000，丢帧工程 01:00:43;10 显示 1049，与 4.5 一致（2026-10-28，Claude 用 Resolve 脚本接口实测） |
| 画面变换 | 按 2.5 写入后，Resolve 读到缩放 0.5、旋转 5°，位移和裁切按画面比例正确。数值写成整数（`1`、`5`）时整份文件导入失败，必须写成带小数点的形式 |
| 导入失败排查 | Resolve 遇到不认的写法时只给出「OTIO 文件无法解析」，没有具体位置。已知两种触发：Resolve 私有字段里本应是小数的数值写成整数；复合片段上带 `Resolve_OTIO` 元数据 |
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

单位：Pan、Tilt、Crop 是画面宽或高的比例，与本工程 `transform` 相同，已实测。

**数值格式**：`Parameter Value`、`Default Parameter Value`、`minValue`、`maxValue` 一律写成带小数点的 JSON 数，例如 `1.0`、`5.0`、`0.0`，即使值是整数。Resolve 21.1 遇到整数会拒绝整份文件。导出自检必须检查这一点。

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
| `link` | 同一个 `occurrence_id` 的视频和音频片段组成一组，组里**每个** `clipitem` 都写全组的 `link`，包括指向自己的那条。每条 `link` 含 `linkclipref`、`mediatype`、`trackindex`（从 1 数）、`clipindex`（该轨里第几个 `clipitem`，从 1 数）。Premiere 25.4 实测：只在一侧写链接时，主画面与对应声音没有链接 |
| `logginginfo/lognote` | `zsir-cut clip=… occ=…` |
| 增益 | `filter` 里的 Audio Levels（`effectid` 为 `audiolevels`，参数 `level`） |
| 画面变换 | `filter` 里的 Basic Motion（`effectid` 为 `basic`）和 Crop（`effectid` 为 `crop`）。`scale` 为百分比，只写这一个缩放参数，不写分轴缩放。`rotation` 写 `−rotation_deg`：FCP7 和 Premiere 顺时针为正，FCP 和本工程逆时针为正。`center` 的 `horiz` 写 `position[0]`、`vert` 写 `−position[1]`：画面中心为 0，整个画面宽高为 1，向下为正。`crop` 的 `left`、`right`、`top`、`bottom` 为百分比。依据：Premiere 25.4 实测，旧写法把 `center` 乘了 2、没反转纵轴，导致插入画面偏到右上方越界；`crop` 读入正确 |
| 恒定变速、倒放、定格 | `filter` 里的 Time Remap（`effectid` 为 `timeremap`），分段时先按第 1 节拆片段。变速片段的 `in`、`out` 按**变速后**的时间计：`out − in` 等于 `end − start`。正放时 `in = 源入点 ÷ 速度`。倒放时 `reverse` 为 TRUE，FCP7 把整段素材倒过来编号，所以 `in = (素材总帧数 − 源出点) ÷ 速度`，源出点是这一段最大的源帧（不含）。定格不用 `freeze` 参数（Premiere 25.4 忽略它），改用 `variablespeed` 为 1 的 Time Remap，在 `graphdict` 参数里写两个关键帧：片段起点和终点都映射到定格的源帧。依据：Premiere 25.4 实测，旧写法导致两倍速段开头黑屏（入点超出素材）、倒放取错帧（25 帧工程 52:00 显示 001199）、定格继续前进 |
| 声道选择 | 音频片段的 `sourcetrack` 指明取哪个声道 |

空白不需要 gap 元素，`start` 不连续即可。

### 3.3 转场与标记

- 叠化写成 `transitionitem`：`start`、`end` 是占用的序列区间，`alignment` 按对齐方式直接写 `center`、`start` 或 `end`，不用 `start-black` 和 `end-black`；`effect` 名称和 ID 都是 `Cross Dissolve`。
- 时间线标记写在 `sequence` 的 `marker` 里：`name`、`comment`、`in`、`out`。

### 3.4 待实测（Premiere 25.5）

| 项 | 要核实的 |
|---|---|
| `clipitem` 计时 | Premiere 25.4 实测：普通片段、J cut、叠化、起止时码、同名素材都正确；混合帧率素材在线、取帧正确 |
| 定格的 `graphdict` 写法 | Premiere 是否按关键帧定格 |
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
| `transform` | 保留：写成 Resolve 私有效果（见 2.5），不记损失 | 保留，不记 |
| `speed_segmented` | `approximated`，`R_SPLIT_FOR_RETIME` | 同左 |
| `speed_smooth` | `approximated`，`R_SPLIT_FOR_RETIME` | 同左 |
| `ext_data` | 写进 `metadata.zsir`，不记 | `unsupported`，`R_EXT_DROPPED` |
