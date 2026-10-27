"""Independent check of a reference preview: decode every frame's bottom barcode and compare the source frame
with the frame the project says should show (timeline-schema 4.5: forward/hold floor(s*r), reverse ceil(s*r)-1).
python3 -I tools/acceptance/preview_check.py <preview.mov> <p.zcut.json>
Frames inside transitions and on smooth retime segments are skipped (preview does not blend; smooth is approximate)."""
import json, math, subprocess, sys
from fractions import Fraction as F
def T(s): return F(s[:-1] if s.endswith("s") else s)
def read_bits(gray, w, h):
    sc = F(w, 960); y = h - int(8 * sc); bits = []
    for i in range(48):
        x = int((i * 20 + 10) * sc); bits.append(1 if gray[y * w + x] > 128 else 0)
    num = lambda a, b: int("".join(map(str, bits[a:b])), 2)
    mid, frame, chk = num(0, 16), num(16, 40), num(40, 48)
    s = sum(int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, 40, 8)) & 0xFF
    return mid, frame, chk == s
def expected(d, tframe):
    tl = d["timelines"][0]; R = F(tl["edit_rate"]); media = {m["id"]: m for m in d["media"]}
    t = F(tframe) / R; best = None
    for tr in tl["tracks"]:
        if tr["kind"] != "video": continue
        for c in tr["clips"]:
            if c.get("enabled") is False: continue
            ts, du = T(c["timeline_start"]), T(c["duration"])
            if not (ts <= t < ts + du): continue
            m = media[c["media_id"]]
            if m["kind"] == "image": best = (c["id"], 0, None); continue
            r = F(m["video"]["rate"]); at = t - ts; tm = c.get("time_map")
            if not tm:
                best = (c["id"], math.floor((T(c["source_start"]) + at) * r), "fwd"); continue
            for a, b in zip(tm, tm[1:]):
                a0, a1 = T(a["at"]), T(b["at"])
                if a0 <= at < a1:
                    if a["interp"] == "smooth": best = (c["id"], None, "smooth"); break
                    if a["interp"] == "hold": s = T(a["source"]); best = (c["id"], math.floor(s * r), "hold"); break
                    s0, s1 = T(a["source"]), T(b["source"]); s = s0 + (s1 - s0) * (at - a0) / (a1 - a0)
                    best = (c["id"], (math.ceil(s * r) - 1) if s1 < s0 else math.floor(s * r), "rev" if s1 < s0 else "fwd"); break
    return best
def in_transition(d, tframe):
    tl = d["timelines"][0]; R = F(tl["edit_rate"]); t = F(tframe) / R
    for tr in tl["tracks"]:
        for x in tr.get("transitions", []) or []:
            a = T(x.get("at") or x.get("timeline_start", "0s")); du = T(x["duration"])
            if a - du <= t <= a + du: return True
    return False
if __name__ == "__main__":
    mov, proj = sys.argv[1], sys.argv[2]; d = json.load(open(proj, encoding="utf-8"))
    pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", mov], capture_output=True, text=True, check=True).stdout)["streams"][0]
    w, h = pr["width"], pr["height"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mov, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (w * h); bad = []; checked = skipped = 0; kinds = {}
    for k in range(n):
        e = expected(d, k)
        if e is None or e[1] is None or in_transition(d, k): skipped += 1; continue
        mid, fr, ok = read_bits(raw[k * w * h:(k + 1) * w * h], w, h)
        checked += 1; kinds[e[2]] = kinds.get(e[2], 0) + 1
        if not ok or fr != e[1]: bad.append((k, e, fr, ok))
    print(f"frames {n} checked {checked} skipped {skipped} by kind {kinds} | mismatched {len(bad)}")
    for b in bad[:15]: print("  tl frame", b[0], "expected", b[1], "got", b[2], "checksum ok" if b[3] else "checksum BAD")
    sys.exit(1 if bad else 0)
