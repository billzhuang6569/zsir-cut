# ADR-0003 TypeScript 内核，桌面壳后续用 Tauri + TS

状态：已采纳 · 2026-10-26

## 背景

调研的开放问题之一是桌面壳走 Tauri + TS 还是 Rust（fork FilmCraft）。首发是 Skill + CLI，但 CLI 的实现语言决定了以后界面能否直接复用内核。MCP 生态和前端能力都在 TypeScript 这边。

## 决策

内核、CLI、MCP server 都用 TypeScript（Node.js 24 LTS、pnpm workspace、strict 模式）。第 3 步的桌面壳用 Tauri + TS，直接调用同一个内核。识别与对齐 worker 是 Python 子进程，见 ADR-0005。

## 后果

- 时间运算不能用 JavaScript 的浮点数，必须用 `bigint` 有理数，AGENTS.md 把它列为硬规则。
- 没有官方的 TS 版 OTIO 库，OTIO 导出由我们按格式直接写，用官方 Python 库只做测试里的读回校验。
- 媒体预览和渲染的性能上限低于纯 Rust 方案，要用真实素材实测，必要时引入原生组件。

## 考虑过的其他方案

- Rust，fork FilmCraft：性能上限最高，交换格式最全，但团队要会 Rust，FilmCraft 仍是 alpha，维护团队未核实。
- Electron + Remotion：Remotion 对 3 人以上公司要商业许可，渲染链重。

依据：[调研文档](https://claude.ai/artifact/PJytj2A1kDu8Wb4aPSkNdR)「桌面壳与渲染引擎」「开放问题」。2026-10-26 Bill 确认。
