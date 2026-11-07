// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { Markdown } from "../src/ai-components.js";
import { Icon } from "../src/components.js";
import { ICONS } from "../src/icons.js";
import { SubtitleCanvas } from "../src/SubtitleCanvas.js";
import { defaultStyle } from "../src/subtitles.js";
import { rulerTicks } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const source = (file: string) => readFileSync(`packages/desktop/src/${file}`, "utf8");

it("draws a path for every referenced icon, including aliases and tool action icons", async () => {
  const names = new Set(Object.keys(ICONS));
  const components = source("components.tsx");
  for (const block of ["aliases", "textPaths"]) {
    const body = components.split(`const ${block}:`)[1]?.split("};")[0] ?? "";
    for (const match of body.matchAll(/^ {2}(?:"([^"]+)"|(\w+)):/gm)) names.add(match[1] ?? match[2] ?? "");
  }
  const literal = (node: ts.Node | undefined) => {
    if (!node) return;
    if (ts.isStringLiteral(node)) names.add(node.text);
    else if (ts.isJsxExpression(node)) literal(node.expression);
    else if (ts.isConditionalExpression(node)) {
      literal(node.whenTrue);
      literal(node.whenFalse);
    }
  };
  for (const file of readdirSync("packages/desktop/src").filter((name) => name.endsWith(".tsx"))) {
    const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && ["icon", "name"].includes(node.name.getText(tree))) literal(node.initializer);
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "icon") literal(node.initializer);
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "TOOL_ACTIONS" && node.initializer) {
        const actions = node.initializer;
        if (ts.isObjectLiteralExpression(actions))
          for (const entry of actions.properties)
            if (ts.isPropertyAssignment(entry) && ts.isArrayLiteralExpression(entry.initializer))
              literal(entry.initializer.elements[1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(() =>
      root.render(
        [...names].map((name) => (
          <span key={name} data-icon={name}>
            <Icon name={name} />
          </span>
        )),
      ),
    );
    for (const wrapper of node.children)
      expect(wrapper.querySelector("path[d]"), wrapper.getAttribute("data-icon") ?? "").not.toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});

it.each(["25", "30000/1001"])("spaces ruler labels and minor ticks with rational frames at %s fps", (rate) => {
  const wide = rulerTicks(800, 48, rate);
  const major = wide.filter((tick) => tick.major);
  expect(major[0]?.label).toBe("00:00");
  expect(major[1]?.label).toBe("00:02");
  expect(major[1]?.left).toBeGreaterThanOrEqual(96);
  expect(wide.slice(1, 5).every((tick) => !tick.major)).toBe(true);
  const close = rulerTicks(800, 192, rate).filter((tick) => tick.major);
  expect(close[0]?.label).toBe("00:00:00");
  expect(close[1]?.left).toBeGreaterThanOrEqual(96);
  expect(close[1]?.label).toMatch(/^00:00:\d\d$/);
  expect(rulerTicks(800, 96, rate)[0]?.label).toBe("00:00");
});

it("draws the paused zero-second caption above video and fits its stage when the viewer resizes", async () => {
  const recorded = recordingCanvas();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recorded.context);
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const node = document.createElement("div");
  const rect = vi.spyOn(node, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600 } as DOMRect);
  const root = createRoot(node);
  try {
    await act(() =>
      root.render(
        <SubtitleCanvas
          cues={[{ cue_id: "cue_zero", text: "以前要花两天的时", style_id: "sty_1", start: "0s", end: "2s" }]}
          styles={[{ ...defaultStyle, id: "sty_1" }]}
          at="0s"
          playing={false}
          format={{ width: 1920, height: 1080 }}
        />,
      ),
    );
    const stage = node.querySelector<HTMLElement>(".zc-subtitle-stage");
    expect(stage?.style.width).toBe("800px");
    expect(stage?.style.height).toBe("450px");
    expect(recorded.calls.some(([name]) => name === "fillText")).toBe(true);
    expect(node.querySelector("canvas")?.getAttribute("aria-label")).toBe("以前要花两天的时");
    rect.mockReturnValue({ width: 400, height: 400 } as DOMRect);
    await act(() => resize());
    expect(stage?.style.width).toBe("400px");
    expect(stage?.style.height).toBe("225px");
    expect(source("timeline.css")).toMatch(/\.zc-picture > \.zc-subtitle-stage,[\s\S]*?z-index: 2/);
  } finally {
    await act(() => root.unmount());
    expect(disconnect).toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shares left-aligned tabs, segmented active states and keyboard-only settings focus", () => {
  const shell = source("shell.css");
  expect(shell).toMatch(/\.zc-tab \{[^}]*flex: none;[^}]*padding: 0;[^}]*font-size: 13px/s);
  expect(shell).toMatch(/\.zc-tab\.is-active::after \{[^}]*left: 0;[^}]*right: 0;/s);
  expect(shell).toMatch(/\.zc-seg > button \{[^}]*background: transparent;/s);
  expect(shell).toMatch(/\.zc-seg > button\[aria-pressed="true"\],[^}]*background: var\(--raised-2\)/s);
  expect(source("settings.css")).toContain(".zc-settings-nav .zc-row:focus:not(:focus-visible)");
  expect(source("settings.css")).toContain(".zc-settings-nav .zc-row:focus-visible");
  expect(source("media.css")).toMatch(/\.zc-media-hint kbd \{[^}]*border: 1px solid/s);
  expect(source("ai.css")).toMatch(/\.zc-chat-user \{[^}]*align-self: flex-end;[^}]*width: fit-content;/s);
  expect(source("ai.css")).toMatch(/\.zc-chat-assistant > \.zc-icon-btn \{[^}]*position: absolute;[^}]*opacity: 0;/s);
});

it("renders normal AI prose at weight 400 while retaining Markdown emphasis and headings", async () => {
  const style = document.createElement("style");
  style.textContent = source("ai.css");
  document.head.append(style);
  const node = document.createElement("div");
  node.style.fontWeight = "600";
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(() => root.render(<Markdown text={"普通正文 **重点**\n# 标题\n- 列表正文"} />));
    const body = node.querySelector<HTMLElement>(".zc-markdown");
    expect(getComputedStyle(body as HTMLElement).fontWeight).toBe("400");
    expect(body?.querySelector("p")?.textContent).toBe("普通正文 重点");
    expect(body?.querySelector("strong")?.textContent).toBe("重点");
    expect(getComputedStyle(body?.querySelector("strong") as HTMLElement).fontWeight).toBe("600");
    expect(body?.querySelector("h3")?.textContent).toBe("标题");
    expect(body?.querySelector("li")?.textContent).toBe("列表正文");
  } finally {
    await act(() => root.unmount());
    node.remove();
    style.remove();
  }
});
