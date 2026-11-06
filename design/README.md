# design/

从 Claude Design 的设计系统同步过来的文件，桌面版据此生成样式。Claude 维护，Codex 只读。

设计系统：v2 https://claude.ai/artifact/15p6YuU4UfgJEGWU6tUDtX（现在桌面版用的）；v3「黑底浮卡」https://claude.ai/artifact/TSP7nbUeS5MgrfEEwNjse7

| 文件 | 内容 |
|---|---|
| `tokens.json` | 颜色、字体、间距、圆角、尺寸变量。桌面版构建时生成 CSS 变量，名字不变 |
| `reference/components.css` | 设计系统组件的参考样式（类名 `zc-*`） |
| `reference/components.js` | 设计系统组件的参考实现（预览用，React 18 经典脚本）。桌面版按它的结构和类名重写，不直接引用 |
| `assets/apps/` | Premiere Pro、DaVinci Resolve 图标，来自 syvixor/skills-icons（MIT） |

Final Cut Pro 的图标不放进仓库，桌面版运行时从本机安装的 FCP 里读取，见 ADR-0016。

## v3「黑底浮卡」（2026-11-06 同步）

`v3/` 是第 3 版设计系统，给 U3.10 换皮用（`docs/tasks/ui-3.md`）。U3.10 把 `v3/tokens.json` 换到 `design/tokens.json`、`v3/components.css` 换到 `reference/components.css`，并删掉 `v3/`。在那之前桌面版仍读 v2，避免换皮前界面先坏掉。

| 文件 | 内容 |
|---|---|
| `v3/tokens.json` | 变量。和 v2 比：颜色改为纯中性灰并新增 `lane`、`accent`、`accent-soft`、`cream`、`focus`、`danger`、`danger-soft`、`playhead`、`selection`、`marker-chapter`、`file-mov` 等；新增 `shadow` 组（`shadow-popover`、`shadow-dialog`）；去掉 `size` 组，尺寸写在 `v3/DESIGN.md` 的 Layout 一节。`packages/desktop/src/tokens.ts` 要跟着改 |
| `v3/components.css` | 组件参考样式，类名 `zc-*`，包括 `zc-seam`、`zc-cut-tick`、`zc-cache-bar`、`zc-chap-*`、`zc-popover`、`zc-outline-sec` |
| `v3/DESIGN.md` | 规范值（YAML）和用法说明，按 Google DESIGN.md（alpha）格式 |
| `v3/icons.mjs` | 线条图标的 SVG 路径（24 网格、1.5 描边），桌面版按它做图标组件 |

界面设计稿：https://claude.ai/artifact/2cz57o7WFBCD2kcNpEA3n8 （画布里每一屏、每块画板对应 U3 的哪个任务，见 `docs/tasks/ui-3.md` 第 4.3 节）。
