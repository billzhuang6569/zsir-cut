import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { add, compare, div, floor, parseRational, rational } from "./timeline.js";

export type Config = { port: number; token: string };
interface MediaStatus {
  media_id: string;
  key: string;
  peaks: string;
  thumbs: string;
}
interface Status {
  media?: MediaStatus[];
  media_ready?: { media_id: string; key: string }[];
  directory_ok?: boolean;
}
export interface Thumbs {
  version: number;
  interval: string;
  tile_width: number;
  tile_height: number;
  columns: number;
  rows: number;
  count: number;
  sheets: string[];
}
const stores = new WeakMap<
  Config,
  { status: Status; listeners: Set<() => void>; resources: Map<string, Promise<unknown>> }
>();
function store(config: Config) {
  let value = stores.get(config);
  if (!value) {
    value = { status: {}, listeners: new Set(), resources: new Map() };
    stores.set(config, value);
  }
  return value;
}
export function updateMediaCache(config: Config, status: Status) {
  const value = store(config);
  for (const next of status.media ?? []) {
    const previous = value.status.media?.find((item) => item.key === next.key);
    if (previous && (previous.peaks !== next.peaks || previous.thumbs !== next.thumbs)) {
      for (const key of value.resources.keys()) if (key.startsWith(`${next.key}/`)) value.resources.delete(key);
    }
  }
  for (const ready of status.media_ready ?? []) {
    for (const key of value.resources.keys()) if (key.startsWith(`${ready.key}/`)) value.resources.delete(key);
  }
  value.status = status;
  for (const listener of value.listeners) listener();
}
export function mediaCacheUrl(config: Config, key: string, name: string, at?: string) {
  const query = new URLSearchParams({ token: config.token, ...(at ? { at } : {}) });
  return `http://127.0.0.1:${config.port}/media-cache/${key}/${name}?${query}`;
}
export function useMediaCache(config: Config | undefined, id: string) {
  const [, render] = useState(0);
  useEffect(() => {
    if (!config) return;
    const value = store(config);
    const listener = () => render((version) => version + 1);
    value.listeners.add(listener);
    return () => {
      value.listeners.delete(listener);
    };
  }, [config]);
  const item = config ? store(config).status.media?.find((item) => item.media_id === id) : undefined;
  return item && config ? { ...item, fallback: store(config).status.directory_ok === false } : undefined;
}
export function loadMediaResource<T>(
  config: Config,
  key: string,
  name: string,
  read: (response: Response) => Promise<T>,
): Promise<T | undefined> {
  const resources = store(config).resources;
  const id = `${key}/${name}`;
  let pending = resources.get(id);
  if (!pending) {
    pending = fetch(mediaCacheUrl(config, key, name))
      .then((response) => (response.ok ? read(response) : undefined))
      .catch(() => undefined);
    resources.set(id, pending);
    const current = pending;
    void pending.then((value) => {
      if (value === undefined && resources.get(id) === current) resources.delete(id);
    });
  }
  return pending as Promise<T | undefined>;
}
export function thumbnailCell(index: Thumbs, at: string) {
  const interval = parseRational(index.interval, true);
  const i =
    interval.numerator === 0n
      ? 0
      : Math.max(
          0,
          Math.min(index.count - 1, Number(floor(add(div(parseRational(at, true), interval), rational(1n, 2n))))),
        );
  const cells = index.columns * index.rows;
  const cell = i % cells;
  return {
    sheet: index.sheets[Math.floor(i / cells)],
    column: cell % index.columns,
    row: Math.floor(cell / index.columns),
    index: i,
  };
}
export function thumbnailStyle(
  config: Config,
  key: string,
  index: Thumbs,
  at: string,
  fine: boolean,
  width: number,
  height: number,
): CSSProperties {
  if (fine && compare(parseRational(index.interval, true), rational(0n)) > 0)
    return {
      width: "100%",
      height: "100%",
      backgroundImage: `url("${mediaCacheUrl(config, key, "frame", at)}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  const cell = thumbnailCell(index, at);
  // Enlarge the tile so its one-pixel inset covers the whole cell.
  const scale = Math.max((width + 2) / index.tile_width, (height + 2) / index.tile_height);
  const tileWidth = Math.ceil(index.tile_width * scale);
  const tileHeight = Math.ceil(index.tile_height * scale);
  return cell.sheet
    ? {
        width,
        height,
        backgroundImage: `url("${mediaCacheUrl(config, key, cell.sheet)}")`,
        backgroundSize: `${tileWidth * index.columns}px ${tileHeight * index.rows}px`,
        backgroundPosition: `${-cell.column * tileWidth - (tileWidth - width) / 2}px ${-cell.row * tileHeight - (tileHeight - height) / 2}px`,
        backgroundRepeat: "no-repeat",
      }
    : {};
}
