# 独立验收工具

这里是 Claude 用来验收 Codex 交付的脚本。它们按规格独立实现关键结论，**不复用产品代码的逻辑**，所以能发现实现和规格不一致的地方。它们不属于产品，不进 CI，只在本机运行。Codex 不修改这个目录，见 AGENTS.md。

先运行 `pnpm typecheck`，生成 `packages/core/dist/`，`.mjs` 脚本要用到它。

| 脚本 | 做什么 | 用法 |
|---|---|---|
| `l1_check.py` | 按 timeline-schema 第 8 节独立实现的语义检查 | `python3 -I tools/acceptance/l1_check.py <工程>...` |
| `project_subs.py` | 按 timeline-schema 5.2 节独立实现的字幕投影 | `python3 -I tools/acceptance/project_subs.py <工程>` |
| `projection_compare.mjs` | 比较 core 的投影结果和上面的独立投影器 | `node tools/acceptance/projection_compare.mjs <工程>...` |
| `validate_compare.mjs` | 列出 core 校验器报出的规则编号；对真实素材跑 L2 和重链接 | `node tools/acceptance/validate_compare.mjs codes <工程>...` |
| `fixtures_check.py` | 独立检查生成的测试素材：条码、白帧与脉冲、外录偏移、提示音、指纹 | `python3 -I tools/acceptance/fixtures_check.py <仓库根目录>` |
| `edit_fuzz.py` | 对 `edit` 做随机组合压力测试：每步独立校验，联动操作不得造成失步，最后逐步撤销须回到原样 | `python3 -I tools/acceptance/edit_fuzz.py <工程> [步数] [种子]` |
| `segment.py` | 按 subtitle-rules.md 独立实现的断句与换行 | 供 `segment_diff.py` 调用 |
| `segment_diff.py` | 随机字词流分别交给 core 的 `resegment` 和 `segment.py`，逐条比较字幕条与换行 | `python3 -I tools/acceptance/segment_diff.py [条数] [种子] [zh\|en]` |
