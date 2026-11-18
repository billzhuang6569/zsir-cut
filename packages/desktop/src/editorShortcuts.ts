import { useEffect, useRef } from "react";
import { keyboardKey } from "./timelineActions.js";

type Region = "media" | "timeline";
type Role = Region | "source" | "global";
type Handler = (key: string, event: KeyboardEvent, region: Region) => boolean | undefined;

const handlers = new Map<Role, { handle: Handler; active: () => boolean }>();

function dispatch(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
  const focus = target?.closest<HTMLElement>("[data-editor-region]")?.dataset.editorRegion;
  const region: Region =
    focus === "media" ||
    (!focus && (handlers.get("media")?.active() || (!handlers.has("timeline") && handlers.has("source"))))
      ? "media"
      : "timeline";
  const key = keyboardKey(event);
  const roles: Role[] =
    document.querySelector("dialog[open]") || target?.closest('[role="dialog"]')
      ? ["global"]
      : region === "media"
        ? ["global", "media", "source", "timeline"]
        : ["global", "timeline"];
  for (const role of roles) {
    if (handlers.get(role)?.handle(key, event, region)) {
      event.preventDefault();
      return;
    }
  }
}

export function useEditorShortcut(role: Role, handle: Handler, active = false) {
  const latest = useRef({ handle, active });
  latest.current = { handle, active };
  useEffect(() => {
    const entry = {
      handle: (key: string, event: KeyboardEvent, region: Region) => latest.current.handle(key, event, region),
      active: () => latest.current.active,
    };
    if (handlers.size === 0) window.addEventListener("keydown", dispatch);
    handlers.set(role, entry);
    return () => {
      if (handlers.get(role) === entry) handlers.delete(role);
      if (handlers.size === 0) window.removeEventListener("keydown", dispatch);
    };
  }, [role]);
}
