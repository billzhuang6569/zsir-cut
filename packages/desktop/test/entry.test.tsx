// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectEntry } from "../src/ProjectEntry.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
async function setup(fail = false) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const changed = vi.fn();
  const call = vi.fn(async (verb: string, _request: Record<string, unknown>) => {
    if (verb === "recent_projects")
      return [{ path: "/missing.zcut.json", name: "缺失工程", exists: false, openedAt: new Date().toISOString() }];
    if (verb === "project_open" && fail) throw new Error("工程版本不兼容");
    if (verb === "inspect") return { project: { revision: { id: "rev_current" } } };
    return [];
  });
  await act(() => root.render(<ProjectEntry project={null} call={call} changed={changed} error={null} />));
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
it("creates a matched project, imports every dropped path and selects media", async () => {
  const view = await setup();
  try {
    expect(view.node.querySelector('[aria-label="开始页"]')).not.toBeNull();
    expect(
      Array.from(view.node.querySelectorAll("button")).find((item) => item.textContent?.includes("缺失工程"))?.disabled,
    ).toBe(true);
    const paths = view.node.querySelector<HTMLTextAreaElement>("textarea");
    if (!paths) throw new Error("Missing paths");
    await view.input(paths, "/素材/拍摄/镜头.mov\n/素材/拍摄/录音.wav");
    await view.click("从素材新建");
    await view.click("确定");
    expect(view.call).toHaveBeenCalledWith(
      "create_project",
      expect.objectContaining({
        project: "/素材/拍摄/拍摄.zcut.json",
        name: "拍摄",
        match_media: "/素材/拍摄/镜头.mov",
        timeline: {},
        subtitles: { language: "zh" },
        author: { kind: "human" },
      }),
    );
    expect(view.call).toHaveBeenCalledWith(
      "import_media",
      expect.objectContaining({
        paths: ["/素材/拍摄/镜头.mov", "/素材/拍摄/录音.wav"],
        base_revision: "rev_current",
        label: "导入 2 个素材",
        author: { kind: "human" },
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
    await view.click("打开工程");
    const path = view.node.querySelector<HTMLInputElement>("form input");
    if (!path) throw new Error("Missing path");
    await view.input(path, "/损坏.zcut.json");
    await view.click("确定");
    expect(view.node.querySelector('[role="alert"]')?.textContent).toContain("工程版本不兼容");
    expect(view.changed).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});
it("allows manual picture settings without a subtitle track", async () => {
  const view = await setup();
  try {
    await view.click("新建工程");
    const path = view.node.querySelectorAll<HTMLInputElement>("form input")[1];
    if (!path) throw new Error("Missing path");
    await view.input(path, "/新工程.zcut.json");
    const language = Array.from(view.node.querySelectorAll("select")).at(-1);
    if (!language) throw new Error("Missing language");
    await act(() => {
      language.value = "";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click("确定");
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
    await act(() =>
      root.render(
        <ProjectEntry
          project={{ name: "当前工程" } as import("../src/connection.js").ProjectView}
          call={call}
          changed={() => {}}
          error={null}
          aiBusy
        />,
      ),
    );
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
