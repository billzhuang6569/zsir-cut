# zsir-cut · 庄Sir剪辑助手

给剪辑师和 AI Agent 共用的「时间线中间站」。Agent 在这里把粗剪和字幕做完，人在这里审批和微调，然后一键交给 Final Cut Pro、DaVinci Resolve、Premiere Pro 收尾。

它不是第四个 NLE，也不是生成式短视频机器。

## 现状

第一批预发布版 0.1.0。还没有代码签名，请先用不重要的工程试。

## 安装

到 [Releases](https://github.com/billzhuang6569/zsir-cut/releases) 下载：

| 系统 | 文件 |
|---|---|
| macOS（Apple Silicon） | `zsir-cut_<版本>_aarch64.dmg` |
| Windows（x64） | `zsir-cut_<版本>_x64-setup.exe` |

**第一次打开**

- macOS：把应用拖进「应用程序」。提示无法验证开发者时，到「系统设置 → 隐私与安全性」点「仍要打开」。
- Windows：SmartScreen 提示时，点「更多信息 → 仍要运行」。

**用得上的话要另外准备的**

- 想用 AI 面板：Claude Code 或 Codex。
- 想识别字幕（只有 Mac 版）：在「设置 → 字幕识别」下载本地模型，或填火山引擎豆包语音的 API Key。

**已知限制**

- Windows 版这个版本不能识别字幕，也不能保存配音密钥。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 开发

- `pnpm install`：安装 workspace 依赖。
- `pnpm lint`：检查脚手架代码与配置格式。
- `pnpm format`：格式化脚手架代码与配置。
- `pnpm typecheck`：检查 TypeScript 类型。
- `pnpm test`：运行各包的 Vitest 测试。
- `pnpm validate:examples`：校验示例工程与交接 JSON。
