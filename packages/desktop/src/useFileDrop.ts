import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectView } from "./connection.js";
import { DESKTOP_AUTHOR } from "./connection.js";
import { type DropTarget, type PlaceMode, type Placement, placeMedia, placementKinds } from "./media.js";
import type { UiState } from "./state.js";
import { add, type MediaView, parseRational, printRational } from "./timeline.js";
import { fileName, orderedPaths } from "./timelineDrop.js";

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
type ImportResult = {
  imported?: { media_id: string }[];
  skipped?: { media_id: string }[];
  receipt?: { before: string | null; after: string | null } | null;
};
export type TimelineLanding = { target: DropTarget; at: string; mode: PlaceMode };

export function listenFileDrop(
  handler: Parameters<ReturnType<typeof getCurrentWindow>["onDragDropEvent"]>[0],
  error: () => void,
) {
  let active = true;
  let unlisten: (() => void) | undefined;
  if (isTauri())
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (active) handler(event);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {
        if (active) error();
      });
  return () => {
    active = false;
    unlisten?.();
  };
}

export async function importAndPlace(
  paths: Iterable<string>,
  project: ProjectView,
  state: UiState,
  landing: TimelineLanding,
  placement: Placement,
  call: Call,
  current: () => boolean,
  report: (message: string | null) => void,
) {
  const failures: string[] = [];
  const named = (path: string, error: unknown) => {
    const message =
      error instanceof Error
        ? typeof error.cause === "string" && error.cause.startsWith("E_IO ")
          ? error.cause.slice(5)
          : error.message
        : String(error);
    return `${fileName(path)}：${message}`;
  };
  let revision = project.revision.id;
  let at = landing.at;
  let view = project;
  const ops: Record<string, unknown>[] = [];
  const placed: string[] = [];
  const gapTracks = new Map<string, string>();
  const pairs = new Map<string, string>();

  for (const path of orderedPaths(paths, Array.isArray(paths))) {
    if (!current()) return;
    try {
      const request = {
        project: state.project,
        base_revision: revision,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
      };
      const result = (await call("import_media", { ...request, label: "导入素材", paths: [path] })) as ImportResult;
      if (!current()) return;
      revision = result.receipt?.after ?? result.receipt?.before ?? revision;
      const id = (result.imported?.[0] ?? result.skipped?.[0])?.media_id;
      if (!id) throw new Error("没有找到导入的素材");
      const { entity } = (await call("inspect", {
        project: state.project,
        view: "entity",
        id,
        at_revision: revision,
      })) as { entity: MediaView };
      if (!current()) return;
      const { target, mode } = landing;
      const primary = placementKinds(entity, placement)[0];
      const gapTrack = "index" in target && primary ? gapTracks.get(primary) : undefined;
      const plan = placeMedia(view, entity, state, at, {
        target: gapTrack ? { track: gapTrack } : target,
        placement,
        mode,
        pairs,
      });
      if ("error" in plan) throw new Error(plan.error);
      if ("index" in target && !gapTrack) {
        for (const track of plan.added) {
          if (!gapTracks.has(track.kind)) gapTracks.set(track.kind, track.id);
        }
      }
      if (plan.op.video_track && plan.op.audio_track) {
        pairs.set(plan.op.video_track, plan.op.audio_track);
        pairs.set(plan.op.audio_track, plan.op.video_track);
      }
      ops.push(...plan.added, plan.op);
      placed.push(path);
      at = printRational(add(parseRational(at, true), parseRational(plan.op.duration, true)), true);
      view = { ...view, tracks: plan.tracks };
    } catch (error) {
      failures.push(named(path, error));
    }
  }
  if (!current()) return;
  if (ops.length) {
    try {
      await call("edit", {
        project: state.project,
        timeline_id: project.id,
        base_revision: revision,
        idempotency_key: crypto.randomUUID(),
        author: DESKTOP_AUTHOR,
        label: "把文件放入时间线",
        ops,
      });
    } catch (error) {
      failures.push(...placed.map((path) => named(path, error)));
    }
  }
  if (current()) report(failures.length ? failures.join("\n") : null);
}
