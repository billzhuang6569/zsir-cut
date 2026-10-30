# 语音：克隆音色与 AI 配音 v0.1

状态：草案 · 2026-10-30 · 依据 ADR-0019

用 fish.audio 的接口做两件事：从一段人声克隆出音色；用音色把文字念成音频。生成的音频作为素材进工程，能拖上时间线、导出、交接。字幕面板可以选几条字幕直接配音，配音记住对应的字幕。

接口依据：fish.audio API 文档（2026-10-30 读取）。`POST /model` 建音色，`PATCH /model/{id}` 改名，`DELETE /model/{id}` 删除，`POST /v1/tts` 生成。鉴权用 `Authorization: Bearer <key>`，模型用请求头 `model` 指定。

## 1. 本机存放

都在 `~/Library/Application Support/zsir-cut/`，与名词库同一目录，跟随 `HOME`。写入方式同 `term-library.md` 第 1 节：临时文件加原子替换，加文件锁（`<文件名>.lock`），拿不到锁等最多 2 秒，超时返回 `failed`、`E_IO`、`retryable: true`。

### 1.1 设置 `settings.json`

```json
{
  "schema": "zsir-cut/settings",
  "version": 1,
  "voice": { "provider": "fish_audio", "model": "s2.1-pro" },
  "network": { "proxy": null }
}
```

| 字段 | 说明 |
|---|---|
| `voice.model` | 默认生成模型。取 `s2.1-pro`、`s2.1-pro-free`、`s2-pro`、`drama-3`，默认 `s2.1-pro` |
| `network.proxy` | 访问 fish.audio 用的 HTTP 代理地址，例如 `http://127.0.0.1:7897`。为 null 时用环境变量 `HTTPS_PROXY`，也没有就直连 |

文件不存在时按上表默认值。键按字母序序列化。

### 1.2 API Key

- 存在 macOS 钥匙串：通用密码，服务名 `zsir-cut.fish-audio`，账户名 `default`。不写进任何文件、日志、结果信封或错误信息。
- 读：`security find-generic-password -s zsir-cut.fish-audio -a default -w`。
- 写和删：启动 `security -i`，把命令从标准输入写进去，不能把 Key 放在命令行参数里（参数在进程列表里看得到）。
- 测试和 CI 不碰钥匙串：内核读 Key 时，环境变量 `ZSIR_FISH_API_KEY` 有值就用它。

### 1.3 音色库 `voices.json`

