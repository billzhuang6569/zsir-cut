# zsir-cut 工作计划

状态：草案 v1 · 2026-10-26
依据：[开源技术选型调研](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)（2026-10-21）与之后的分步讨论。

## 一句话定位

给剪辑师和 Agent 共用的「时间线中间站」：Agent 在这里把粗剪和字幕做完，人在这里审批和微调，然后一键交给 NLE 收尾。我们不做第四个 NLE，也不做生成式「选题到成片」流水线。

## 已定决策

| 决策 | 结论 |
|---|---|
| 首发形态 | Claude Code Skill + CLI 先行，桌面 UI 在无头内核跑通之后 |
| 许可证 | MIT。依赖按 MIT/Apache 兼容筛选，AGPL/GPL 组件只能以子进程方式调用 |
| 技术栈 | 内核、CLI、MCP 都用 TypeScript；后续桌面壳用 Tauri + TS，调用同一内核 |
| ASR / 对齐 worker | 独立子进程。本地默认 Qwen3-ASR 1.7B + Qwen3-ForcedAligner；云端兜底火山引擎语音识别，云端结果同样跑本地对齐 |
| 平台 | macOS（Apple Silicon）优先，本地推理走 MLX。Windows 推到第 2 步之后做兼容 |
| 交接宿主 | 一期 Final Cut Pro、DaVinci Resolve、Premiere Pro 三家都做单向导出 |
| 验收基线 | Final Cut Pro 先行（团队用得最多），再 Resolve，再 Premiere |
| Resolve 联动 | Studio 是 API 联动前提；免费版降级为文件导入并明示 |
| 产品范围 | 通用剪辑工具；首批验收素材用采访口播（ADR-0013）。暂不做 MG 包装和动态标题 |
| 桌面版 AI | 对话面板驱动用户本机的 Agent；「决定」写进工程（ADR-0014） |
| 直接导出 | 一期只做 SRT 和音频，成片放二期（ADR-0015） |

## 分工

- **Bill**：定产品取舍；提供真实素材和字幕正确稿；在自己机器上按检查单把导出工程导入三家 NLE，回填结果；批准 spec 变更和里程碑。
- **Claude（统筹与验收）**：写和改 spec；把工作拆成单 PR 大小的任务；通过 Codex 插件派发代码任务；用 `gh` 审 PR、看 CI；跑验收，把失败写成新的 fixture。Claude 不直接写功能代码，也不改 Codex 的代码。
- **Codex（实现）**：按 spec 和任务说明写代码与测试，一个任务一个 PR。

协作规则：

- trunk 加短生命周期分支，一个任务一个 PR。
- Codex 的 PR 描述必须写三件事：改了什么、跑了哪些 fixture、loss report 有什么变化。
- 任何涉及时间或格式的 bug，修复必须附带触发它的输入工程，防止回归。
- 所有 PR 由 Claude 验收后合并，并在 PR 里留验收记录。Bill 只在验收剪辑效果、Skill 剪辑效果和产品界面设计时介入，见 ADR-0012。

## 第 0 步：立合同，不写功能（约一周）

产物都是文档、schema 和测试工程，不含功能代码。按依赖顺序，每项一个 PR：

| 顺序 | PR | 作者 | 内容 |
|---|---|---|---|
| 0.1 | 本计划 | Claude | `docs/plan.md` |
| 0.2 | 时间线 schema | Claude | `docs/spec/timeline-schema.md` + `schema/timeline.schema.json` + 示例工程。有理数时间与整数 tick；`media_id / occurrence_id / clip_id` 三层身份；`schema_version` 与 `revision`；字幕作为一等轨道（五层），词 token 存源媒体时间 |
| 0.3 | 命令协议 | Claude | `docs/spec/command-protocol.md`：10–20 个动词签名；`base_revision / idempotency_key`；结果信封（status / changes / warnings / receipt / 「可能已提交但验证失败」）；编辑会话（草稿、审批、原子应用）；CLI 与 MCP 对等 |
| 0.4 | 交接 profile | Claude | `docs/spec/handoff-profile.md`：三家导出 profile 枚举（FCPXML 1.11–1.13、OTIO + SRT、FCP7 xmeml + SRT）；交接包目录结构；`loss-report.json` schema；四级 validation |
| 0.5 | Agent 约定与 ADR | Claude | `AGENTS.md`（给 Codex 的仓库约定、分支、PR 必附测试）+ `docs/adr/` 每条已定决策一篇 |
| 0.6 | 测试工程规格 | Claude | `docs/spec/fixtures.md`：标准小工程与采访评测集的规格和验收数字 |
| 0.7 | 工程脚手架 | Codex | pnpm workspace、TypeScript 配置、CI（schema 校验示例工程、lint、单测） |
| 0.8 | 测试工程生成器 | Codex | 按 0.6 规格用 ffmpeg 生成合成素材：每帧烧 asset ID 与源帧号；25 与 30000/1001 两套含 DF/NDF；非零起始时码；J/L cut；同源三次使用且 in/out 不同；中文、空格、百分号路径；同名不同内容文件。媒体不进 git，由脚本复现 |

