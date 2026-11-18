import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { type ClipEdit, selectedClips, setClips } from "./clipProperties.js";
import type { ProjectView } from "./connection.js";
import { displayKey } from "./settings-keymap.js";
import { contains, timecode } from "./timeline.js";
import { keyboardKey } from "./timelineActions.js";
import "./clip-properties.css";

export interface ClipMenuAnchor {
  element: HTMLButtonElement;
  x: number;
  y: number;
}

export function ClipMenu({
  anchor,
  project,
  ids,
  keymap,
  blocked,
  edit,
  inspect,
  close,
  copyError,
}: {
  anchor: ClipMenuAnchor;
  project: ProjectView;
  ids: string[];
  keymap: Record<string, string | null>;
  blocked: string | undefined;
  edit: ClipEdit;
  inspect: (() => void) | undefined;
  close: () => void;
  copyError: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const targets = selectedClips(project, ids);
  const clipIds = targets.map(({ clip }) => clip.id);
  const enable = targets.some(({ clip }) => !clip.enabled);
  const hasPair = targets.every(
    ({ clip, track }) =>
      clip.occurrence_id &&
      project.tracks.some(
        (other) =>
          other.kind !== "subtitle" &&
          other.kind !== track.kind &&
          other.clips.some(
            (item) =>
              item.occurrence_id === clip.occurrence_id &&
              (contains(item.timeline_in.t, item.timeline_out.t, clip.timeline_in.t) ||
                contains(clip.timeline_in.t, clip.timeline_out.t, item.timeline_in.t)),
          ),
      ),
  );
  const restoreSync = targets.some(({ clip }) => project.clipProperties?.[clip.id]?.sync_broken);
  const enabledLabel = enable ? "启用片段" : "停用片段";
  const syncLabel = restoreSync ? "检查音画同步" : "允许音画不同步";
  const actions = [
    {
      label: "删除留空隙",
      key: keymap.lift_delete,
      reason: blocked,
      run: () => edit("删除留空隙", [{ op: "remove", clip_ids: clipIds }]),
    },
    {
      label: "删除并合拢",
      key: keymap.ripple_delete,
      reason: blocked,
      run: () => edit("删除并合拢", [{ op: "remove", clip_ids: clipIds, ripple: true }]),
    },
    { label: enabledLabel, reason: blocked, run: () => edit(enabledLabel, setClips(clipIds, { enabled: enable })) },
    {
      label: syncLabel,
      reason: blocked ?? (hasPair ? undefined : "选择同一次使用中有对应音频或视频的片段"),
      run: () => edit(syncLabel, setClips(clipIds, { sync_broken: restoreSync ? null : true })),
    },
    {
      label: "复制时码",
      run: () => {
        void Promise.resolve()
          .then(() =>
            navigator.clipboard.writeText(targets.map(({ clip }) => timecode(clip.timeline_in.t, project)).join("\n")),
          )
          .catch(copyError);
      },
    },
    { label: "在属性里编辑", reason: inspect ? undefined : "返回工程后编辑属性", run: () => inspect?.() },
  ];
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      const x = anchor.x + width <= window.innerWidth ? anchor.x : anchor.x - width;
      const y = anchor.y + height <= window.innerHeight ? anchor.y : anchor.y - height;
      element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
      element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
    };
    place();
    element.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) closeRef.current();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  function run(index: number) {
    const action = actions[index];
    if (!action || action.reason) return;
    close();
    anchor.element.focus();
    action.run();
  }

  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const shortcut = actions.findIndex((action) => action.key && action.key === keyboardKey(event.nativeEvent));
    event.stopPropagation();
    switch (event.key) {
      case "Escape":
        close();
        anchor.element.focus();
        break;
      case "Tab":
        close();
        anchor.element.focus();
        return;
      case "ArrowDown":
      case "ArrowUp":
        buttons[(index + buttons.length + (event.key === "ArrowDown" ? 1 : -1)) % buttons.length]?.focus();
        break;
      case "Home":
        buttons[0]?.focus();
        break;
      case "End":
        buttons.at(-1)?.focus();
        break;
      default:
        if (shortcut < 0) return;
        run(shortcut);
    }
    event.preventDefault();
  }

  return createPortal(
    <div ref={menu} role="menu" aria-label="片段操作" className="zc-cue-menu zc-clip-menu" onKeyDown={keydown}>
      {actions.map(({ label, key, reason }, index) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={!!reason}
          aria-describedby={reason ? `clip-menu-reason-${index}` : undefined}
          onClick={() => run(index)}
        >
          <span>{label}</span>
          {key && <kbd>{displayKey(key)}</kbd>}
          {reason && <small id={`clip-menu-reason-${index}`}>{reason}</small>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
