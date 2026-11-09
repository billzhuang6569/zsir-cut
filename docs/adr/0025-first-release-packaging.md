# ADR-0025 第一批发布：应用自带 Node、ffmpeg 和识别环境，未签名的预发布版

状态：已采纳 · 2026-11-09（同日修订：Bill 要求任何人拿到安装包就能用，第 4、5、7、8 条改了）

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
4. **带 ffmpeg 和 ffprobe。** 用固定版本的现成静态构建，校验 sha256：Mac 用 martin-riedl.de 的 arm64 构建，Windows 用 BtbN 的 win64 构建。这些构建是 GPL，所以放宽 AGENTS.md 硬规则 6（见下）。它们始终是独立的子进程程序，不链接进应用。每个 Release 附上对应的 ffmpeg 源码和许可证，`THIRD_PARTY_NOTICES.md` 写明。
5. **带语音识别环境，不带模型（只 Mac）。** 用 python-build-standalone 的 Python 3.13，按 `workers/asr/requirements.lock` 装好依赖放进应用。模型联网下载，见 ADR-0026。Windows 不带，这个版本不提供语音识别。
6. **不签名。** Mac 用 ad-hoc 签名（M 芯片要求至少有这个），不公证；Windows 不签名。发布说明写清楚第一次怎么打开。这是预发布能接受的，正式版要重新决定。
7. **本机出包，脚本可重复。** Mac 包由 Claude 在 Bill 的 Mac 上打。Windows 包由 Claude 在 Bill 提供的 Windows 机器上打。两边都跑 `scripts/package-release.mjs` 和同一套冒烟检查。工作流保留，能手动触发，不是发布的唯一路径。
8. **Windows 上暂时不能用的功能要好好说明，不能崩：** 语音识别、配音密钥存储（依赖 macOS `security`）和读取 Final Cut Pro 图标（依赖 `sips`）。

**硬规则 6 的放宽：** 应用的代码依赖仍然只用 MIT、Apache-2.0、BSD、ISC。ffmpeg 可以作为独立的子进程程序打包，并附上许可证和源码。其他 GPL、AGPL 工具仍然不能打包。 Python 运行时和 `typing_extensions` 是 PSF-2.0，也是宽松许可，随识别环境打包，许可证一并带上。

## 后果

- 安装包会大很多：Node、ffmpeg 和 Python 环境加起来可能有几百 MB。
- 用户第一次要手动放行应用。用本地模型还要下载 2 到 4 GB 的模型。
- 仓库开始有 `CHANGELOG.md`，第 4 步「每个里程碑打 tag」从这里起步。
- 发布 GPL 程序就要提供源码，每个 Release 都要记得附上。

## 考虑过的其他方案

- **不带 ffmpeg，让用户自己装：** 最初的方案。Bill 否决：任何人拿到安装包就要能用。
- **带 LGPL 构建的 ffmpeg：** Mac arm64 没有可靠的现成构建，也没有 libx264。
- **把宿主打成单文件（Node SEA 或 esbuild）：** 内核大量依赖相对路径和 `@napi-rs/canvas` 原生模块，改动大、风险高。
- **用户自己装 Node：** 多一个门槛，版本也管不住。
- **先只发 Mac：** Bill 明确要 Windows 版。
