export function timelineVisual<T>() {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: T | null) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
