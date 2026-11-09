# 第一批发布 0.1.0

决策见 [ADR-0025](../adr/0025-first-release-packaging.md) 和 [ADR-0026](../adr/0026-recognition-modes.md)。Bill 2026-11-09 修订：ffmpeg 和识别环境内置，先做 U6，再打包；Mac 先打，Windows 在 Bill 给的机器上打。

## R1 打包和发布工作流（Codex，一个 PR）

验收标准：

- `tauri.conf.json` 打开打包：Mac 出 dmg（ad-hoc 签名，只 aarch64），Windows 出 NSIS。图标用设计系统的应用图标生成全套尺寸（`tauri icon`）。
- 打包脚本组装资源目录，结构和仓库相同，只带生产依赖，并带当前平台的 Node 24 和 `@napi-rs/canvas` 原生模块。
- 窗口壳：发布版从资源目录启动自带的 Node 和宿主，工作目录不依赖编译机；开发版行为不变。Windows 上不弹黑色控制台窗口。
- 给宿主的 `PATH` 最前面放应用自带的 ffmpeg 目录。开发版行为不变。
- `findProgram` 在 Windows 上能找到 `.exe` 和 `.cmd`，并能正确启动 `.cmd`。
- 打包脚本带上固定版本的 ffmpeg、ffprobe（校验 sha256）和它们的许可证；Mac 版再带 python-build-standalone 的 Python 3.13 和按锁定版本装好的识别依赖。Python 不往应用目录写字节码。
- Windows 上语音识别、配音密钥和读取 FCP 图标不崩：识别和配音密钥给出说明，图标退回默认。
- `.github/workflows/release.yml` 能手动触发，出产物并跑冒烟。
- 冒烟：用打包好的 Node 启动打包好的宿主，打开一个测试工程，通过 WebSocket 读到工程；Windows 再静默安装并启动应用，确认宿主进程起来了。
- 版本号全部改成 0.1.0。

## U6 字幕识别设置和豆包语音识别（Codex，一个 PR，排在 R1 后面）

按 `docs/spec/desktop-host.md` 第 9 节、`docs/spec/asr-worker.md` 和设计画布实现。

验收标准：

- 设置页五张画板的状态都有：切换模式、选模型、下载进度和取消、已下载和删除、API Key 输入和显示、测试的通过和失败、Windows。
- API 模式下，字幕面板的识别和 Agent 调的 `transcribe` 都走豆包，结果有逐字时间，能进字幕流程。
- 测试不联网：HTTP 和 worker 都打桩。覆盖状态码映射、超长素材分段和偏移、下载续传和校验失败、镜像切换、Key 不进日志。
- Claude 用真 Key 跑通：设置页测试通过，一段真实素材识别成字幕。

## R2 发布（Claude）

1. Mac 包在本机隔离环境里装上，从 Finder 打开，走一遍：打开工程、预览、导出、API 识别、下载模型、本地识别。
2. 在 Bill 提供的 Windows 机器上打包并跑冒烟。
3. 打 `v0.1.0`，附上 ffmpeg 源码，写发布说明，发布为预发布。
