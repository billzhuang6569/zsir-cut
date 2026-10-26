import { readdirSync, readFileSync } from "node:fs";
import { validateLossReport, validateManifest, validateProject } from "../packages/core/src/schema.ts";

const projects = ["examples", "fixtures/projects"].flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".zcut.json"))
    .map((name) => `${directory}/${name}`),
);

for (const [path, validator] of [
  ...projects.map((path) => [path, validateProject] as const),
  ["examples/handoff/loss-report.json", validateLossReport] as const,
  ["examples/handoff/manifest.json", validateManifest] as const,
]) {
  const result = validator(JSON.parse(readFileSync(path, "utf8")));
  console.log(`${path} ${result.valid ? "valid" : "invalid"}`);
  if (!result.valid) {
    console.error(result.errors);
    process.exitCode = 1;
  }
}
