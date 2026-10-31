# 字幕第 4 轮：对标剪映

来源：Bill 2026-10-31 要求字幕的分行、界面交互、编辑操作、样式全面对标剪映，Agent 能调用所有操作。决策见 ADR-0022，规格见 `docs/spec/subtitle-editing.md`。

共同约定沿用 `step-3.md`「3.8 起的共同约定」。可以改写移植的参考代码（MIT）在 `.tmp/ref/opencut-classic`、`.tmp/ref/openreel-video`；slate-transcript-editor 的拆行合并逻辑只看做法即可（`handle-split-paragraph`、`handle-delete-in-paragraph`）。移植的代码按 `polish-1.md` 的规定保留版权声明并写进 `THIRD_PARTY_NOTICES.md`。参考代码里的时间都是浮点秒，移过来必须改成有理数。

`schema/` 里的新字段和 `split_token` 已由 Claude 写好，照着实现，不要改 schema。

## 任务

| 编号 | 内容 | 前置 | 验收 |
|---|---|---|---|
| S4.1 | 宿主动词 `subtitle_tidy`、`subtitle_proofread` 的框架：范围、`request`、`accepted` 加 `pass_id`、`ui_state.subtitle_pass`、`E_SUB_PASS_RUNNING`；`subtitle_tidy` 完整实现（规格 2.1）。两个动词在宿主的 MCP 里提供 | — | 用假 Agent：选 3 条重新分行只改这 3 条所在范围，带 `request` 时提示词里有这句；跑的时候再调返回 `E_SUB_PASS_RUNNING`；失败不写入、`reason` 可读；历史里是一步「AI 重新分行」 |
| S4.2 | 概要和校对：自动流程三步（规格第 1 节）、`subtitle_proofread` 完整实现（2.2）、提示词同步 Skill 3.1 和 3.2 节、`ext["zsir.proofread"]` 标记、两个新警告；字幕面板顶部状态「分行 3/6」「校对 2/6」 | S4.1 | 规格第 11 节「校对」各项测试；概要和分行同时开始；校对失败不影响分行结果；Claude 在 Bill 的采访副本上实跑，抽查改动都是错字 |
| S4.3 | 核心操作 `split_token`（规格第 3 节）；字幕列表像剪映一样编辑：直接在行里改、回车拆条、Shift+回车换行、行首退格合并、行尾 Delete、↑↓、Esc、撤销、多选和工具栏、右键菜单、AI 入口（4.5，调用 S4.1 的动词）、改过的字画虚线和「还原」（4.6）、查找的上一个下一个（4.7）；`ui_state.subtitle_selection` | S4.1 | 规格第 11 节「`split_token`」「列表」各项测试；在字词中间回车拆条后撤销一次回到原样；CLI 和 MCP 都能调 `split_token` |
| S4.4 | 时间线上的字幕片段：拖两端改显示时间、吸附、不越过相邻条、整条不能拖、右键恢复自动时间、双击进入列表编辑（规格第 5 节）。在已移植的 OpenCut 拖边代码（`timelineTrim.ts`）上扩展 | — | 规格第 11 节「时间线」各项测试；拖边是一步，能撤销 |
| S4.5 | 渲染器支持新的静态样式字段（斜体、下划线、字间距、对齐、多层描边、阴影、发光）；样式面板重排成规格第 9 节的「样式」子标签和「应用到」；预览上点选字幕、拖动位置、拖角缩放、居中吸附 | — | 渲染器 golden 图逐像素比对（Node）；预览和叠层导出用同一份代码；旧工程（只有 `outline`）导出的叠层和改动前逐像素相同 |
| S4.6 | 动画：渲染器加入场、出场、逐字（规格第 7 节），预览播放时逐帧画，叠层导出按画面状态出图；样式面板「动画」子标签；损失报告记 `R_STYLE_NOT_REPRESENTABLE`。逐字动画改写自 OpenReel `caption-animation-renderer.ts` | S4.5 | 每种动画三个时刻的 golden 图；带动画的工程导出两次逐像素相同；没有动画的工程导出不变 |
| S4.7 | 预设样式：至少 12 个、五组，样式面板顶部预设网格、悬停播放动画、套用规则（规格第 8 节）。预设的外观由 Claude 和 Bill 验收 | S4.6 | 套用后历史一步「套用样式：…」；`position` 不变；截图给 Bill 看 |

S4.1 和 S4.4、S4.5 可以同时做。S4.2、S4.3 在 S4.1 合并后做；S4.6 在 S4.5 之后；S4.7 最后。

## 验收

每个 PR 合并前，Claude 在 Bill 的采访副本上跑一遍桌面版，截图看界面，PR 里留验收记录。全部合并后，把测试 App 跑起来交给 Bill 实机看：分行、校对、列表编辑手感、样式、动画、预设。
