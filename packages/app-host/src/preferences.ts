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
  version: z.number().int().min(2),
  default_agent: z.enum(["claude", "codex"]).nullable(),
  keymap,
  preview_cache: previewCache,
  ui,
});
const patchSchema = preferences.partial().extend({
  version: z.literal(2).optional(),
  keymap: keymap.partial().optional(),
  preview_cache: previewCache.partial().optional(),
  ui: ui.partial().extend({ chapters: chapters.partial().optional(), layout: layout.partial().optional() }).optional(),
});
export type Preferences = z.infer<typeof preferences>;
export const defaultPreferences: Preferences = {
  schema: "zsir-cut/desktop",
  version: 2,
  default_agent: null,
  keymap: { preset: "fcp", overrides: {} },
  preview_cache: {
    directory: "~/Movies/庄Sir剪辑助手/预览缓存",
    limit_gb: 20,
    quality: "720p",
    auto: true,
    pause_on_battery: false,
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
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(patch).map(([key, value]) => [
      key,
      isObject(value) ? merge(Object.hasOwn(base, key) && isObject(base[key]) ? base[key] : {}, value) : value,
    ]),
  ]);
}
function readItem(
  schema: z.core.$ZodType,
  stored: unknown,
  fallback: unknown,
  invalid: string[],
  path = "",
): { value: unknown; extras: Record<string, unknown> } {
  const inner = schema instanceof z.ZodDefault ? schema.unwrap() : schema;
  if ((inner instanceof z.ZodObject || inner instanceof z.ZodRecord) && isObject(stored)) {
    const shape: z.ZodRawShape =
      inner instanceof z.ZodObject
        ? inner.shape
        : Object.fromEntries(
            Object.keys(stored)
              .filter((key) => z.safeParse(inner.keyType, key).success)
              .map((key) => [key, inner.valueType]),
          );
    const extras = Object.fromEntries(Object.entries(stored).filter(([key]) => !Object.hasOwn(shape, key)));
    const entries = Object.entries(shape).map(([key, child]) => {
      const item = readItem(
        child,
        Object.hasOwn(stored, key) ? stored[key] : undefined,
        isObject(fallback) ? fallback[key] : undefined,
        invalid,
        path ? `${path}.${key}` : key,
      );
      if (Object.keys(item.extras).length) extras[key] = item.extras;
      return [key, item.value];
    });
    return { value: Object.fromEntries(entries.filter(([, value]) => value !== undefined)), extras };
  }
  const parsed = z.safeParse(schema, stored);
  if (parsed.success) return { value: parsed.data, extras: {} };
  if (stored !== undefined) invalid.push(path);
  return { value: structuredClone(fallback), extras: {} };
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
  private extras: Record<string, unknown> = {};
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
    let stored: unknown;
    this.warning = undefined;
    this.extras = {};
    try {
      stored = JSON.parse(await readFile(this.file, "utf8"));
      if (!isObject(stored)) throw new Error("Preferences must be an object");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warning = { type: "warning", code: "W_PREFS_RESET", message: "应用偏好无法读取，已恢复默认设置" };
        await rename(this.file, `${this.file}.broken`).catch(() => {});
      }
      this.value = structuredClone(defaultPreferences);
      return;
    }
    const migrated = stored.version === 1;
    const invalid: string[] = [];
    const loaded = readItem(preferences, migrated ? { ...stored, version: 2 } : stored, defaultPreferences, invalid);
    this.value = preferences.parse(loaded.value);
    this.extras = loaded.extras;
    if (invalid.length) {
      this.warning = {
        type: "warning",
        code: "W_PREFS_RESET",
        message: `这几项设置无效，已恢复默认：${invalid.join("、")}`,
      };
    }
    if (migrated) {
      this.value.preview_cache.pause_on_battery = false;
      await this.persist(this.value);
    }
  }
  private async persist(next: Preferences) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialize(merge(this.extras, next)));
    await rename(temporary, this.file);
    this.value = next;
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
      // Patches must not downgrade a file written by a newer version.
      merged.version = this.value.version;
      if (parsed.keymap?.overrides !== undefined)
        (merged.keymap as Preferences["keymap"]).overrides = parsed.keymap.overrides;
      const next = preferences.parse(merged);
      const content = serialize(next);
      if (content === serialize(this.value)) return { status: "no_op" as const, result: this.get() };
      await this.persist(next);
      return { status: "applied" as const, result: this.get() };
    });
    this.writes = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
