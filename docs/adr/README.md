# 架构决策记录（ADR）

每篇记录一个已定决策：为什么这样定、放弃了什么、带来什么后果。决策变了不改旧文，写一篇新的，把旧文状态改为「已被 ADR-xxxx 取代」。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-skill-cli-first.md) | 首发形态：Skill + CLI 先行，UI 在无头内核之后 | 已采纳 |
| [0002](0002-mit-license.md) | MIT 开源，依赖按许可证筛选 | 已采纳 |
| [0003](0003-typescript-stack.md) | TypeScript 内核，桌面壳后续用 Tauri + TS | 已采纳 |
| [0004](0004-macos-first.md) | macOS（Apple Silicon）优先 | 已采纳 |
| [0005](0005-asr-engine.md) | 字幕引擎：本地 Qwen3，云端火山引擎兜底 | 已采纳 |
| [0006](0006-three-hosts-fcp-baseline.md) | 三家 NLE 单向导出，FCP 为验收基线 | 已采纳 |
| [0007](0007-resolve-studio.md) | Resolve 联动以 Studio 为前提 | 已采纳 |
| [0008](0008-interview-first.md) | 首批场景：采访口播 | 被 0013 取代 |
| [0009](0009-division-of-labor.md) | 分工：Claude 统筹验收，Codex 实现 | 合并规则被 0012 取代 |
| [0010](0010-rational-time-and-time-map.md) | 有理数时间与时间映射 | 已采纳 |
| [0011](0011-own-kernel.md) | 自建最小内核，不 fork 现有编辑器 | 已采纳 |
| [0012](0012-continuous-delivery.md) | 连续推进：Claude 自行验收合并 | 已采纳 |
| [0013](0013-general-purpose-product.md) | 产品通用，首批验收用采访 | 已采纳 |
| [0014](0014-chat-panel-and-decisions.md) | 桌面版内置对话面板驱动本机 Agent；「决定」写进工程 | 已采纳 |
| [0015](0015-direct-export-scope.md) | 直接导出：一期只做 SRT 和音频，成片放二期 | 已采纳 |
| [0016](0016-desktop-architecture.md) | 桌面版架构：Tauri 窗口 + Node 宿主进程 | 已采纳 |
| [0017](0017-steps-and-subtitle-overlay.md) | 步骤管理器与字幕叠层进一期 | 已采纳 |

模板：

```markdown
# ADR-xxxx 标题

状态：已采纳 · YYYY-MM-DD

## 背景
## 决策
## 后果
## 考虑过的其他方案
```
