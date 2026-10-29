# zsir-cut 设计规范

状态：v2 · 2026-10-29 · 取代 v1（v1 是手写的 Markdown 规范）

设计规范以 Claude Design 的设计系统为准：**[庄Sir剪辑助手 设计系统](https://claude.ai/artifact/15p6YuU4UfgJEGWU6tUDtX)**。它包含：

- 品牌手册（README）：三条设计哲学、文案、颜色、字体、间距、布局、图标、交互。
- 设计变量（`tokens.json`）：颜色（深色主题）、字体、字号、间距、圆角、尺寸。
- 13 个组件，每个都有说明和实时预览：Icon、Button、IconButton、Tabs、Switch、StatusPill、Kbd、DecisionCard、StepRow、FileIcon、DestinationCard、SubtitleRow、Clip。

界面设计稿：[设计画布](https://claude.ai/artifact/6g8fzZAHD7GhqE4EeUyF9d)。

## 给实现者（Codex）

- 第 3 步桌面版的颜色、字号、间距、圆角一律引用设计系统的变量名，例如 `var(--attention)`、`var(--space-6)`，不写死数值。
- 组件的样子、状态和交互以设计系统里各组件的说明为准。设计系统里的 `bundle.js` 是预览用的参考实现，桌面版按它的类名和结构重写成项目自己的组件，不直接引用。
- 设计系统改了以后，Claude 在任务说明里写清楚改了哪些变量和组件。

## 三条设计哲学（摘要，原文在设计系统里）

1. 能用图标，就不用文字。
2. 能用图形表达清楚的逻辑，就不用文本。
3. 简约。
