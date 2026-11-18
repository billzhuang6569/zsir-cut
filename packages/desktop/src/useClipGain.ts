import { useCallback, useEffect, useRef } from "react";

export function useClipGain() {
  const audio = useRef<AudioContext | null>(null);
  const gains = useRef(new WeakMap<HTMLMediaElement, GainNode>());
  useEffect(
    () => () => {
      void audio.current?.close();
      audio.current = null;
      gains.current = new WeakMap();
    },
    [],
  );
  return useCallback((element: HTMLMediaElement, db: number) => {
    const level = 10 ** (db / 20);
    let node = gains.current.get(element);
    if (!node && level > 1 && typeof AudioContext !== "undefined") {
      const context = audio.current ?? new AudioContext();
      audio.current = context;
      node = context.createGain();
      context.createMediaElementSource(element).connect(node).connect(context.destination);
      gains.current.set(element, node);
    }
    if (node) {
      node.gain.value = level;
      if (audio.current?.state === "suspended") void audio.current.resume().catch(() => {});
    }
    element.volume = node ? 1 : Math.min(1, level);
  }, []);
}
