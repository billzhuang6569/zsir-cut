---
version: alpha
name: 庄Sir剪辑助手
description: 剪辑师和 Agent 共用的时间线剪辑台。深色、安静、内容优先；颜色只用来表达含义。
colors:
  bg: "#0A0A0A"
  bg-viewer: "#000000"
  bg-timeline: "#141414"
  panel: "#171717"
  panel-2: "#1F1F1F"
  raised: "#262626"
  raised-2: "#303030"
  lane: "#222222"
  line: "#2A2A2A"
  line-strong: "#404040"
  text: "#F5F5F5"
  text-2: "#D4D4D4"
  text-3: "#A6A6A6"
  text-4: "#919191"
  text-off: "#5C5C5C"
  primary: "#FFFFFF"
  on-primary: "#0A0A0A"
  accent: "#A8E4F2"
  accent-soft: "#1C3138"
  cream: "#F6F0C4"
  focus: "#A8E4F2"
  attention: "#F5B544"
  attention-soft: "#33270F"
  approved: "#5BD1A8"
  approved-ink: "#8BE3C4"
  approved-soft: "#14302A"
  on-approved: "#0A1A14"
  info: "#A8E4F2"
  info-soft: "#1C3138"
  danger: "#FF8A7A"
  danger-soft: "#3A1C18"
  playhead: "#FFFFFF"
  selection: "#FFFFFF"
  track-video: "#2A2A2A"
  track-video-line: "#3A3A3A"
  track-video-ink: "#F5F5F5"
  track-audio: "#CDE8B5"
  track-audio-line: "#B3D696"
  track-audio-ink: "#0A0A0A"
  track-audio-wave: "#5E7A48"
  track-subtitle: "#A8E4F2"
  track-subtitle-line: "#8ACFE0"
  track-subtitle-ink: "#0A0A0A"
  marker-chapter: "#F6F0C4"
  file-fcpxml: "#C9B8FF"
  file-otio: "#A8D0FF"
  file-xml: "#B8B8FF"
  file-srt: "#D4D4D4"
  file-mov: "#A8E4F2"
  file-wav: "#CDE8B5"
  file-mp4: "#FFB3A6"
  scrim: "rgba(0, 0, 0, 0.72)"
  surface: "{colors.panel}"
  on-surface: "{colors.text}"
  neutral: "{colors.accent}"
  secondary: "{colors.attention}"
  tertiary: "{colors.approved}"
  error: "{colors.danger}"
typography:
  display:
    fontFamily: Manrope
    fontSize: 30px
    fontWeight: 600
    lineHeight: 36px
  headline:
    fontFamily: Manrope
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
  title:
    fontFamily: Manrope
    fontSize: 15px
    fontWeight: 600
    lineHeight: 22px
  heading:
    fontFamily: Manrope
    fontSize: 13px
    fontWeight: 600
    lineHeight: 20px
  overline:
    fontFamily: Manrope
    fontSize: 11px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: 0.06em
  body:
    fontFamily: Manrope
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  label:
    fontFamily: Manrope
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
  caption:
    fontFamily: Manrope
    fontSize: 11px
    fontWeight: 400
    lineHeight: 14px
  mono-lg:
    fontFamily: Manrope
    fontSize: 13px
    fontWeight: 500
    lineHeight: 20px
    fontFeature: "'tnum' 1"
  mono-sm:
    fontFamily: Manrope
    fontSize: 11px
    fontWeight: 400
    lineHeight: 14px
    fontFeature: "'tnum' 1"
rounded:
  xs: 6px
  sm: 8px
  md: 10px
  lg: 16px
  xl: 20px
  full: 9999px
