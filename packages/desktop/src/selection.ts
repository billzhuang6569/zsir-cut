import type { PointerEvent } from "react";

export function preventPointerSelection(event: PointerEvent<HTMLElement>) {
  event.preventDefault();
  const active = event.currentTarget.ownerDocument.activeElement;
  // Canceling pointerdown also blocks the browser's default blur outside an editor.
  if (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) &&
    !active.contains(event.target as Node)
  )
    active.blur();
}
