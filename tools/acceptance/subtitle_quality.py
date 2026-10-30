"""Score subtitle segmentation quality against docs/tasks/subtitle-2.md. Usage: python3 -I tools/acceptance/subtitle_quality.py <project.zcut.json> [--sample 50]"""
import json, random, sys
from fractions import Fraction

NO_END = set("的 地 得 和 与 跟 及 或 在 是 把 被 给 对 向 从 往 让 将 很 最 更 太 都 也 还 就 又 才 再 而 并 这 那 这个 那个 这些 那些 一个 一些 一种 一位 每 各 第".split())
NO_START = set("的 地 得 了 着 过 吗 呢 吧 啊 呀 嘛 啦 们 上 下 里 中 后 前 时 似的 一样".split())
FILLERS = {"呃", "嗯", "额", "哎"}
NUM = set("0123456789零一二三四五六七八九十百千万亿两几半")
UNIT = set("个位家条年月日天号点分秒岁元块万亿倍次小时%")
PUNCT = "，。！？、；：,.!?;:“”\"'（）()…—"

def sec(s):
    return Fraction(s[:-1]) if s.endswith("s") else Fraction(s)

def width(text):
    return sum(1 if ord(ch) > 0x2E7F else Fraction(1, 2) for ch in text.strip(PUNCT))

def clean(t):
    return t.strip(PUNCT)

def main():
    args = sys.argv[1:]
    path = args[0]
    sample = int(args[args.index("--sample") + 1]) if "--sample" in args else 50
    project = json.load(open(path))
    terms = [t for t in project.get("recognition", {}).get("terms", [])]
    rows, issues = [], {k: [] for k in ["too_wide", "too_long", "bad_end", "bad_start", "split_term", "split_number", "filler", "stutter", "short"]}
    for tr in project["transcripts"]:
        terms_t = terms + tr.get("recognition", {}).get("terms", [])
        remove_fillers = (tr.get("recognition") or project.get("recognition") or {}).get("remove_fillers", False)
        tokens = tr["tokens"]
        index = {t["id"]: i for i, t in enumerate(tokens)}
        cues = sorted(tr["cues"], key=lambda c: index[c["first_token"]])
        prev_last = None
        for c in cues:
            a, b = index[c["first_token"]], index[c["last_token"]]
            vis = [t for t in tokens[a : b + 1] if t["text"]]
            if not vis:
                continue
            text = "".join(t["text"] for t in vis)
            breaks = [index[x] for x in c.get("breaks", [])]
            lines, cur = [], ""
            for i in range(a, b + 1):
                cur += tokens[i]["text"]
                if i in breaks:
                    lines.append(cur); cur = ""
            lines.append(cur)
            dur = sec(vis[-1]["align"]["end"]) - sec(vis[0]["align"]["start"])
            row = {"cue": c["id"], "text": " / ".join(lines), "dur": float(dur), "state": c.get("state")}
            rows.append(row)
            if any(width(l) > 16 for l in lines): issues["too_wide"].append(row)
            if dur > 6: issues["too_long"].append(row)
            if clean(vis[-1]["text"]) in NO_END: issues["bad_end"].append(row)
            if clean(vis[0]["text"]) in NO_START: issues["bad_start"].append(row)
            if width(text) < 3: issues["short"].append(row)
            if prev_last is not None:
                left, right = clean(prev_last["text"]), clean(vis[0]["text"])
                if left and right and left[-1] in NUM and (right[0] in NUM or right[0] in UNIT):
                    issues["split_number"].append(row)
                joint = left[-6:] + right[:6]
                for term in terms_t:
                    pos = joint.find(term)
                    if pos != -1 and pos < len(left[-6:]) < pos + len(term):
                        issues["split_term"].append(row)
            for i, t in enumerate(vis):
                if remove_fillers and clean(t["text"]) in FILLERS:
                    issues["filler"].append(row)
                if remove_fillers and i and len(clean(t["text"])) >= 2 and clean(t["text"]) == clean(vis[i - 1]["text"]):
                    issues["stutter"].append(row)
            prev_last = vis[-1]
    n = len(rows) or 1
    limits = {"too_wide": 0, "too_long": 0, "bad_end": 0.02, "bad_start": 0.02, "split_term": 0, "split_number": 0, "filler": 0, "stutter": 0, "short": 0.05}
    ok = True
    print(f"{path}\ncues {len(rows)}")
    for k, lim in limits.items():
        cnt = len(issues[k])
        passed = cnt <= (lim * n if lim < 1 else lim)
        ok &= passed
        print(f"  {k:13} {cnt:4}  {cnt / n:6.1%}  limit {lim if lim >= 1 or lim == 0 else f'{lim:.0%}'}  {'ok' if passed else 'FAIL'}")
        for r in issues[k][:5]:
            print(f"      {r['text']}")
    print("RESULT", "PASS" if ok else "FAIL")
    random.seed(20261030)
    print(f"\nsample {min(sample, len(rows))} for manual read:")
    for r in sorted(random.sample(rows, min(sample, len(rows))), key=lambda r: rows.index(r)):
        print(f"  {r['text']}   ({r['dur']:.1f}s)")

main()