spacing:
  space-1: 4px
  space-2: 8px
  space-3: 12px
  space-4: 16px
  space-5: 20px
  space-6: 24px
  space-8: 32px
  space-12: 48px
  window-pad: 8px
  topbar-h: 48px
  rail-w: 72px
  panel-w: 300px
  inspector-w: 340px
  toolbar-h: 44px
  track-header-w: 40px
  track-h: 30px
  control-h: 32px
  row-h: 36px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
    padding: "0 14px"
  button-primary-hover:
    backgroundColor: "#FFFFFF"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
    padding: "0 12px"
  section-overline:
    textColor: "{colors.text-3}"
    typography: "{typography.overline}"
  button-secondary-hover:
    backgroundColor: "{colors.panel-2}"
  button-approve:
    backgroundColor: "{colors.approved}"
    textColor: "{colors.on-approved}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
  button-icon:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-3}"
    rounded: "{rounded.sm}"
    size: "32px"
  button-icon-active:
    backgroundColor: "{colors.raised-2}"
    textColor: "{colors.text}"
  input-field:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
    padding: "0 10px"
  segmented:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-3}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
  segmented-selected:
    backgroundColor: "{colors.raised-2}"
    textColor: "{colors.text}"
  tab:
    textColor: "{colors.text-3}"
    typography: "{typography.label}"
    height: "36px"
  tab-selected:
    textColor: "{colors.text}"
  rail-item:
    textColor: "{colors.text-3}"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    size: "48px"
  rail-item-selected:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.on-primary}"
  window:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.xl}"
    padding: "{spacing.window-pad}"
  panel-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  track-lane:
    backgroundColor: "{colors.lane}"
    rounded: "{rounded.xs}"
    height: "{spacing.track-h}"
  slider-active:
    backgroundColor: "{colors.accent}"
    height: "4px"
  chip-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  preset-selected:
    backgroundColor: "{colors.cream}"
    size: "2px"
  chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "24px"
    padding: "0 10px"
  chip-attention:
    backgroundColor: "{colors.attention-soft}"
    textColor: "{colors.attention}"
  chip-approved:
    backgroundColor: "{colors.approved-soft}"
    textColor: "{colors.approved-ink}"
  chip-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
  list-row:
    textColor: "{colors.text-2}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "{spacing.row-h}"
    padding: "8px 10px"
  list-row-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  card:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-4}"
  decision-card:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-4}"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.space-6}"
  tooltip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  clip-video:
    backgroundColor: "{colors.track-video}"
    textColor: "{colors.track-video-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    height: "{spacing.track-h}"
  clip-audio:
    backgroundColor: "{colors.track-audio}"
    textColor: "{colors.track-audio-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    height: "{spacing.track-h}"
  clip-subtitle:
    backgroundColor: "{colors.track-subtitle}"
    textColor: "{colors.track-subtitle-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    height: "32px"
  clip-video-border:
    backgroundColor: "{colors.track-video-line}"
    size: "1px"
  clip-audio-border:
    backgroundColor: "{colors.track-audio-line}"
    size: "1px"
  clip-audio-wave:
    backgroundColor: "{colors.track-audio-wave}"
    width: "2px"
  clip-subtitle-border:
    backgroundColor: "{colors.track-subtitle-line}"
    size: "1px"
  clip-selected:
    backgroundColor: "{colors.selection}"
    size: "2px"
  playhead:
    backgroundColor: "{colors.playhead}"
    width: "1px"
  timeline:
    backgroundColor: "{colors.bg-timeline}"
    textColor: "{colors.text-4}"
    typography: "{typography.mono-sm}"
  ruler-chapter-marker:
    backgroundColor: "{colors.marker-chapter}"
    size: "8px"
  preview-viewer:
    backgroundColor: "{colors.bg-viewer}"
    textColor: "{colors.text}"
    typography: "{typography.mono-lg}"
  divider:
    backgroundColor: "{colors.line}"
    height: "1px"
  button-secondary-border:
    backgroundColor: "{colors.line-strong}"
    size: "1px"
  button-danger:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control-h}"
  chip-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  field-label:
    textColor: "{colors.text-4}"
    typography: "{typography.label}"
  control-disabled:
    textColor: "{colors.text-off}"
  focus-ring:
    backgroundColor: "{colors.focus}"
    size: "2px"
  dialog-scrim:
    backgroundColor: "{colors.scrim}"
  file-badge-fcpxml:
    backgroundColor: "{colors.file-fcpxml}"
    textColor: "{colors.on-primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
  file-badge-otio:
    backgroundColor: "{colors.file-otio}"
    textColor: "{colors.on-primary}"
  file-badge-xml:
    backgroundColor: "{colors.file-xml}"
    textColor: "{colors.on-primary}"
  file-badge-srt:
    backgroundColor: "{colors.file-srt}"
    textColor: "{colors.on-primary}"
  file-badge-mov:
    backgroundColor: "{colors.file-mov}"
    textColor: "{colors.on-primary}"
  file-badge-wav:
    backgroundColor: "{colors.file-wav}"
    textColor: "{colors.on-primary}"
  file-badge-mp4:
    backgroundColor: "{colors.file-mp4}"
    textColor: "{colors.on-primary}"
---

# 庄Sir剪辑助手 · 设计规范

