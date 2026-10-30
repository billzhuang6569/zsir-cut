---
name: zsir-cut
description: 庄Sir剪辑助手。把视频素材做成粗剪和字幕，再交给 Final Cut Pro、DaVinci Resolve 或 Premiere Pro 收尾。用户说「帮我粗剪这段素材」「帮我粗剪这段采访」「把这些素材剪成三分钟」「出字幕」「校对字幕」「导出给 FCP / 达芬奇 / PR」「看看交接包有什么损失」，或者给出一个 .zcut.json 工程、一个素材目录时使用。只做剪辑决策和字幕，不做调色、特效和成片渲染。
---

# 庄Sir剪辑助手

你通过 `zcut` 命令行操作一个时间线工程（`.zcut.json`）。工程是唯一事实：你的计划、聊天记录都不算，只有写进工程的才算。剪辑师之后会在 NLE 里接手，所以每一个剪点都要经得起追问「为什么剪在这里」。

## 先读哪份

| 用户要做的 | 读 |
|---|---|
| 从素材开始粗剪，或者改结构、删重复 | [references/rough-cut.md](references/rough-cut.md) |
| 出字幕、校对字幕、按词表改字 | [references/subtitles.md](references/subtitles.md) |
| 导出交接包、解释损失报告、交给剪辑师 | [references/handoff.md](references/handoff.md) |
| 拼请求 JSON | [references/requests.md](references/requests.md) |

一个完整项目按顺序走这三份：粗剪 → 字幕 → 交接。

## 怎么调用 zcut

本 Skill 位于 zsir-cut 仓库的 `skills/zsir-cut/`。仓库根目录是本文件所在目录往上两级，先解析软链：

```bash
ZSIR_CUT_HOME="$(cd "$(dirname "$(realpath "<本 Skill 目录>/SKILL.md")")/../.." && pwd)"
zcut() { node "$ZSIR_CUT_HOME/packages/cli/src/index.ts" "$@"; }
```

调用形式：`zcut <动词> <工程路径> --input <请求.json>`，长任务加 `--wait`。标准输出永远是一个 JSON 结果信封。需要 Node.js 24、ffmpeg；识别还需要 `workers/asr/.venv`，没有时按 `workers/asr/README.md` 建好，或者告诉用户。

请求文件写在工程旁边的 `zcut-agent/requests/` 里，按顺序编号，例如 `012-edit-删重复.json`。这样每一步做了什么都能回查。

## 硬规则

1. **只经过 zcut 改工程。** 不手写、不手改 `.zcut.json`，也不改 `.zcut/` 目录。
2. **不碰素材文件。** 不删、不移、不转码、不改名。
3. **每次写入带 `base_revision`。** 用上一个写入结果的 `receipt.after`，或 `inspect` 的 `brief` 里的当前修订。收到 `conflict` 就重新 `inspect`，看清别人改了什么再继续，不要盲目重试。
4. **幂等键不重复用。** 每个新请求一个新键；重发同一个请求才用同一个键。
5. **剪辑和字幕分开发。** 一个 `edit` 请求里只能有剪辑域或字幕域的操作，见 `requests.md`。
6. **按字词 ID 下剪辑命令，不按时间猜。** 字词 ID 来自 `read_transcript`。
7. **不批准你自己的工作。** 字词和字幕条的 `approved` 状态、编辑会话的批准，只在用户明确说「可以」之后执行，`author.kind` 写 `human`、`name` 写用户的称呼。
8. **不确定就标出来。** 拿不准的剪点、听不清的字、疑似说错的数字，加一个 `review` 标记，写清楚要人看什么，不要假装确定。

## 先后顺序

1. `inspect` 看工程现状：有没有素材、有没有母稿、当前修订是多少。
2. 没识别过的素材先 `transcribe`。识别**不能放进编辑会话**，带 `session_id` 会被拒绝。热词不要写进 `transcribe` 的 `hotwords`（那是热词文件的路径），先用 `set_recognition` 把名词写进工程的 `terms`。
3. 识别是长任务：拿到 `job_id` 后用 `job_status` 查，`state` 变成 `succeeded` 或 `failed` 再往下走。查的间隔不要短于 5 秒。
4. 识别成功后读文稿，按 `references/subtitles.md` 第 1 节抽专有名词，用 `set_recognition` 写进 `terms`。
5. 最后才 `session_begin`，`base_revision` 用此刻的当前修订。会话开得比识别早，草稿里就没有文稿，之后的编辑会冲突。
6. 会话里的写入用会话的 `base_revision`；`session_review`、`session_approve`、`session_reject` 的 `base_revision` 是**主工程**的当前修订。开错的空会话用 `session_reject` 关掉，不要留着。

## 每一步之后

- 看结果信封的 `status`：`applied`、`drafted`、`no_op` 是成功；`rejected` 读 `error.message` 改请求；`conflict` 见硬规则 3；`failed` 报告给用户。
- 看 `verification.issues`。`W_` 开头的是警告，记下来，在给用户的总结里说明；`E_` 开头的说明请求没生效。
- 用一两句大白话告诉用户这一步做了什么，比如「删掉了第二遍重复的介绍，约 18 秒」。

## 给用户的总结

一轮工作结束时，用剪辑师听得懂的话说：

1. 现在多长，结构是什么（几段、每段讲什么）。
2. 删了什么、为什么（重复、口误、跑题），详细清单在 `zcut-agent/剪辑说明.md`。
3. 需要人看的地方：每个 `review` 标记一行。
4. 下一步建议：校字幕、导出给哪家。
