# Agent 评测集

Claude 的独立验收工具（`docs/tasks/v0.2.md` 第 6 节）。用真实的本机 Agent（Claude Code 或 Codex）、仓库的 MCP server 和桌面版提示词（`skills/zsir-cut/rules.md` + `desktop.md`）跑一组指令，再读工程检查结果。

```bash
node tools/acceptance/agent-evals/run.mjs --project <起始工程.zcut.json> [--agent claude|codex] [--only 01,05] [--out <目录>]
```

- 起始工程不进仓库（真实素材的转写属于用户）。每条用例在临时目录里复制一份，带全新的 `.zcut/`。
- 素材离线也能跑：剪辑只用工程里的素材信息。
- 每条用例的 `<界面>` 段按 `desktop-host.md` 4.5 的格式由本工具生成，代替桌面宿主；界面动词不可用。
- 结果：每条用例一行 `PASS` / `FAIL` 和原因，详细日志（Agent 的事件流、最终工程、历史）在 `--out` 下。

用例在 `cases.mjs`。失败的情形写成新用例。
