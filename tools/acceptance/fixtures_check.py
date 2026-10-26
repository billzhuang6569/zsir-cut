"""Independent acceptance for 0.8 fixtures. Usage: python3 -I accept08.py <repo_root>"""
import hashlib, json, math, os, subprocess, sys
from fractions import Fraction as F
ROOT = sys.argv[1]; M = os.path.join(ROOT, "fixtures/.media")
fails = []; notes = []
def ok(cond, msg):
    (notes if cond else fails).append(("ok  " if cond else "FAIL ") + msg)

def ffprobe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def frame_gray(path, n, w=960, h=540):
    # exact frame n by decode index
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"select=eq(n\\,{n}),format=gray", "-vsync", "0",
           "-frames:v", "1", "-f", "rawvideo", "-"]
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    assert len(data) == w * h, (path, n, len(data))
    return data

def read_strip(gray, w=960, h=540):
    bits = []
    for i in range(48):
        x = i * 20 + 10; y = h - 8
        bits.append(1 if gray[y * w + x] >= 128 else 0)
    val = lambda bs: int("".join(map(str, bs)), 2)
    aid, fno, chk = val(bits[0:16]), val(bits[16:40]), val(bits[40:48])
    b = bits[0:40]; s = sum(val(b[i:i + 8]) for i in range(0, 40, 8)) & 0xFF
    return aid, fno, chk == s

def mean_luma(gray, w=960, h=540):
    # sample a band away from overlays: rows 200..340, every 16 px
    tot = cnt = 0
    for y in range(200, 340, 8):
        for x in range(300, 660, 16):
            tot += gray[y * w + x]; cnt += 1
    return tot / cnt

def fingerprint(path):
    size = os.path.getsize(path); h = hashlib.sha256()
    with open(path, "rb") as f:
        if size <= 12 * 1024 * 1024:
            return hashlib.sha256(f.read()).hexdigest()
        h.update(f"{size}\n".encode())
        chunk = 4 * 1024 * 1024
        for off in (0, (size - chunk) // 2, size - chunk):
            f.seek(off); h.update(f.read(chunk))
    return h.hexdigest()

def pcm(path, ch, start, dur, sr=48000):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(dur), "-i", path, "-map", "0:a:0",
           "-af", f"pan=mono|c0=c{ch}", "-ar", str(sr), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw), 2)]

def goertzel(xs, f, sr=48000):
    k = 2 * math.cos(2 * math.pi * f / sr); s1 = s2 = 0.0
    for x in xs: s0 = x + k * s1 - s2; s2, s1 = s1, s0
    return s1 * s1 + s2 * s2 - k * s1 * s2

def pulse_onset(path, ch, t_from, t_to, sr=48000):
    """first 2 kHz onset in [t_from, t_to) using 2 ms windows; returns absolute seconds or None"""
    xs = pcm(path, ch, t_from, t_to - t_from); win = sr // 500
    base = None
    es = [goertzel(xs[i:i + win], 2000) for i in range(0, len(xs) - win, win)]
    base = max(es[0], 1)
    for j in range(len(es) - 5):
        if all(e > 1e9 and e > 100 * base for e in es[j:j + 5]):
            return t_from + j * win / sr
    return None

