import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Envelope, Project, Verb } from "../../core/dist/index.js";

const { newId, readAsrSettings }: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

const gatedVerbs = [
  "export",
  "record_handoff_check",
  "voice_generate",
  "voice_clone",
  "transcribe",
  "terms_edit",
  "voice_edit",
] as const;
const permissionsSchema = z.strictObject({
  schema: z.literal("zsir-cut/permissions"),
  version: z.literal(1),
  allow: z.array(z.enum(gatedVerbs)),
});
const permissionAnswer = z.strictObject({
  id: z.string().startsWith("prm_"),
  answer: z.enum(["once", "project", "deny"]),
  message: z.string().optional(),
});
export type HostEnvelope = Omit<Envelope, "error"> & {
  error:
    | Envelope["error"]
    | { code: "E_PERMISSION_DENIED"; message: string; retryable: boolean; details: { message: string } };
};
export function permissionDenied(verb: Verb, message: string): HostEnvelope {
  return {
    ok: false,
    status: "rejected",
    verb,
    request_id: newId("req_"),
    receipt: null,
    changes: [],
    verification: { level: "none", passed: false, issues: [] },
    result: null,
    error: { code: "E_PERMISSION_DENIED", message: "用户拒绝了许可", retryable: false, details: { message } },
  };
}
async function readPermissions(file: string) {
  try {
    return permissionsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
      await rename(file, `${file}.broken`);
    }
    return permissionsSchema.parse({ schema: "zsir-cut/permissions", version: 1, allow: [] });
  }
}
async function needsPermission(verb: Verb, command: Record<string, unknown>) {
  if (verb !== "transcribe") return true;
  if (command.engine === "local") return false;
  if (command.engine === "cloud" || (await readAsrSettings()).mode === "api") return true;
  try {
    const config = JSON.parse(await readFile(join(homedir(), ".zsir-cut/config.json"), "utf8"));
    return config?.asr?.cloud_fallback === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
function describe(verb: Verb, command: Record<string, unknown>, projectPath: string) {
  const target =
    verb === "export"
      ? resolve(typeof command.output === "string" ? command.output : dirname(projectPath))
      : verb === "record_handoff_check" && typeof command.package === "string"
        ? resolve(command.package)
        : null;
  const descriptions: Partial<Record<Verb, [string, string]>> = {
    export: [`导出到「${basename(target ?? "")}」`, "将在此文件夹写入导出文件。"],
    record_handoff_check: [`更新「${basename(target ?? "交接")}」的交接检查`, "将把验收结果写入交接包。"],
    voice_generate: ["生成配音", "将调用云端语音服务生成配音，可能产生费用。"],
    voice_clone: ["克隆音色", "将上传参考音频并创建云端音色，可能产生费用。"],
    transcribe: ["使用云端识别声音", "音频可能上传至云端语音识别服务。"],
    terms_edit: ["修改全局名词库", "将修改本机共享的名词库，影响其他工程。"],
    voice_edit: ["修改全局音色库", "将修改共享的音色库，删除音色时也会删除云端模型，影响其他工程。"],
  };
  const [title, detail] = descriptions[verb] ?? ["请求许可", "请确认本次操作。"];
  return { type: "permission_request" as const, id: `prm_${randomUUID()}`, verb, title, detail, target, command };
}
type Request = ReturnType<typeof describe>;
export class Permissions {
  private pending = new Map<
    string,
    {
      request: Request;
      file: string;
      chat: string | undefined;
      shown: boolean;
      resolve: (message: string | null) => void;
    }
  >();
  waitingForChat(chat: string) {
    return [...this.pending.values()].some((item) => item.chat === chat && item.shown);
  }
  private operations = Promise.resolve();
  constructor(private ui: () => ((request: Request) => void) | undefined) {}
  request(
    verb: Verb,
    command: Record<string, unknown>,
    projectPath: string,
    load: () => Promise<Project>,
    chat?: string,
  ) {
    if (
      !gatedVerbs.includes(verb as (typeof gatedVerbs)[number]) ||
      (verb === "export" && command.dry_run === true) ||
      (verb === "transcribe" && command.engine === "local")
    )
      return Promise.resolve(null);
    const request = describe(verb, command, projectPath);
    return new Promise<string | null>((resolve) => {
      const item = { request, file: "", chat, shown: false, resolve };
      this.pending.set(request.id, item);
      const operation = this.operations.then(async () => {
        if (!this.pending.has(request.id)) return;
        if (!(await needsPermission(verb, command))) {
          this.finish(request.id, null);
          return;
        }
        item.file = join(dirname(projectPath), ".zcut", (await load()).id, "permissions.json");
        if ((await readPermissions(item.file)).allow.includes(verb as (typeof gatedVerbs)[number])) {
          this.finish(request.id, null);
          return;
        }
        if (!this.pending.has(request.id)) return;
        const send = this.ui();
        if (!send) this.finish(request.id, "桌面版界面没有打开");
        else {
          item.shown = true;
          send(request);
        }
      });
      this.operations = operation.catch((error) => this.finish(request.id, `无法读取工程许可：${String(error)}`));
    });
  }
  private finish(id: string, message: string | null) {
    const item = this.pending.get(id);
    this.pending.delete(id);
    item?.resolve(message);
  }
  async answer(input: unknown) {
    const answer = permissionAnswer.parse(input);
    const operation = this.operations.then(async () => {
      const item = this.pending.get(answer.id);
      if (!item?.shown) throw new z.ZodError([{ code: "custom", path: ["id"], message: "许可请求已结束或不存在" }]);
      if (answer.answer === "project") {
        const value = await readPermissions(item.file);
        if (!value.allow.includes(item.request.verb as (typeof gatedVerbs)[number]))
          value.allow.push(item.request.verb as (typeof gatedVerbs)[number]);
        value.allow.sort();
        await mkdir(dirname(item.file), { recursive: true });
        const temporary = `${item.file}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify({ allow: value.allow, schema: value.schema, version: value.version })}\n`,
        );
        await rename(temporary, item.file);
      }
      this.finish(answer.id, answer.answer === "deny" ? (answer.message ?? "") : null);
    });
    this.operations = operation.catch(() => {});
    await operation;
    return { status: "applied" as const, result: {} };
  }
  replay() {
    const send = this.ui();
    if (send) for (const item of this.pending.values()) if (item.shown) send(item.request);
  }
  denyChat(chat: string | undefined) {
    for (const [id, item] of this.pending) if (item.chat === chat) this.finish(id, "对话已停止");
  }
  clear() {
    for (const id of this.pending.keys()) this.finish(id, "工程或宿主已关闭");
  }
}
