import { randomBytes } from "node:crypto";
import type { Project, Transcript } from "./types.ts";

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
  "dec_",
  "job_",
  "exp_",
  "ovl_",
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

export function transcriptIds(project: Project, transcript: Transcript, prefix: "tok_" | "cue_"): () => string {
  const existing = (prefix === "tok_" ? transcript.tokens : transcript.cues).map((item) => item.id);
  let allocate: (() => string) | undefined;
  return () => {
    if (!allocate) {
      const suffix = (item: Transcript) => item.id.slice(4).replaceAll("-", "").toLowerCase();
      const storedTag = (item: Transcript) => (item.ext?.zsir as { id_tag?: string } | undefined)?.id_tag;
      let tag = storedTag(transcript);
      if (!tag) {
        const source = suffix(transcript);
        let length = 6;
        tag = source.slice(-length);
        while (
          project.transcripts.some((item) => item !== transcript && (storedTag(item) ?? suffix(item).slice(-6)) === tag)
        ) {
          if (length >= source.length) throw new Error("Cannot allocate a unique transcript ID tag");
          length += 2;
          tag = source.slice(-length);
        }
        transcript.ext = { ...transcript.ext, zsir: { ...(transcript.ext?.zsir as object), id_tag: tag } };
      }
      const stem = `${prefix}${tag}_`;
      let next = 0n;
      for (const id of existing) {
        const serial = id.slice(stem.length);
        if (!id.startsWith(stem) || !/^[0-9a-z]+$/u.test(serial)) continue;
        let value = 0n;
        for (const digit of serial) value = value * 36n + BigInt("0123456789abcdefghijklmnopqrstuvwxyz".indexOf(digit));
        if (value >= next) next = value + 1n;
      }
      allocate = () => `${stem}${(next++).toString(36)}`;
    }
    return allocate();
  };
}
