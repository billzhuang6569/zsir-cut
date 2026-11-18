import { type PointerEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipEdit } from "./clipProperties.js";
import { IconButton } from "./components.js";
import type { TrackView } from "./timeline.js";

export function TrackHead({
  track,
  index,
  blocked,
  carrier,
  target,
  solo,
  edit,
  toggleTarget,
  toggleSolo,
  resize,
}: {
  track: TrackView;
  index: number;
  blocked: boolean;
  carrier: boolean;
  target: boolean;
  solo: boolean;
  edit: ClipEdit;
  toggleTarget: () => void;
  toggleSolo: () => void;
  resize: (height: number | undefined, commit: boolean) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const focusName = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  }, []);
  const popup = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const element = popup.current;
    if (!menu || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min(menu.x, window.innerWidth - width))}px`;
    element.style.top = `${Math.max(0, Math.min(menu.y, window.innerHeight - height))}px`;
    element.querySelector("button")?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) setMenu(null);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [menu]);

  const beginRename = () => {
    if (!blocked) setName(track.name);
  };
  const setTrack = (label: string, fields: { locked?: boolean; enabled?: boolean }) =>
    edit(label, [{ op: "set_track", track_id: track.id, ...fields }]);
  const lock = track.locked ? "解锁轨道" : "锁定轨道";
  const enable =
    track.kind === "video" ? (track.enabled ? "隐藏画面" : "显示画面") : track.enabled ? "静音" : "取消静音";
  const removeReason =
    track.clips.length || track.transitions?.length
      ? "移走片段和转场后删除"
      : carrier
        ? "更换字幕承载轨后删除"
        : undefined;
  const finishResize = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (drag.current?.pointer !== event.pointerId) return;
    const { y, height } = drag.current;
    drag.current = null;
    resize(
      commit && event.clientY !== y ? Math.max(30, Math.min(240, Math.round(height + event.clientY - y))) : undefined,
      commit,
    );
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: The track header is a group of editing controls.
    <div
      className="zc-track-name zc-track-head zc-track-controls"
      role="group"
      aria-label={track.name}
      onContextMenu={(event) => {
        if (blocked || (event.target as Element).closest("input")) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {name === null ? (
        <button
          ref={nameButton}
          type="button"
          className="zc-track-title"
          title={track.name}
          aria-label={track.name}
          onDoubleClick={beginRename}
          onKeyDown={(event) => {
            if (blocked) return;
            if (event.key === "F2" || event.key === "Enter") {
              event.preventDefault();
              beginRename();
            } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              const { left, bottom } = event.currentTarget.getBoundingClientRect();
              setMenu({ x: left, y: bottom });
            }
          }}
        >
          {track.name}
        </button>
      ) : (
        <input
          ref={focusName}
          aria-label="轨道名"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setName(null)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
            event.preventDefault();
            const next = name.trim();
            setName(null);
            if (event.key === "Enter" && !blocked && next && next !== track.name)
              edit("重命名轨道", [{ op: "rename_track", track_id: track.id, name: next }]);
          }}
        />
      )}
      <div className="zc-track-buttons">
        <IconButton
          icon="lock"
          label={lock}
          pressed={!!track.locked}
          disabled={blocked}
          onClick={() => setTrack(lock, { locked: !track.locked })}
        />
        <IconButton
          icon={track.kind === "video" ? "eye" : "volume"}
          label={enable}
          pressed={track.enabled}
          disabled={blocked}
          onClick={() => setTrack(enable, { enabled: !track.enabled })}
        />
        {track.kind === "audio" && (
          <button
            type="button"
            className="zc-ibtn zc-icon-btn"
            title={solo ? "取消独奏" : "独奏"}
            aria-label={solo ? "取消独奏" : "独奏"}
            aria-pressed={solo}
            disabled={blocked}
            onClick={toggleSolo}
          >
            S
          </button>
        )}
        <IconButton
          icon="target"
          label={target ? "取消目标轨" : "设为目标轨"}
          pressed={target}
          disabled={blocked}
          onClick={toggleTarget}
        />
      </div>
      <button
        type="button"
        className="zc-track-resize"
        aria-label="调整轨道高度"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const row = event.currentTarget.closest(".zc-track");
          if (!row) return;
          drag.current = { pointer: event.pointerId, y: event.clientY, height: row.getBoundingClientRect().height };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointer === event.pointerId)
            resize(Math.max(30, Math.min(240, Math.round(start.height + event.clientY - start.y))), false);
        }}
        onPointerUp={(event) => finishResize(event, true)}
        onPointerCancel={(event) => finishResize(event, false)}
        onLostPointerCapture={(event) => finishResize(event, false)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const height = event.currentTarget.closest(".zc-track")?.getBoundingClientRect().height ?? 30;
          resize(Math.max(30, Math.min(240, Math.round(height) + (event.key === "ArrowUp" ? -4 : 4))), true);
        }}
      />
      {menu &&
        createPortal(
          // biome-ignore lint/a11y/useSemanticElements: The floating action list is not a form.
          <div
            ref={popup}
            role="group"
            aria-label="轨道操作"
            className="zc-cue-menu zc-clip-menu zc-track-menu"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                setMenu(null);
                nameButton.current?.focus();
              }
            }}
          >
            {(["上方", "下方"] as const).flatMap((side, offset) =>
              (["video", "audio"] as const).map((kind) => {
                const label = `在${side}新建${kind === "video" ? "视频轨" : "声音轨"}`;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={blocked}
                    onClick={() => {
                      setMenu(null);
                      nameButton.current?.focus();
                      edit(label, [{ op: "add_track", id: `trk_${crypto.randomUUID()}`, kind, index: index + offset }]);
                    }}
                  >
                    {label}
                  </button>
                );
              }),
            )}
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setMenu(null);
                beginRename();
              }}
            >
              重命名轨道
            </button>
            <button
              type="button"
              aria-disabled={blocked || !!removeReason}
              onClick={() => {
                if (blocked || removeReason) return;
                setMenu(null);
                nameButton.current?.focus();
                edit("删除轨道", [{ op: "remove_track", track_id: track.id }]);
              }}
            >
              删除轨道
              {removeReason && <small>{removeReason}</small>}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
