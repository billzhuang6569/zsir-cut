// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Layout } from "../../app-host/src/preferences.js";
import { LayoutDivider } from "../src/LayoutDivider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let saved: Layout;
let previewWidth = 500;
const dragging = { current: false };
const commit = vi.fn();
const captures = new Set<number>();
const fields = ["left_width", "right_width", "timeline_height"] as const;
const divider = (field: keyof Layout) => container.querySelector<HTMLElement>(`.zc-layout-${field}`) as HTMLElement;
const value = (field: keyof Layout) => Number(divider(field).getAttribute("aria-valuenow"));
function Harness() {
  const [draft, setDraft] = useState<Partial<Layout>>({});
  return (
    <main className="zc-shell">
      <div className="zc-functions" />
      <section className="zc-editor">
        <div className="zc-preview-slot" />
        <div className="zc-parameters" />
      </section>
      {fields.map((field) => (
        <LayoutDivider
          key={field}
          field={field}
          label={field}
          value={draft[field] === undefined ? saved[field] : draft[field]}
          dragging={dragging}
          change={(next) => setDraft({ [field]: next })}
          commit={(next) => {
            commit(field, next);
            saved[field] = next;
            setDraft({});
          }}
          cancel={() => setDraft({})}
        />
      ))}
    </main>
  );
}
function pointer(field: keyof Layout, type: string, position: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: position, clientY: position });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return act(() => divider(field).dispatchEvent(event));
}
const key = (field: keyof Layout, key: string) =>
  act(() => divider(field).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
beforeEach(async () => {
  saved = { left_width: 300, right_width: 340, timeline_height: 0.43 };
  dragging.current = false;
  previewWidth = 500;
  commit.mockClear();
  captures.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.matches(".zc-functions")
      ? value("left_width")
      : this.matches(".zc-parameters")
        ? value("right_width")
        : previewWidth;
    return { width, height: 800, left: 0, top: 0 } as DOMRect;
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: (id: number) => captures.add(id) },
    hasPointerCapture: { configurable: true, value: (id: number) => captures.has(id) },
    releasePointerCapture: { configurable: true, value: (id: number) => captures.delete(id) },
  });
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  for (const method of ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"])
    Reflect.deleteProperty(HTMLElement.prototype, method);
});

it.each(fields)("previews %s and writes exactly once on release, resets to null on double click", async (field) => {
  const before = value(field);
  await pointer(field, "pointerdown", 100);
  await pointer(field, "pointermove", 132);
  expect(dragging.current).toBe(true);
  expect(divider(field).dataset.dragging).toBe("true");
  expect(value(field)).toBe(field === "timeline_height" ? 0.39 : before + (field === "left_width" ? 32 : -32));
  expect(commit).not.toHaveBeenCalled();
  await pointer(field, "pointerup", 132);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith(field, value(field));
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
  await act(() => divider(field).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(commit).toHaveBeenLastCalledWith(field, null);
});
it("resizes by 16px using the correct direction and keeps a 360px preview", async () => {
  await key("left_width", "ArrowRight");
  expect(value("left_width")).toBe(316);
  await key("right_width", "ArrowRight");
  expect(value("right_width")).toBe(324);
  await key("timeline_height", "ArrowUp");
  expect(value("timeline_height")).toBe(0.45);
  await key("timeline_height", "ArrowDown");
  expect(value("timeline_height")).toBe(0.43);
  for (const [field, start] of [
    ["left_width", 316],
    ["right_width", 324],
  ] as const) {
    await pointer(field, "pointerdown", 0);
    await pointer(field, "pointerup", field === "left_width" ? 10000 : -10000);
    expect(value(field)).toBe(start + 140);
  }
});
it.each(fields)("clamps %s to spec limits", async (field) => {
  previewWidth = 2000;
  const sign = field === "left_width" ? 1 : -1;
  await pointer(field, "pointerdown", 0);
  await pointer(field, "pointerup", sign * 10000);
  expect(value(field)).toBe(field === "timeline_height" ? 0.75 : field === "left_width" ? 560 : 600);
  await pointer(field, "pointerdown", 0);
  await pointer(field, "pointerup", -sign * 10000);
  expect(value(field)).toBe(field === "timeline_height" ? 0.2 : field === "left_width" ? 200 : 240);
});
it("cancels without saving on Escape, capture loss, pointercancel and unmount; ignores other pointers", async () => {
  for (const type of ["pointercancel", "lostpointercapture", "Escape"]) {
    await pointer("left_width", "pointerdown", 100);
    await pointer("left_width", "pointermove", 132);
    await pointer("left_width", "pointerup", 300, 2);
    expect(dragging.current).toBe(true);
    if (type === "Escape") await key("left_width", type);
    else await pointer("left_width", type, 132);
    expect(value("left_width")).toBe(300);
    expect(commit).not.toHaveBeenCalled();
    expect(dragging.current).toBe(false);
  }
  await pointer("left_width", "pointerdown", 100);
  await pointer("left_width", "pointerup", 100);
  expect(commit).not.toHaveBeenCalled();
  await pointer("left_width", "pointerdown", 100);
  await act(() => root.render(<div />));
  expect(dragging.current).toBe(false);
  expect(captures.size).toBe(0);
});
it("fixes the overflowing shell and constrains content tracks instead of only hiding body overflow", () => {
  const css = readFileSync("packages/desktop/src/shell.css", "utf8");
  expect(css).toMatch(
    /html,\s*body,\s*#root\s*\{[^}]*height: 100%;[^}]*overflow: hidden;[^}]*overscroll-behavior: none/s,
  );
  expect(css).not.toMatch(/min-width: 1280px|min-height: 760px/);
  expect(css).toMatch(/\.zc-editor\s*\{[^}]*grid-template-rows: minmax\(0,/s);
  expect(css).toMatch(/\.zc-upper-row\s*\{[^}]*minmax\(0, 1fr\)[^}]*overflow: hidden/s);
  expect(css).toMatch(/\.zc-function-panel\s*\{\s*overflow: auto/s);
});

it.each(fields)("clears copied text when dragging %s", async (field) => {
  const textarea = document.createElement("textarea");
  container.append(textarea);
  textarea.focus();
  expect(document.activeElement).toBe(textarea);
  const range = document.createRange();
  range.selectNodeContents(container);
  window.getSelection()?.addRange(range);
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(() => divider(field).dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(divider(field));
  expect(window.getSelection()?.rangeCount).toBe(0);
  expect(dragging.current).toBe(true);
  await pointer(field, "pointercancel", 0);
});
