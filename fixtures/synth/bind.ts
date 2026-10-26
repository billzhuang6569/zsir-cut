import { dirname, relative, resolve, sep } from "node:path";

export type FingerprintTable = Record<
  string,
  { path: string; size_bytes: number; fingerprint: { algo: "sampled-sha256-v1"; value: string } }
>;

export function bindProject(source: string, table: FingerprintTable, outputProject: string, mediaRoot: string): string {
  const project = JSON.parse(source) as {
    media: Array<{ path: string; size_bytes: number; fingerprint: { algo: string; value: string } }>;
  };
  for (const media of project.media) {
    const sourcePath = media.path.replace(/^\.\.\/\.media\//, "");
    const entry = table[sourcePath];
    if (!entry) throw new Error(`Missing fingerprint: ${sourcePath}`);
    media.path = relative(dirname(outputProject), resolve(mediaRoot, entry.path)).split(sep).join("/");
    media.size_bytes = entry.size_bytes;
    media.fingerprint = entry.fingerprint;
  }
  return `${JSON.stringify(project, null, 2)}\n`;
}
