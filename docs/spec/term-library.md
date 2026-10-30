# 全局名词库 v0.1

状态：草案 · 2026-10-30 · 依据 ADR-0018

每个工程的专有名词存在 `recognition.terms` 里（`timeline-schema.md` 4.1）。全局名词库是本机所有工程共用的一份名词表：在一个工程里反复出现的名词自动收进来，之后所有工程识别时都拿它当热词。

## 1. 存放

- 文件：`~/Library/Application Support/zsir-cut/terms.json`，与最近工程列表在同一目录，跟随 `HOME`。不存在时视为空库。
- 写入用临时文件加原子替换。同一时刻可能有 CLI、MCP、桌面版几个进程在写，写入前加文件锁（同目录下的 `terms.json.lock`），拿不到锁等待最多 2 秒，超时返回 `failed`、`E_IO`、`retryable: true`。
- 格式：

```json
{
  "schema": "zsir-cut/terms",
  "version": 1,
  "terms": [
    { "text": "豆包", "state": "active", "source": "auto", "projects": ["prj_…"], "added_at": "2026-10-30T02:11:14.464Z" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `text` | 名词原文，去掉首尾空白。比较时区分大小写，全角半角不转换 |
| `state` | `active` 启用，识别时用；`blocked` 屏蔽，识别时不用，也不会再被自动收进来 |
| `source` | `auto` 自动收录；`user` 用户手动加 |
| `projects` | 让它被收录、或在之后又出现过的工程 ID，去重，按加入顺序，最多保留 50 个 |
| `added_at` | 第一次进库的时间 |

- `terms` 按 `text` 的 Unicode 码点排序，序列化确定：同样的内容得到同样的字节。

## 2. 名词从哪来

工程里的 `recognition.terms` 是唯一来源，名词库不自己从文稿里猜词。工程名词有两个来路：

1. Agent 识别完成后，从 `reference_text` 和文稿里挑出专有名词（品牌、产品、人名、机构、地名、行业术语），用 `set_recognition` 写进 `terms`。挑词规则写在 Skill 的 `subtitles.md` 里。
2. 用户在字幕面板的识别设置里手动增删。

## 3. 自动收录

`set_recognition` 改了 `terms` 并成功提交后，内核对**新增的**每个名词做一次检查：

1. 统计它在本工程所有母稿里出现的次数：把每份母稿第 2 层 `text` 非空的字词按顺序拼成一个字符串，数这个名词不重叠出现的次数。
2. 次数 ≥ 2，并且名词库里没有它，就以 `active`、`source: auto` 加进库，`projects` 写本工程 ID。
3. 名词库里已有它：`active` 的把本工程 ID 补进 `projects`；`blocked` 的什么都不做。
4. 次数不足 2 的只留在本工程，不进库。

从工程里删掉一个名词，不会把它从名词库删掉。检查失败（例如拿不到锁）不影响 `set_recognition` 本身：工程照常提交，结果的 `warnings` 加 `W_TERMS_LIBRARY`，写明原因。

## 4. 识别时使用

`transcribe` 把名词库里所有 `active` 的名词排在工程名词和热词文件之后，合并去重，交给 worker（`asr-worker.md` 第 6 节第 4 条）。合并后超过 300 个时，从名词库的部分截掉多出的，按 `projects` 个数从多到少保留，个数相同按 `text` 排序。实际用到的完整热词表写进 `transcribe` 结果的 `result.hotwords`（长任务的 `job.json` 里保留完整信封），以后能追查。工程文件的运行记录不加字段。名词库变了，热词摘要随之变化，同一素材会重新识别。

## 5. 动词

两个动词都不属于某个工程，请求不带 `project`、`base_revision`、`session_id`，不写工程日志。CLI 用 `zcut terms list`、`zcut terms edit --input <请求.json>`；MCP 工具名 `zcut_terms_list`、`zcut_terms_edit`。结果信封照第 4 节，`receipt` 为 null。

| 动词 | 参数 | 说明 |
|---|---|---|
| `terms_list` | `state`（可选，`active` 或 `blocked`）、`query`（可选，子串匹配） | 读动词，`result.terms` 是匹配的条目 |
| `terms_edit` | `ops`：数组，每项 `{ "op": "add" \| "remove" \| "block" \| "unblock", "text": "…" }` | 按顺序执行。`add` 以 `active`、`source: user` 加入，已存在时改为 `active`；`remove` 删除条目；`block` 改为 `blocked`，不存在时新建一条 `blocked`；`unblock` 改为 `active`。全部成功返回 `applied`，`changes` 每项一条（`entity` 为 `term`，`id` 为名词原文）；一个都没变返回 `no_op` |

参数不合法（空文本、超过 64 个字符、未知 `op`）返回 `rejected`、`E_VALIDATION`，什么都不写。设置页在以后的版本里做，界面通过这两个动词读写。

## 6. 测试

- 用临时 `HOME`，不碰真实的名词库。
- 收录：出现 2 次的名词进库，1 次的不进；`blocked` 的不会被自动改回；同一名词从两个工程收录时 `projects` 有两项。
- 序列化确定；两个进程同时写不丢条目。
- `transcribe` 的热词合并顺序、300 个上限和截断顺序；结果里的 `result.hotwords`。
