// @vitest-environment jsdom

import { isTauri } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectEntry } from "../src/ProjectEntry.js";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
async function setup(fail = false, empty = false, createFailure = false) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const changed = vi.fn();
  const call = vi.fn(async (verb: string, _request: Record<string, unknown>) => {
    if (verb === "recent_projects")
      return empty
        ? []
        : [{ path: "/missing.zcut.json", name: "缺失工程", exists: false, openedAt: new Date().toISOString() }];
    if (verb === "create_project" && createFailure)
      throw new Error("操作发起人的姓名缺失，无法继续，请重试", {
        cause: "E_VALIDATION /author: must have required property 'name'",
      });
    if (verb === "project_open" && fail) throw new Error("工程版本不兼容");
    if (verb === "inspect") return { project: { revision: { id: "rev_current" } } };
    return [];
  });
  await act(async () => {
    root.render(<ProjectEntry project={null} call={call} changed={changed} error={null} />);
  });
  const click = async (text: string) => {
    const button = Array.from(node.querySelectorAll("button")).find((item) => item.textContent === text);
    if (!button) throw new Error(`找不到按钮 ${text}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const input = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return {
    node,
    root,
    call,
    changed,
    click,
    input,
    close: async () => {
      await act(() => root.unmount());
      node.remove();
    },
  };
}
it("dismisses the project menu on outside pointerdown but keeps inside presses open", async () => {
  const view = await setup();
  try {
    await view.click("未打开工程");
    const menu = view.node.querySelector('[aria-label="工程菜单"]');
    if (!menu) throw new Error("Missing project menu");
    for (const target of [menu, menu.querySelector("button")]) {
      await act(() => target?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      expect(view.node.querySelector('[aria-label="工程菜单"]')).toBe(menu);
    }
    await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    expect(view.node.querySelector('[aria-label="工程菜单"]')).toBe(menu);
    await act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(view.node.querySelector('[aria-label="工程菜单"]')).toBeNull();
    await view.click("未打开工程");
    await view.click("关闭");
    expect(view.node.querySelector('[aria-label="工程菜单"]')).toBeNull();
  } finally {
    await view.close();
  }
});

it("toggles the project menu with its button and restores button focus on Escape", async () => {
  const view = await setup();
  try {
    const button = view.node.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("Missing project button");
    for (const open of [true, false, true]) {
      await act(() => button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe(String(open));
      expect(Boolean(view.node.querySelector('[aria-label="工程菜单"]'))).toBe(open);
    }
    const item = view.node.querySelector<HTMLButtonElement>(".zc-entry-menu button");
    await act(() => {
      item?.focus();
      item?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view.node.querySelector('[aria-label="工程菜单"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  } finally {
    await view.close();
  }
});

it.each(["pointerdown", "Escape"])("keeps a project switch running after menu dismissal by %s", async (event) => {
  const view = await setup();
  let finish = () => {};
  const opening = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    await view.click("未打开工程");
    view.call.mockImplementationOnce(async () => {
      await opening;
      return [];
    });
    await view.click("回到开始页");
    expect(view.changed).not.toHaveBeenCalled();
    await act(() =>
      window.dispatchEvent(
        event === "Escape" ? new KeyboardEvent("keydown", { key: "Escape" }) : new MouseEvent("pointerdown"),
      ),
    );
    expect(view.node.querySelector('[aria-label="工程菜单"]')).toBeNull();
    await act(async () => finish());
    expect(view.call).toHaveBeenCalledWith("project_open", { path: null });
    expect(view.changed).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    finish();
    await view.close();
  }
});

it("creates a matched project, imports every dropped path and selects media", async () => {
  const view = await setup();
  try {
    expect(view.node.querySelector('[aria-label="开始页"]')).not.toBeNull();
    expect(
      Array.from(view.node.querySelectorAll("button")).find((item) => item.textContent?.includes("缺失工程"))?.disabled,
    ).toBe(true);
    await view.click("输入路径");
    const paths = view.node.querySelector<HTMLTextAreaElement>("textarea");
    if (!paths) throw new Error("Missing paths");
    await view.input(paths, "/素材/拍摄/镜头.mov\n/素材/拍摄/录音.wav");
    await view.click("从素材新建");
    await view.click("新建");
    expect(view.call).toHaveBeenCalledWith(
      "create_project",
      expect.objectContaining({
        project: "/素材/拍摄/拍摄.zcut.json",
        name: "拍摄",
        match_media: "/素材/拍摄/镜头.mov",
        timeline: {},
        subtitles: { language: "zh" },
        author: { kind: "human", name: "桌面用户" },
      }),
    );
    expect(view.call).toHaveBeenCalledWith(
      "import_media",
      expect.objectContaining({
        paths: ["/素材/拍摄/镜头.mov", "/素材/拍摄/录音.wav"],
        base_revision: "rev_current",
        label: "导入 2 个素材",
        author: { kind: "human", name: "桌面用户" },
      }),
    );
    expect(view.changed).toHaveBeenLastCalledWith(true);
  } finally {
    await view.close();
  }
});
it("shows an open failure on the start page", async () => {
  const view = await setup(true);
  try {
    await view.click("未打开工程");
    await view.click("打开工程");
    const path = view.node.querySelector<HTMLInputElement>("form input");
    if (!path) throw new Error("Missing path");
    await act(() => path.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await view.input(path, "/损坏.zcut.json");
    await view.click("打开");
    expect(view.node.querySelector('[role="alert"]')?.textContent).toContain("工程版本不兼容");
    expect(view.changed).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});
it("allows manual picture settings without a subtitle track", async () => {
  const view = await setup();
  try {
    await view.click("未打开工程");
    await view.click("新建工程");
    const path = view.node.querySelectorAll<HTMLInputElement>("form input")[1];
    if (!path) throw new Error("Missing path");
    await act(() => path.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await view.input(path, "/新工程.zcut.json");
    const language = Array.from(view.node.querySelectorAll("select")).at(-1);
    if (!language) throw new Error("Missing language");
    await act(() => {
      language.value = "";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click("新建");
    const request = view.call.mock.calls.find((row) => row[0] === "create_project");
    expect(request?.[1]).toMatchObject({ timeline: { edit_rate: "25", width: 1920, height: 1080 } });
    expect(request?.[1]).not.toHaveProperty("subtitles");
    expect(request?.[1]).not.toHaveProperty("match_media");
  } finally {
    await view.close();
  }
});

it("asks before stopping an active reply and cancels without opening another project", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const call = vi.fn(async () => []);
  try {
    await act(async () => {
      root.render(
        <ProjectEntry
          project={{ name: "当前工程" } as import("../src/connection.js").ProjectView}
          call={call}
          changed={() => {}}
          error={null}
          aiBusy
        />,
      );
    });
    const click = async (text: string) => {
      const button = Array.from(node.querySelectorAll("button")).find((item) => item.textContent === text);
      if (!button) throw new Error(text);
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await click("当前工程");
    await click("回到开始页");
    expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain("AI 正在回复");
    expect(call).not.toHaveBeenCalledWith("project_open", expect.anything());
    await click("取消");
    expect(call).not.toHaveBeenCalledWith("project_open", expect.anything());
    await click("回到开始页");
    await click("停止并切换");
    expect(call).toHaveBeenCalledWith("project_open", { path: null });
  } finally {
    await act(() => root.unmount());
    node.remove();
  }
});

it("hides empty recents and reveals styled path entry only on request", async () => {
  const view = await setup(false, true);
  try {
    expect(view.node.querySelector(".zc-entry-recent-section")).toBeNull();
    expect(view.node.querySelector("textarea")).toBeNull();
    for (const button of view.node.querySelectorAll(".zc-start-content > .zc-entry-actions button")) {
      expect(button.querySelector("svg path")?.getAttribute("d")).toBeTruthy();
      expect(button.textContent).toMatch(/新建工程|打开工程/);
    }
    await view.click("输入路径");
    expect(view.node.querySelector("textarea.zc-input.zc-textarea")).not.toBeNull();
    const drop = view.node.querySelector('[aria-label="拖入素材"]');
    await act(() => drop?.dispatchEvent(new Event("dragenter", { bubbles: true })));
    expect(drop?.classList.contains("is-dragging")).toBe(true);
    await act(() => drop?.dispatchEvent(new Event("dragleave", { bubbles: true })));
    expect(drop?.classList.contains("is-dragging")).toBe(false);
  } finally {
    await view.close();
  }
});

it("hides browser path controls in Tauri", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const view = await setup(false, true);
  try {
    expect(view.node.querySelector("textarea")).toBeNull();
    expect(view.node.textContent).not.toContain("输入路径");
    expect(view.node.textContent).not.toContain("从素材新建");
  } finally {
    await view.close();
    vi.mocked(isTauri).mockReturnValue(false);
  }
});

it("shows create failures with expandable kernel details and does not import", async () => {
  const view = await setup(false, true, true);
  try {
    await view.click("新建工程");
    const path = view.node.querySelectorAll<HTMLInputElement>("form input")[1];
    if (!path) throw new Error("Missing path");
    await view.input(path, "/新工程.zcut.json");
    await view.click("新建");
    expect(view.node.querySelector('[role="alert"]')?.textContent).toContain("操作发起人的姓名缺失");
    expect(view.node.querySelector("details pre")?.textContent).toContain("E_VALIDATION /author");
    expect(view.call).not.toHaveBeenCalledWith("import_media", expect.anything());
    expect(view.changed).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it("uses the start canvas hierarchy and filters recent projects by name", async () => {
  const h = await setup();
  try {
    expect(h.node.querySelector(".zc-entry-brand h1")?.textContent).toBe("开始剪辑");
    expect(h.node.querySelector(".zc-entry-brand .is-primary")?.textContent).toBe("新建工程");
    expect(h.node.querySelector(".zc-entry-drop .zc-hint")?.textContent).toContain("不会移动或改写原文件");
    const search = h.node.querySelector<HTMLInputElement>('[aria-label="搜索工程"]');
    if (!search) throw new Error("Missing project search");
    await h.input(search, "不存在的名称");
    expect(h.node.querySelectorAll(".zc-entry-recents li")).toHaveLength(0);
    await h.input(search, "缺失");
    expect(h.node.querySelectorAll(".zc-entry-recents li")).toHaveLength(1);
    expect(h.node.querySelector<HTMLButtonElement>(".zc-entry-recents button")?.disabled).toBe(true);
  } finally {
    await h.close();
  }
});