采访口播评测集：10 条团队真实采访素材加人工校对的字幕正确稿，覆盖单机位、双机位、中英混说、品牌词和数字。素材放本地，不进仓库，仓库里只放清单和校验值。

第 0 步完成标准：四份 spec 合并；示例工程能过 schema 校验；生成器能在一台干净的 Mac 上复现全部合成素材。

## 第 1 步：无头内核加导出，走 CLI（约两周）

每个模块一个 PR，Codex 实现，CI 用 fixture 对 golden 文件比对，Claude 审 diff 和 loss report。

详细拆分见 [docs/tasks/step-1.md](tasks/step-1.md)。下面七条是概要。

1. 时间线读写与校验（`inspect`、`validate`）。
2. `edit` 动词：有序操作列表、dry-run、revision 冲突检测、undo。
3. FCPXML 导出器加损失报告。这是验收基线，字幕用 `<caption>`，用 DTD 校验。
4. OTIO + SRT 导出器（Resolve）。
5. FCP7 xmeml + SRT 导出器（Premiere）。
6. ASR / 对齐 worker：Qwen3-ASR 1.7B（MLX）本地，火山引擎 API 兜底，统一输出词级 token。
7. CLI 收口，与 MCP 对等的接口测试。

每个导出器合并后，Bill 按检查单在 FCP、Resolve、Premiere 里实机导入，结果回填到交接包的 `host_import` 字段。逐切点 0 帧偏差、source in/out 无静默错位才算通过。

## 第 2 步：Skill 首发，真项目跑通（一到两周）

详细拆分见 [docs/tasks/step-2.md](tasks/step-2.md)。第 1 步已于 2026-10-28 完成，第 2 步已于 2026-10-29 完成，收尾情况和遗留问题都记在那里。

写 SKILL.md：一个路由 skill，加粗剪、字幕、交接复核三个子 skill。用一个真实采访项目走完「素材、转写、Agent 粗剪、字幕校对、导出 FCP 接手版」，Resolve 和 Premiere 各导一份做对照。

通过标准沿用调研里的验收情景：把一组采访整理成三分钟，优先讲核心观点，去掉重复表达，保留必要停顿，按客户词表校正字幕。成功不是产出一个 MP4，而是：删掉的内容可追溯；字幕跟着留下的语音走；每段素材在 FCP 里仍能重新修剪；不能保留的部分在交接前就写进损失报告。

这一步会暴露协议设计的问题，在这里修比做完 UI 再修便宜得多。

## 第 3 步：设计，再前端

产品设计、界面布局和路线图见 [docs/product.md](product.md)。任务拆分见 [docs/tasks/step-3.md](tasks/step-3.md)。顺序：产品设计与界面设计稿定稿（Bill 验收）→ `design.md` → 规格修订（补齐界面需要的动词和数据）→ Codex 用 Tauri + TS 按面板实现，调用同一内核，不另起一套逻辑。

## 第 4 步：稳定化

把验收矩阵做成 CI 门禁：逐切点 0 帧、移盘后重链接、音频脉冲同步、字幕不随剪辑漂移、重复导入幂等。每个里程碑打 tag，`CHANGELOG` 记录三家 NLE 版本的兼容状态。

## 一期不做

- 自研编解码和调色。
- 生成式成片流水线。
- 直接导出成片 MP4，放二期（ADR-0015）。
- 多机位，放二期，见 `docs/product.md` 第 7 节。
- MG 包装、动态标题、复杂特效。
- NLE 导回与往返（先单向交接加版本快照）。
- 用浏览器自动化或 CEP 文件轮询控制 NLE。

## 待 Bill 提供

- 10 条采访素材和字幕正确稿（第 0.6、0.8 步之后用于评测）。
- 三家 NLE 的具体版本号，以及 Resolve 是 Free 还是 Studio，写进交接 profile 的宿主版本表。
- 客户词表样例一份，用于字幕校正验收。

## 开放问题

- Resolve 免费版的降级路径：只做文件导入，还是附带非官方桥接脚本并标明限制。
- 云端字幕兜底的触发方式：检测到资源不足时自动提示，还是只在设置里手动切换。
