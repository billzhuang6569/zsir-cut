# design/

从 Claude Design 的设计系统同步过来的文件，桌面版据此生成样式。Claude 维护，Codex 只读。

设计系统：https://claude.ai/artifact/15p6YuU4UfgJEGWU6tUDtX

| 文件 | 内容 |
|---|---|
| `tokens.json` | 颜色、字体、间距、圆角、尺寸变量。桌面版构建时生成 CSS 变量，名字不变 |
| `reference/components.css` | 设计系统组件的参考样式（类名 `zc-*`） |
| `reference/components.js` | 设计系统组件的参考实现（预览用，React 18 经典脚本）。桌面版按它的结构和类名重写，不直接引用 |
| `assets/apps/` | Premiere Pro、DaVinci Resolve 图标，来自 syvixor/skills-icons（MIT） |

Final Cut Pro 的图标不放进仓库，桌面版运行时从本机安装的 FCP 里读取，见 ADR-0016。
