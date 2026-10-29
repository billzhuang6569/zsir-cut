# ADR-0016 桌面版架构：Tauri 窗口 + Node 宿主进程

状态：已采纳 · 2026-10-29

## 背景

ADR-0003 定了桌面壳用 Tauri + TS，内核、CLI、MCP 都是 TypeScript，跑在 Node 上。Tauri 的窗口是系统网页视图，里面跑不了 Node：读写工程、调用识别 worker、导出都要 Node。桌面版还要做三件网页做不到的事：驱动本机的 Claude Code / Codex 命令行（ADR-0014）、对外提供界面动词的 MCP（command-protocol 9.6）、读本机安装的剪辑软件图标。

## 决策

桌面版由三部分组成：

| 部分 | 位置 | 做什么 |
|---|---|---|
| 界面 | `packages/desktop` | React 18 + TypeScript + Vite。只负责显示和交互，不读写文件，不含业务逻辑 |
| 宿主进程 | `packages/app-host` | Node 进程。调用内核的同一个 `dispatch`；对界面提供本机 WebSocket 通道；对 Agent 提供 MCP（内核动词加界面动词）；以后负责启动本机 Agent 命令行 |
| 窗口壳 | `apps/desktop-tauri` | Tauri 2（Rust）。开窗口，启动宿主进程，把端口和一次性令牌交给界面 |

规则：

- 界面里的每个修改工程或产生文件的操作，都通过宿主进程调用内核动词，返回同样的结果信封。界面不另写逻辑（ADR-0001、`product.md` 第 6 节）。
- 宿主进程只监听 `127.0.0.1`，每次启动生成随机令牌，界面连接时必须带上。别的进程连不上。
- 界面动词（`ui_*`）由宿主进程的 MCP 收下，转给界面执行，界面把结果回给宿主进程。界面没连上时返回 `E_APP_NOT_RUNNING`。
- 颜色、字号、间距从 `design/tokens.json` 生成 CSS 变量，名字和设计系统一致。`design/` 由 Claude 维护，从 Claude Design 的设计系统同步过来。
- 剪辑软件图标：Premiere、Resolve 用仓库里的 MIT 图标（`design/assets/apps/`）；Final Cut Pro 的图标不进仓库，运行时从本机安装的 FCP 应用里读，没装就显示字母色块。
- 一期在开发环境用本机的 Node 启动宿主进程。打包成独立应用时怎么带上 Node，到发布前再定，另写 ADR。

## 后果

- CI 只跑界面和宿主进程的 TypeScript 测试，不编译 Rust。窗口壳由 Claude 在本机编译验收。
- 新依赖：react、react-dom、vite、@vitejs/plugin-react、ws、@tauri-apps/api、@tauri-apps/cli，以及 Rust 的 tauri。都是 MIT 或 Apache-2.0。
- 宿主进程是第二个调用内核的入口，和 CLI、MCP 一样要有对等测试。

## 考虑过的其他方案

- Electron：自带 Node，少一个进程，但违背 ADR-0003，安装包大很多。
- 把内核改写成 Rust 或编译成 WebAssembly：内核依赖 Node 的文件、子进程和 ffmpeg 调用，改写代价太大。
- 界面直接调用 `zcut` 命令行：每个操作起一个进程，慢，也拿不到界面动词需要的双向通道。
