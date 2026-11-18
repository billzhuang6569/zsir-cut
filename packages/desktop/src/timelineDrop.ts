import type { ProjectView } from "./connection.js";
import { type DropTarget, type PlaceMode, placementRange } from "./media.js";
import type { UiState } from "./state.js";
import { div, type MediaView, mul, parseRational, rational, sub } from "./timeline.js";
import { snapEdges } from "./timelineMove.js";

export function dropMode(
  magnetic: boolean,
  preset: "fcp" | "premiere",
  { altKey, metaKey }: { altKey: boolean; metaKey: boolean },
): PlaceMode {
  return magnetic !== (preset === "fcp" ? altKey : metaKey) ? "insert" : "overwrite";
}

export function dropPosition(position: { x: number; y: number }, ratio: number) {
  return { x: position.x / ratio, y: position.y / ratio };
}

export function dropTrack(
  y: number,
  rulerBottom: number,
  rows: { id: string; top: number; bottom: number }[],
): { target: DropTarget; top: number } | null {
  if (y < rulerBottom) return null;
  for (const [index, row] of rows.entries()) {
    if (y < row.top) return { target: { index }, top: row.top };
    if (y < row.bottom) return { target: { track: row.id }, top: row.top };
  }
  return { target: { index: rows.length }, top: (rows.at(-1)?.bottom ?? rulerBottom) + 6 };
}

export function dropTime(
  project: ProjectView,
  state: UiState,
  geometry: { x: number; left: number; scroll: number; label: number; scale: number },
  snap: boolean,
  playhead: string,
  media?: MediaView,
  grab = 0,
) {
  const { x, left, scroll, label, scale } = geometry;
  const duration = media ? placementRange(project, media, state).duration : "0s";
  const offset = div(rational(BigInt(Math.round((x - left + scroll - label) * 1000))), rational(BigInt(scale * 1000)));
  const start = sub(offset, mul(parseRational(duration, true), rational(BigInt(grab), 1000n)));
  return snapEdges(
    project,
    [],
    ["0s", duration],
    rational(0n),
    start.numerator < 0n ? rational(0n) : start,
    scale,
    snap,
    playhead,
  ).to;
}

export const fileName = (path: string) => path.split(/[/\\]/).at(-1) ?? path;

export function orderedPaths(paths: Iterable<string>, ordered: boolean) {
  const values = [...paths];
  return ordered ? values : values.sort((a, b) => fileName(a).localeCompare(fileName(b), "zh-CN", { numeric: true }));
}
