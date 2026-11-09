# 第一批发布 0.1.0

决策见 [ADR-0025](../adr/0025-first-release-packaging.md)。

## R1 打包和发布工作流（Codex，一个 PR）

验收标准：

- `tauri.conf.json` 打开打包：Mac 出 dmg（ad-hoc 签名，只 aarch64），Windows 出 NSIS。图标用设计系统的应用图标生成全套尺寸（`tauri icon`）。
- 打包脚本组装资源目录，结构和仓库相同，只带生产依赖，并带当前平台的 Node 24 和 `@napi-rs/canvas` 原生模块。
- 窗口壳：发布版从资源目录启动自带的 Node 和宿主，工作目录不依赖编译机；开发版行为不变。Windows 上不弹黑色控制台窗口。
- 给宿主的 `PATH` 前面加上常用目录：Mac 的 `/opt/homebrew/bin`、`/usr/local/bin`；Windows 的 `%LOCALAPPDATA%\Microsoft\WinGet\Links`、`C:\ProgramData\chocolatey\bin`。
- `findProgram` 在 Windows 上能找到 `.exe` 和 `.cmd`，并能正确启动 `.cmd`。
- 宿主启动时检查 ffmpeg 和 ffprobe。缺任何一个，界面顶部显示提示和安装命令（Mac：`brew install ffmpeg`；Windows：`winget install Gyan.FFmpeg`），可以复制，装好后重启应用消失。
- 发布版的识别环境路径是 `~/.zsir-cut/asr/.venv`。没有环境时任务失败原因写明怎么安装；Windows 写明暂不支持本地识别。Python 不往应用目录写字节码。
- Windows 上配音密钥和读取 FCP 图标不崩，配音密钥给出说明，图标退回默认。
- `.github/workflows/release.yml`：`v*` 标签触发，也可手动触发只出产物；两个平台构建、冒烟、把文件传到 Release 草稿。
- 冒烟：用打包好的 Node 启动打包好的宿主，打开一个测试工程，通过 WebSocket 读到工程；Windows 再静默安装并启动应用，确认宿主进程起来了。
- 版本号全部改成 0.1.0。

## R2 发布（Claude）

1. Mac 包在本机隔离环境里装上跑一遍。
2. 手动跑工作流，检查 Windows 冒烟结果和安装包。
3. 打 `v0.1.0`，写发布说明，发布为预发布。
