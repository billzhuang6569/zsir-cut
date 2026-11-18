import type { ProjectChanged } from "../../app-host/src/revision-events.js";

export function aiTurnSteps(events: ProjectChanged[], turn: string | null | undefined) {
  return [
    ...new Map(
      events
        .filter((event) => turn && event.turn === turn && event.author?.kind === "agent")
        .map((event) => [event.revision.id, event]),
    ).values(),
  ];
}

export function aiTimelineChanges(steps: ProjectChanged[], cleared: boolean) {
  const clips = new Map<string, string>();
  const removals = new Map<string, { track: string; at: string; label: string }>();
  if (!cleared) {
    for (const step of steps) {
      const label = step.label ?? "修改片段";
      for (const change of step.changes) {
        if (change.entity !== "clip") continue;
        if (change.after) {
          clips.set(change.key, label);
          removals.delete(change.key);
        } else if (change.before?.track_id) {
          clips.delete(change.key);
          removals.set(change.key, { track: change.before.track_id, at: change.before.start, label });
        }
      }
    }
  }
  return { clips, removals };
}

export function aiProgress(steps: ProjectChanged[]) {
  const batch = steps.at(-1)?.batch;
  return `AI 正在剪… 第 ${batch ? `${batch.seq} / ${batch.count}` : Math.max(1, steps.length)} 步`;
}
