// Acceptance helpers for validation and relink. Usage: node tools/acceptance/validate_compare.mjs codes|media|relink args...
import { readFileSync, readdirSync } from "node:fs";
import { dirname, basename } from "node:path";
const core = await import("../../packages/core/dist/index.js");
const [mode, ...args] = process.argv.slice(2);
const load = (p) => { const r = core.parseProject(readFileSync(p, "utf8")); if (!r.ok) throw new Error("parse " + p); return r; };
if (mode === "codes") {
  for (const p of args) {
    const r = load(p); const issues = [...(r.issues ?? []), ...core.validateProjectSemantics(r.project)];
    const codes = [...new Set(issues.map((i) => i.code))].sort();
    console.log(basename(p).padEnd(28), codes.join(" ") || "(none)");
  }
} else if (mode === "media") {
  const p = args[0]; const r = load(p);
  const issues = await core.validateProjectMedia(r.project, dirname(p));
  const by = {}; for (const i of issues) by[i.code] = (by[i.code] ?? 0) + 1;
  console.log(basename(p), JSON.stringify(by));
} else if (mode === "relink") {
  const [p, root] = args; const r = load(p);
  const res = await core.relinkMedia(r.project, dirname(p), [root]);
  const out = res.project ?? res.value?.project;
  console.log(JSON.stringify({ relinked: res.relinked.length, not_found: res.not_found, skipped: res.skipped.length }));
  const dup = res.relinked.filter((x) => x.media_id.startsWith("med_DUP"));
  for (const d of dup) console.log(" ", d.media_id, "->", d.to);
  const after = await core.validateProjectMedia(out, dirname(p));
  console.log(" L2 after relink:", after.length ? JSON.stringify(after.map((i) => i.code)) : "clean");
}
