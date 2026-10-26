# ADR-0011 自建最小内核，不 fork 现有编辑器

状态：已采纳 · 2026-10-26

## 背景

调研评估了 FilmCraft、OpenReel、WeftCut、BashCut 等可 fork 的底座，并列出 fork 前要满足的六条门槛。首发改为 Skill + CLI 后，一期不需要图形编辑器，底座的主要价值变成数据模型和命令设计。

## 决策

一期自己写最小内核：时间线读写与校验、编辑命令、投影、修订日志、导出器。借鉴而不 fork：FilmCraft 的工程格式与命令总线、WeftCut 的单写者和 dry-run、OpenChatCut 的编辑会话思路（AGPL，只借鉴不抄代码）。第 3 步做界面时，再按调研的六条门槛评估是否引入底座。

## 后果

- 一期没有现成的预览和播放能力，预览靠 ffmpeg 渲染代理视频。
- 数据模型完全由我们的 spec 决定，不受底座内部结构牵制。

## 考虑过的其他方案

- fork FilmCraft：许可证友好、交换格式最全，但是 Rust 且仍是 alpha。
- fork OpenReel：TS 路线，但工程格式没有文档，存在浏览器存储里。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「fork 决策门槛与首轮验证」；分步讨论最后一轮「重点从比底座变成自己写最小内核」。
