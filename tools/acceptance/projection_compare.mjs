// Compare core projectSubtitles with the independent Python projector. Usage: node tools/acceptance/projection_compare.mjs <project>...
import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; import { basename } from "node:path"; import { fileURLToPath } from "node:url";
const PROJECTOR = fileURLToPath(new URL("./project_subs.py", import.meta.url));
const core = await import("../../packages/core/dist/index.js");
const str = (r) => (r.denominator === 1n ? String(r.numerator) : r.numerator + "/" + r.denominator);
for (const p of process.argv.slice(2)) {
  const pr = core.parseProject(readFileSync(p, "utf8")); const tl = pr.project.timelines[0].id;
  const res = core.projectSubtitles(pr.project, tl);
  const mine = JSON.parse(execFileSync("python3", ["-I", PROJECTOR, p], { encoding: "utf8" }));
  const a = res.cues.map((c) => [c.track_id, c.cue_id, c.clip_ids && c.clip_ids.length ? c.clip_ids.join("+") : (c.clip_id ?? null), str(c.start), str(c.end), c.lines.join("")].join("|")).sort();
  const b = mine.cues.map((c) => [c.track, c.cue, c.clip, c.start, c.end, c.text].join("|")).sort();
  const onlyA = a.filter((x) => !b.includes(x)), onlyB = b.filter((x) => !a.includes(x));
  const ua = res.unprojected.map((u) => u.clip_id + "|" + u.token_id).sort().join(","), ub = mine.unprojected.map((u) => u.join("|")).sort().join(",");
  console.log(basename(p).padEnd(24), "cues", a.length, "vs", b.length, onlyA.length || onlyB.length ? "DIFF" : "SAME", "| unprojected", ua === ub ? "SAME" : "DIFF");
  for (const x of onlyA.slice(0, 5)) console.log("  codex only:", x); for (const x of onlyB.slice(0, 5)) console.log("  claude only:", x);
}
