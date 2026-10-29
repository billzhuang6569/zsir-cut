import { useEffect, useRef, useState } from "react";

export function reverseBuffer(context: Pick<AudioContext, "createBuffer">, input: AudioBuffer): AudioBuffer {
  const output = context.createBuffer(input.numberOfChannels, input.length, input.sampleRate);
  for (let channel = 0; channel < input.numberOfChannels; channel++) {
    const source = input.getChannelData(channel);
    const target = output.getChannelData(channel);
    for (let i = 0; i < source.length; i++) target[i] = source[source.length - 1 - i] ?? 0;
  }
  return output;
}
export function useReverseAudio(
  src: string | undefined,
  clipId: string | undefined,
  seconds: number,
  speed: number,
  playing: boolean,
  gain: number,
  error: (message: string) => void,
) {
  const context = useRef<AudioContext | null>(null);
  const active = useRef<{
    node: AudioBufferSourceNode;
    gain: GainNode;
    at: number;
    started: number;
    rate: number;
    clip: string | undefined;
  } | null>(null);
  const [decoded, setDecoded] = useState<{ src: string; buffer: AudioBuffer } | null>(null);
  const reverse = speed < 0;
  useEffect(() => {
    if (!src || !reverse || decoded?.src === src || typeof AudioContext === "undefined") return;
    const controller = new AbortController();
    const audio = context.current ?? new AudioContext();
    context.current = audio;
    // shortcut: Reverse monitoring decodes one source in memory; use streaming chunks for very long media.
    void fetch(src, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("读取倒放声音失败");
        return response.arrayBuffer();
      })
      .then((bytes) => audio.decodeAudioData(bytes))
      .then((buffer) => {
        if (!controller.signal.aborted) setDecoded({ src, buffer: reverseBuffer(audio, buffer) });
      })
      .catch(() => {
        if (!controller.signal.aborted) error("倒放声音读取或解码失败");
      });
    return () => controller.abort();
  }, [src, reverse, decoded, error]);
  useEffect(() => {
    const audio = context.current;
    const stop = () => {
      active.current?.node.stop();
      active.current = null;
    };
    if (!audio || !playing || !reverse || !decoded || decoded.src !== src) {
      stop();
      return;
    }
    const rate = -speed;
    const offset = Math.max(0, decoded.buffer.duration - seconds);
    const prior = active.current;
    if (
      prior &&
      prior.rate === rate &&
      prior.clip === clipId &&
      Math.abs(prior.at + (audio.currentTime - prior.started) * rate - offset) < 0.15
    ) {
      prior.gain.gain.value = 10 ** (gain / 20);
      return;
    }
    stop();
    if (offset >= decoded.buffer.duration) return;
    const node = audio.createBufferSource();
    const volume = audio.createGain();
    node.buffer = decoded.buffer;
    node.playbackRate.value = rate;
    volume.gain.value = 10 ** (gain / 20);
    node.connect(volume);
    volume.connect(audio.destination);
    active.current = { node, gain: volume, at: offset, started: audio.currentTime, rate, clip: clipId };
    node.start(0, offset);
    void audio.resume().catch(() => error("声音播放失败，请重试"));
  }, [src, clipId, seconds, speed, playing, reverse, decoded, gain, error]);
  useEffect(
    () => () => {
      active.current?.node.stop();
      void context.current?.close();
    },
    [],
  );
}
