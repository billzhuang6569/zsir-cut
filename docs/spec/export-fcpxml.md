# FCPXML 映射 v0.1

状态：草案 · 2026-10-26 · 依赖 `timeline-schema.md`、`handoff-profile.md`
适用 profile：`fcp-11-fcpxml-1.13`、`fcp-10.6-fcpxml-1.11`，以及 Resolve 的候选 `resolve-21-fcpxml-1.11`

本文定义怎样把 zsir-cut 工程的一条时间线写成 FCPXML。依据是 FCP 12.4 应用包里的 1.13 DTD，以及 GitHub 上由 FCP 真实导出的文件。没有真实导出佐证的写法列在第 11 节「待实测」，1.11 合并前逐条核实。

## 1. 原则

1. 时间直接写成规格里的有理数秒，写法与 FCPXML 相同，例如 `1001/30000s`，不做浮点换算。
2. 以 FCP 的主故事情节为骨架：第一条视频轨是主故事情节，其余轨道都是挂在它上面的连接片段。
3. 每个片段、字幕都带上 zsir-cut 的 ID，导回时靠它重新匹配。
4. 同一个工程、同一个 profile、同一个导出器版本，输出逐字节相同。

## 2. 文档骨架

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.13">
  <resources> 格式、素材、效果 </resources>
  <library>
    <event name="zsir-cut">
      <project name="工程名 · 时间线名">
        <sequence ...> <spine> ... </spine> </sequence>
      </project>
    </event>
  </library>
</fcpxml>
```

1.11 profile 只改 `version`，元素和属性相同。两个版本都要通过对应 DTD 校验。

## 3. 资源

资源 ID 按出现顺序编为 `r1`、`r2`……：先时间线格式，再按 `media[]` 顺序的各素材格式，然后素材，最后效果。

**格式**：`<format id frameDuration width height>`。`frameDuration` 是帧率的倒数，例如 25 帧写 `1/25s`，29.97 写 `1001/30000s`。不写 `name`。静帧图片用不带 `frameDuration` 的格式。

**素材**：每个 `media[]` 条目一个 `<asset>`：

| 属性 | 取值 |
|---|---|
| `id` | 资源 ID |
| `name` | `media.name`，没有就取文件名 |
| `start` | 源起始时码换算成的秒数，按素材自己的帧率和丢帧规则换算。没有起始时码写 `0s` |
| `duration` | `media.duration`；静帧图片写 `0s` |
| `hasVideo`、`hasAudio` | 按 `media.video`、`media.audio` 是否存在 |
| `format` | 该素材的格式 ID |
| `audioSources`、`audioChannels`、`audioRate` | 有音频时写 `1`、声道数、`48000` |

`<asset>` 内放 `<media-rep kind="original-media" src="file:///绝对路径"/>`。路径按 RFC 3986 百分号编码，中文、空格和 `%` 都要编码，`/` 不编码。

**效果**：用到叠化时声明 `<effect id name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>`。

## 4. 序列

`<sequence format duration tcStart tcFormat audioLayout="stereo" audioRate="48k">`：

- `tcStart` 是时间线起始时码换算的秒数，`tcFormat` 按 `drop_frame` 写 `DF` 或 `NDF`。
- `duration` 是时间线总长：所有轨道上最晚的片段出点。
- 下文的「序列时刻 t」指 zsir-cut 的序列时间。写进主故事情节时，偏移量一律是 `tcStart + t`。

## 5. 主故事情节

第一条视频轨的片段按时间顺序放进 `<spine>`。片段之间、开头和末尾的空白用 `<gap>` 填满，保证主故事情节覆盖整个 `[0, duration)`，这样任何连接片段都有可挂靠的对象。`<gap>` 的 `start` 写成和它的 `offset` 相同。

每个主故事情节片段写成 `<asset-clip>`：`ref` 指向素材，`offset` 是 `tcStart + timeline_start`，`start` 是 `asset.start + source_start`，`duration` 是片段时长。

**音视频配对**：同一个 `occurrence_id` 在第一条音频轨上有且只有一个音频片段，并且两者的时间映射相同时，把它们写成同一个 `<asset-clip>`，`srcEnable="all"`。音频的入出点和视频不同时，就是 J/L cut，用 `audioStart` 和 `audioDuration` 表示：`audioStart` 是 `asset.start + 音频片段的 source_start`，`audioDuration` 是音频片段时长。不满足配对条件时，主故事情节片段写 `srcEnable="video"`，音频作为连接片段另写。

## 6. 连接片段

除主故事情节片段和已配对的音频外，所有片段都写成连接片段，挂在「包含它入点的那个主故事情节元素」上。入点正好落在两个元素交界时，挂在后一个上。

- **lane**：第 2、3……条视频轨依次是 `1`、`2`……。第 1、2……条音频轨上没配对的片段依次是 `-1`、`-2`……。
- **offset**：按父元素的本地时间计算，等于 `父元素的 start + (t − 父元素的序列入点)`。
- 视频连接片段写 `srcEnable="video"`，音频连接片段写 `srcEnable="audio"`。
- 其余属性与主故事情节片段相同。

## 7. 片段属性

| zsir-cut | FCPXML |
|---|---|
| `enabled: false` | `enabled="0"` |
| `gain_db` | `<adjust-volume amount="-3dB"/>` |
| `source_channels` | `<audio-channel-source srcCh="1, 2"/>`，声道号从 1 开始 |
| `transform.scale` | `<adjust-transform scale="0.5 0.5"/>` |
| `transform.rotation_deg` | `<adjust-transform rotation="5"/>`，与缩放写在同一个元素里 |
| `transform.position` | `<adjust-transform position="x y"/>`，单位换算见第 11 节 |
| `transform.crop` | `<adjust-crop mode="trim"><trim-rect left top right bottom/></adjust-crop>`，单位换算见第 11 节 |
| `label` | 片段的 `name` |
| ID | 片段末尾 `<metadata>` 里两条 `<md>`：`com.zsir-cut.clip-id`、`com.zsir-cut.occurrence-id`；配对时再加 `com.zsir-cut.audio-clip-id` |

## 8. 变速

有 `time_map` 的片段不直接写成 `<asset-clip>`，而是包在一个 `<clip>` 里，这和 FCP 真实导出的结构一致：

```xml
<clip offset="片段在父元素里的位置" duration="片段时长" name="...">
  <timeMap>
    <timept time="0s" value="关键点源时间 − 最小源时间" interp="linear"/>
    ...
  </timeMap>
  <asset-clip ref="..." offset="0s" start="asset.start + 最小源时间" duration="最大源时间 − 最小源时间" .../>
