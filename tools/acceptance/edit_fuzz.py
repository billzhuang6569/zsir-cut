"""Black-box fuzz for edit ops (1.6): random op sequences through the zcut CLI.
After every applied step: independent L1 check (l1_check.py) must show no E_ errors;
linked / all-track ops must not introduce W_SYNC. At the end, undo every step and
require the project bytes to equal the original except `revision`.
Usage: python3 -I tools/acceptance/edit_fuzz.py <project.zcut.json> [steps] [seed]
Run from the repository root after `pnpm typecheck`."""
import json, os, random, shutil, subprocess, sys, tempfile
from fractions import Fraction as F

ROOT = os.getcwd()
CLI = [ "node", os.path.join(ROOT, "packages/cli/dist/index.js") ]
HERE = os.path.dirname(os.path.abspath(__file__))
src, steps, seed = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200, int(sys.argv[3]) if len(sys.argv) > 3 else 1
rnd = random.Random(seed)
work = tempfile.mkdtemp(prefix="zcut-fuzz-"); proj = os.path.join(work, "p.zcut.json"); shutil.copy(src, proj)
T = lambda s: F(s[:-1])
def ts(x):
    x = F(x); return "0s" if x == 0 else (f"{x.numerator}s" if x.denominator == 1 else f"{x.numerator}/{x.denominator}s")
def load(): return json.load(open(proj, encoding="utf-8"))
def run(verb, req):
    p = subprocess.run(CLI + [verb, proj], input=json.dumps(req, ensure_ascii=False), capture_output=True, text=True)
    return json.loads(p.stdout)
def l1(path):
    out = subprocess.run([sys.executable, "-I", os.path.join(HERE, "l1_check.py"), path], capture_output=True, text=True).stdout
    errs = [l for l in out.splitlines() if l.startswith("    ")]
    warn = out.split("warnings:")[-1]
    return errs, ("W_SYNC" in warn)
def strip_rev(d): d = dict(d); d.pop("revision", None); return d

original = strip_rev(load()); applied = []; stats = {}
for i in range(steps):
    d = load(); tl = d["timelines"][0]; rate = F(tl["edit_rate"]); fd = 1 / rate
    vid = [t for t in tl["tracks"] if t["kind"] == "video"]; aud = [t for t in tl["tracks"] if t["kind"] == "audio"]
    clips = [(t, c) for t in vid + aud for c in t["clips"]]
    end = max([T(c["timeline_start"]) + T(c["duration"]) for _, c in clips] or [F(0)])
    frame = lambda x: F(round(x / fd)) * fd
    kind = rnd.choice(["remove_span", "split", "move", "remove", "set_clip", "add_marker"])
    op = None; sync_safe = True
    if kind == "remove_span" and end > 4 * fd:
        a = frame(F(rnd.random()) * (end - 2 * fd)); dur = max(fd, frame(F(rnd.random()) * min(end - a, 5)))
        op = {"op": "remove_span", "range": {"start": ts(a), "duration": ts(dur)}}
    elif kind == "split" and clips:
        t, c = rnd.choice(clips); s, du = T(c["timeline_start"]), T(c["duration"])
        if du >= 2 * fd and not c.get("time_map"):
            op = {"op": "split", "clip_id": c["id"], "at": ts(s + frame(du / 2))}
    elif kind == "move" and clips:
        t, c = rnd.choice(clips); op = {"op": "move", "clip_ids": [c["id"]], "to": ts(T(c["timeline_start"]) + rnd.choice([-1, 1]) * rnd.randint(1, 30) * fd)}
    elif kind == "remove" and clips:
        t, c = rnd.choice(clips); op = {"op": "remove", "clip_ids": [c["id"]], "linked": True}
    elif kind == "set_clip" and clips:
        t, c = rnd.choice(clips); op = {"op": "set_clip", "clip_id": c["id"], "label": f"fuzz {i}"}
    elif kind == "add_marker":
        op = {"op": "add_marker", "at": ts(frame(F(rnd.random()) * end)), "duration": "0s", "kind": "note", "text": f"m{i}"}
    if not op: continue
    req = {"base_revision": d["revision"]["id"], "idempotency_key": f"fuzz-{seed}-{i}", "author": {"kind": "agent", "name": "fuzz"}, "ops": [op]}
    env = run("edit", req); st = env["status"]; stats[(op["op"], st)] = stats.get((op["op"], st), 0) + 1
    if st == "applied":
        applied.append(op["op"]); errs, sync = l1(proj)
        if errs: print("L1 ERROR after", op, errs[:3]); sys.exit(1)
        if sync and op["op"] in ("remove_span", "split", "remove"): print("W_SYNC after linked/all-track op", op); sys.exit(1)
    elif st not in ("rejected",): print("unexpected", st, json.dumps(env)[:300]); sys.exit(1)
print("ops:", {f"{k[0]}:{k[1]}": v for k, v in sorted(stats.items())})
for j in range(len(applied)):
    d = load(); env = run("undo", {"base_revision": d["revision"]["id"], "idempotency_key": f"undo-{seed}-{j}", "author": {"kind": "agent", "name": "fuzz"}})
    if env["status"] != "applied": print("undo failed at", j, json.dumps(env)[:300]); sys.exit(1)
print("undo all:", "IDENTICAL" if strip_rev(load()) == original else "DIFFERENT", f"({len(applied)} steps)")
