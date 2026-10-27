"""Independent cut lists (handoff-profile.md section 6.0) and an independent FCPXML reader (export-fcpxml.md).
python3 -I tools/acceptance/cutlist.py project <p.zcut.json>          -> cut list from the project
python3 -I tools/acceptance/cutlist.py fcpxml <file.fcpxml> <p.zcut.json> -> cut list read back from FCPXML
python3 -I tools/acceptance/cutlist.py compare <file.fcpxml> <p.zcut.json> -> zero-frame comparison
Rows: (kind, track_index, clip_id, media_id, tl_in, tl_out, src_in, src_out) in timeline frames / media frames (audio-only: 48 kHz samples)."""
import json, sys, xml.etree.ElementTree as ET
from fractions import Fraction as F

def T(s):
    s = s.strip()
    assert s.endswith("s"), s
    return F(s[:-1]) if "/" in s else F(s[:-1])

def load(p): return json.load(open(p, encoding="utf-8"))

def media_unit(m):
    if m.get("video") and m["kind"] == "video": return F(m["video"]["rate"])
    if m["kind"] == "audio": return F(48000)
    return F(25)  # images: convention

def project_rows(d):
    tl = d["timelines"][0]; R = F(tl["edit_rate"]); media = {m["id"]: m for m in d["media"]}
    rows = []; counters = {"video": 0, "audio": 0}
    for t in tl["tracks"]:
        if t["kind"] not in ("video", "audio"): continue
        counters[t["kind"]] += 1; idx = counters[t["kind"]]
        for c in t["clips"]:
            m = media[c["media_id"]]; u = media_unit(m)
            ts, du, ss = T(c["timeline_start"]), T(c["duration"]), T(c["source_start"])
            if c.get("time_map"):
                pts = [T(p["source"]) for p in c["time_map"]]; s_in, s_out = pts[0], pts[-1]
            else:
                s_in, s_out = ss, ss + du
            rows.append((t["kind"], idx, c["id"], c["media_id"], rnd(ts * R), rnd((ts + du) * R), rnd(s_in * u), rnd(s_out * u)))
    return sorted(rows, key=lambda r: (r[0], r[1], r[4]))

def rnd(x):
    import math
    return math.floor(x + F(1, 2))

