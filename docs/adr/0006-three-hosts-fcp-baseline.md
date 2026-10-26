# ADR-0006 三家 NLE 单向导出，FCP 为验收基线

状态：已采纳 · 2026-10-26

## 背景

团队三款软件都用，FCP 最多。三家里只有 Resolve Studio 有能双向读写时间线的外部 API；FCP 没有任何 API，只能用 FCPXML 推入；Premiere 读不了 FCPXML，只认 FCP7 XML。

## 决策

一期对 FCP、Resolve、Premiere 都做单向导出。验收基线是 FCP：交换层先在 FCP 上做到逐切点零偏差，再做 Resolve，再做 Premiere。导回和往返放到第二期。profile 与验证规则见 `docs/spec/handoff-profile.md`。

## 后果

- 第 1 步第一个导出器是 FCPXML，字幕用 `<caption>`。
- FCP 的主故事情节和连接片段语义要专门建模，不能把轨道号直接当 lane。
- FCP 无法程序化导出，以后的导回只能靠用户手动导出或 Share Destination。

## 考虑过的其他方案

- 只做 Resolve：它是唯一有 API 且原生支持 OTIO 的，但团队用 FCP 最多。
- 以 Resolve 为基线：调研原建议如此，按团队实际使用情况改为 FCP。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「推荐交换策略」。2026-10-26 Bill 确认 FCP 用得最多。
