# ADR-0007 Resolve 联动以 Studio 为前提

状态：已采纳 · 2026-10-21

## 背景

Resolve 21.1 起高级脚本需要 Studio，第三方应用无法从外部连接免费版。社区有在免费版里跑桥接脚本的绕法，但非官方，随时可能失效。

## 决策

API 级联动（第二期的 `resolve-21-api` profile）只支持 Studio。免费版用户走文件导入：导出 OTIO 或 FCPXML 加 SRT，由用户手动导入，并在界面上明示。应用启动时探测已安装的 Resolve 是 Free 还是 Studio、版本号、脚本 API 是否可达。

## 后果

- 一期本来就只做文件导出，这条决策主要约束第二期。
- 未决：免费版是只做文件导入，还是附带非官方桥接脚本并标明「能用到不能用为止」。

## 考虑过的其他方案

- 依赖社区桥接脚本支持免费版：体验好，但不可控。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「DaVinci Resolve」「已定决策」。
