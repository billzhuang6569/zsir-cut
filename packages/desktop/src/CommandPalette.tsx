import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { actions } from "../../app-host/src/keymap.js";
import { PANELS, type Panel } from "../../app-host/src/ui.js";
import { commandBlockReason, type EditorCommand, runEditorCommand } from "./editorShortcuts.js";
import { actionLabels, displayKey } from "./settings-keymap.js";
import "./command-palette.css";

export function CommandPalette({
  keymap,
  panelLabels,
  recent,
  close,
  onRun,
}: {
  keymap: Record<string, string | null>;
  panelLabels: Record<Panel, string>;
  recent: EditorCommand[];
  close: () => void;
  onRun: (command: EditorCommand) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  useLayoutEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    input.current?.focus();
    return () => modal?.close();
  }, []);

  const search = query.trim().toLowerCase();
  const commands = [
    ...actions.map((id) => ({ id, label: actionLabels[id], shortcut: displayKey(keymap[id] ?? null) })),
    ...PANELS.map((panel) => ({ id: `panel_${panel}` as const, label: `切换到${panelLabels[panel]}`, shortcut: null })),
  ];
  const rank = new Map(recent.map((id, i) => [id, i]));
  const results = commands
    .sort((a, b) => (rank.get(a.id) ?? recent.length) - (rank.get(b.id) ?? recent.length))
    .filter(({ id, label }) => label.toLowerCase().includes(search) || id.includes(search.replace(/\s+/g, "_")))
    .map((command) => ({ ...command, reason: commandBlockReason(command.id) }));
  const active = Math.min(index, results.length - 1);
  const activeId = results[active] ? `${listId}-${results[active].id}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const run = (command: EditorCommand) => {
    if (runEditorCommand(command)) {
      onRun(command);
      if (command === "command_palette") {
        setQuery("");
        setIndex(0);
      }
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "Escape":
        close();
        break;
      case "ArrowDown":
        setIndex(Math.min(active + 1, results.length - 1));
        break;
      case "ArrowUp":
        setIndex(Math.max(0, active - 1));
        break;
      case "Enter": {
        const result = results[active];
        if (result && !result.reason) run(result.id);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <dialog
      ref={dialog}
      className="zc-dialog zc-command-palette"
      aria-label="命令面板"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <input
        ref={input}
        role="combobox"
        aria-label="搜索动作"
        aria-controls={listId}
        aria-expanded="true"
        aria-activedescendant={activeId}
        placeholder="搜索动作"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label="动作">
        {results.map(({ id, label, shortcut, reason }, row) => (
          <button
            type="button"
            tabIndex={-1}
            key={id}
            id={`${listId}-${id}`}
            role="option"
            aria-selected={row === active}
            aria-disabled={reason ? true : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!reason) run(id);
            }}
          >
            <span>
              {label}
              {reason && <small>{reason}</small>}
            </span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </button>
        ))}
      </div>
      {results.length === 0 && <output>试试其他动作名称</output>}
    </dialog>
  );
}
