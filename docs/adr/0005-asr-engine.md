# ADR-0005 字幕引擎：本地 Qwen3，云端火山引擎兜底

状态：已采纳 · 2026-10-21

## 背景

调研里真实中文会议音频上 Whisper 的字错率约 20%，不能做中文默认引擎。Qwen3-ASR 和 Qwen3-ForcedAligner 是 Apache-2.0，Mac 上可走 MLX，强制对齐能给词级时间。

## 决策

- 本地默认：Qwen3-ASR 1.7B 识别，Qwen3-ForcedAligner 对齐，中文按 jieba 聚词。内存不超过 16 GB 的机器用 0.6B。
- 云端兜底：火山引擎语音识别，在设置里配置。云端结果同样跑本地对齐器，保证词级时间来源一致。
- worker 是独立的 Python 子进程，放在 `workers/asr`，通过命令行和 JSON 与内核交换数据，输出写入母稿的第 1、3 层。
- 默认引擎最终以团队评测集上的结果为准，不引用别人的数字。

## 后果

- 需要一套 Python 环境，安装说明要写清楚。
- 对齐器原始刻度约 80 ms，词级时间不等于逐帧精确，逐词动效要人工确认。
- 资源不足时默认只提示，用户在本地配置里开启 `asr.cloud_fallback` 后才自动切到云端，见 `docs/spec/asr-worker.md` 第 3 节（2026-10-26 定）。
- 未决：火山引擎之外要不要第二家兜底。

## 考虑过的其他方案

- whisper.cpp：英文好，中文差，保留为兜底。
- SenseVoice：CPU 上中文可用，保留为兜底。
- 纯云端：素材要上传，与「本地原片优先」冲突。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「字幕技术栈」「已定决策」。