本文件按 Google DESIGN.md（alpha）格式写成：开头的 YAML 是规范值，下面的文字说明怎么用，两者冲突时以 YAML 为准。界面设计稿放在「庄Sir剪辑助手 UI 设计工作台」画布里，都照本文件画。

## Overview

**一句话：黑底上浮着几块圆角卡片的创作工具。** 风格参考近年的创作类剪辑工具：近黑色的窗口上浮着几块大圆角卡片：左边是功能区，右上是预览和参数区，右下是贯通的时间线，彼此留一道窄缝。画面和素材缩略图是主角，界面本身只用黑、白、灰。

- **给谁用。** 剪辑师和他们的 Agent（Claude Code、Codex）。人在这里看、做决定、微调，Agent 在这里执行。
- **感觉。** 利落、现代、有点潮，但不花哨。大圆角、纯灰、白色主按钮、细描边的次要按钮、小胶囊标签。
- **两个亮色，各管一件事。** 冰蓝（ice）表示「选中、正在编辑」：选中的字幕条、拖动中的滑块、焦点环。奶油黄（cream）只用在图标栏的当前项和选中的预设上。除此之外，彩色只用来表达状态：琥珀＝需要你，青绿＝已确认，珊瑚＝出错。
- **图标优先。** 图标栏是图标加一行小字；工具栏、轨道头只放图标，悬停给提示。
- **白色等于「你在这里」。** 播放头、选中片段的外框和拖动把手都是白色。
- **通用，不写死题材。** 文案、轨道名、默认值都不假设是采访或口播。

## Colors

整套界面只有深色主题，灰色不带色偏（纯中性灰）。

