import type { Envelope } from "./dispatch.ts";

type SummaryEnvelope = Pick<Envelope, "changes" | "receipt" | "status" | "verification"> & {
  verb: string;
  result: unknown;
  error: { code: string; message: string } | null;
};

const warningMessages: Record<string, string> = {
  W_ASR_ALIGN_DEGRADED: "部分字词的对齐质量较低。",
  W_ASR_EMPTY: "没有识别到字词。",
  W_ASR_REPETITION: "识别结果含连续重复的字词。",
  W_ASR_ZERO_WIDTH: "修正了零时长字词。",
  W_FILLERS_HIDDEN: "隐藏了部分语气词的字幕。",
  W_RIPPLE_SKIPPED: "有片段挡住合拢，保留了空隙。",
  W_REPLACE_SKIPPED_LOCKED: "跳过受锁定保护的字幕。",
};

export function summarizeToolResult(envelope: SummaryEnvelope, input?: Record<string, unknown>): string {
  const { receipt, changes, status, verb, error } = envelope;
  const result = envelope.result as Record<string, unknown> | null;
  const project = result?.project as { revision?: unknown } | undefined;
  const revision = result?.revision ?? project?.revision;
  const revisionId = typeof revision === "object" && revision && "id" in revision ? revision.id : revision;
  const current = receipt?.after ?? receipt?.before ?? (typeof revisionId === "string" ? revisionId : "—");
  const lines = [`${status} ${verb} ${current}`];
  if (error) lines.push(`${error.code} ${error.message}`);
  if (typeof result?.job_id === "string") lines.push(`job_id ${result.job_id}`);
  const label = result?.label ?? input?.label;
  if (typeof label === "string" && label) lines.push(`label ${label}`);

  const counts = new Map<string, Record<Envelope["changes"][number]["action"], number>>();
  for (const { entity, action } of changes) {
    const count = counts.get(entity) ?? { created: 0, removed: 0, updated: 0 };
    if (action === "created" || action === "removed") count[action]++;
    else count.updated++;
    counts.set(entity, count);
  }
  for (const [entity, { created, removed, updated }] of counts)
    lines.push(`${entity} 新增 ${created}，删除 ${removed}，修改 ${updated}`);

  const warnings = new Set<string>();
  for (const issue of envelope.verification.issues) {
    if (issue.severity === "warning") warnings.add(`${issue.code} ${issue.message}`);
    if (issue.severity === "error" && !error) lines.push(`${issue.code} ${issue.message}`);
  }
  if (Array.isArray(result?.warnings)) {
    for (const warning of result.warnings) {
      const code = typeof warning === "string" ? warning : warning?.code;
      if (typeof code !== "string") continue;
      const message = warning?.message ?? warning?.reason ?? warningMessages[code] ?? "详见结构化结果。";
      warnings.add(`${code} ${message}`);
    }
  }
  lines.push(...warnings);

  const summary = lines
    .slice(0, 21)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");
  return summary.length > 2000 ? `${summary.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, "")}…` : summary;
}