</clip>
```

- `timept` 的 `time` 是片段内时间，从 0 开始；`value` 是内层素材片段的时间，从 0 开始。
- 插值：`linear` 写 `linear`；`smooth` 写 `smooth2`。
- `hold` 段写成两个 `value` 相同的连续关键点。前一个点之后的段为定格。
- 倒放就是 `value` 递减。
- 包装后的 `<clip>` 照常带 ID 元数据、可以作为主故事情节元素或连接片段。

## 9. 转场

只支持主故事情节上两个相邻片段之间的叠化。在两片段之间插入：

```xml
<transition name="Cross Dissolve" offset="..." duration="...">
  <filter-video ref="叠化效果 ID" name="Cross Dissolve"/>
</transition>
```

`offset` 按对齐方式：`center` 是 `tcStart + 剪点 − 时长/2`，`start` 是 `tcStart + 剪点`，`end` 是 `tcStart + 剪点 − 时长`。两侧片段的 `offset` 和 `duration` 不因转场改变。其他轨道上的转场一期不支持，写进损失报告。

## 10. 字幕、标记

**字幕**：每条字幕轨按 `timeline-schema.md` 5.2 节投影，再按 `handoff-profile.md` 3.2 节量化。每条投影结果写成一个 `<caption>`，挂在包含其入点的主故事情节元素上：

```xml
<caption lane="N" offset="..." duration="..." start="0s" role="SRT?captionFormat=SRT.zh-Hans">
  <text><text-style ref="ts1">第一行&#10;第二行</text-style></text>
  <text-style-def id="ts1"><text-style/></text-style-def>
  <note>zsir-cut cue=cue_zh_03 occ=occ_2</note>
</caption>
```

- `lane` 排在视频连接片段之后：第 k 条字幕轨是视频连接 lane 数加 k。
- 换行用换行符。样式在字幕里表达不了，写进损失报告 `subtitle_style`。
- 独立字幕条也写成 `<caption>`，`note` 里的 `cue` 写它自己的 ID，不写 `occ`。
- `text-style-def` 的 ID 在全文件内按顺序编号。

**标记**：挂在包含它的主故事情节元素上，`start` 用父元素本地时间。`note`、`todo`、`review` 写 `<marker value="文字">`，`todo` 加 `completed="0"`；`chapter` 写 `<chapter-marker value="文字">`。

## 11. 待实测

以下写法没有找到 FCP 真实导出作为佐证。1.11 实现后，先用三个标准工程导出，再由 Bill 在 FCP 12.4 里导入核对，结果写回本节，有问题就改规格。

| 项 | 当前写法 | 要核实的 |
|---|---|---|
| 位移单位 | `position` 暂按「时间线高度的百分比」换算 | FCP 的实际单位 |
| 裁切单位 | `trim-rect` 暂按「源画面尺寸的百分比」 | FCP 的实际单位 |
| 字幕语言代码 | `SRT.zh-Hans`、`SRT.en` | FCP 是否接受 `zh-Hans`，不接受时的替代写法 |
| 静帧素材 | 不带 `frameDuration` 的格式、`duration="0s"` | 能否正常导入 |
| 声道选择 | `audio-channel-source srcCh` | 只取声道 1 是否生效 |
| 混合帧率 | 不写 `conform-rate` | 25 帧素材在 29.97 时间线里的取帧是否符合预期 |
| 自定义元数据 | `com.zsir-cut.*` 的 `md` 键 | 导入后再从 FCP 导出，这些键是否保留 |
| 包装变速 | 第 8 节的 `<clip>` 结构 | 分段、定格、倒放的画面是否与条码一致 |
| 叠化位置 | 两侧片段位置不变 | 剪点位置是否保持 |

## 12. 读回比对

导出器测试必须把生成的 FCPXML 解析回「剪辑表」：每个视频和音频片段的序列入点、出点、源入点、源出点、素材 ID。再与工程投影出的剪辑表逐条比较，必须零帧偏差。这一步在 CI 里跑，DTD 校验只在本地跑，因为 DTD 是 Apple 的文件，不能进公开仓库。
