import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bindProject, type FingerprintTable } from "./bind.js";

describe("fixture project binding", () => {
  it("replaces only path, size and fingerprint in std-25", () => {
    const source = readFileSync(new URL("../projects/std-25.zcut.json", import.meta.url), "utf8");
    const original = JSON.parse(source);
    const table: FingerprintTable = Object.fromEntries(
      original.media.map((media: { path: string }, i: number) => [
        media.path.replace("../.media/", ""),
        {
          path: media.path.replace("../.media/", ""),
          size_bytes: i + 10,
          fingerprint: { algo: "sampled-sha256-v1", value: String(i).padStart(64, "0") },
        },
      ]),
    );
    const output = JSON.parse(
      bindProject(source, table, "/repo/fixtures/.media/projects/std-25.zcut.json", "/repo/fixtures/.media"),
    );
    for (let i = 0; i < original.media.length; i++) {
      const before = original.media[i],
        after = output.media[i];
      expect(after.path).toBe(`../${before.path.replace("../.media/", "")}`);
      expect(after.size_bytes).toBe(i + 10);
      expect(after.fingerprint).toEqual(table[before.path.replace("../.media/", "")]!.fingerprint);
      delete before.path;
      delete before.size_bytes;
      delete before.fingerprint;
      delete after.path;
      delete after.size_bytes;
      delete after.fingerprint;
    }
    expect(output).toEqual(original);
  });
});
