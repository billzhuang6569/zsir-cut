"""Independent OTIO readback (official opentimelineio library) compared with the project cut list (handoff-profile 6.0).
tools/python/.venv/bin/python -I tools/acceptance/otio_readback.py <file.otio> <p.zcut.json>
Split retime clips (same clip_id) are merged: timeline in/out = outer bounds, source in = first piece start, source out = last piece end."""
import sys, os
from fractions import Fraction as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import opentimelineio as otio
from cutlist import load, project_rows, media_unit, rnd, fmt

def Q(rt):  # RationalTime -> exact seconds
    return F(rt.value).limit_denominator(10**9) / F(rt.rate).limit_denominator(10**6)

def otio_rows(path, d):
    tl = d["timelines"][0]; R = F(tl["edit_rate"]); media = {m["id"]: m for m in d["media"]}
    t = otio.adapters.read_from_file(path)
    pieces = {}; counters = {"Video": 0, "Audio": 0}
    for tr in t.tracks:
        counters[tr.kind] += 1; idx = counters[tr.kind]; kind = tr.kind.lower(); pos = F(0)
        for it in tr:
            if isinstance(it, otio.schema.Transition): continue
            dur = Q(it.source_range.duration) if it.source_range else Q(it.duration())
            if isinstance(it, otio.schema.Stack):  # export-otio-xmeml 2.2: reverse = compound with -1 warp around a forward clip
                inner = [c for tr2 in it for c in tr2 if isinstance(c, otio.schema.Clip)][0]
                z = inner.metadata.get("zsir", {}) or it.metadata.get("zsir", {}); mid = z["media_id"]
                ref = inner.media_reference; avail0 = Q(ref.available_range.start_time) if getattr(ref, "available_range", None) else F(0)
                lo = Q(inner.source_range.start_time) - avail0; scal = F(1)
                for e in it.effects:
                    if isinstance(e, otio.schema.LinearTimeWarp): scal = F(e.time_scalar).limit_denominator(1000)
                a, b = (lo + abs(scal) * dur, lo) if scal < 0 else (lo, lo + scal * dur)
                pieces.setdefault((kind, idx, z["clip_id"]), []).append((pos, pos + dur, a, b, mid))
            elif isinstance(it, otio.schema.Clip):
                z = it.metadata.get("zsir", {}); mid = z["media_id"]; m = media[mid]
                ref = it.media_reference; avail0 = Q(ref.available_range.start_time) if getattr(ref, "available_range", None) else F(0)
                s0 = Q(it.source_range.start_time) - avail0
                scalar = F(1)
                for e in it.effects:
                    if isinstance(e, otio.schema.FreezeFrame): scalar = F(0)
                    elif isinstance(e, otio.schema.LinearTimeWarp): scalar = F(e.time_scalar).limit_denominator(1000)
                # export-otio-xmeml 2.2: a reverse piece's start_time is its LOWEST source time
                a, b = (s0, s0 + scalar * dur) if scalar >= 0 else (s0 - scalar * dur, s0)
                pieces.setdefault((kind, idx, z["clip_id"]), []).append((pos, pos + dur, a, b, mid))
            pos += dur
    rows = []
    for (kind, idx, cid), ps in pieces.items():
        ps.sort(); mid = ps[0][4]; u = media_unit(media[mid])
        rows.append((kind, idx, cid, mid, rnd(ps[0][0] * R), rnd(ps[-1][1] * R), rnd(ps[0][2] * u), rnd(ps[-1][3] * u)))
    return sorted(rows, key=lambda r: (r[0], r[1], r[4]))

if __name__ == "__main__":
    d = load(sys.argv[2]); a = project_rows(d); b = otio_rows(sys.argv[1], d)
    ka = {(r[0], r[1], r[2]): r for r in a}; kb = {(r[0], r[1], r[2]): r for r in b}
    bad = [k for k in ka if k not in kb or ka[k] != kb[k]] + [k for k in kb if k not in ka]
    print(f"rows project {len(a)} otio {len(b)} | mismatched {len(bad)}")
    for k in bad[:10]: print("  project:", fmt(ka[k]) if k in ka else None); print("  otio:   ", fmt(kb[k]) if k in kb else None)
    sys.exit(1 if bad or len(a) != len(b) else 0)