- **地面（Grounds）**：窗口是近黑 `bg` (#0A0A0A)，三块浮动卡片是 `panel` (#171717)，卡片里的小卡和分组是 `panel-2` (#1F1F1F)，输入框、搜索框、小标签、选中行是 `raised` (#262626)，按下的按钮是 `raised-2` (#303030)。时间线上每条轨道是一根圆角的空槽 `lane` (#222222)，片段放在槽上。预览画面背后是纯黑 `bg-viewer`。
- **文字（Text）**：`text` (#F5F5F5) 标题，`text-2` 正文，`text-3` 次要信息和未选中图标，`text-4` (#919191) 标签和时间码。`text-4` 在 `raised` 上仍有 4.8:1。`text-off` 只用于禁用和装饰。
- **主按钮（Primary）**：纯白 #FFFFFF，黑字。每屏最多一个，例如顶栏的「导出」。
- **冰蓝 Accent (#A8E4F2)**：选中、正在编辑、引用。选中的字幕条、滑块已选段、焦点环、@素材标签、链接。时间线上的字幕片段也是冰蓝。
- **奶油 Cream (#F6F0C4)**：只用在图标栏当前项的方块底和选中预设的外框，上面放黑色图标。别处不用。
- **状态色**：琥珀 `attention` (#F5B544) 需要你处理；青绿 `approved` (#5BD1A8) 已确认；珊瑚 `danger` (#FF8A7A) 删除和出错，只做文字和图标。
- **轨道与片段**：视频片段是缩略图条（底色 `track-video`）；声音片段是浅青柠 `track-audio` 加深绿波形；字幕片段是冰蓝 `track-subtitle` 加黑字。三者明度和样子都不同，色弱用户也分得开。章节标记用奶油色。
- **文件类型**：导出面板里文件图标底部的色带，每种格式一个颜色（`file-*`）。

对比度（都已计算）：正文 `text-2`/`panel` 12.1:1；`text-4`/`panel` 5.7:1；黑字/冰蓝 14.2:1；黑字/奶油 17.1:1；琥珀/`panel` 9.9:1；字幕片段文字 14.2:1。

## Typography

**Manrope** 负责英文和数字，**Noto Sans SC** 负责中文（macOS 上回退到苹方）。Manrope 的字形略圆，和大圆角卡片同一个气质，又比 Inter 少见。时间码和数字用 Manrope 的等宽数字（`tnum`），数字跳动时不晃。

| 级别 | 字号/行高 | 字重 | 用在哪 |
|---|---|---|---|
| `display` | 30/36 | 600 | 开始页标题，一屏最多一个 |
| `headline` | 20/28 | 600 | 对话框标题 |
| `title` | 15/22 | 600 | 面板标题、卡片标题、一级章节 |
| `heading` | 13/20 | 600 | 面板内的小节、去处名称 |
| `overline` | 11/14 | 600 | 网格和列表上方的分组标题；英文全大写、字距 0.06em |
| `body` | 13/20 | 400 | 默认：对话、字幕文字、选项 |
| `label` | 12/16 | 500 | 字段名、按钮文字、标签页、小标签 |
| `caption` | 11/14 | 400 | 提示、图标栏文字、缩略图名称 |
| `mono-lg` | 13/20 | 500 | 预览区时间码 |
| `mono-sm` | 11/14 | 400 | 标尺、列表开始时间、时长、规格 |

规则：一个面板里最多三个级别；只用 400、500、600 三种字重；中文不加字距；英文的分组标题和按钮可以全大写（例如 EXPORT），中文不需要。

## Layout

一个窗口，近黑底，三块浮动卡片，基准尺寸 1440×900，最小 1280×760。

```
┌──────────────── 顶栏 48（直接在黑底上）─────────────────┐
│ 图标栏 │┌ 功能区 300 ┐┌──── 剪辑区（自适应）────┐┌ 参数区 340 ┐│
│  72   ││            ││ 预览                    ││            ││
│ 黑底  ││            ││ 播放控制               ││            ││
│       ││            ││ 工具栏 44               ││            ││
│       ││            ││ 时间线                  ││            ││
│       │└────────────┘└────────────────────────┘└────────────┘│
└──────────────────────────────────────────────────────────────┘
```

- **黑底**：窗口四周留 8px 黑边，卡片之间留 8px 缝。顶栏和图标栏直接放在黑底上，不加卡片。
- **图标栏**（72 宽）：AI、素材、章节、字幕、语音，图标 20 加一行 11px 小字。当前项是 48×48 的奶油色圆角方块、黑色图标。底部是历史和设置。
- **功能区卡片**（300）：发起操作、设参数。**参数区卡片**（340）：左边功能的结果和属性。左边换功能，右边跟着换。
- **剪辑区卡片**：上面是预览（画面 12 圆角），下面一行播放控制，再下面是工具栏和时间线。预览和时间线在同一张卡片里，中间可以拖动分界线。
- **时间线**：每条轨道是一根 30 高的圆角空槽（字幕轨 26 高），轨道之间留 6px。左边一列只放图标（声音轨的喇叭、视频轨的眼睛），不写轨道名；悬停显示「视频 A」等名字。
- 间距按 4px 网格：控件之间 8，字段之间 12，卡片内边距 16，对话框内边距 24。

## Elevation & Depth

层级靠**黑底上的卡片**和**明暗**表达，不靠阴影：`bg` 黑底 < `panel` 卡片 < `panel-2` 卡片里的分组 < `raised` 输入框和选中项 < `raised-2` 按下。卡片之间用黑缝分开，卡片内部尽量不画分割线，需要时用 1px `line`。

阴影只有两处：菜单、悬停提示、弹出框用 `shadow-popover` 加 1px `line` 边框；对话框用 `shadow-dialog`，背后盖 `scrim`。

## Shapes

大圆角，层级越高圆角越大：

- `xs` 6px：时间线片段和轨道槽、标签、色块
- `sm` 8px：按钮、输入框、下拉框、分段控件、列表行
- `md` 10px：缩略图、卡片里的小卡、菜单、预设格子
- `lg` 16px：三块浮动卡片、预览画面
- `xl` 20px：对话框、窗口外框
- `full`：小标签、开关、状态圆点、头像

图标是 1.5px 线条、圆头圆角，24 网格画，按 16 或 20 显示。

## Components

YAML 里的 `components` 是每个组件的规范值，这里写怎么用。

- **按钮**：主按钮纯白黑字，一屏一个；次要按钮是透明底加 1px `line-strong` 细描边（参考图里的 EXPORT 样式）；幽灵按钮无底，悬停变 `panel-2`；批准按钮青绿底，只用于「批准」；删除用珊瑚色文字。图标按钮 32×32，选中时 `raised-2` 底。
- **图标栏项**：72 宽的列里放 48×48 的方块，图标 20，下面一行 11px 小字。当前项：奶油色方块、黑色图标，小字变白。有待处理事项时右上角加琥珀圆点。
- **标签页**：选中项白字加 2px 白色下划线；面板内的二级切换用分段控件。
- **分段控件**：`raised` 底的胶囊，选中段 `raised-2`。
- **输入框、搜索框、下拉框**：`raised` 底、无描边、8 圆角，聚焦时 2px 冰蓝外环。搜索框左边放大镜。
- **小标签（chip）**：胶囊形，24 高，`raised` 底、`text-2` 字，可以横排成一行快速筛选（参考图里的 blur / zoom 那一行）。状态版：琥珀、青绿、冰蓝、珊瑚。
- **开关、滑块**：开关开启时白色轨道、黑色圆点；滑块轨道 `raised-2`，已选段冰蓝，白色圆形把手，右边跟一个可直接改的数值。
- **缩略图网格**：素材和预设用 3 列（窄面板 2 列）网格，10 圆角的方图，下面一行 11px 名字；分组上方用 `overline` 标题。选中项加 2px 白框。
- **列表行**：至少 36 高，行高随文字增长，绝不压到下一行。悬停 `panel-2`，选中 `raised`。字幕列表里正在编辑的那条左边时间变冰蓝。行尾操作只在悬停或编辑时出现。
- **决定卡片**：`panel-2` 底、10 圆角。问题一行，选项是可点的整行（推荐项排第一，带「推荐」小标签），选中项白色描边；最后一行是「其他想法」输入框。
- **时间线片段**：放在轨道槽上，6 圆角。视频是缩略图条；声音是浅青柠加波形；字幕是冰蓝加黑字。选中片段两端出现白色把手（6×16 的竖条，带 ‹ › 小箭头），外框 2px 白色。审阅标记是片段上方的琥珀小三角。
- **播放头**：1px 白线，顶部是白色圆角小方块，里面没有字。
- **悬停提示**：`raised` 底，11px，带快捷键提示（`kbd` 小方块）。
- **对话框**：20 圆角，内边距 24，标题 `headline`。右上角关闭，底部右对齐按钮。
- **空状态**：一个 40px 线条图标、一句说明、最多一个按钮。

## Do's and Don'ts

- 要：三块卡片浮在黑底上，之间留 8px 黑缝。
- 要：每屏只有一个白色主按钮；其余用细描边或幽灵按钮。
- 要：冰蓝只表示「选中、正在编辑、引用」，奶油只用在图标栏当前项和选中预设上。
- 要：图标按钮都有悬停提示和读屏名称。
- 要：时间码用等宽数字，预览写 `时:分:秒:帧`，列表写 `分:秒`。
- 要：长文字换行，容器跟着变高。
- 要：要读的文字对比度至少 4.5:1；`text-off` 不用于要读的文字。
- 不要：渐变、玻璃拟态、发光效果、彩色大背景。
- 不要：卡片加彩色左边框；用表情符号当图标。
- 不要：在卡片里套卡片超过两层。
- 不要：把冰蓝或奶油当装饰色用。
- 不要：在文案里写死「采访」「口播」等题材。

## Iconography

线条图标：1.5px 描边、圆头圆角、24 网格，显示为 16（工具栏、行内）或 20（图标栏）。颜色跟随文字：未选中 `text-3`，选中和悬停 `text`；在奶油或白色底上用 `on-primary` 黑色。常用图标：AI（火花）、素材（胶片）、章节（书签列表）、字幕（字幕框）、语音（话筒）、历史（时钟）、设置（滑杆）、选择、切割（剪刀）、标记（旗）、撤销、重做、吸附（磁铁）、播放、导出。

**软件图标**：凡是指代某个软件的地方（剪辑软件、Agent、导出去处、设置里的工具列表），一律用 [syvixor/skills-icons](https://github.com/syvixor/skills-icons)（MIT）的图标，用它的深色版（去掉随系统切换的样式）。目前用到：Claude Code、Codex、DaVinci Resolve、Premiere Pro、CapCut（剪映）。图标库里没有 Final Cut Pro，桌面版运行时从本机安装的 FCP 里读图标（ADR-0016），仓库里不放。软件图标是圆角方块，按 16（行内）、24（列表）、32–36（卡片和选项）显示，不改颜色、不加描边；库里没有的软件，用中性底的线条图标代替，不自己画仿品。

## Motion

动效只用来说明「东西从哪来、到哪去」。悬停和按下 80ms；面板切换、展开 160ms；对话框出现 200ms。曲线一律 ease-out。不做弹跳和装饰动画；AI 工作中的小圆点 1.2 秒呼吸。

## Voice

界面文案用短句、动词开头、说人话：「导出」「重新识别」「批准这一版」。数字带单位，时间带格式。错误提示写清「发生了什么」和「怎么办」。英文只出现在软件名（Final Cut Pro）、格式名（SRT）和全大写的英文分组标题里。
