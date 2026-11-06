"""按 command-protocol 9.1 的 chapters 视图独立算章节树，和 core 的结果比。

用法：python3 -I tools/acceptance/chapters_check.py <工程> <inspect chapters 的结果信封 JSON>
不复用产品代码。时间用 Fraction。
"""
import json, sys
from fractions import Fraction as F

def T(s): return F(s[:-1])

def expected(project, timeline_id=None):
    tl = next(t for t in project["timelines"] if timeline_id in (None, t["id"]))
    total = F(0)
    for tr in tl["tracks"]:
        if tr["kind"] in ("video", "audio"):
            for c in tr["clips"]:
                total = max(total, T(c["timeline_start"]) + T(c["duration"]))
    ms = sorted((m for m in tl.get("markers", []) if m["kind"] == "chapter"), key=lambda m: (T(m["at"]), m["id"]))
    groups = []
    for m in ms:
        lv = m.get("level", 1)
        if lv == 1:
            groups.append({"m": m, "secs": []})
        else:
            if not groups:
                groups.append({"m": None, "secs": []})
            groups[-1]["secs"].append(m)
    out = []
    orphan = bool(groups) and groups[0]["m"] is None
    for gi, g in enumerate(groups):
        start = T(g["m"]["at"]) if g["m"] else T(g["secs"][0]["at"])
        end = T(groups[gi + 1]["m"]["at"]) if gi + 1 < len(groups) else total
        hue = gi if orphan else gi
        secs = []
        for si, s in enumerate(g["secs"]):
            ss = T(s["at"])
            se = T(g["secs"][si + 1]["at"]) if si + 1 < len(g["secs"]) else end
            se = min(se, end)
            secs.append(dict(id=s["id"], level=2, start=ss, end=se, duration=se - ss, title=s["text"],
                             description=s.get("description"), user_edited=bool(s.get("ext", {}).get("zsir.user_edited")), hue=hue))
        out.append(dict(id=g["m"]["id"] if g["m"] else None, level=1, start=start, end=end, duration=end - start,
                        title=g["m"]["text"] if g["m"] else None,
                        description=g["m"].get("description") if g["m"] else None,
                        user_edited=bool(g["m"].get("ext", {}).get("zsir.user_edited")) if g["m"] else False,
                        hue=hue, sections=secs))
    return out, total

def norm(item):
    r = {}
    for k, v in item.items():
        if isinstance(v, dict) and "t" in v: v = T(v["t"])
        if k == "sections": v = [norm(x) for x in v]
        r[k] = v
    return r

def main():
    project = json.load(open(sys.argv[1], encoding="utf-8"))
    env = json.load(open(sys.argv[2], encoding="utf-8"))
    res = env.get("result", env)
    exp, total = expected(project, res.get("timeline_id"))
    got = [norm(x) for x in res["chapters"]]
    bad = 0
    if T(res["total"]["t"]) != total:
        print("total", res["total"], "want", total); bad += 1
    if len(got) != len(exp):
        print("一级个数", len(got), "want", len(exp)); bad += 1
    for e, g in zip(exp, got):
        for k in ("id", "level", "start", "end", "duration", "title", "description", "user_edited", "hue"):
            if e[k] != g.get(k): print(e["id"], k, g.get(k), "want", e[k]); bad += 1
        if len(e["sections"]) != len(g.get("sections", [])):
            print(e["id"], "二级个数", len(g.get("sections", [])), "want", len(e["sections"])); bad += 1
        for es, gs in zip(e["sections"], g.get("sections", [])):
            for k in ("id", "start", "end", "duration", "title", "description", "user_edited", "hue"):
                if es[k] != gs.get(k): print(es["id"], k, gs.get(k), "want", es[k]); bad += 1
    print("OK" if not bad else f"{bad} 处不一致", f"（一级 {len(exp)}，二级 {sum(len(e['sections']) for e in exp)}）")
    sys.exit(1 if bad else 0)

main()
