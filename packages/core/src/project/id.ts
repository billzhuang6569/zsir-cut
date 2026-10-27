import { randomBytes } from "node:crypto";

const prefixes = new Set([
  "prj_",
  "tl_",
  "trk_",
  "med_",
  "occ_",
  "clp_",
  "trn_",
  "mrk_",
  "trs_",
  "run_",
  "tok_",
  "cue_",
  "sty_",
  "rev_",
  "req_",
  "ses_",
]);

export interface IdSources {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export function newId(prefix: string, sources: IdSources = {}): string {
  if (!prefixes.has(prefix)) throw new RangeError(`Invalid ID prefix: ${prefix}`);
  const now = (sources.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new RangeError("Invalid UUIDv7 timestamp");
  const random = (sources.randomBytes ?? randomBytes)(10);
  if (random.length !== 10) throw new RangeError("UUIDv7 needs 10 random bytes");
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes.set(random, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
