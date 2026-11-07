import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { actions, keyNotation, mergeKeymap } from "./keymap.js";

const chapters = z.strictObject({
  view: z.enum(["outline", "timeline"]),
  zoom: z.number().min(0.5).max(4),
  folded: z.array(z.string()),
});
const layout = z.strictObject({
  left_width: z.number().int().min(200).max(560).nullable(),
  right_width: z.number().int().min(240).max(600).nullable(),
  timeline_height: z.number().min(0.2).max(0.75).multipleOf(0.001).nullable(),
});
const defaultLayout = { left_width: null, right_width: null, timeline_height: null };
export type Layout = z.infer<typeof layout>;
const ui = z.strictObject({
  snap: z.boolean(),
  magnetic: z.boolean(),
  timeline_zoom: z.number().positive().nullable(),
  track_height: z.enum(["s", "m", "l"]),
  chapters,
  layout: layout.default(defaultLayout),
});
const keymap = z.strictObject({
  preset: z.enum(["fcp", "premiere"]),
  overrides: z.partialRecord(z.enum(actions), z.string().regex(keyNotation).nullable()),
});
const previewCache = z.strictObject({
  directory: z.string().refine((path) => isAbsolute(path) || path === "~" || path.startsWith("~/")),
  limit_gb: z.number().int().min(1).max(2000),
  quality: z.enum(["540p", "720p", "1080p"]),
  auto: z.boolean(),
  pause_on_battery: z.boolean(),
});
const preferences = z.strictObject({
  schema: z.literal("zsir-cut/desktop"),
  version: z.literal(1),
  default_agent: z.enum(["claude", "codex"]).nullable(),
  keymap,
  preview_cache: previewCache,
  ui,
});
const patchSchema = preferences.partial().extend({
  keymap: keymap.partial().optional(),
  preview_cache: previewCache.partial().optional(),
  ui: ui.partial().extend({ chapters: chapters.partial().optional(), layout: layout.partial().optional() }).optional(),
});
export type Preferences = z.infer<typeof preferences>;
export const defaultPreferences: Preferences = {
  schema: "zsir-cut/desktop",
  version: 1,
  default_agent: null,
  keymap: { preset: "fcp", overrides: {} },
  preview_cache: {
    directory: "~/Movies/庄Sir剪辑助手/预览缓存",
    limit_gb: 20,
    quality: "720p",
    auto: true,
    pause_on_battery: true,
  },
  ui: {
    snap: true,
    magnetic: true,
    timeline_zoom: null,
    track_height: "m",
    chapters: { view: "outline", zoom: 1, folded: [] },
    layout: defaultLayout,
  },
};
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? merge(base[key] as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}
function serialize(value: unknown) {
  return `${JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )}\n`;
}
export class DesktopPreferences {
  private file: string;
  private value = structuredClone(defaultPreferences);
  private writes = Promise.resolve();
  warning: { type: "warning"; code: "W_PREFS_RESET"; message: string } | undefined;
  constructor(
    directory = process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/zsir-cut")
      : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "zsir-cut"),
  ) {
    this.file = join(directory, "desktop.json");
  }
  async load() {
    try {
      this.value = preferences.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warning = { type: "warning", code: "W_PREFS_RESET", message: "应用偏好无法读取，已恢复默认设置" };
        await rename(this.file, `${this.file}.broken`).catch(() => {});
      }
      this.value = structuredClone(defaultPreferences);
    }
  }
  get() {
    const prefs = structuredClone(this.value);
    const directory = prefs.preview_cache.directory;
    return {
      prefs,
      preview_cache_directory:
        directory === "~" ? homedir() : directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory,
      ...mergeKeymap(prefs.keymap.preset, prefs.keymap.overrides),
    };
  }
  async set(patch: unknown) {
    const parsed = patchSchema.parse(patch);
    const operation = this.writes.then(async () => {
      const merged = merge(this.value, parsed);
      if (parsed.keymap?.overrides !== undefined)
        (merged.keymap as Preferences["keymap"]).overrides = parsed.keymap.overrides;
      const next = preferences.parse(merged);
      const content = serialize(next);
      if (content === serialize(this.value)) return { status: "no_op" as const, result: this.get() };
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, content);
      await rename(temporary, this.file);
      this.value = next;
      return { status: "applied" as const, result: this.get() };
    });
    this.writes = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
