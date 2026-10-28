import { add, floor, parseRational, rational } from "./rational.ts";

function nominal(rate: string, drop: boolean): bigint {
  if (drop && rate !== "30000/1001" && rate !== "60000/1001")
    throw new Error("Drop-frame requires 30000/1001 or 60000/1001");
  const fps = floor(add(parseRational(rate), rational(1n, 2n)));
  if (fps < 1n) throw new Error(`Unsupported timecode rate: ${rate}`);
  return fps;
}

export function timecodeToFrame(value: string, rate: string): bigint {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid timecode: ${value}`);
  const drop = match[4] === ";";
  const fps = nominal(rate, drop);
  const dropped = drop ? fps / 15n : 0n;
  const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5]].map((part) => BigInt(part!));
  if (
    hours! > 23n ||
    minutes! > 59n ||
    seconds! > 59n ||
    frames! >= fps ||
    (drop && seconds === 0n && minutes! % 10n !== 0n && frames! < dropped)
  )
    throw new Error(`Invalid timecode: ${value}`);
  const totalMinutes = hours! * 60n + minutes!;
  return (hours! * 3600n + minutes! * 60n + seconds!) * fps + frames! - dropped * (totalMinutes - totalMinutes / 10n);
}

export function frameToTimecode(
  frame: bigint,
  rate: string,
  drop = false,
  start = drop ? "00:00:00;00" : "00:00:00:00",
): string {
  const fps = nominal(rate, drop);
  const dropped = drop ? fps / 15n : 0n;
  if (frame < 0n) throw new RangeError("negative frame");
  let count = frame + timecodeToFrame(start, rate);
  const tenMinutes = fps * 600n - dropped * 9n;
  const day = tenMinutes * 144n;
  count %= day;
  if (drop) {
    const block = count / tenMinutes;
    const rest = count % tenMinutes;
    const firstMinute = fps * 60n;
    count +=
      block * dropped * 9n +
      (rest >= firstMinute ? dropped * ((rest - firstMinute) / (firstMinute - dropped) + 1n) : 0n);
  }
  const hours = count / (fps * 3600n);
  const minutes = (count / (fps * 60n)) % 60n;
  const seconds = (count / fps) % 60n;
  const frames = count % fps;
  const pad = (value: bigint) => value.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${drop ? ";" : ":"}${pad(frames)}`;
}
