const project = "采访.zcut.json";
const write = {
  project,
  base_revision: "rev_42",
  idempotency_key: "step-1",
  author: { kind: "agent", name: "剪辑助手" },
};
const draft = { ...write, session_id: "ses_review" };
const human = { kind: "human", name: "剪辑师" };
const job = "job_00000000-0000-7000-8000-000000000000";
const decisions = [
  {
    question: "保留这段背景介绍吗？",
    options: [
      { id: "keep", label: "保留", recommended: true },
      { id: "cut", label: "剪掉" },
    ],
  },
];

const readOnly = "只读，无需 base_revision。";
const globalWrite = "写本机全局数据，无需 base_revision。";
const mainWrite = "写主工程，base_revision 用主工程当前修订。";
const draftWrite = "写会话元数据，base_revision 用草稿当前修订。";
const projectWrite = "默认写主工程，带 session_id 写草稿，base_revision 用目标当前修订。";
const uiOnly = "只操作桌面界面，无需 base_revision。";
const subtitleWrite = "写当前打开的工程，由宿主管理 base_revision。";
const pollJob = "收到 job_id 后用 job_status 查结果。";
const pollSubtitle = "用 ui_state 查看字幕处理进度，完成后读字幕复核。";

function describe(
  purpose: string,
  usage: string,
  target: string,
  parameters: string,
  example: object,
  next: string,
): string {
  return [purpose, usage, target, `参数：${parameters}`, JSON.stringify(example), next].join("\n");
}

