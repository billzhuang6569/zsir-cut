"""Independent FCP7 XML (xmeml v5) readback, export-otio-xmeml section 3, compared with the project cut list.
python3 -I tools/acceptance/xmeml_readback.py <file.xml> <p.zcut.json>
clipitem timing uses the sequence rate; in/out are sequence-rate frames from the media's first frame.
Split pieces (id suffix -sN) are merged: timeline outer bounds, source in of first piece, source out of last piece.
Rows whose loss report entry is R_GRID_ROUNDED may differ by at most one frame (pass the loss report as 3rd arg)."""
import json, sys, os, re, xml.etree.ElementTree as ET
from fractions import Fraction as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cutlist import load, project_rows, media_unit, rnd, fmt

def rate_of(el):
    tb = int(el.findtext("rate/timebase")); ntsc = el.findtext("rate/ntsc") == "TRUE"
    return F(tb * 1000, 1001) if ntsc else F(tb)

def xmeml_rows(path, d):
    media = {m["id"]: m for m in d["media"]}
    root = ET.parse(path).getroot(); seq = root.find("sequence"); R = rate_of(seq)
    files = {}
    for f in root.iter("file"):
        if f.find("pathurl") is not None: files[f.get("id")] = f
    pieces = {}
    for kind in ("video", "audio"):
        for idx, tr in enumerate(seq.find("media").find(kind).findall("track"), 1):
            for ci in tr.findall("clipitem"):
                cr = rate_of(ci); assert cr == R, f"clipitem {ci.get('id')} rate {cr} != sequence {R}"
                st, en = int(ci.findtext("start")), int(ci.findtext("end")); i, o = int(ci.findtext("in")), int(ci.findtext("out"))
                speed, rev, freeze = F(1), False, False
                for flt in ci.findall("filter"):
                    eff = flt.find("effect")
                    if eff is None or eff.findtext("effectid") != "timeremap": continue
                    for p in eff.findall("parameter"):
                        pid, val = p.findtext("parameterid"), p.findtext("value")
                        if pid == "speed": speed = F(val) / 100
                        elif pid == "reverse": rev = val == "TRUE"
                        elif pid == "freeze": freeze = val == "TRUE"
                s_in, s_out = F(i), F(o)
                if freeze: s_out = s_in
                if rev: s_in, s_out = s_out, s_in
                cid = re.sub(r"-s\d+$", "", ci.get("id")); mid = ci.find("file").get("id")
                pieces.setdefault((kind, idx, cid), []).append((st, en, s_in, s_out, mid))
    rows = []
    for (kind, idx, cid), ps in pieces.items():
        ps.sort(); mid = ps[0][4]; u = media_unit(media[mid])
        rows.append((kind, idx, cid, mid, ps[0][0], ps[-1][1], rnd(ps[0][2] / R * u), rnd(ps[-1][3] / R * u)))
    return sorted(rows, key=lambda r: (r[0], r[1], r[4]))

if __name__ == "__main__":
    d = load(sys.argv[2]); a = project_rows(d); b = xmeml_rows(sys.argv[1], d)
    rounded = set()
    if len(sys.argv) > 3:
        lr = json.load(open(sys.argv[3], encoding="utf-8")); items = lr.get("items", lr) if isinstance(lr, dict) else lr
        rounded = {x["entity_id"] for x in items if x.get("reason_code") == "R_GRID_ROUNDED"}
    ka = {(r[0], r[1], r[2]): r for r in a}; kb = {(r[0], r[1], r[2]): r for r in b}
    R = F(d["timelines"][0]["edit_rate"]); media = {m["id"]: m for m in d["media"]}
    def close(x, y, cid):
        if x == y: return True
        if cid not in rounded: return False
        # R_GRID_ROUNDED: source points may move by at most half a sequence frame (+1 unit for integer rounding)
        src_tol = media_unit(media[x[3]]) / (2 * R) + 1
        return x[:6] == y[:6] and all(abs(x[i] - y[i]) <= src_tol for i in (6, 7))
    bad = [k for k in ka if k not in kb or not close(ka[k], kb[k], k[2])] + [k for k in kb if k not in ka]
    print(f"rows project {len(a)} xmeml {len(b)} | mismatched {len(bad)} | grid-rounded {len(rounded)}")
    for k in bad[:10]: print("  project:", fmt(ka[k]) if k in ka else None); print("  xmeml:  ", fmt(kb[k]) if k in kb else None)
    sys.exit(1 if bad or len(a) != len(b) else 0)
