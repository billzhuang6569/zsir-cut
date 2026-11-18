import { useEffect, useRef } from "react";
import type { Action } from "../../app-host/src/keymap.js";
import type { Panel } from "../../app-host/src/ui.js";
import { keyboardKey } from "./timelineActions.js";

type Region = "media" | "timeline";
type Role = Region | "source" | "global";
export type EditorCommand = Action | `panel_${Panel}`;
export type EditorShortcutHandler = (
  key: string,
  event: KeyboardEvent | null,
  region: Region,
  command?: EditorCommand,
) => boolean | undefined;
// undefined defers to the next handler, null means the command can run.
type Availability = (command: EditorCommand) => string | null | undefined;

const handlers = new Map<Role, { handle: EditorShortcutHandler; active: () => boolean; availability: Availability }>();

const commandRoles: Role[] = ["global", "timeline"];

export function commandBlockReason(command: EditorCommand) {
  for (const role of commandRoles) {
    const reason = handlers.get(role)?.availability(command);
    if (reason !== undefined) return reason;
  }
  return "请先打开工程";
}

function dispatchShortcut(
  roles: Role[],
  key: string,
  event: KeyboardEvent | null,
  region: Region,
  command?: EditorCommand,
) {
  return roles.some((role) => handlers.get(role)?.handle(key, event, region, command));
}

export function runEditorCommand(command: EditorCommand) {
  return commandBlockReason(command) === null && dispatchShortcut(commandRoles, "", null, "timeline", command);
}

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
  if (dispatchShortcut(roles, key, event, region)) event.preventDefault();
}

export function useEditorShortcut(
  role: Role,
  handle: EditorShortcutHandler,
  active = false,
  availability?: Availability,
) {
  const latest = useRef({ handle, active, availability });
  latest.current = { handle, active, availability };
  useEffect(() => {
    const entry = {
      handle: ((key, event, region, command) =>
        latest.current.handle(key, event, region, command)) satisfies EditorShortcutHandler,
      availability: ((command) => latest.current.availability?.(command)) satisfies Availability,
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