```json
{
  "schema": "zsir-cut/voices",
  "version": 1,
  "voices": [
    {
      "id": "voc_01…",
      "name": "庄Sir",
      "fish_model_id": "…",
      "source": { "kind": "file", "name": "录音.wav" },
      "sample": "voices/voc_01….wav",
      "created_at": "2026-10-30T02:11:14.464Z"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 本机 ID，`voc_` 加 UUIDv7 |
| `name` | 显示名，1 到 40 个字符，可以重名 |
| `fish_model_id` | fish.audio 返回的模型 `_id` |
| `source` | `kind` 取 `file`（上传文件）或 `media`（工程里的素材），`file` 记文件名；`media` 记工程 ID、素材 ID 和源区间 |
| `sample` | 试听用的参考音频，相对本目录的路径，克隆时截出来的那段，见第 3 节 |

`voices` 按 `created_at` 再按 `id` 排序。音色库属于本机，所有工程共用。

## 2. 动词

都不属于某个工程的动词，请求不带 `project`、`base_revision`、`session_id`，不写工程日志，`receipt` 为 null。CLI 和 MCP 名字照 `term-library.md` 第 5 节的规则：`zcut voice list`、`zcut_voice_list`，依此类推。

| 动词 | 类型 | 参数 | 说明 |
|---|---|---|---|
| `settings_get` | 读 | 无 | `result.settings` 是 1.1 节的内容，加 `result.voice_key_set`（布尔），不返回 Key 本身 |
| `settings_set` | 写 | `voice.model`、`network.proxy`、`voice_key`（可选） | 只改给了的字段。`voice_key` 为字符串时写进钥匙串，为 null 时删除。返回 `applied` 或 `no_op` |
| `voice_list` | 读 | 无 | `result.voices` 是音色库全部条目 |
| `voice_edit` | 写 | `ops`：`{op: "rename", id, name}` 或 `{op: "delete", id}` | `rename` 先 `PATCH` fish.audio 的标题再改本机；`delete` 先 `DELETE` fish.audio 的模型（对方返回 404 也算成功），再删本机条目和试听文件。`changes` 每项 `entity: "voice"` |
| `voice_clone` | 长任务 | 见第 3 节 | 建一个音色 |

`voice_generate` 是工程动词，见第 4 节。

不属于工程的长任务（`voice_clone`）的任务目录放在 `~/Library/Application Support/zsir-cut/jobs/<job_id>/`，`job.json` 格式同 `command-protocol.md` 9.1.1；`job_status` 不带 `project` 时查这里。

远端和本机不能一起原子提交，按「先远端、后本机」的顺序做，有这些已知的窗口，一期接受，不做补偿：
- `voice_edit` 多项操作里后面一项远端失败时，本机库不写，但前面已成功的远端改名或删除不回滚。界面一次只发一项。
- `voice_clone` 远端建好、本机写库失败时，fish.audio 上会多一个没入库的音色。
- `settings_set` 同时改 Key 和设置文件时，Key 写进钥匙串后设置文件写失败，Key 不回滚。

## 3. 克隆 `voice_clone`

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 音色名 |
| `file` | 二选一 | 本机音频或视频文件的绝对路径 |
| `media` | 二选一 | `{project, media_id, source_start, duration}`：工程里一个素材的一段，桌面版从时间线片段右键发起时用片段的源区间 |
| `text` | 否 | 参考音频里说的话。不给时：来自工程素材且该区间有母稿的，取第 2 层 `text` 非空的字词拼起来；否则不传，由 fish.audio 自己识别。素材有多份母稿时取第一份；只取对齐区间和实际取样区间重叠的字词 |

步骤：

1. 用 ffmpeg 把参考段转成 44.1 kHz、16 位、单声道 WAV，写到 `voices/<id>.wav`。只读源文件，不改源文件。参考段短于 5 秒返回 `rejected`、`E_VALIDATION`；长于 60 秒只取前 60 秒，结果加警告 `W_VOICE_SAMPLE_TRIMMED`。fish.audio 建议 10 到 30 秒干净人声，界面上提示这一点。
2. `POST /model`，multipart：`type=tts`、`train_mode=fast`、`visibility=private`、`title=name`、`voices=<WAV>`、`texts=<text>`（有就传）、`enhance_audio_quality=true`。
3. 成功后写音色库，`result.voice` 是新条目。上游失败时删掉第 1 步写的文件，音色库不变。

## 4. 生成 `voice_generate`

工程动词，长任务，按写请求带 `project`、`base_revision`、`idempotency_key`、`author`。生成的音频按第 5 节导入为素材，整个任务完成时一次性写成一个修订。

| 参数 | 必填 | 说明 |
|---|---|---|
| `voice_id` | 是 | 音色库里的 ID |
| `model` | 否 | 不给用设置里的 `voice.model` |
| `items` | 二选一 | 零散旁白：`[{text}]`，1 到 50 条，每条 1 到 2000 个字符 |
| `cues` | 二选一 | 字幕配音：`{transcript_id, cue_ids, mode}`。`mode` 取 `per_cue`（每条字幕一段）或 `merged`（合成一段），必填，由用户在弹窗里选 |
| `params` | 否 | 见下表，都可省略 |
| `replaces` | 否 | 重新生成时，被替换的那个配音素材的 ID，记进新素材的 `take_of` |

`params` 原样映射到 fish.audio 的同名字段；不给的不传，用对方默认值：

| 参数 | 范围 | fish.audio 默认 |
|---|---|---|
| `speed` | 0.5 到 2.0，写进 `prosody.speed` | 1 |
| `volume` | dB，写进 `prosody.volume` | 0 |
| `temperature` | 0 到 1 | 0.7 |
| `top_p` | 0 到 1 | 0.7 |
| `normalize_loudness` | 布尔，写进 `prosody.normalize_loudness` | true |

固定传：`reference_id` 为音色的 `fish_model_id`，`format: "wav"`，`sample_rate: 44100`，`latency: "normal"`。`language` 不传。

字幕配音的文字：每条字幕取它第 2 层 `text` 非空的字词按顺序拼起来，不用换行。`merged` 把各条按 `cue_ids` 在母稿里的顺序拼接，条与条之间加一个中文逗号，原文末尾已有标点的不加。

选中的字幕里有一条拼出来是空文字，返回 `rejected`、`E_VALIDATION`，不发任何请求。`cues` 不另设条数和字数上限。`voice_generate` 不支持 `dry_run`，带了返回 `E_UNSUPPORTED`。

请求并发不超过 3 个。单条失败时整个任务失败、不写工程，已下载的文件删掉；`job.json` 里记下是哪一条、上游返回的状态码。

## 5. 生成结果进工程

- 文件放在工程文件所在目录的 `voice/` 文件夹，文件名 `<素材 ID>.wav`。目录不存在就建。
- 每个文件按 `import_media`（`command-protocol.md` 9.2）的规则导入，`kind` 为 `audio`。例外：不按大小和指纹去重。两段音频字节相同也各建一个素材，因为它们对应的文字和来源不同。素材名：零散旁白取文字前 20 个字符；字幕配音取第一条字幕前 20 个字符。
- 素材的 `ext["zsir.voice"]`：

| 字段 | 说明 |
|---|---|
| `kind` | `free`（零散旁白）或 `cues`（字幕配音） |
| `voice_id`、`voice_name` | 生成时的音色。音色后来被删了，素材照常可用 |
| `model`、`params` | 生成时的模型和参数 |
| `text` | 实际送去生成的文字 |
| `transcript_id`、`cue_ids` | 只有 `cues` 才有 |
| `take_of` | 替换的上一版素材 ID，没有就不写 |
| `generated_at` | 生成时间 |

- 工程文件本身不保存 Key、不保存 fish.audio 的地址。
- 同一个 `voice_generate` 请求生成的多段，在 `changes` 里按 `items` 或 `cue_ids` 的顺序列出。

## 6. 推荐位置与过期

两件事都由读取方现算，不存进工程：

- **推荐位置**：`cues` 类配音的推荐起点是 `cue_ids` 里第一条字幕投影到当前时间线后的序列起点（`timeline-schema.md` 字幕投影规则）。这条字幕在时间线上被投影成多段时，取最早的一段。这条字幕没上时间线就没有推荐位置，不改用后面的字幕。
- **过期**：`cue_ids` 里有字幕被删了，或者现在拼出的文字和 `text` 不同，这段配音算过期。

## 7. 错误

| 情况 | 状态 | 错误码 |
|---|---|---|
| 没设置 Key | `rejected` | `E_VOICE_AUTH` |
| fish.audio 返回 401 | `failed` | `E_VOICE_AUTH`，`retryable: false` |
| fish.audio 返回 402（余额不足） | `failed` | `E_VOICE_PAYMENT`，`retryable: false` |
| fish.audio 返回 429、5xx，网络超时或连不上 | `failed` | `E_VOICE_UPSTREAM`，`retryable: true` |
| 其他 4xx | `failed` | `E_VOICE_UPSTREAM`，`retryable: false`，`message` 带上对方的 `message` |

单次 HTTP 请求超时 120 秒。错误信息里不能出现 Key。

## 8. 桌面版

- 功能区新增「语音」标签，和 AI、素材、章节、字幕并列，下分三个子页：
  - **克隆**：拖入或选择音频文件；接收从时间线拖来的声音片段；下方是音色库，每项能试听、改名、删除（删除要确认，说明会同时删掉 fish.audio 上的音色）。
  - **生成**：选音色、输入文字、细调（默认收起，第 4 节 `params` 和模型）、生成。
  - **结果**：本工程里带 `ext["zsir.voice"]` 的素材。复用素材面板的卡片、试听、拖放、在访达中显示。同一条链上的 `take_of` 折叠成一项，展开看历史版本。过期的标出来，可以一键用原参数重新生成。
- 时间线上的声音片段右键「克隆为新音色」，用片段的源区间发 `voice_clone`。
- 字幕面板顶部加一个配音图标，进入选择状态：框选、Shift 连选、Cmd 多选；点「完成」弹窗，选音色、模型、「每条一段 / 合成一段」，然后生成。
- 把 `cues` 类配音拖上时间线时，在推荐位置显示一条提示线，靠近时吸附，也可以放在别处。
- 设置页（新增，顶栏齿轮图标）：fish.audio API Key（密码框，存进钥匙串后只显示「已设置」）、默认模型、代理地址。
- 界面动词不新增；`ui_state` 和 `ui_show_panel` 的标签多一个 `voice`，子页取 `clone`、`generate`、`results`（`command-protocol.md` 9.6）。

## 9. 测试

- 不联网：fish.audio 客户端可注入，测试用假的客户端，检查请求的字段、请求头和 multipart 内容。
- 不碰钥匙串和真实目录：用临时 `HOME` 和 `ZSIR_FISH_API_KEY`。
- 克隆：短于 5 秒拒绝；长于 60 秒截断并给警告；上游失败时不留文件；用工程素材时 `text` 取母稿字词。
- 生成：`per_cue` 每条一个素材，`merged` 一个；拼接规则；`ext["zsir.voice"]` 字段；任何一条失败工程不变；并发不超过 3。
- 错误码按第 7 节映射，错误信息里没有 Key。
- CLI 和 MCP 对等。
