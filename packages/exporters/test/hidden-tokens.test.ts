import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fingerprint, parseProject, runExport, serializeProject } from "../../core/src/index.js";
import exporter from "../src/index.js";

it.each(["fcp-11-fcpxml-1.13", "resolve-18.5-otio", "premiere-25-xmeml-5"] as const)(
  "%s exports one subtitle across hidden words and none when all are hidden",
  async (profile) => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-hidden-"));
    try {
      const parsed = parseProject(await readFile("fixtures/regressions/hidden-tokens.zcut.json", "utf8"));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const project = parsed.project;
      const media = project.media[0];
      const transcript = project.transcripts[0];
      if (!media || !transcript) throw new Error("Missing regression media or transcript");
      const source = join(directory, "hidden.mov");
      await writeFile(source, "fake media");
      media.path = "hidden.mov";
      media.fingerprint = await fingerprint(source);
      const projectPath = join(directory, "hidden.zcut.json");
      for (const hidden of [[1], [0], [4], [0, 1, 2, 3, 4]]) {
        for (const [index, token] of transcript.tokens.entries())
          token.text = hidden.includes(index) ? "" : (token.heard ?? "");
        await writeFile(projectPath, serializeProject(project));
        const result = await runExport(
          project,
          { project: projectPath, output: join(directory, hidden.join("")) },
          { ...exporter, gitSha: async () => "abcdef0" },
          `exp_hidden_${hidden.join("")}`,
          "2026-10-29T00:00:00.000Z",
          profile,
          async (_project, _timeline, _path, options) => {
            const data = Buffer.from("preview placeholder");
            await writeFile(options.output, data);
            return { path: options.output, sha256: createHash("sha256").update(data).digest("hex"), frames: "0" };
          },
        );
        if (result.rejected) throw new Error(JSON.stringify(result));
        expect(result.manifest.validation.schema.status).toBe("pass");
        expect(result.manifest.validation.media_resolved.status).toBe("pass");
        const srt = await readFile(join(result.package, "subtitles/zh-Hans.srt"), "utf8");
        const allHidden = hidden.length === 5;
        expect(srt.match(/-->/g) ?? []).toHaveLength(allHidden ? 0 : 1);
        if (!allHidden) {
          const lines =
            hidden[0] === 4 ? ["一起啊", "切这个"] : hidden[0] === 0 ? ["啊", "切这个瓜"] : ["一起", "切这个瓜"];
          expect(srt.trim().split("\n")).toHaveLength(2 + lines.length);
          expect(srt).toContain(hidden[0] === 0 ? "00:00:06,200" : "00:00:06,000");
          expect(srt).toContain(hidden[0] === 0 ? "00:00:07,200" : "00:00:07,000");
          expect(srt.trim().split("\n").slice(2)).toEqual(lines);
        }
        if (profile === "fcp-11-fcpxml-1.13") {
          const file = result.manifest.files.find((file) => file.role === "timeline");
          if (!file) throw new Error("Missing FCPXML");
          const xml = await readFile(join(result.package, file.path), "utf8");
          expect(xml.match(/<caption /g) ?? []).toHaveLength(allHidden ? 0 : 1);
          if (hidden.length === 1 && hidden[0] === 1) expect(xml).toContain("一起\n切这个瓜");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
