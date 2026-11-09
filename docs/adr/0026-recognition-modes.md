# ADR-0026 字幕识别两种模式：本地模型和 API 识别

状态：已采纳 · 2026-11-09

## 背景

Bill 2026-11-09 要求：设置页的「字幕识别」显示本地模型和 API 识别两种模式，可以切换；API 识别填火山引擎豆包语音的 API Key；本地模型在这里下载并显示进度；两种模式都能测试。界面见设计画布「设置 · 字幕识别」五张画板。

ADR-0005 把火山引擎定为兜底，只留了桩，凭据走环境变量。Claude 2026-11-09 用 Bill 的 Key 实测：

| 接口 | 结果 |
|---|---|
| 标准版 `submit` 和 `query`，资源 `volc.seedasr.auc` | 能用，但 `audio` 只收 URL，本地文件传不了 |
| 极速版 `recognize/flash`，资源 `volc.bigasr.auc_turbo`，base64 传本地音频 | 能用，一次返回，有逐字时间（毫秒） |
| 极速版，资源 `volc.seedasr.auc_turbo` | `45000030`，这个 Key 没有权限 |
| 错误的 Key | `45000010` |

## 决策

1. **用极速版接口。** `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`，请求头 `X-Api-Key`、`X-Api-Resource-Id: volc.bigasr.auc_turbo`、`X-Api-Request-Id`（UUID）、`X-Api-Sequence: -1`。不用标准版，因为素材不离开本机就没有 URL。
2. **API 模式直接用云端的逐字时间，不跑本地对齐。** 改掉 `asr-worker.md` 里「云端结果一律再跑本地 align」。选 API 模式的用户可能没下模型，也不想占内存。
3. **模式是应用级设置，不是工程设置。** `transcribe` 动词的 `auto` 按当前模式走。
4. **Key 存系统钥匙串，只存一个 Key。** 不再用 `ZSIR_VOLC_APP_ID` 和 `ZSIR_VOLC_ACCESS_TOKEN`。
5. **模型由应用下载。** 先连 Hugging Face，失败自动换 `hf-mirror.com`，能续传，下完校验。高精度和省内存都要加上对齐模型，所以界面写的大小是两者之和。
6. **Windows 这个版本不提供语音识别，两种模式都没有。** Bill 定：下个版本再探索双平台都能跑的本地模型。

## 后果

- 这个 Key 没开通 2.0 的极速版。开通后是否换 `volc.seedasr.auc_turbo`，以后再定。
- 只支持 2 小时以内、100 MB 以内的单次请求。更长的素材要分段，见 `asr-worker.md`。
- `hf-mirror.com` 是第三方镜像，靠校验保证文件没问题。

## 考虑过的其他方案

- **标准版加上传到对象存储：** 要用户多配一套存储，也违背「素材不离开本机」的默认。
- **把模型打进安装包：** 安装包多 2 到 4 GB，而且选 API 的用户用不上。Bill 定联网下载。
