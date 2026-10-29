import type { Track } from "./types.ts";

export function automaticTrackName(tracks: Track[], kind: Track["kind"]): string {
  const prefix = { video: "视频", audio: "声音", subtitle: "字幕" }[kind];
  let highest = 0n;
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const suffix = new RegExp(`^${prefix} ([A-Z]+)$`).exec(track.name)?.[1];
    if (!suffix) continue;
    let value = 0n;
    for (const letter of suffix) value = value * 26n + BigInt(letter.charCodeAt(0) - 64);
    if (value > highest) highest = value;
  }
  let suffix = "";
  for (let value = highest + 1n; value > 0n; value = (value - 1n) / 26n)
    suffix = String.fromCharCode(65 + Number((value - 1n) % 26n)) + suffix;
  return `${prefix} ${suffix}`;
}