VID = {  # path, expected id, rate, frames
  "25/A_25.mov": (1, F(25), 3000), "25/B_25.mov": (2, F(25), 2250),
  "2997/A_2997.mov": (11, F(30000, 1001), math.ceil(120 * F(30000, 1001))),
  "2997/B_2997.mov": (12, F(30000, 1001), math.ceil(90 * F(30000, 1001))),
  "shared/图形_alpha.mov": (23, F(25), 125),
  "shared/素材 盘/100% 原片/批次1/同名素材.mov": (31, F(25), 250),
  "shared/素材 盘/100% 原片/批次2/同名素材.mov": (32, F(25), 250),
}
for rel, (aid, rate, nframes) in VID.items():
    p = os.path.join(M, rel)
    if not os.path.exists(p): ok(False, f"missing {rel}"); continue
    pr = ffprobe(p); v = [s for s in pr["streams"] if s["codec_type"] == "video"][0]
    ok(F(v["r_frame_rate"]) == rate, f"{rel} rate {v['r_frame_rate']}")
    ok(int(v.get("nb_frames", -1)) == nframes, f"{rel} frames {v.get('nb_frames')} want {nframes}")
    ok((v["width"], v["height"]) == (960, 540), f"{rel} size {v['width']}x{v['height']}")
    if aid == 23:
        ok("a" in v.get("pix_fmt", "") or "4444" in v.get("profile", ""), f"{rel} alpha pix_fmt={v.get('pix_fmt')} profile={v.get('profile')}")
        continue
    for n in (0, 1, nframes // 2, nframes - 1):
        a, f, c = read_strip(frame_gray(p, n))
        ok(a == aid and f == n and c, f"{rel} strip@{n} -> id {a} frame {f} chk {c}")

# white frames & pulses on A (both rates) for seconds 1,7,59,119
for rel, rate in (("25/A_25.mov", F(25)), ("2997/A_2997.mov", F(30000, 1001))):
    p = os.path.join(M, rel)
    for k in (1, 7, 59, 119):
        n = math.floor(k * rate)
        wl = mean_luma(frame_gray(p, n)); bl = mean_luma(frame_gray(p, n - 2))
        ok(wl > 200 and bl < 200, f"{rel} white frame {n} luma {wl:.0f} (neighbour {bl:.0f})")
        on = pulse_onset(p, 0, k - 0.1, k + 0.1)
        lo, hi = F(n) / rate, F(n + 1) / rate
        ok(on is not None and float(lo) - 0.002 <= on < float(hi), f"{rel} pulse k={k} onset {on} in [{float(lo):.4f},{float(hi):.4f})")

# EXT: pulse at A-time k  -> EXT time k+2
ext = os.path.join(M, "shared/外录音频.wav")
if os.path.exists(ext):
    for k in (1, 30, 100):
        on = pulse_onset(ext, 0, k + 2 - 0.1, k + 2 + 0.1)
        ok(on is not None and abs(on - (k + 2)) < 0.003, f"EXT pulse for A {k}s at {on}")
    ok(pulse_onset(ext, 0, 0.0, 1.9) is None, "EXT first 2 s silent of pulses")
else: ok(False, "missing EXT")

# token tone check on A_25: first token of sentence 3 and a high-index token
script = json.load(open(os.path.join(ROOT, "fixtures/synth/script.json"), encoding="utf-8"))
for idx in (0, 37, 152):
    t = script["tokens"][idx]; f0 = 600 + 40 * (idx % 20); st = t["start_ms"] / 1000
    xs = pcm(os.path.join(M, "25/A_25.mov"), 0, st, 0.04)
    e_on = goertzel(xs, f0); xs2 = pcm(os.path.join(M, "25/A_25.mov"), 0, max(0, st - 0.06), 0.04); e_off = goertzel(xs2, f0)
    ok(e_on > 50 * max(e_off, 1), f"token {idx} tone {f0} Hz at {st}s energy ratio {e_on / max(e_off, 1):.0f}")

# id tones on ch1
for rel, aid in (("25/A_25.mov", 1), ("25/B_25.mov", 2), ("2997/A_2997.mov", 11)):
    xs = pcm(os.path.join(M, rel), 1, 10.3, 0.2); f0 = 200 + 10 * aid
    ok(goertzel(xs, f0) > 20 * goertzel(xs, f0 + 50), f"{rel} id tone {f0} Hz")

# DUP same name different content
d1 = os.path.join(M, "shared/素材 盘/100% 原片/批次1/同名素材.mov"); d2 = d1.replace("批次1", "批次2")
if os.path.exists(d1) and os.path.exists(d2): ok(fingerprint(d1) != fingerprint(d2), "DUP fingerprints differ")

# VFR
vfr = os.path.join(M, "shared/手机录屏_vfr.mp4")
if os.path.exists(vfr):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
                          "-of", "csv=p=0", vfr], capture_output=True, text=True).stdout.replace(",", " ").split()
    ds = sorted({round(float(b) - float(a), 4) for a, b in zip(out, out[1:])})
    ok(len(ds) >= 2, f"VFR distinct frame durations {ds[:6]}")
    dur = float(ffprobe(vfr)["format"]["duration"]); ok(abs(dur - 30) < 0.2, f"VFR duration {dur}")

# timecodes
for rel, tc in (("25/A_25.mov", "10:00:00:00"), ("25/B_25.mov", "10:00:01:12"), ("2997/A_2997.mov", "10:00:00;00")):
    pr = ffprobe(os.path.join(M, rel)); tags = [s.get("tags", {}).get("timecode") for s in pr["streams"]]
    ok(tc in tags, f"{rel} timecode {tags}")

# fingerprints.json vs independent computation
fpj = os.path.join(M, "fingerprints.json")
if os.path.exists(fpj):
    data = json.load(open(fpj, encoding="utf-8")); items = data if isinstance(data, list) else data.get("files", data)
    if isinstance(items, dict): items = [{**v, "path": v.get("path", k)} for k, v in items.items()]
    bad = 0
    for it in items:
        p = it["path"]; p = p if os.path.isabs(p) else os.path.join(M, p)
        fp = it.get("fingerprint"); fp = fp.get("value") if isinstance(fp, dict) else fp
        if fingerprint(p) != fp or os.path.getsize(p) != it.get("size_bytes"): bad += 1; fails.append(f"FAIL fingerprint {it['path']}")
    ok(bad == 0, f"fingerprints.json {len(items)} entries match independent sha")

total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(M) for f in fs)
ok(total < 300 * 1024 * 1024, f"total size {total / 1048576:.1f} MiB")
print("\n".join(notes)); print("\n".join(fails)); print(f"\n{len(notes)} ok, {len(fails)} fail")
