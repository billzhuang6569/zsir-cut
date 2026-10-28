# 请求速查

完整规则在仓库的 `docs/spec/command-protocol.md` 和 `docs/spec/edit-ops.md`，请求的 JSON Schema 在 `schema/command.schema.json`。这里只列常用写法。

## 公共字段

读请求只需要工程路径（命令行第二个参数）。写请求另加：

```json
{
  "base_revision": "rev_…",
  "idempotency_key": "rough-cut-012",
  "author": { "kind": "agent", "name": "claude" }
}
```

- `base_revision`：上一个写入结果的 `receipt.after`。
- 在编辑会话里：再加 `"session_id": "ses_…"`，`base_revision` 用草稿的修订。
- 时间写成秒的分数加 `s`，例如 `"2/5s"` 是 0.4 秒，`"1s"`、`"0s"`。可以不约分。

## 建工程和导入

```json
// create_project（命令行第二个参数是新工程路径，以 .zcut.json 结尾）
{ "name": "某某专访", "timeline": {}, "match_media": "/素材/A001.mov",
  "subtitles": { "language": "zh" },
  "idempotency_key": "create-1", "author": { "kind": "agent", "name": "claude" } }

// import_media
{ "paths": ["/素材/A001.mov", "/素材/B001.mov"], …公共字段 }

// import_media 的重链接
{ "relink": { "search_roots": ["/Volumes/新盘/素材"] }, …公共字段 }

// transcribe（长任务，加 --wait）
{ "media_id": "med_…", "language": "zh", "engine": "auto", "hotwords": "/工程目录/zcut-agent/热词.txt", …公共字段 }
```

## 读

```json
{ "view": "brief" }                                   // inspect：新会话先看这个
{ "view": "timeline" }                                // inspect：完整剪辑表
{ "transcript_id": "trs_…", "with_times": true }      // read_transcript：按母稿读
{ "timeline_id": "tl_…" }                             // read_transcript：按时间线读
{ "media": true }                                     // validate：连素材一起查
```

## 编辑会话

```json
{ "approval": "manual", "intent": "按纸面剪辑搭 3 分钟粗剪", …公共字段 }   // session_begin
{ "session_id": "ses_…", …公共字段 }                                          // session_review
{ "session_id": "ses_…", …公共字段, "author": { "kind": "human", "name": "Bill" } }  // session_approve，用户同意后
```

`session_approve` 的 `base_revision` 是主工程的当前修订，不是草稿的。

## 剪辑域（一个请求里只放这一类）

```json
{ "ops": [
  { "op": "place", "media_id": "med_…",
    "tokens": { "transcript_id": "trs_…", "from_token": "tok_…", "to_token": "tok_…", "pause": "2/5s" },
    "at": "end", "mode": "insert", "video_track": "trk_v1", "audio_track": "trk_a1" },
  { "op": "remove_span",
    "tokens": { "transcript_id": "trs_…", "from_token": "tok_…", "to_token": "tok_…", "pause": "1/5s" } },
  { "op": "add_marker", "at": "754/25s", "duration": "0s", "kind": "review", "text": "跳剪，建议盖空镜" }
], …公共字段 }
```

一个字词被投影到多个片段上时（同一段话用了两次），`remove_span` 的 `tokens` 要加 `clip_id`。

## 字幕域（一个请求里只放这一类）

```json
{ "ops": [
  { "op": "edit_text", "transcript_id": "trs_…", "from_token": "tok_…", "to_token": "tok_…", "text": "zsir-cut" },
  { "op": "hide_tokens", "transcript_id": "trs_…", "tokens": ["tok_…", "tok_…"] },
  { "op": "resegment", "transcript_id": "trs_…" },
  { "op": "split_cue", "cue_id": "cue_…", "after_token": "tok_…" },
  { "op": "add_free_cue", "track_id": "trk_sub1", "id": "cue_title1", "timeline_start": "0s", "duration": "3s", "text": "庄Sir · 剪辑师" }
], …公共字段 }
```

## 导出

```json
{ "timeline_id": "tl_…", "profile": "fcp-11-fcpxml-1.13", "output": "/工程目录/交接", "dry_run": true, …公共字段 }
```

正式导出去掉 `dry_run`，必要时加 `"accept_losses": true`，命令行加 `--wait`。

## 常见报错

| 报错 | 原因 |
|---|---|
| `conflict`、`E_CONFLICT` | `base_revision` 过期。重新 `inspect`，看清变化再发 |
| `E_MIXED_DOMAIN` | 剪辑和字幕操作放进了同一个请求 |
| `E_LOCKED` | 想改已批准的字或字幕条。停下来问用户 |
| `E_IDEMPOTENCY_MISMATCH` | 幂等键重复用在了不同请求上，换一个新键 |
| `E_SESSION_STATE` | 会话状态不对，或者在会话外用了 `force` |
