export function encodeBarcode(id: number, frame: number): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id > 65535 || !Number.isInteger(frame) || frame < 0 || frame > 16777215) {
    throw new RangeError("barcode ID or frame out of range");
  }
  const bytes = [id >> 8, id & 255, frame >> 16, (frame >> 8) & 255, frame & 255];
  bytes.push(bytes.reduce((sum, value) => sum + value, 0) & 255);
  return Uint8Array.from(bytes.flatMap((byte) => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1)));
}

export function decodeBarcode(bits: ArrayLike<number>): { id: number; frame: number } {
  if (bits.length !== 48) throw new Error("barcode must have 48 bits");
  const bytes = Array.from({ length: 6 }, (_, index) => {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      const digit = bits[index * 8 + bit];
      if (digit !== 0 && digit !== 1) throw new Error("invalid barcode bit");
      value = (value << 1) | digit;
    }
    return value;
  });
  if (((bytes[0]! + bytes[1]! + bytes[2]! + bytes[3]! + bytes[4]!) & 255) !== bytes[5])
    throw new Error("barcode checksum mismatch");
  return { id: (bytes[0]! << 8) | bytes[1]!, frame: (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]! };
}
