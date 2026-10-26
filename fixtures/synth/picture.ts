import { encodeBarcode } from "./barcode.ts";

export const WIDTH = 960;
export const HEIGHT = 540;

export function isWhiteFrame(frame: number, rateNumerator: number, rateDenominator: number): boolean {
  const n = BigInt(frame),
    numerator = BigInt(rateNumerator),
    denominator = BigInt(rateDenominator);
  const second = (n * denominator + numerator - 1n) / numerator;
  return (second * numerator) / denominator === n;
}

export function paintBarcode(rgb: Buffer, id: number, frame: number): void {
  const bits = encodeBarcode(id, frame);
  for (let bit = 0; bit < 48; bit++) {
    const shade = bits[bit] ? 255 : 0;
    for (let y = HEIGHT - 16; y < HEIGHT; y++) {
      rgb.fill(shade, (y * WIDTH + bit * 20) * 3, (y * WIDTH + bit * 20 + 20) * 3);
    }
  }
}

export function baseFrame(
  id: number,
  frame: number,
  rateNumerator: number,
  rateDenominator: number,
  still = false,
): Buffer {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  rgb.fill(still ? 48 : isWhiteFrame(frame, rateNumerator, rateDenominator) ? 255 : 38);
  paintBarcode(rgb, id, frame);
  return rgb;
}

export function overlayText(
  rgb: Buffer,
  rgba: Buffer,
  width: number,
  height: number,
  left: number,
  top: number,
  dark = false,
): void {
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const alpha = rgba[source + 3]!;
      if (!alpha) continue;
      const target = ((top + y) * WIDTH + left + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        rgb[target + channel] = Math.round(
          (dark ? 0 : rgba[source + channel]!) + (rgb[target + channel]! * (255 - alpha)) / 255,
        );
    }
}
