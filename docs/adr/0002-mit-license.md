# ADR-0002 MIT 开源，依赖按许可证筛选

状态：已采纳 · 2026-10-21

## 背景

希望项目能被团队之外的人使用和二次开发，也希望能与 FilmCraft、WeftCut、BashCut 等宽松许可的项目互通。调研里与我们最接近的 OpenChatCut 是 AGPL，只能借鉴思路不能抄代码。

## 决策

本仓库用 MIT 许可证。依赖只用 MIT、Apache-2.0、BSD、ISC 许可的库。GPL、AGPL 工具（例如带 GPL 组件的 FFmpeg 构建）只能作为子进程调用。模型权重单独审查许可证，不自动下载非商用权重。

## 后果

- AGENTS.md 要求每个新依赖在 PR 里写明许可证。
- 团队品牌 Skill、客户词表、API key 留在本地配置，不进仓库。
- 仓库已于 2026-10-26 转为公开。原计划第 2 步之后再公开，提前的原因是私有仓库的 GitHub Actions 受账号额度限制，CI 无法运行。

## 考虑过的其他方案

- AGPL：能防止被闭源利用，但会挡住大部分互通和商用场景。
- 闭源：与「外部 Agent 自由接入」的定位冲突。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「已定决策」「许可证与风险」。
