// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadMediaResource, type Thumbs, thumbnailCell, thumbnailStyle, updateMediaCache } from "../src/media-cache.js";
import type { ClipView } from "../src/timeline.js";
import { Wave, wavePeak } from "../src/Wave.js";

const index: Thumbs = {
  version: 1,
  interval: "2s",
  columns: 10,
  rows: 10,
  tile_width: 170,
  tile_height: 96,
  count: 201,
  sheets: ["thumbs-000.jpg", "thumbs-001.jpg", "thumbs-002.jpg"],
};
const config = { port: 1, token: "secret" };
const key = "a".repeat(32);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("locates nearest grid cells across rows, sheets, ties, stills and clamped endpoints", () => {
  expect(thumbnailCell(index, "0s")).toMatchObject({ sheet: "thumbs-000.jpg", column: 0, row: 0 });
  expect(thumbnailCell(index, "19s")).toMatchObject({ index: 10, column: 0, row: 1 });
  expect(thumbnailCell(index, "198s")).toMatchObject({ index: 99, column: 9, row: 9 });
  expect(thumbnailCell(index, "199s")).toMatchObject({ index: 100, sheet: "thumbs-001.jpg", column: 0, row: 0 });
  expect(thumbnailCell(index, "999s")).toMatchObject({ index: 200, sheet: "thumbs-002.jpg" });
  expect(thumbnailCell({ ...index, interval: "0s", count: 1 }, "999s").index).toBe(0);
  const style = thumbnailStyle(config, key, index, "198s", false, 96, 56);
  expect(style.backgroundImage).toContain("thumbs-000.jpg?token=secret");
  expect(style.backgroundPosition).toBe("-930.5px -523px");
  expect(style.backgroundSize).toBe("1030px 580px");
  expect(thumbnailStyle(config, key, index, "1/2s", true, 96, 56).backgroundImage).toContain(
    "/frame?token=secret&at=1%2F2s",
  );
  expect(thumbnailStyle(config, key, { ...index, interval: "0s" }, "0s", true, 96, 56).backgroundImage).toContain(
    "thumbs-000.jpg",
  );
});
it.each([
  [37, 56],
  [37, 55],
  [155.52, 48],
  [155.52, 47.25],
  [97, 57],
  [96, 56],
])("covers the whole cell with pixels from a single tile at %s x %s", (width, height) => {
  for (let i = 0; i < 201; i++) {
    const at = `${i * 2}s`;
    const cell = thumbnailCell(index, at);
    const style = thumbnailStyle(config, key, index, at, false, width, height);
    const [sheetWidth, sheetHeight] = String(style.backgroundSize).split(" ").map(Number.parseFloat);
    const [x, y] = String(style.backgroundPosition).split(" ").map(Number.parseFloat);
    if (sheetWidth === undefined || sheetHeight === undefined || x === undefined || y === undefined)
      throw new Error("missing sprite geometry");
    const tileWidth = sheetWidth / index.columns;
    const tileHeight = sheetHeight / index.rows;
    expect([tileWidth, tileHeight].every(Number.isInteger)).toBe(true);
    expect(style.width).toBe(width);
    expect(style.height).toBe(height);
    const left = -x + (Number(style.width) - width) / 2;
    const top = -y + (Number(style.height) - height) / 2;
    expect(left).toBeGreaterThanOrEqual(cell.column * tileWidth + 1);
    expect(top).toBeGreaterThanOrEqual(cell.row * tileHeight + 1);
    expect(left + width).toBeLessThanOrEqual((cell.column + 1) * tileWidth - 1);
    expect(top + height).toBeLessThanOrEqual((cell.row + 1) * tileHeight - 1);
  }
});
it("shares binary requests and retries a missing file after ready", async () => {
  const local = { ...config };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from([0, 128, 255]).buffer });
  vi.stubGlobal("fetch", fetcher);
  const read = async (response: Response) => new Uint8Array(await response.arrayBuffer());
  expect(await loadMediaResource(local, key, "peaks.bin", read)).toBeUndefined();
  updateMediaCache(local, { media_ready: [{ media_id: "med_a", key }] });
  const [a, b] = await Promise.all([
    loadMediaResource(local, key, "peaks.bin", read),
    loadMediaResource(local, key, "peaks.bin", read),
  ]);
  expect(a).toBe(b);
  expect([...(a ?? [])]).toEqual([0, 128, 255]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("uses a thin line before ready and refreshes Uint8 peaks on the push without zoom refetches", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const local = { ...config };
  const clip: ClipView = {
    id: "clp_a",
    media_id: "med_a",
    enabled: true,
    label: null,
    speed: "1",
    timeline_in: { t: "0s" },
    timeline_out: { t: "1s" },
    source_in: { t: "0s" },
    source_out: { t: "1s" },
  };
  const values = new Uint8Array(100);
  values[10] = 255;
  expect(wavePeak(clip, values, 0, 3, 12)).toBe(1);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, arrayBuffer: async () => values.buffer });
  vi.stubGlobal("fetch", fetcher);
  updateMediaCache(local, { media: [{ media_id: clip.media_id, key, peaks: "building", thumbs: "building" }] });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Wave clip={clip} config={local} width={96} scale={12} />));
    expect(host.querySelector(".is-pending")).not.toBeNull();
    await act(async () =>
      updateMediaCache(local, {
        media: [{ media_id: clip.media_id, key, peaks: "ready", thumbs: "ready" }],
        media_ready: [{ media_id: clip.media_id, key }],
      }),
    );
    expect(host.querySelector(".is-pending")).toBeNull();
    await act(async () => root.render(<Wave clip={clip} config={local} width={192} scale={24} />));
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
