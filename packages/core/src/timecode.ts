function nominal(rate: string, drop: boolean): bigint {
  if (drop && rate !== "30000/1001") throw new Error("Drop-frame requires 30000/1001");
  if (rate === "25") return 25n;
  if (rate === "30000/1001") return 30n;
  throw new Error(`Unsupported timecode rate: ${rate}`);
}

export function timecodeToFrame(value: string, rate: string): bigint {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid timecode: ${value}`);
  const drop = match[4] === ";";
  const fps = nominal(rate, drop);
  const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5]].map((part) => BigInt(part!));
  if (
    hours! > 23n ||
    minutes! > 59n ||
    seconds! > 59n ||
    frames! >= fps ||
    (drop && seconds === 0n && minutes! % 10n !== 0n && frames! < 2n)
  )
    throw new Error(`Invalid timecode: ${value}`);
  const totalMinutes = hours! * 60n + minutes!;
  return (
    (hours! * 3600n + minutes! * 60n + seconds!) * fps +
    frames! -
    (drop ? 2n * (totalMinutes - totalMinutes / 10n) : 0n)
  );
}

export function frameToTimecode(
  frame: bigint,
  rate: string,
  drop = false,
  start = drop ? "00:00:00;00" : "00:00:00:00",
): string {
  const fps = nominal(rate, drop);
  if (frame < 0n) throw new RangeError("negative frame");
  let count = frame + timecodeToFrame(start, rate);
  const day = drop ? 2589408n : fps * 86400n;
  count %= day;
  if (drop) {
    const tenMinutes = 17982n;
    const block = count / tenMinutes;
    const rest = count % tenMinutes;
    count += block * 18n + (rest >= 1800n ? 2n * ((rest - 1800n) / 1798n + 1n) : 0n);
  }
  const hours = count / (fps * 3600n);
  const minutes = (count / (fps * 60n)) % 60n;
  const seconds = (count / fps) % 60n;
  const frames = count % fps;
  const pad = (value: bigint) => value.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${drop ? ";" : ":"}${pad(frames)}`;
}
