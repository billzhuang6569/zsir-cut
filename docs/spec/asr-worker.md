# 识别 worker 契约 v0.1

状态：草案 · 2026-10-26 · 依赖 ADR-0005、`timeline-schema.md` 第 5 节、`subtitle-rules.md`

识别与对齐 worker 是独立的 Python 子进程，放在 `workers/asr/`。内核通过命令行调用它，交换 JSON 文件，不共享内存，不互相导入代码。本文定义两者之间的接口。

## 1. 运行环境

- Python 3.12，依赖用 `workers/asr/pyproject.toml` 声明并锁定版本，许可证按 ADR-0002 筛选。
- 本地引擎：Qwen3-ASR（1.7B，内存 16 GB 及以下的机器用 0.6B）识别，Qwen3-ForcedAligner 对齐，在 Apple Silicon 上走 MLX。中文对齐结果按 jieba 分词聚成词。
- 云端引擎：火山引擎语音识别。凭据从环境变量 `ZSIR_VOLC_APP_ID`、`ZSIR_VOLC_ACCESS_TOKEN` 读取，不写进任何文件，不进仓库。
- 模型权重放在用户目录 `~/.zsir-cut/models/`，首次使用时下载，下载前核对许可证。

## 2. 命令

```text
python -m zsir_asr transcribe  --input <媒体> --channels 0 [--start <秒> --duration <秒>]
                               --language zh|en|auto --engine local|cloud|auto
                               [--model 1.7b|0.6b] [--hotwords <文件>] --out <结果.json>
python -m zsir_asr align       --input <媒体> --channels 0 --text <文本文件> --language zh|en --out <结果.json>
python -m zsir_asr probe       --out <结果.json>
python -m zsir_asr eval        --manifest <评测清单> --out <报告目录>
```

- `transcribe`：识别加对齐，一次完成。
- `align`：给定文字，只做对齐。用于人改字后重新对齐，以及给云端结果补对齐。
- `probe`：报告本机能用什么：芯片、内存、MLX 是否可用、已下载的模型、云端凭据是否已配置。只报告凭据「有没有」，不输出凭据内容。
- `eval`：在采访评测集上跑 `fixtures.md` 第 7 节的全部指标。

## 3. 引擎选择

隐私优先：音频默认不离开本机。

| `--engine` | 行为 |
|---|---|
| `local` | 只用本地引擎，失败就报错 |
| `cloud` | 只用云端，没配置凭据就报错 |
| `auto` | 先用本地。本地报 `E_ASR_OOM` 或 `E_ASR_MODEL_UNAVAILABLE` 时，**只有用户在本地配置里开启了云端兜底**，才改用云端；否则报错并建议开启 |

用户配置在 `~/.zsir-cut/config.json` 的 `asr.cloud_fallback`，默认 `false`。内核的 `transcribe` 动词默认传 `auto`。这一条解决了 ADR-0005 里「资源不足时自动提示还是手动切换」的开放问题：默认提示，用户明确开启后才自动切换。

云端结果一律再跑本地 `align`，保证词级时间来源一致。本地对齐也不可用时，保留云端自带的时间，并在结果里给出警告 `W_ASR_CLOUD_TIMING`。

## 4. 输出

成功时写出：

```json
{
  "schema": "zsir-cut/asr-result",
  "schema_version": "0.1",
  "input": { "path": "...", "size_bytes": 0, "fingerprint": "64 位十六进制", "channels": [0], "start_ms": 0, "duration_ms": 120000 },
  "language": "zh",
  "asr": { "name": "qwen3-asr", "model": "Qwen3-ASR-1.7B", "version": "...", "weights_digest": "sha256:..." },
  "align": { "name": "qwen3-forced-aligner", "model": "...", "version": "...", "weights_digest": "sha256:..." },
  "tokens": [ { "text": "我们", "start_ms": 10120, "end_ms": 10440, "conf": 0.98 } ],
  "runtime": { "seconds": 12.3, "peak_memory_mb": 5400, "engine_used": "local" },
  "warnings": []
}
```

- 时间是相对于媒体文件开头的源时间，整数毫秒。内核把它换算成规格里的有理数时间，写进母稿第 1 层 `raw_runs` 和第 3 层 `align`。
- `tokens` 按 `start_ms` 递增，不重叠，不含空文本。
- 同一份输入、同一组模型和参数，输出的 `tokens` 必须相同。

失败时退出码非零，并写出：

```json
{ "schema": "zsir-cut/asr-error", "schema_version": "0.1", "code": "E_ASR_OOM", "message": "...", "retryable": true }
```

| 错误码 | 含义 | 可重试 |
|---|---|---|
| `E_ASR_INPUT` | 媒体读不了，或指定声道、区间无效 | 否 |
| `E_ASR_MODEL_UNAVAILABLE` | 模型没下载，或 MLX 不可用 | 否 |
| `E_ASR_OOM` | 内存不足 | 是，换小模型或分段 |
| `E_ASR_CLOUD_AUTH` | 云端凭据缺失或无效 | 否 |
| `E_ASR_CLOUD_NETWORK` | 云端网络错误或超时 | 是 |
| `E_ASR_INTERNAL` | 其他 | 视情况 |

## 5. 缓存

结果缓存在 `~/.zsir-cut/cache/asr/`。缓存键是下列内容的 SHA-256：输入指纹、声道、区间、语言、引擎、两个模型的权重摘要、worker 版本、热词文件的 SHA-256。命中缓存直接返回，不重新计算。重跑只替换分析结果，不动母稿里人改过的层，规则见 `timeline-schema.md` 第 5 节。

## 6. 内核侧的 `transcribe` 动词

1. 调用 worker，拿到结果。
2. 结果写进母稿：第 1 层追加一条 `asr` 运行和一条 `align` 运行；第 3 层更新对齐时间；第 2 层只新增或替换 `state` 为 `auto` 的字词，不动 `edited` 和 `approved` 的；第 4 层按 `subtitle-rules.md` 对受影响的范围重新断句，跳过锁定的字幕条。
3. 整个过程是一个修订，可以撤销。
4. worker 运行时间长，`transcribe` 按长任务返回 `accepted` 和任务 ID。

## 7. 测试

- 单元测试不依赖模型、MLX 和网络，CI 能跑：参数解析、结果与错误的 JSON 格式、缓存键、jieba 聚词、毫秒到有理数的换算。
- **朗读测试素材**：在 `fixtures.md` 的素材清单里新增一项，由生成器用 macOS 自带的中文朗读声音，把台词脚本每句念出来，放在每句的开始时刻，生成 `shared/台词朗读.wav`。它只用于识别的冒烟测试：识别结果与台词脚本的字错率低于 10% 即通过，不比较时间。
- **评测集**：Bill 提供素材和正确稿后，`eval` 跑出全部指标，作为选默认模型的依据。
