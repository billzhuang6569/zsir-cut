# AGENTS.md

给在本仓库写代码的 Agent（主要是 Codex）。开始任何任务前读完本文。

## 项目是什么

zsir-cut（庄Sir剪辑助手）是剪辑师和 AI Agent 共用的时间线中间站：Agent 做粗剪和字幕，人审批微调，然后交给 Final Cut Pro、DaVinci Resolve、Premiere Pro 收尾。一期是无头内核加 CLI 加 Claude Code Skill，没有桌面 UI。

## 分工

- **Bill**：产品决策，批准 spec 变更和里程碑，在真实 NLE 里做实机验收。
- **Claude**：写 spec、拆任务、审 PR、跑验收。不写功能代码。
- **你（Codex）**：按 spec 和任务说明实现，一个任务一个 PR。不合并自己的 PR。

## 先读什么

按顺序：

1. `docs/plan.md`：工作计划和当前所处的步骤。
2. `docs/product.md`：产品设计、界面布局和路线图。界面相关任务必读。
3. `docs/spec/timeline-schema.md`：工程文件结构。
4. `docs/spec/command-protocol.md`：动词、结果信封、修订与幂等。
5. `docs/spec/handoff-profile.md`：导出、交接包、损失报告。
6. `docs/adr/`：已定决策和理由。
7. 任务说明本身。

## spec 是合同

- `docs/spec/`、`docs/adr/`、`docs/plan.md`、`schema/` 下已有的文件，`design/`（从设计系统同步的变量和参考实现），以及 `tools/acceptance/`（Claude 的独立验收工具），你只读不改。
- 实现中发现 spec 有矛盾、遗漏或做不到的地方，不要自己绕过，也不要改 spec。在 PR 描述的「spec 问题」一节写清楚，按最保守的理解实现，或者停下来只交问题说明。
- 例外：任务说明明确让你新建的 schema 文件，例如 `schema/command.schema.json`，按对应 spec 写。
- 错误码、校验规则编号、状态值、动词名必须与 spec 完全一致，不新增。

## 技术栈

| 项 | 选择 |
|---|---|
| 语言 | TypeScript，`strict` 全开，ES 模块 |
| 运行时 | Node.js 24 LTS |
| 包管理 | pnpm workspace |
| 测试 | Vitest |
| 格式与检查 | Biome |
| JSON Schema 校验 | Ajv（draft 2020-12）加 ajv-formats |
| 语音识别与对齐 worker | Python 子进程，单独目录，见 ADR-0005 |

工程结构在第 0.7 步脚手架任务里建立，目标形态如下，偏离要在 PR 里说明理由：

```text
packages/core        时间线模型、校验、编辑、投影、修订与日志
packages/exporters   fcpxml、otio、xmeml 导出器与损失报告
packages/cli         zcut 命令行
packages/mcp         MCP server，与 CLI 共用 core，不另写逻辑
packages/app-host    桌面版宿主进程：给界面的本机通道、MCP（含界面动词），见 ADR-0016
packages/desktop     桌面版界面：React + Vite，只显示和交互
apps/desktop-tauri   桌面版窗口壳：Tauri 2
workers/asr          Python：识别、对齐
fixtures/            测试工程、生成器、golden 文件、回归用例
schema/  docs/  examples/
```

## 硬规则

1. **时间不用浮点。** 时间、帧率、变速一律用有理数运算，内部用 `bigint`。工程文件里的时间字符串按 `timeline-schema.md` 2.1 节的规范形式读写。任何地方出现 `parseFloat` 处理时间都是缺陷。
2. **同样的输入得到同样的字节。** 工程文件序列化和导出文件都必须确定。不要在输出里写当前时间、随机数或机器路径，除非 spec 要求，例如清单里的 `created_at`。
3. **CLI 与 MCP 对等。** 两者调用同一个 core 函数，返回同一个结果信封，用测试保证。
4. **写入只有一条路径。** 所有修改都经过 core 的编辑入口，包括修订检查、幂等、校验和日志。不准在别处直接写工程文件。
5. **不删除、移动、改写素材文件。**
6. **依赖许可证。** 只用 MIT、Apache-2.0、BSD、ISC 许可的依赖。GPL、AGPL 的工具只能作为子进程调用，不能链接或打包。新增依赖要在 PR 里列出名称、版本和许可证。
7. **测试不联网。** 单元测试和 CI 不访问网络，不依赖本机安装的 NLE。
8. **大文件不进 git。** 媒体文件由 `fixtures/` 里的生成器复现。
9. **不碰网络与代理配置。** 本机靠 Clash Verge 代理上网。不修改任何代理、系统网络、DNS、hosts 或全局 shell 配置。需要联网的命令，单条设置 `HTTPS_PROXY=http://127.0.0.1:7897`。

## 测试要求

- 每个 PR 带测试。新功能要有单元测试；导出器要有 golden 文件比对。
- golden 文件放在 `fixtures/golden/`。改 golden 必须在 PR 描述里逐个说明为什么变。
- 任何涉及时间或格式的缺陷，修复时把触发它的最小输入工程加进 `fixtures/regressions/`，并写一个会因该缺陷失败的测试。
- 提交前本地跑通：`pnpm install`、`pnpm lint`、`pnpm test`。脚手架建好后，以根目录 `package.json` 的脚本为准。

## 分支、提交与 PR

- 主干是 `main`，只通过 PR 合并。
- 分支名：`codex/<任务编号>-<简短英文>`，例如 `codex/0.7-scaffold`。
- 一个任务一个 PR，尽量小。做不完就交能独立合并的一部分，并在 PR 里写清剩余部分。
- 提交信息用前缀：`feat`、`fix`、`test`、`refactor`、`chore`、`docs`，后面用中文或英文描述都可以。

PR 描述必须包含以下各节，没有内容就写「无」：

```markdown
## 改了什么
## 跑了哪些测试和 fixture
## golden 与损失报告的变化
## 新增依赖
## spec 问题
```

## 不确定时

先查 spec 和 ADR。查不到、需要做产品取舍的，在 PR 的「spec 问题」里提出，不要自己定。
