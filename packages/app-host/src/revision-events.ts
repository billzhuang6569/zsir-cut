import type { EntityChange, JournalEntry } from "../../core/dist/index.js";

const { add, parseRational, printRational }: typeof import("../../core/dist/rational.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "../../core/src/rational.ts" : "../../core/dist/rational.js",
    import.meta.url,
  ).href
);

export function projectChanged(entry: JournalEntry, sessionId: string | null) {
  const changes = entry.changes ?? [];
  const summary: Partial<Record<EntityChange["entity"], { added: number; removed: number; changed: number }>> = {};
  for (const change of changes) {
    const counts = summary[change.entity] ?? { added: 0, removed: 0, changed: 0 };
    summary[change.entity] = counts;
    counts[change.before === null ? "added" : change.after === null ? "removed" : "changed"]++;
  }
  const position = (value: EntityChange["before"], parent: string | null) =>
    value === null
      ? null
      : {
          track_id: parent,
          start: value.timeline_start as string,
          end: printRational(
            add(parseRational(value.timeline_start as string, true), parseRational(value.duration as string, true)),
            true,
          ),
        };
  return {
    type: "project_changed" as const,
    target: sessionId ? ("session" as const) : ("main" as const),
    session_id: sessionId ?? entry.session_id ?? null,
    revision: { seq: entry.seq, id: entry.revision },
    verb: entry.verb,
    label: entry.label ?? null,
    reason: entry.reason ?? null,
    author: entry.author,
    batch: entry.batch ?? null,
    summary,
    changes: changes.slice(0, 50).map((change) => ({
      key: change.key,
      entity: change.entity,
      ...(change.entity === "clip"
        ? {
            before: position(change.before, change.before_parent),
            after: position(change.after, change.after_parent),
          }
        : {}),
    })),
    truncated: changes.length > 50,
  };
}

export type ProjectChanged = ReturnType<typeof projectChanged>;
