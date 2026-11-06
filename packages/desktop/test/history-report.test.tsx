// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { EntityChange } from "../../core/dist/project/entities.js";
import type { HistoryEntry } from "../src/HistoryPanel.js";
import { HistoryReport } from "../src/HistoryReport.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const change = (
  entity: EntityChange["entity"],
  key: string,
  before: EntityChange["before"],
  after: EntityChange["after"],
): EntityChange => ({
  entity,
  key,
  before,
  after,
  before_parent: null,
  after_parent: null,
  before_index: null,
  after_index: null,
});
it("renders the six report types in canvas order, hides empty sections, folds long lists and exposes no entity ids", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const entry: HistoryEntry = {
    revision: "rev_internal",
    seq: 1,
    kind: "write",
    at: "2026-11-06T06:05:00Z",
    label: "校对与剪辑",
    batch: null,
    reason: "去掉重复内容",
    author: { kind: "agent", name: "Claude Code" },
    changes: [
      change("clip", "clp_internal", { label: "开拍前的沟通", duration: "16s" }, null),
      ...Array.from({ length: 7 }, (_, i) =>
        change("cue", `cue_internal_${i}`, { text: `豆宝${i}` }, { text: `豆包${i}` }),
      ),
      change(
        "style",
        "sty_internal",
        { name: "常用样式", outline: { width: 0.07 } },
        { name: "常用样式", outline: { width: 0.13 } },
      ),
      change("marker", "mrk_internal", null, { text: "开场" }),
      change(
        "project",
        "project",
        { subtitle_overlays: [] },
        {
          subtitle_overlays: [
            {
              id: "ovl_internal",
              name: "中文字幕",
              output_path: "/输出/字幕.mov",
              last_export: { revision_id: "rev_internal", size_bytes: 100 },
            },
          ],
        },
      ),
    ],
  };
  try {
    await act(() =>
      root.render(
        <HistoryReport
          entry={entry}
          decisions={[{ id: "dec_internal", seq: 1, question: "跳剪怎么处理？", state: "pending", options: [] }]}
        />,
      ),
    );
    expect(
      [...container.querySelectorAll("[data-change-type]")].map((node) => node.getAttribute("data-change-type")),
    ).toEqual(["ask", "edit", "text", "prop", "items", "files"]);
    expect(container.textContent).toContain("去掉重复内容");
    expect(container.textContent).toContain("删除开拍前的沟通");
    expect(container.querySelector('[data-change-type="text"] del')?.textContent).toBe("豆宝0");
    expect(container.querySelector("summary")?.textContent).toBe("还有 2 处");
    expect(container.textContent).toContain("0.07 → 0.13");
    expect(container.textContent).toContain("/输出/字幕.mov");
    expect(container.textContent).not.toContain("internal");
    await act(() => root.render(<HistoryReport entry={{ ...entry, changes: [] }} decisions={[]} />));
    expect(container.querySelector("[data-change-type]")).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
