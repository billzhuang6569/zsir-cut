"""Differential test: random transcripts -> `resegment` via the zcut CLI vs the independent segment.py.
Usage (repo root, after `pnpm typecheck`): python3 -I tools/acceptance/segment_diff.py [cases] [seed] [zh|en]"""
import json, os, random, subprocess, sys, tempfile
from fractions import Fraction as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from segment import segment

cases = int(sys.argv[1]) if len(sys.argv) > 1 else 200
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 1
lang = sys.argv[3] if len(sys.argv) > 3 else "zh"
rnd = random.Random(seed); ROOT = os.getcwd()
ZH = list("剪辑字幕时间线采访素材交接工程品牌数字导出画面声音观众节奏重复停顿")
EN = ["the", "edit", "agent", "caption", "timeline", "handoff", "frame", "accurate", "interview", "brand"]
def word():
    r = rnd.random()
    if lang == "en": return rnd.choice(EN)
    if r < 0.15: return rnd.choice(["Agent", "FCP", "2026", "Qwen3", "zsir-cut"])
    return "".join(rnd.choice(ZH) for _ in range(rnd.randint(1, 4)))
def ts(x):
    x = F(x); return "0s" if x == 0 else (f"{x.numerator}s" if x.denominator == 1 else f"{x.numerator}/{x.denominator}s")
base = json.load(open(os.path.join(ROOT, "examples/minimal.zcut.json"), encoding="utf-8"))
fails = 0
for case in range(cases):
    toks = []; t = F(0)
    for i in range(rnd.randint(5, 60)):
        w = word()
        p = rnd.random()
        if p < 0.08: w += "，" if lang == "zh" else ","
        elif p < 0.12: w += "。" if lang == "zh" else "."
        d = F(rnd.randint(8, 60), 100) * max(1, len(w)) / (2 if lang == "zh" else 4)
        toks.append({"id": f"tok_{i:03d}", "text": w, "start": t, "end": t + d})
        g = rnd.random(); t = t + d + (F(rnd.randint(70, 150), 100) if g < 0.08 else F(rnd.randint(30, 60), 100) if g < 0.2 else F(rnd.randint(0, 10), 100))
    d = json.loads(json.dumps(base))
    d["media"][0]["duration"] = ts(max(t + 1, F(d["media"][0]["duration"][:-1])))
    run = {"id": "run_rand", "kind": "align", "engine": {"name": "rand", "model": "rand", "version": "0"}, "created_at": "2026-10-27T00:00:00Z",
           "range": {"start": "0s", "duration": ts(t + 1)}, "tokens": [{"text": x["text"], "start": ts(x["start"]), "end": ts(x["end"])} for x in toks]}
    d["transcripts"] = [{"id": "trs_rand", "media_id": d["media"][0]["id"], "source_channels": [0], "language": "zh-Hans" if lang == "zh" else "en",
                         "raw_runs": [run], "tokens": [{"id": x["id"], "text": x["text"], "state": "auto",
                         "align": {"start": ts(x["start"]), "end": ts(x["end"]), "run": "run_rand"}} for x in toks],
                         "cues": [{"id": "cue_all", "first_token": toks[0]["id"], "last_token": toks[-1]["id"], "state": "auto"}]}]
    work = tempfile.mkdtemp(prefix="zcut-seg-"); p = os.path.join(work, "p.zcut.json")
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    req = {"base_revision": d["revision"]["id"], "idempotency_key": f"seg-{case}", "author": {"kind": "agent", "name": "diff"},
           "ops": [{"op": "resegment", "transcript_id": "trs_rand"}]}
    out = json.loads(subprocess.run(["node", os.path.join(ROOT, "packages/cli/dist/index.js"), "edit", p], input=json.dumps(req), capture_output=True, text=True).stdout)
    if out["status"] != "applied": print("case", case, "status", out["status"], json.dumps(out.get("error"))[:200]); fails += 1; continue
    got = [{"first": c["first_token"], "last": c["last_token"], "breaks": c.get("breaks", [])} for c in json.load(open(p, encoding="utf-8"))["transcripts"][0]["cues"]]
    want = segment(toks, "zh-talk" if lang == "zh" else "en-talk")
    if got != want:
        fails += 1
        if fails <= 3:
            print("MISMATCH case", case)
            for i, (g, w) in enumerate(zip(got + [None] * 5, want + [None] * 5)):
                if g != w: print("   at cue", i, "core:", g, "claude:", w); break
            print("   tokens:", " ".join(f"{x['text']}[{float(x['start']):.2f}-{float(x['end']):.2f}]" for x in toks)[:600])
print(f"{cases - fails}/{cases} identical ({lang}, seed {seed})")