export const TOOL_DOCS: Record<string, string> = {
  inspect: describe(
    "按视图读取工程。",
    "刚接手用 brief，核对剪点用 timeline，查原始对象用 entity；桌面 MCP 可用 guide 读工作指南。",
    readOnly,
    "view；按视图提供 timeline_id、id 或 session_id；guide 用 name（rough-cut、subtitles、handoff）。",
    { project, view: "brief" },
    "从结果取当前修订和实体 ID，再读所需范围或发起编辑。",
  ),
  read_transcript: describe(
    "读取母稿或投影到时间线的转写。",
    "按原话找剪点或校字幕时使用，删话时使用返回的字词 ID。",
    readOnly,
    "transcript_id、timeline_id、range；需要字级时间时用 with_times。",
    { project, timeline_id: "tl_main", with_times: true },
    "用字词 ID 指定 remove_span 或 edit_text 的范围。",
  ),
  validate: describe(
    "校验工程结构和语义。",
    "交接前跑 L1；还要确认素材在线和指纹时加跑 L2。",
    readOnly,
    "media、session_id。",
    { project },
    "按 verification.issues 定位问题再复查。",
  ),
  diff: describe(
    "对比两次修订的实体差异。",
    "复核改动时使用，查看单个实体的现状用 inspect entity。",
    readOnly,
    "from、to（默认当前修订）、session_id。",
    { project, from: "rev_41" },
    "按差异里的实体 ID 复查重点改动。",
  ),
  import_media: describe(
    "探测素材、计算指纹并登记，或重链接离线素材。",
    "加入新文件用 paths，移动后的素材用 relink。",
    mainWrite,
    "paths 或 relink.search_roots，后者可指定 media_ids。",
    { ...write, paths: ["/素材/采访.mov"] },
    "用返回的素材 ID 放置片段，或验证重链接结果。",
  ),
  edit: describe(
    "原子执行一组有序编辑操作。",
    "先读准对象 ID；删一段话用 remove_span 的 tokens。每组只含一个域，范围不确定先 dry_run。",
    `${projectWrite} 批次后续步骤可省略 base_revision。`,
    `ops、timeline_id、label（Agent 必填）、turn（可选，按轮撤回用）。

剪辑域
place 放置素材：media_id、source_start/duration 或 tokens、at（可为 end）、video_track/audio_track、mode（insert/overwrite）。
remove 删除整段：clip_ids、linked、ripple。
remove_span 删除区间：range 或 tokens（同段话多次出现时带 clip_id）、tracks、ripple、snap。
trim 修剪入点或出点：clip_id、edge、to、ripple、linked。
split 切成两段：clip_id、at、new_id。
roll 滚动相邻剪点：clip_id、edge、to、linked。
move 移动片段：clip_ids、to、track_id、mode（place/insert；0.2 加 overwrite）。
slip 只挪源内容：clip_id、by（有符号有理数秒）、linked（0.2）。
slide 挪片段并修剪邻居：clip_id、by（有符号有理数秒）、linked（0.2）。
set_clip 修改片段属性：clip_id、gain_db、transform、time_map 等。
add_transition 加转场：from_clip、to_clip、duration、alignment。
remove_transition 删转场：transition_id。
add_marker 加标记：at、duration、kind、text；章节可带 level、description。
update_marker 改标记：marker_id 加要改的字段。
remove_marker 删标记：marker_id。
add_track 加视频或音频轨：kind、name、index。
remove_track 删轨：track_id；视音频轨须为空且未被字幕承载引用。
rename_track 改轨名：track_id、name；字幕轨归字幕域。
set_track 设置可见、静音或锁定：track_id、enabled、locked；字幕轨归字幕域（0.2）。
update_media 整理素材：media_id 加 tags、folders、rating、note 或 link。

字幕域
edit_text 改显示文字并保留听到的内容：transcript_id、from_token、to_token、text。
replace_text 批量查找替换：find、replace、transcript_ids 或 cue_ids、match_case。
hide_tokens 隐藏字词的显示文字：transcript_id、tokens。
set_token_state 设置字词状态：transcript_id、tokens、state；批准需用户确认。
split_token 按源时间拆字词：transcript_id、token_id、at、new_id。
resegment 重切字幕条：transcript_id、range、rules 或 cut_after；跳过锁定条。
set_cue 改字幕条：cue_id、breaks、timing、style_id、state。
split_cue 拆字幕条：cue_id、after_token、new_id。
merge_cues 合并相邻字幕条：cue_ids。
mark_proofread 标记母稿已校对：transcript_id。
set_override 为单次素材使用设置字幕例外：track_id、occurrence_id、cue_id、hidden/text/style_id。
remove_override 撤去单次使用的字幕例外：track_id、occurrence_id、cue_id。
add_free_cue 加独立字幕：track_id、timeline_start、duration、text、style_id。
remove_free_cue 删独立字幕：track_id、id。
add_style 加字幕样式：id、name 和样式字段。
update_style 改字幕样式并升版本：style_id 加要改的字段。
add_subtitle_track 加字幕轨：language、carrier_tracks、default_style_id。
set_recognition 改识别设置：language、terms 等；需要重新识别时调用 transcribe。
add_overlay 加字幕叠层配置：name、timeline_id、subtitle_track_id、output_path。
update_overlay 改叠层配置：overlay_id 加要改的字段。
remove_overlay 删叠层配置：overlay_id；已导出的文件保留。

宏操作（0.2，展开为基础操作；scope 用 range 或 clip_ids，省略为整条时间线）
tighten_pauses 压短同一片段内的停顿：scope、max_pause、min_gap。
remove_fillers 剪掉匹配的语气词及声音：scope、words、pause。
keep_tokens 只留指定字词段并合拢：clip_id、keep（from_token/to_token 列表）、pause、scope。
close_gaps 合拢全部视音频轨都空着的间隙：scope。`,
    { ...write, label: "删重复介绍", ops: [{ op: "remove", clip_ids: ["clp_intro"], ripple: true }] },
    "检查 changes 和警告，再读时间线并用 receipt.after 作为后续写入基准。",
  ),
  undo: describe(
    "撤销上一步、整批改动或整轮 AI 改动。",
    "纠正最近编辑时用；回到任意历史点用 restore。",
    projectWrite,
    "target、batch_id、turn_id（三选一或省略）。",
    write,
    "用 inspect history 确认撤销结果。",
  ),
  redo: describe(
    "重做已撤销的步骤。",
    "恢复刚撤销的改动时用。",
    projectWrite,
    "target（省略时重做最近可重做的步骤）。",
    write,
    "重读时间线确认结果。",
  ),
  restore: describe(
    "以指定历史修订的内容创建新修订。",
    "用户要回到某一步时使用；只查看旧版本用 inspect。",
    mainWrite,
    "target。",
    { ...write, target: "rev_41" },
    "核对回执的新修订，再读时间线。",
  ),
  batch_status: describe(
    "查询有序编辑批次的进度。",
    "收到 queued 或等待批次收尾时使用。",
    readOnly,
    "batch_id。",
    { project, batch_id: "bat_roughcut" },
    "处理缺失或失败的步骤，完成后复查时间线。",
  ),
  transcribe: describe(
    "识别和对齐素材语音，生成母稿和初始字幕。",
    "缺少识别结果时用；已有母稿的错字用字幕编辑。",
    mainWrite,
    "media_id、range、engine（auto/local/cloud）。",
    { ...write, media_id: "med_interview" },
    pollJob,
  ),
  session_begin: describe(
    "从主工程开一个编辑会话。",
    "用户要先审方案或对比版本时用，明确要直接剪时编辑主工程。",
    "新建会话草稿，base_revision 用主工程当前修订。",
    "approval、intent。",
    { ...write, approval: "manual", intent: "对比两版开场" },
    "保存 session_id，后续写入指向草稿。",
  ),
  session_review: describe(
    "提交草稿供用户审阅。",
    "草稿完成后用；只读改动摘要用 inspect review。",
    draftWrite,
    "session_id。",
    draft,
    "让用户在界面审阅方案。",
  ),
  session_approve: describe(
    "批准会话并把草稿合并到主工程。",
    "仅在用户明确批准时调用。",
    mainWrite,
    "session_id、author（human）。",
    { ...draft, author: human },
    "核对主工程新修订及合并结果。",
  ),
  session_reject: describe(
    "结束并拒绝编辑会话。",
    "用户决定放弃草稿时调用。",
    "写会话元数据，base_revision 用主工程当前修订。",
    "session_id、author（human）。",
    { ...draft, author: human },
    "确认会话已拒绝，再回主工程。",
  ),
  session_ask: describe(
    "在编辑会话中留下待决定的问题。",
    "草稿上的关键取舍用它；直接改主工程的取舍用 ask。",
    draftWrite,
    "session_id、decisions（question、options、refs）。",
    { ...draft, decisions },
    "记下决定 ID，继续处理无关改动。",
  ),
  session_answer: describe(
    "记录用户对会话决定的回答。",
    "有明确回答时使用，剪辑在后续 edit 执行。",
    draftWrite,
    "session_id、decision_id、option_id / text / skip 三选一。",
    { ...draft, author: human, decision_id: "dec_intro", option_id: "keep" },
    "读取回答，按需更新草稿。",
  ),
  ask: describe(
    "把关键取舍加到工程的待决定队列。",
    "先按保守方案做，意思、事实或结构有重要取舍时再问。",
    "写工程决定队列，不产生修订；base_revision 用主工程当前修订。",
    "decisions（question、options、refs；选项可带 ops）。",
    { ...write, decisions },
    "继续处理无关部分，等待用户点选。",
  ),
  answer: describe(
    "记录用户选项或文字，并尝试执行所选操作。",
    "用户已作选择时使用。",
    "写工程决定队列；选项带 ops 时可写主工程，base_revision 用主工程当前修订。",
    "decision_id、option_id / text / skip 三选一。",
    { ...write, author: human, decision_id: "dec_intro", option_id: "keep" },
    "检查 execution；stale 时按最新工程重做。",
  ),
  render_preview: describe(
    "渲染整条时间线的代理预览。",
    "需要通看剪辑节奏时用；正式交接用 export。",
    "写预览文件，无需 base_revision。",
    "timeline_id、output、at_revision。",
    { project, timeline_id: "tl_main", output: "/tmp/preview" },
    pollJob,
  ),
  view_timeline: describe(
    "生成剪点胶片条和波形。",
    "视觉自检剪点时用；看整条视频用 render_preview。",
    "写检查图片，无需 base_revision。",
    "timeline_id、output、at_revision。",
    { project, timeline_id: "tl_main", output: "/tmp/check" },
    pollJob,
  ),
  export: describe(
    "生成 NLE 交接包或直接导出文件。",
    "交接先 dry_run 看损失，确认后再写文件。",
    "写到 output；字幕叠层也更新工程，base_revision 用当前修订。",
    "profile、output、timeline_id；字幕叠层用 overlay_id。",
    { ...write, profile: "direct-srt", output: "/tmp/export", dry_run: true },
    "检查损失报告；收到 job_id 后用 job_status 查结果。",
  ),
  create_project: describe(
    "新建工程和一条空时间线。",
    "开始新剪辑时用；已有工程用 inspect。",
    "写新 .zcut.json，无需 base_revision。",
    "project、name、timeline；可用 match_media 匹配素材规格。",
    { project, name: "采访", timeline: { edit_rate: "25" }, idempotency_key: "create-1", author: human },
    "用返回的修订导入素材。",
  ),
  record_handoff_check: describe(
    "记录 NLE 导入或渲染对照的验收结果。",
    "实机验收完成后用，同类检查再次记录会整体覆盖。",
    "更新交接包 manifest.json，无需 base_revision。",
    "package、check、status；可附 host_version 和 items。",
    { package: "/交接/采访", check: "host_import", status: "pass" },
    "确认验收记录后交接。",
  ),
  job_status: describe(
    "查询长任务进度和最终结果。",
    "工具返回 accepted 时使用。",
    readOnly,
    "job_id、project（全局音色克隆任务省略）。",
    { project, job_id: job },
    "完成后读取任务信封，失败时根据 error 判断下一步。",
  ),
  terms_list: describe(
    "查询全局名词库。",
    "确认品牌、人名是否收录时用；读当前项目的识别设置用 inspect。",
    readOnly,
    "query、state。",
    { query: "品牌" },
    "按需在识别或校对时使用命中词。",
  ),
  terms_edit: describe(
    "编辑全局名词库。",
    "希望后续工程也使用该词时用；只改当前字幕用 edit。",
    globalWrite,
    "ops，逐项给 op（add/remove/block/unblock）和 text。",
    { ops: [{ op: "add", text: "凯迪仕" }] },
    "用 terms_list 回读。",
  ),
  settings_get: describe(
    "读取本机语音和网络设置。",
    "查看默认模型、密钥配置状态或代理设置时用。",
    readOnly,
    "无。",
    {},
    "按需用 settings_set 更新。",
  ),
  settings_set: describe(
    "更新本机语音、密钥或网络设置。",
    "用户调整本机偏好时用；只指定一次生成模型用 voice_generate。",
    globalWrite,
    "voice.model、voice_key、network.proxy。",
    { voice: { model: "s2.1-pro" } },
    "用 settings_get 回读状态。",
  ),
  voice_list: describe(
    "列出本机音色。",
    "选择配音音色或确认克隆结果时用。",
    readOnly,
    "无。",
    {},
    "用返回的音色 ID 发起配音。",
  ),
  voice_edit: describe(
    "重命名或删除全局音色。",
    "管理音色库时用；给时间线配音用 voice_generate。",
    globalWrite,
    "ops，逐项给 op（rename/delete）、id，重命名带 name。",
    { ops: [{ op: "rename", id: "voc_00000000-0000-7000-8000-000000000000", name: "解说" }] },
    "用 voice_list 回读。",
  ),
  voice_clone: describe(
    "从音频样本克隆音色。",
    "用户要新音色时用，有可用音色时直接生成。",
    globalWrite,
    "name、file 或 media，可给 text 提示。",
    { name: "解说", file: "/素材/样本.wav" },
    pollJob,
  ),
  voice_generate: describe(
    "用指定音色生成配音并登记素材。",
    "有确认的文本或字幕范围时用；新建音色用 voice_clone。",
    mainWrite,
    "voice_id、items 或 cues、params。",
    { ...write, voice_id: "voc_00000000-0000-7000-8000-000000000000", items: [{ text: "欢迎收看。" }] },
    "用 job_status 取生成的素材 ID，再试听或放置。",
  ),
  ui_state: describe(
    "读当前界面、播放头、选中对象和字幕任务。",
    "需要理解用户指的「这里」时用，工程详情用 inspect。",
    readOnly,
    "无。",
    {},
    "用返回的选中 ID 或播放头定位用户指的范围。",
  ),
  ui_show_panel: describe(
    "打开桌面面板或历史悬浮窗。",
    "要把相关功能指给用户时用。",
    uiOnly,
    "panel、sub（例如 subtitles/style 或 chapters/outline）。",
    { panel: "subtitles", sub: "style" },
    "按需定位并选中要展示的对象。",
  ),
  ui_seek: describe(
    "移动播放头并滚动到目标。",
    "带用户看剪点时用；改片段位置用 edit。",
    uiOnly,
    "at（序列时间）或 id。",
    { at: "12s" },
    "按需选中目标或播放一段。",
  ),
  ui_select: describe(
    "选中界面上的实体。",
    "指给用户看某些对象时用；查看实体数据用 inspect entity。",
    uiOnly,
    "ids（空数组取消选中）。",
    { ids: ["clp_intro"] },
    "按需定位播放头或打开相关面板。",
  ),
  ui_play: describe(
    "从播放头或指定区间开始播放。",
    "请用户试听一段时用；生成预览文件用 render_preview。",
    uiOnly,
    "range、loop。",
    { range: { start: "12s", duration: "3s" } },
    "需要停止时调用 ui_pause。",
  ),
  ui_pause: describe(
    "暂停当前播放。",
    "用户要停下查看某处时用。",
    uiOnly,
    "无。",
    {},
    "按需用 ui_state 查看停下的位置。",
  ),
  subtitle_tidy: describe(
    "用 AI 重新分行和断句。",
    "用户希望调整字幕可读性时用；识别后若正在自动整理，等待当前任务。",
    subtitleWrite,
    "transcript_id、cue_ids、request。",
    { request: "按语义分行" },
    pollSubtitle,
  ),
  subtitle_proofread: describe(
    "用 AI 校对字幕文字。",
    "需要查错字和人名时用；只调整分行用 subtitle_tidy。",
    subtitleWrite,
    "transcript_id、cue_ids、request。",
    { request: "核对人名和品牌名" },
    pollSubtitle,
  ),
};
