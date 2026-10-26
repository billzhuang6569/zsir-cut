# zsir-cut · 庄Sir剪辑助手

给剪辑师和 AI Agent 共用的「时间线中间站」。Agent 在这里把粗剪和字幕做完，人在这里审批和微调，然后一键交给 Final Cut Pro、DaVinci Resolve、Premiere Pro 收尾。

它不是第四个 NLE，也不是生成式短视频机器。

## 现状

项目处于第 0 步：先立技术合同（时间线 schema、命令协议、交接 profile）和标准测试工程，再写功能代码。工作计划见 [docs/plan.md](docs/plan.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 开发

- `pnpm install`：安装 workspace 依赖。
- `pnpm lint`：检查脚手架代码与配置格式。
- `pnpm format`：格式化脚手架代码与配置。
- `pnpm typecheck`：检查 TypeScript 类型。
- `pnpm test`：运行各包的 Vitest 测试。
- `pnpm validate:examples`：校验示例工程与交接 JSON。
