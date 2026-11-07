// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { App } from "../src/App.js";
import { Markdown, StepRow } from "../src/ai-components.js";
import { initialState } from "../src/state.js";
import { TimelinePreview } from "./timeline-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  style = document.createElement("style");
  style.textContent = ["ai.css", "timeline.css", "subtitles.css", "shell.css"]
    .map((file) => readFileSync(`packages/desktop/src/${file}`, "utf8"))
    .join("\n");
  document.head.append(style);
});
afterEach(async () => {
  await act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  container.remove();
  style.remove();
});
const get = (selector: string) => container.querySelector<HTMLElement>(selector) as HTMLElement;

it("disables shell selection and centrally permits only copyable text and editable controls", async () => {
  await act(() =>
    root.render(
      <>
        <App />
        <section className="zc-shell">
          <Markdown text={"AI 正文 **重点**\n# 标题\n- 项目\n```\n代码\n```"} />
          <StepRow live={false} name="Read" failed={false} detail="工具细节" />
          <input aria-label="测试输入" />
          <textarea />
          {/* biome-ignore lint/a11y/useSemanticElements: Match the subtitle rich text editor. */}
          <div contentEditable role="textbox" tabIndex={0} suppressContentEditableWarning>
            字幕
          </div>
          <p role="alert">
            错误说明
            <button type="button" className="zc-btn">
              重试
            </button>
          </p>
          <p className="zc-selectable">/文件位置</p>
        </section>
      </>,
    ),
  );
  expect(getComputedStyle(get("main.zc-shell")).userSelect).toBe("none");
  expect(getComputedStyle(get("main.zc-shell")).cursor).toBe("default");
  for (const selector of [
    ".zc-markdown",
    "input",
    "textarea",
    '[contenteditable="true"]',
    'p[role="alert"]',
    "p.zc-selectable",
  ]) {
    expect(getComputedStyle(get(selector)).userSelect, selector).toBe("text");
    expect(getComputedStyle(get(selector)).cursor, selector).toBe("text");
  }
  await act(() => get(".zc-step").click());
  expect(getComputedStyle(get(".zc-step-detail")).userSelect).toBe("text");
  expect(get(".zc-step").closest(".zc-selectable")).toBeNull();
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    expect(getComputedStyle(button).userSelect).toBe("none");
    if (!button.disabled) expect(getComputedStyle(button).cursor).toBe("default");
  }
});

it("blocks browser select-all outside editors, including dialogs, and preserves native editing and propagation", async () => {
  await act(() => root.render(<App />));
  const shell = get("main");
  const dialog = document.createElement("dialog");
  dialog.open = true;
  shell.append(dialog);
  const targets = [shell, dialog];
  for (const tag of ["input", "textarea", "div"]) {
    const element = document.createElement(tag);
    if (tag === "div") {
      element.setAttribute("contenteditable", "");
      element.append(document.createElement("span"));
    }
    dialog.append(element);
    targets.push(element, ...(tag === "div" ? [element.firstElementChild as HTMLElement] : []));
  }
  for (const meta of [true, false]) {
    for (const target of targets) {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        metaKey: meta,
        ctrlKey: !meta,
        bubbles: true,
        cancelable: true,
      });
      let reached = false;
      const listener = () => {
        reached = true;
      };
      target.addEventListener("keydown", listener);
      await act(() => target.dispatchEvent(event));
      target.removeEventListener("keydown", listener);
      expect(event.defaultPrevented).toBe(target === shell || target === dialog);
      expect(reached).toBe(true);
    }
  }
});

it.each(["input", "textarea", "select", "contenteditable"])(
  "prevents picture selection and blurs an outside %s only on the primary pointer",
  async (tag) => {
    await act(() =>
      root.render(
        <TimelinePreview
          project={null}
          state={initialState()}
          update={() => {}}
          config={undefined}
          call={async () => ({})}
          error={null}
          dragging={{ current: false }}
        />,
      ),
    );
    const editor = document.createElement(tag === "contenteditable" ? "div" : tag);
    if (tag === "contenteditable") {
      editor.setAttribute("contenteditable", "");
      editor.tabIndex = 0;
    }
    container.append(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);
    const text = document.createTextNode("已有选择");
    container.append(text);
    const range = document.createRange();
    range.selectNode(text);
    window.getSelection()?.addRange(range);
    const picture = get(".zc-picture");
    const secondary = new MouseEvent("pointerdown", { button: 2, bubbles: true, cancelable: true });
    await act(() => picture.dispatchEvent(secondary));
    expect(secondary.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect(window.getSelection()?.rangeCount).toBe(1);
    const primary = new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true });
    await act(() => picture.dispatchEvent(primary));
    expect(primary.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
    expect(window.getSelection()?.rangeCount).toBe(0);
  },
);