def tc_seconds(tc, rate):
    if not tc: return F(0)
    hh, mm, ss, ff = int(tc[0:2]), int(tc[3:5]), int(tc[6:8]), int(tc[9:11]); df = tc[8] == ";"
    nominal = round(rate)
    frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff
    if df:
        drop = 2 if nominal == 30 else 4; total_min = hh * 60 + mm
        frames -= drop * (total_min - total_min // 10)
    return F(frames) / rate

def fcpxml_rows(path, d):
    tl = d["timelines"][0]; R = F(tl["edit_rate"]); media = {m["id"]: m for m in d["media"]}
    root = ET.parse(path).getroot()
    seq = root.find(".//sequence"); tc0 = T(seq.get("tcStart", "0s"))
    assets = {a.get("id"): a for a in root.iter("asset")}
    # map asset -> media_id by media-rep src basename match against project media paths
    import urllib.parse, os
    by_name = {}
    for m in d["media"]:
        by_name.setdefault(os.path.basename(m["path"]), []).append(m["id"])
    def md(el, key):
        meta = el.find("metadata")
        if meta is None: return None
        for x in meta.findall("md"):
            if x.get("key") == key: return x.get("value")
        return None
    rows = []
    # video track index from lane: spine -> V1, lane k>0 -> V(k+1); audio: paired -> A1, lane -k -> A k
    def emit(el, tl_in, dur, parent_kind_lane):
        kind, idx = parent_kind_lane
        if el.tag == "clip":  # retime wrapper
            inner = el.find("asset-clip"); src_el = inner
            tm = el.find("timeMap"); vals = [T(p.get("value")) for p in tm.findall("timept")]
            a = assets[inner.get("ref")]; base = T(inner.get("start", "0s")) - T(a.get("start", "0s"))
            s_in, s_out = base + vals[0], base + vals[-1]
            cid = md(el, "com.zsir-cut.clip-id"); mid = mid_of(inner)
            u = media_unit(media[mid])
            rows.append((kind, idx, cid, mid, rnd(tl_in * R), rnd((tl_in + dur) * R), rnd(s_in * u), rnd(s_out * u)))
            if kind == "video" and inner.get("srcEnable", "all") == "all":
                acid = md(el, "com.zsir-cut.audio-clip-id") or cid
                rows.append(("audio", 1, acid, mid, rnd(tl_in * R), rnd((tl_in + dur) * R), rnd(s_in * u), rnd(s_out * u)))
            return
        a = assets[el.get("ref")]; mid = mid_of(el); u = media_unit(media[mid])
        s_in = T(el.get("start", "0s")) - T(a.get("start", "0s"))
        cid = md(el, "com.zsir-cut.clip-id")
        en = el.get("srcEnable", "all")
        if en in ("all", "video") and kind == "video":
            rows.append(("video", idx, cid, mid, rnd(tl_in * R), rnd((tl_in + dur) * R), rnd(s_in * u), rnd((s_in + dur) * u)))
        if en == "all" and kind == "video":
            ast = el.get("audioStart"); adu = el.get("audioDuration")
            a_s = T(ast) - T(a.get("start", "0s")) if ast else s_in; a_d = T(adu) if adu else dur
            a_tl = tl_in + (a_s - s_in)
            rows.append(("audio", 1, md(el, "com.zsir-cut.audio-clip-id") or cid, mid, rnd(a_tl * R), rnd((a_tl + a_d) * R), rnd(a_s * u), rnd((a_s + a_d) * u)))
        if en == "audio" or kind == "audio":
            rows.append(("audio", idx, cid, mid, rnd(tl_in * R), rnd((tl_in + dur) * R), rnd(s_in * u), rnd((s_in + dur) * u)))
    def mid_of(el):
        a = assets[el.get("ref")]; rep = a.find("media-rep"); src = urllib.parse.unquote(rep.get("src"))
        cands = by_name.get(os.path.basename(src), [])
        if len(cands) == 1: return cands[0]
        for mid in cands:  # same-name files: match by full path suffix
            if src.endswith(media[mid]["path"].lstrip("./").split("..")[-1].lstrip("/")): return mid
        return cands[0] if cands else None
    for item in seq.find("spine"):
        if item.tag == "transition": continue
        off = T(item.get("offset")) - tc0; dur = T(item.get("duration")); start_local = T(item.get("start", "0s"))
        if item.tag in ("asset-clip", "clip"):
            emit(item, off, dur, ("video", 1))
        for ch in list(item):
            lane = ch.get("lane")
            if ch.tag not in ("asset-clip", "clip") or lane is None: continue
            lane = int(lane); c_off = off + (T(ch.get("offset")) - start_local); c_dur = T(ch.get("duration"))
            if lane > 0: emit(ch, c_off, c_dur, ("video", lane + 1))
            else: emit(ch, c_off, c_dur, ("audio", -lane))
    return sorted(rows, key=lambda r: (r[0], r[1], r[4]))

def fmt(r): return f"{r[0]:5} {r[0][0].upper()}{r[1]} {str(r[2]):42} {str(r[3]):10} tl {str(r[4]):>10}-{str(r[5]):<10} src {str(r[6]):>12}-{str(r[7]):<12}"

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "project":
        for r in project_rows(load(sys.argv[2])): print(fmt(r))
    elif mode == "fcpxml":
        for r in fcpxml_rows(sys.argv[2], load(sys.argv[3])): print(fmt(r))
    elif mode == "compare":
        d = load(sys.argv[3]); a = project_rows(d); b = fcpxml_rows(sys.argv[2], d)
        ka = {(r[0], r[1], r[2]): r for r in a}; kb = {(r[0], r[1], r[2]): r for r in b}
        bad = [k for k in ka if k not in kb or ka[k] != kb[k]] + [k for k in kb if k not in ka]
        print(f"rows project {len(a)} fcpxml {len(b)} | mismatched {len(bad)}")
        for k in bad[:10]: print("  project:", fmt(ka[k]) if k in ka else None); print("  fcpxml: ", fmt(kb[k]) if k in kb else None)
        sys.exit(1 if bad or len(a) != len(b) else 0)
