import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

const BLOCK = 4 * 1024 * 1024;

export async function fingerprint(path: string): Promise<{ algo: "sampled-sha256-v1"; value: string }> {
  const size = (await stat(path)).size;
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    if (size <= BLOCK * 3) {
      for (let offset = 0; offset < size; offset += BLOCK)
        hash.update(await readBlock(file, offset, Math.min(BLOCK, size - offset)));
    } else {
      hash.update(`${size}\n`);
      for (const offset of [0, Math.floor((size - BLOCK) / 2), size - BLOCK])
        hash.update(await readBlock(file, offset, BLOCK));
    }
  } finally {
    await file.close();
  }
  return { algo: "sampled-sha256-v1", value: hash.digest("hex") };
}

async function readBlock(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(data, done, length - done, position + done);
    if (!bytesRead) throw new Error("File changed while fingerprinting");
    done += bytesRead;
  }
  return data;
}
