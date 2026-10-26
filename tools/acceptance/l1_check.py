import json, sys, re
from fractions import Fraction as F
def T(s):
    assert s.endswith("s"); return F(s[:-1])
def canon(s):
    x = F(s[:-1]); want = "0s" if x == 0 else (f"{x.numerator}s" if x.denominator == 1 else f"{x.numerator}/{x.denominator}s")
    return s == want
def rate(s): return F(s)
issues = []
def E(code, msg): issues.append((code, msg))
def check(path):
    global issues; issues = []
    d = json.load(open(path, encoding="utf-8"))
    # time form
    def walk(o):
        if isinstance(o, dict):
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
        elif isinstance(o, str) and re.fullmatch(r"\d+(/\d+)?s", o) and not canon(o): E("E_TIME_FORM", o)
    walk(d)
    ids = []
    media = {m["id"]: m for m in d["media"]}; ids += list(media)
    for m in d["media"]:
        if m.get("video", {}).get("vfr"): E("W_VFR", m["id"])
    occ_media = {}; occ_clips = {}
    for tl in d["timelines"]:
        ids.append(tl["id"]); fd = 1 / rate(tl["edit_rate"]); sd = F(1, 48000)
        tracks = {t["id"]: t for t in tl["tracks"]}; ids += list(tracks)
        for t in tl["tracks"]:
            if t["kind"] == "subtitle":
                for c in t["carrier_tracks"]:
                    if tracks.get(c, {}).get("kind") != "audio": E("E_REF", f"carrier {c}")
                for fc in t["free_cues"]: ids.append(fc["id"])
                continue
            spans = []
            clips = {c["id"]: c for c in t["clips"]}
            for c in t["clips"]:
                ids.append(c["id"]); m = media.get(c["media_id"])
                if not m: E("E_REF", c["id"]); continue
                if occ_media.setdefault(c["occurrence_id"], c["media_id"]) != c["media_id"]: E("E_REF", f"occ media {c['id']}")
                occ_clips.setdefault(c["occurrence_id"], []).append((t["kind"], c, fd))
                ts, du, ss = T(c["timeline_start"]), T(c["duration"]), T(c["source_start"])
                for v in (ts, ts + du):
                    ok = (v / fd).denominator == 1 or (t["kind"] == "audio" and (v / sd).denominator == 1)
                    if not ok: E("E_GRID", f"{c['id']} {v}")
                spans.append((ts, ts + du, c["id"]))
                tm = c.get("time_map")
                if tm:
                    ats = [T(p["at"]) for p in tm]; srcs = [T(p["source"]) for p in tm]
                    if len(tm) < 2 or ats[0] != 0 or srcs[0] != ss or ats[-1] != du or any(b <= a for a, b in zip(ats, ats[1:])):
                        E("E_TIMEMAP", c["id"])
                    if t["kind"] == "video" and any((a / fd).denominator != 1 for a in ats): E("E_GRID", f"timemap {c['id']}")
                    lo, hi = min(srcs), max(srcs)
                    # hold segment holds at point value: covered by min/max
                else:
                    lo, hi = ss, ss + du
                if m["kind"] == "image":
                    if ss != 0: E("E_SOURCE_RANGE", f"image {c['id']}")
                elif lo < 0 or hi > T(m["duration"]): E("E_SOURCE_RANGE", f"{c['id']} {float(lo):.3f}-{float(hi):.3f} > {float(T(m['duration'])):.3f}")
            spans.sort()
            for (a0, a1, i), (b0, b1, j) in zip(spans, spans[1:]):
                if b0 < a1: E("E_OVERLAP", f"{i} {j}")
            for tr in t["transitions"]:
                ids.append(tr["id"]); a, b = clips.get(tr["from_clip"]), clips.get(tr["to_clip"])
                if not a or not b: E("E_REF", tr["id"]); continue
                if T(a["timeline_start"]) + T(a["duration"]) != T(b["timeline_start"]): E("E_HANDLES", "not adjacent")
                half = T(tr["duration"]) / 2
                if T(a["source_start"]) + T(a["duration"]) + half > T(media[a["media_id"]]["duration"]) or T(b["source_start"]) - half < 0:
                    E("E_HANDLES", tr["id"])
        for mk in tl["markers"]: ids.append(mk["id"])
    # sync: map timeline->source per clip and compare on overlap
    def src_at(c, x):
        ts = T(c["timeline_start"]); local = x - ts; tm = c.get("time_map")
        if not tm: return T(c["source_start"]) + local
        pts = [(T(p["at"]), T(p["source"]), p["interp"]) for p in tm]
        for (a0, s0, ip), (a1, s1, _) in zip(pts, pts[1:]):
            if a0 <= local <= a1:
                return s0 if ip == "hold" else s0 + (s1 - s0) * (local - a0) / (a1 - a0)
    for occ, cl in occ_clips.items():
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                a, b = cl[i][1], cl[j][1]
                lo = max(T(a["timeline_start"]), T(b["timeline_start"])); hi = min(T(a["timeline_start"]) + T(a["duration"]), T(b["timeline_start"]) + T(b["duration"]))
                if a.get("time_map") is None and b.get("time_map") is None:
                    if T(a["timeline_start"]) - T(a["source_start"]) != T(b["timeline_start"]) - T(b["source_start"]): E("W_SYNC", f"{a['id']} {b['id']}")
                elif lo < hi:
                    for k in range(5):
                        x = lo + (hi - lo) * k / 4
                        if src_at(a, x) != src_at(b, x): E("W_SYNC", f"{a['id']} {b['id']} @{x}"); break
    # transcripts
    occ_ids = set(occ_clips)
    for tr in d["transcripts"]:
        ids.append(tr["id"]); runs = {r["id"] for r in tr["raw_runs"]}; ids += list(runs)
        order = [t["id"] for t in tr["tokens"]]; ids += order; pos = {k: i for i, k in enumerate(order)}
        for t in tr["tokens"]:
            if t["align"]["run"] not in runs: E("E_REF", t["id"])
            if T(t["align"]["end"]) <= T(t["align"]["start"]): E("W_TOKEN_TIME", t["id"])
        for c in tr["cues"]:
            ids.append(c["id"])
            if c["first_token"] not in pos or c["last_token"] not in pos or pos[c["first_token"]] > pos[c["last_token"]]: E("E_TOKEN_RANGE", c["id"])
    cue_ids = {c["id"] for tr in d["transcripts"] for c in tr["cues"]}
    sty = {s["id"] for s in d["subtitle_styles"]}; ids += list(sty)
    for tl in d["timelines"]:
        for t in tl["tracks"]:
            if t["kind"] != "subtitle": continue
            if t["default_style_id"] not in sty: E("E_REF", t["default_style_id"])
            for o in t["overrides"]:
                if o["occurrence_id"] not in occ_ids or o["cue_id"] not in cue_ids: E("E_REF", str(o))
    seen = set()
    for i in ids:
        if i in seen: E("E_ID_DUP", i)
        seen.add(i)
    return d
for p in sys.argv[1:]:
    check(p)
    errs = [i for i in issues if i[0].startswith("E_")]; warns = [i for i in issues if i[0].startswith("W_")]
    print(f"{p.split('/')[-1]}: {len(errs)} errors, warnings: {sorted(set(w[0] for w in warns)) or 'none'}")
    for e in errs: print("   ", e)
