# 交接复核

交接包是给剪辑师的：一个 NLE 能打开的时间线文件、SRT 字幕、一段参考预览、一份损失报告和一份接手说明。目标是剪辑师打开后，每段素材都还能重新修剪，并且事先知道哪些东西没法原样带过去。

## 1. 选目标

| 用户用 | profile |
|---|---|
| Final Cut Pro（默认，验收基线） | `fcp-11-fcpxml-1.13` |
| 旧版 FCP（10.6） | `fcp-10.6-fcpxml-1.11` |
| DaVinci Resolve | `resolve-18.5-otio` |
| Premiere Pro | `premiere-25-xmeml-5` |

用户没说就导 FCP。要做对照时三家各导一份。

## 2. 先试导出

1. `validate` 带 `media: true`，确认素材都在线。报 `E_MEDIA_MISSING` 时先用 `import_media` 的 `relink` 模式在用户给的目录里找回，绝不按文件名猜。
2. `export` 带 `dry_run: true`，只拿损失报告。
3. 逐条读 `items`，用大白话转述给用户：
   - `preserved`：原样带过去，不用说。
   - `approximated`：近似。说清楚差多少，例如「字幕样式用 FCP 默认外观，需要在 FCP 里调」「一个连接片段挪了半帧，看不出来」。
   - `baked`：烘焙成了别的形式，剪辑师改不动原参数。
   - `unsupported`：带不过去。说清楚丢了什么、剪辑师要手动做什么。
4. 有 `error` 级的条目时，导出会被拒绝。先想办法在工程里避开（例如换一种写法），避不开就问用户是否接受，用户同意了才带 `accept_losses: true`。

## 3. 正式导出

1. `export` 不带 `dry_run`，`output` 写用户指定的目录（默认工程旁边的 `交接/`），用 `--wait`。
2. 结果里的 `package` 是交接包目录。打开里面的 `接手说明.txt` 和 `loss-report.json`，确认与试导出一致。
3. 交接包里有参考预览 `preview/*.mov`。告诉用户可以先看它，确认剪辑和字幕是对的，再导进 NLE。

## 4. 交给剪辑师

给用户的交接说明包括：

- 交接包路径，导进哪个软件、怎么导（FCP：文件 → 导入 → XML；Resolve：文件 → 导入 → 时间线；Premiere：文件 → 导入）。
- SRT 在 `subtitles/` 里；重叠的字幕会分成 `.layer2.srt` 等几层，要分别导到不同字幕轨。
- 损失报告的要点，一条一句。
- 所有 `review` 标记，一条一句。
- 可变帧率素材（导入时报过 `W_VFR`）的提醒：建议剪辑师在 NLE 里先转成恒定帧率或生成代理。

## 5. 记录实机结果

剪辑师或用户在 NLE 里导入后告诉你结果时，用 `record_handoff_check` 写进交接包的 `manifest.json`：`check` 为 `host_import`，`status` 为 `pass`、`warn` 或 `fail`，`host_version` 写软件版本，`by` 写是谁看的，`items` 逐项写。没有实际导入过的不要写 `pass`，写 `not_run`。用户只说了总体结论、没逐项说时，不要写 `items`，在 `notes` 里引用用户原话。这个动词不带 `base_revision`、`idempotency_key` 和 `author`，带了会被拒绝。
