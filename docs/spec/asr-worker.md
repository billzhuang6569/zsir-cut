# 识别 worker 契约 v0.1

状态：草案 · 2026-10-26 · 依赖 ADR-0005、`timeline-schema.md` 第 5 节、`subtitle-rules.md`

识别与对齐 worker 是独立的 Python 子进程，放在 `workers/asr/`。内核通过命令行调用它，交换 JSON 文件，不共享内存，不互相导入代码。本文定义两者之间的接口。

## 1. 运行环境

- Python 3.13，依赖用 `workers/asr/pyproject.toml` 声明，精确版本锁在 `workers/asr/requirements.lock`，许可证按 ADR-0002 筛选。虚拟环境放在 `workers/asr/.venv`，不进仓库。
- MLX 推理用 `mlx-audio`（MIT）0.5.8，模型权重用 `mlx-community/Qwen3-ASR-1.7B-8bit` 和 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`，存放在 `~/.zsir-cut/models/<模型名>/`。
- 本地引擎：Qwen3-ASR（1.7B，内存 16 GB 及以下的机器用 0.6B）识别，Qwen3-ForcedAligner 对齐，在 Apple Silicon 上走 MLX。中文对齐结果按 jieba 分词聚成词。有热词文件时，聚词前把其中的每个中文词加入 jieba 词典，保证词表里的词（例如「飞书」「豆包工作」）聚成一个字词，不被拆开。
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

## 2.1 长音频分段

Qwen3-ForcedAligner 一次只能可靠对齐几分钟的音频。2026-10-28 用一条 19 分钟的真实采访实测：整段一次对齐时，3124 个字词里有 3117 个零宽，几乎全部挤在 2 分 20 秒到 2 分 30 秒之间；识别出的文字本身是对的。所以 `transcribe` 和 `align` 都必须先分段：

1. 把要处理的区间（`--start` 到 `--start + --duration`）切成不超过 60 秒的段。从区间起点开始，每段的终点在「段起点 + 40 秒」到「段起点 + 60 秒」之间找：把这 20 秒解码后的单声道音频按 10 毫秒一帧算均方根能量，取能量最低的那一帧的起点作为切点，能量相同取最早的一帧。剩下不足 60 秒时直接作为最后一段。切点按整毫秒记。
2. 每段单独识别（`transcribe`）和单独对齐，字词时间加上段起点。热词对每段都生效。
3. `align` 子命令拿到的是整段文字，没法按段拆。做法：先按第 1 条切好音频段，再对每段跑一次识别，只用识别结果的字数来按比例分配给定文字：给定文字按顺序切给各段，每段分到的字数与该段识别出的字数成比例，切点挪到最近的标点或空格（向后找，不超过 10 个字）。之后每段用分到的文字对齐。
4. 拼接后照第 4 节的约束整理：按起点排序，零宽修正，去重叠。
5. 复读检查：识别模型在近乎静音的段落里会陷入复读，例如 2026-10-28 的真实采访在开拍前 45 秒的静音里输出了几千个「哎」。拼接前，每段内同一个字或词连续重复超过 8 次时，整串删掉，`warnings` 加 `{"code": "W_ASR_REPETITION", "start_ms": 起点, "end_ms": 终点, "count": 删掉的个数}`，每串一条。
6. 质量自检：零宽修正前，零宽字词超过总数 5% 时，`warnings` 加 `{"code": "W_ASR_ALIGN_DEGRADED", "ratio": 比例}`，内核把它带进 `result.warnings`。这说明对齐又出问题了，不能当正常结果用。

分段规则改变了结果，worker 版本号要升，旧缓存自然失效。

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
- `tokens` 按 `start_ms` 递增，不重叠，不含空文本，每个字词 `end_ms` 大于 `start_ms`。
- 对齐器给出零宽字词（`end_ms` 等于 `start_ms`）时，worker 输出前修正：终点延到 `min(下一个字词的起点, 起点 + 40, 输入终点)`；仍是零宽，就把起点提前到 `max(上一个字词的终点, 终点 − 40, 输入起点)`；还是零宽，就把它的文本并到前一个字词（没有前一个就并到后一个）并删掉它。每修正一个记一次，`warnings` 里加一条 `{"code": "W_ASR_ZERO_WIDTH", "count": 修正个数}`。
- 静音或几乎没有人声的素材，`tokens` 可以为空数组，这不是错误。
- 引擎不提供置信度时 `conf` 为 null，例如 MLX 的强制对齐器。内核写入母稿时省略 `conf`，schema 允许。
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

1. 调用 worker，拿到结果。一期一次只识别一个声道，`source_channels` 有多个时返回 `E_UNSUPPORTED`；`range` 必须能用整数毫秒表示，否则返回 `E_VALIDATION`。worker 返回的引擎版本为 null 时，写入母稿记为 `unknown`。
2. worker 的字词不满足第 4 节的约束时，报 `E_ASR_INTERNAL` 并在 `message` 里写出第一个出问题的字词序号和原因。`tokens` 为空时照常写入：母稿有运行记录、没有字词和字幕条，`result.warnings` 加 `W_ASR_EMPTY`。
3. 结果写进母稿：第 1 层追加一条 `asr` 运行和一条 `align` 运行；第 3 层更新对齐时间；第 2 层只新增或替换 `state` 为 `auto` 的字词，不动 `edited` 和 `approved` 的；第 4 层按 `subtitle-rules.md` 对受影响的范围重新断句，跳过锁定的字幕条。
4. **识别设置**：工程有 `recognition` 时（`timeline-schema.md` 4.1），`transcribe` 没写的 `language` 取 `recognition.language`；`recognition.terms`、请求里的热词文件和全局名词库的启用词（`term-library.md` 第 4 节）按这个顺序合并去重后作为热词交给 worker，并按第 1 节加入分词词典。`terms` 变了，缓存键里的热词摘要随之改变，会重新识别。
5. **去水词**：`recognition.remove_fillers` 为 true 时，第 3 步写完第 2 层后，对本次新增或替换的、`state` 为 `auto` 的字词逐个检查：`text` 去掉首尾标点后整个等于 `filler_words`（没写用默认表）里的某一项，就按 `hide_tokens` 处理，即 `text` 设为空串、原文存进 `heard`，`state` 仍为 `auto`。只比较整个字词，不在字词内部截取，所以「那个」只在用户把它加进水词表、并且它单独成为一个字词时才隐藏。隐藏了几个写进 `warnings` 的 `W_FILLERS_HIDDEN`。之后断句按 `timeline-schema.md` 5.2，隐藏字词不断开字幕。
6. 整个过程是一个修订，可以撤销。
7. worker 运行时间长，`transcribe` 按长任务返回 `accepted` 和任务 ID。

## 7. 测试

- 单元测试不依赖模型、MLX 和网络，CI 能跑：参数解析、结果与错误的 JSON 格式、缓存键、jieba 聚词、毫秒到有理数的换算。
- **朗读测试素材**：在 `fixtures.md` 的素材清单里新增一项，由生成器用 macOS 自带的中文朗读声音，把台词脚本每句念出来，放在每句的开始时刻，生成 `shared/台词朗读.wav`。它只用于识别的冒烟测试：识别结果与台词脚本的字错率低于 10% 即通过，不比较时间。
- **评测集**：Bill 提供素材和正确稿后，`eval` 跑出全部指标，作为选默认模型的依据。
