# ADR-0025 第一批发布：应用自带 Node，不带 ffmpeg，未签名的预发布版

状态：已采纳 · 2026-11-09

## 背景

Bill 2026-11-09 要求出第一批 release：Windows 版和 Mac（M 芯片）版，更新到仓库。ADR-0016 留了一句「打包时怎么带 Node，发布前另写 ADR」，本文就是它。

当时的情况：

- Tauri 打包是关的（`bundle.active: false`），只有一张 32×32 的图标。
- 窗口壳用编译时的目录找宿主进程，从 `PATH` 找 `node`，换台电脑就启动不了。
- 从 Finder 打开的应用拿不到终端的 `PATH`，找不到 Homebrew 装的 ffmpeg 和 Agent。
- 没有 Apple 和 Windows 的代码签名证书。
- 内核和导出器用相对路径找 `schema/`、`skills/`、`workers/asr/` 和其他包。
- 本地识别只能在 Apple Silicon 上跑（ADR-0005），它要的 Python 环境和模型都很大。

## 决策

1. **版本号 0.1.0，标签 `v0.1.0`，标成预发布。** 所有包、`tauri.conf.json`、`Cargo.toml` 用同一个版本。
2. **产物两个：** `zsir-cut_0.1.0_aarch64.dmg`（macOS Apple Silicon）和 `zsir-cut_0.1.0_x64-setup.exe`（Windows x64，NSIS，按用户安装）。文件名用英文，应用名仍是「庄Sir剪辑助手」。
3. **应用自带 Node 24 运行时和宿主进程。** 打包脚本把宿主需要的文件组装成一棵和仓库相同结构的目录（`packages/*/dist`、`packages/*/package.json`、`schema/`、`skills/`、`workers/asr/` 的代码、生产依赖），作为 Tauri 资源带上。相对路径不用改，内核不用改写。开发时的行为不变。
4. **不带 ffmpeg，由用户自己装。** AGENTS.md 硬规则 6 不允许打包 GPL 工具，常见的 Mac 版 ffmpeg 都是 GPL 构建。应用按固定目录加 `PATH` 查找 ffmpeg 和 ffprobe；找不到时界面提示安装命令，不让用户对着报错猜。
5. **不带语音识别环境。** Mac 版的本地识别由用户按发布说明单独安装，环境放在 `~/.zsir-cut/asr/.venv`。Windows 版没有本地识别。没有环境时，识别返回清楚的说明，其他功能照常。
6. **不签名。** Mac 用 ad-hoc 签名（M 芯片要求至少有这个），不公证；Windows 不签名。发布说明写清楚第一次怎么打开。这是预发布能接受的，正式版要重新决定。
7. **CI 出包。** 打 `v*` 标签时，GitHub Actions 在 `macos-14` 和 `windows-latest` 上构建，跑冒烟检查，通过后把两个文件传到 Release 草稿。Claude 验收后再发布。
8. **Windows 上暂时不能用的功能要好好说明，不能崩：** 配音密钥存储（依赖 macOS `security`）和读取 Final Cut Pro 图标（依赖 `sips`）。

## 后果

- 安装包大约多 40 MB（压缩后的 Node）。
- 用户第一次要手动放行应用，并自己装 ffmpeg。这和「下载就能用」有距离，正式版前要再看。
- Windows 版只有 CI 上的冒烟检查，没有人在真机上用过。发布说明要写明这一点。
- 仓库开始有 `CHANGELOG.md`，第 4 步「每个里程碑打 tag」从这里起步。

## 考虑过的其他方案

- **带 LGPL 构建的 ffmpeg：** Windows 有现成构建，Mac arm64 没有可靠的现成构建，而且 LGPL 不在 AGENTS.md 允许的许可证里。要带得先改规则，这次不做。
- **把宿主打成单文件（Node SEA 或 esbuild）：** 内核大量依赖相对路径和 `@napi-rs/canvas` 原生模块，改动大、风险高。
- **用户自己装 Node：** 多一个门槛，版本也管不住。
- **先只发 Mac：** Bill 明确要 Windows 版。
