"""Independent subtitle projection (timeline-schema 5.2 + Claude's 1.3 rules). Raw token interval, no subtitle-rules section 7.
Usage: python3 -I project_subs.py <project.zcut.json>"""
import json, sys
from fractions import Fraction as F
T = lambda s: F(s[:-1])
d = json.load(open(sys.argv[1], encoding="utf-8"))
tl = d["timelines"][0]; tracks = {t["id"]: t for t in tl["tracks"]}
def segs_of(c):
    ts, du, ss = T(c["timeline_start"]), T(c["duration"]), T(c["source_start"])
    tm = c.get("time_map")
    if not tm: return [(ts, ts + du, ss, ss + du, "linear")]
    p = [(T(x["at"]), T(x["source"]), x["interp"]) for x in tm]
    return [(ts + a0, ts + a1, s0, s0 if ip == "hold" else s1, ip) for (a0, s0, ip), (a1, s1, _) in zip(p, p[1:])]
def ov(a, b, lo, hi): return max(F(0), min(b, hi) - max(a, lo))
cues_out, unproj = [], set()
for st in [t for t in tl["tracks"] if t["kind"] == "subtitle"]:
    ovr = {(o["occurrence_id"], o["cue_id"]): o for o in st["overrides"]}
    sep = "" if st["language"].startswith("zh") else " "
    for ct in st["carrier_tracks"]:
        for c in tracks[ct]["clips"]:
            if c.get("enabled") is False: continue
            segs = segs_of(c)
            fwd = [s for s in segs if s[4] != "hold" and s[3] > s[2]]
            held = [s[2] for s in segs if s[4] == "hold"]
            rev = [(s[3], s[2]) for s in segs if s[4] != "hold" and s[3] < s[2]]
            src_lo = min(min(s[2], s[3]) for s in segs); src_hi = max(max(s[2], s[3]) for s in segs)
            cl_lo, cl_hi = T(c["timeline_start"]), T(c["timeline_start"]) + T(c["duration"])
            for tr in [x for x in d["transcripts"] if x["language"] == st["language"] and x["media_id"] == c["media_id"]]:
                toks = tr["tokens"]; idx = {t["id"]: i for i, t in enumerate(toks)}
                cue_of = {}
                for cue in tr["cues"]:
                    for i in range(idx[cue["first_token"]], idx[cue["last_token"]] + 1): cue_of[toks[i]["id"]] = cue
                def place(tk):
                    a, b = T(tk["align"]["start"]), T(tk["align"]["end"])
                    if ov(a, b, src_lo, src_hi) * 2 < (b - a): return "out"
                    if any(a <= h < b for h in held) or any(ov(a, b, lo, hi) * 2 >= (b - a) for lo, hi in rev): return "excluded"
                    mid = (a + b) / 2
                    cand = [s for s in fwd if s[2] <= mid < s[3]] or [max(fwd, key=lambda s: ov(a, b, s[2], s[3]))] if fwd else []
                    if not cand or ov(a, b, cand[0][2], cand[0][3]) == 0: return "excluded"
                    s = cand[0]; m = lambda x: s[0] + (min(max(x, s[2]), s[3]) - s[2]) * (s[1] - s[0]) / (s[3] - s[2])
                    return (m(a), m(b))
                for cue in tr["cues"]:
                    run = []; pieces = []
                    for i in range(idx[cue["first_token"]], idx[cue["last_token"]] + 1):
                        tk = toks[i]
                        if tk["text"] == "": continue
                        r = place(tk)
                        if r == "out": continue
                        if r == "excluded":
                            unproj.add((c["id"], tk["id"]))
                            if run: pieces.append(run); run = []
                            continue
                        if run and r[0] < run[-1][1][0]:  # timeline order broken
                            pieces.append(run); run = []
                        run.append((tk, r))
                    if run: pieces.append(run)
                    o = ovr.get((c["occurrence_id"], cue["id"]))
                    if o and o.get("hidden"): continue
                    for n, pc in enumerate(pieces):
                        t_a, t_b = pc[0][1][0], pc[-1][1][1]
                        t_a, t_b = max(t_a, cl_lo), min(t_b, cl_hi)
                        if t_b <= t_a: continue
                        def join(ws):
                            out = ""
                            for w in ws:
                                if out and (sep or (out[-1].isascii() and out[-1].isalnum() and w[0].isascii() and w[0].isalnum())): out += " "
                                out += w
                            return out
                        text = o["text"] if o and "text" in o else join([t["text"] for t, _ in pc])
                        cues_out.append({"track": st["id"], "cue": cue["id"], "clip": c["id"], "piece": n,
                                         "start": str(t_a), "end": str(t_b), "text": text, "ovr": json.dumps(o, sort_keys=True) if o else None})
    for fc in st["free_cues"]:
        a = T(fc["timeline_start"])
        cues_out.append({"track": st["id"], "cue": fc["id"], "clip": None, "piece": 0, "start": str(a), "end": str(a + T(fc["duration"])), "text": fc["text"]})
cues_out.sort(key=lambda r: (r["track"], F(r["start"]), r["cue"]))
# step 7: merge adjacent pieces of the same cue (jump cuts)
fd = 1 / F(tl["edit_rate"]); merged = []
def joinw(a, b, lang):
    if not lang.startswith("zh"): return a + " " + b
    return a + (" " if a and b and a[-1].isascii() and a[-1].isalnum() and b[0].isascii() and b[0].isalnum() else "") + b
langs = {t["id"]: t.get("language", "") for t in tl["tracks"]}
for c in cues_out:
    prev = merged[-1] if merged else None
    same = [m for m in merged if m["track"] == c["track"] and m["cue"] == c["cue"]]
    last = same[-1] if same else None
    if last and c["clip"] is not None and last["clip"] is not None and abs(F(c["start"]) - F(last["end"])) <= fd and last.get("ovr") == c.get("ovr"):
        last["end"] = c["end"]; last["text"] = last["text"] if (c.get("ovr") and "\"text\"" in c["ovr"]) else joinw(last["text"], c["text"], langs[c["track"]]); last["clip"] = last["clip"] + "+" + c["clip"]
    else:
        merged.append(dict(c))
for m in merged: m.pop("ovr", None)
cues_out = merged
print(json.dumps({"cues": cues_out, "unprojected": sorted(unproj)}, ensure_ascii=False, indent=1))
