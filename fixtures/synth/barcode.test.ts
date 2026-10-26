import { describe, expect, it } from "vitest";
import { decodeBarcode, encodeBarcode } from "./barcode.js";

describe("barcode", () => {
  it("round trips ID and source frame", () => {
    for (const [id, frame] of [
      [1, 0],
      [11, 3596],
      [65535, 16777215],
    ]) {
      expect(decodeBarcode(encodeBarcode(id!, frame!))).toEqual({ id, frame });
    }
  });
  it("rejects corruption", () => {
    const bits = encodeBarcode(12, 17982);
    bits[2] = bits[2] ? 0 : 1;
    expect(() => decodeBarcode(bits)).toThrow("checksum");
  });
});
