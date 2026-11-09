# ASR worker

本地识别和强制对齐使用 macOS Apple Silicon、Python 3.13 和 MLX。
需先安装 Python 3.13、ffmpeg（含 ffprobe）；Node.js 24 用于生成冒烟素材。

从仓库根目录建立独立环境，按锁定版本安装依赖：

```sh
python3.13 -m venv workers/asr/.venv
workers/asr/.venv/bin/python -m pip install -r workers/asr/requirements.lock
```

在 `workers/asr/` 下运行 `./.venv/bin/python -m zsir_asr ...`，不需要安装 worker 包。
纯逻辑测试不加载模型、不联网：

```sh
cd workers/asr
./.venv/bin/python -m pytest
```

在应用的「设置 › 字幕识别」中下载本地模型。权重采用 Apache-2.0 许可，存放在以下目录；worker 本身不下载：

- `~/.zsir-cut/models/Qwen3-ASR-1.7B-8bit/`：默认识别模型，来自 `mlx-community/Qwen3-ASR-1.7B-8bit`。
- `~/.zsir-cut/models/Qwen3-ASR-0.6B-8bit/`：内存 16 GB 及以下建议用 `--model 0.6b`。
- `~/.zsir-cut/models/Qwen3-ForcedAligner-0.6B-8bit/`：对齐模型，来自同名 `mlx-community` 仓库。

每个目录保存模型仓库完整文件（配置、分词器和 `.safetensors` 权重）。
识别结果缓存默认在 `~/.zsir-cut/cache/asr/`，可用 `ZSIR_CACHE_DIR` 覆盖。
本地 `transcribe` 和 `align` 按 40–60 秒窗口内最低能量的 10 毫秒帧分段处理，末段不足 60 秒时保留整段；对齐零宽比例超过 5% 时输出 `W_ASR_ALIGN_DEGRADED`。

模型准备好后，从仓库根目录执行冒烟测试：

```sh
sh workers/asr/scripts/smoke.sh
```

脚本用 macOS 中文朗读生成合成素材，独立运行两次识别，检查 token 完全一致、中文字错率低于 10%，并打印耗时和内存。
此测试会运行 MLX；纯逻辑 CI 不执行它。

云端兜底开关位于 `~/.zsir-cut/config.json`：

```json
{"asr":{"cloud_fallback":true}}
```

默认关闭。`--engine auto` 仅在本地报内存不足或模型不可用、且开关已开启时尝试云端。
应用的 `asr.mode` 选择 API 时，内核把 `auto` 改为 `cloud`。API Key 由应用保存在系统钥匙串 `zsir-cut.volc-asr` 中，内核读取后通过 `ZSIR_VOLC_API_KEY` 环境变量传给 worker，不写入配置、日志或识别结果。
云端使用豆包录音文件识别极速版，将音频转为 16 kHz 单声道 64 kbps MP3 后上传，直接使用云端逐字时间，不加载本地模型或对齐器。超过两小时的音频每 90 分钟分段，合并时补回源时间偏移。应用中的测试会跳过识别缓存。
