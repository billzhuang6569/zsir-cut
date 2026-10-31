import type { Transcript } from "./types.ts";

type TranscriptIds = Pick<Transcript, "id" | "ext"> & {
  tokens: { id: string }[];
  cues: { id: string }[];
};

export function transcriptIds(
  project: { transcripts: TranscriptIds[] },
  transcript: TranscriptIds,
  prefix: "tok_" | "cue_",
): () => string {
  const existing = (prefix === "tok_" ? transcript.tokens : transcript.cues).map((item) => item.id);
  let allocate: (() => string) | undefined;
  return () => {
    if (!allocate) {
      const suffix = (item: TranscriptIds) => item.id.slice(4).replaceAll("-", "").toLowerCase();
      const storedTag = (item: TranscriptIds) => (item.ext?.zsir as { id_tag?: string } | undefined)?.id_tag;
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
