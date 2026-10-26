# ADR-0004 macOS（Apple Silicon）优先

状态：已采纳 · 2026-10-26

## 背景

团队机器以 Mac 为主，精修用 FCP 最多。FCP 只有 macOS 版。本地语音识别在 Apple Silicon 上可以走 MLX。

## 决策

一期只保证 macOS Apple Silicon。Windows 兼容放到第 2 步之后。代码不故意写死平台，路径处理和子进程调用按跨平台方式写，但不为 Windows 做测试和验收。

## 后果

- CI 的纯逻辑测试可以在 Linux 跑；涉及 MLX、FCP 的验收在 Bill 的 Mac 上做。
- Windows 上的 Premiere 和 Resolve 用户一期不保证可用。

## 考虑过的其他方案

- 同时支持 Windows：要多一套推理后端（CUDA）和多一倍验收，一期收益小。

依据：2026-10-26 Bill 的回答。
