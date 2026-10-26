"""Independent implementation of docs/spec/subtitle-rules.md sections 2-6 (cue split and line breaks).
segment(tokens, profile, max_lines) -> list of cues: {"first": id, "last": id, "breaks": [id...]}
tokens: [{"id","text","start","end"}] with Fraction seconds, text non-empty, in order."""
from fractions import Fraction as F

PROFILES = {
    "zh-talk": dict(cpl=F(16), max_lines=2, cps=F(9), min_duration=F(1), max_duration=F(6), hard_pause=F(7, 10), soft_pause=F(3, 10), min_gap=F(8, 100), zh=True),
    "en-talk": dict(cpl=F(42), max_lines=2, cps=F(20), min_duration=F(1), max_duration=F(6), hard_pause=F(7, 10), soft_pause=F(3, 10), min_gap=F(8, 100), zh=False),
}
END = set("。！？.!?"); INNER = set("，、；：,;:")

def is_cjk(ch):
    o = ord(ch)
    return 0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF or 0x3000 <= o <= 0x303F
def char_w(ch, zh): return (F(1) if is_cjk(ch) else F(1, 2)) if zh else (F(2) if is_cjk(ch) else F(1))
def text_w(s, zh): return sum((char_w(c, zh) for c in s), F(0))
def needs_space(a, b, zh):
    if not zh: return True
    return bool(a) and bool(b) and a[-1].isascii() and a[-1].isalnum() and b[0].isascii() and b[0].isalnum()
def seq_w(toks, zh):
    w = F(0); prev = None
    for t in toks:
        if prev is not None and needs_space(prev, t["text"], zh): w += char_w(" ", zh)
        w += text_w(t["text"], zh); prev = t["text"]
    return w

def merge_punct(tokens):
    """punctuation-only tokens attach to the previous token"""
    out = []
    for t in tokens:
        if out and t["text"] and all(c in END | INNER for c in t["text"]):
            p = dict(out[-1]); p["text"] += t["text"]; p["end"] = t["end"]; p["ids"] = p["ids"] + [t["id"]]; out[-1] = p
        else:
            q = dict(t); q["ids"] = [t["id"]]; out.append(q)
    return out

def sentences(toks, P):
    out, cur = [], []
    for i, t in enumerate(toks):
        cur.append(t)
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if t["text"][-1] in END or (nxt and nxt["start"] - t["end"] >= P["hard_pause"]):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out

def split_sentence(sent, P, max_lines):
    zh = P["zh"]; cap = P["cpl"] * max_lines; cues = []; cur = []
    i = 0
    while i < len(sent):
        t = sent[i]
        cand = cur + [t]
        if cur and (seq_w(cand, zh) > cap or cand[-1]["end"] - cand[0]["start"] > P["max_duration"]):
            total = seq_w(cur, zh); best = None; best_pri = 9
            for k in range(1, len(cur) + 1):          # boundary after cur[k-1]
                if seq_w(cur[:k], zh) * 2 <= total: continue
                if k < len(cur):
                    pause = cur[k]["start"] - cur[k - 1]["end"]
                    pri = 1 if pause >= P["soft_pause"] else (2 if cur[k - 1]["text"][-1] in INNER else 3)
                else:
                    pri = 3
                if pri < best_pri or (pri == best_pri):   # latest wins on ties
                    if pri <= best_pri: best, best_pri = k, pri
            k = best if best is not None else len(cur)
            cues.append(cur[:k]); cur = cur[k:]
            continue
        cur = cand; i += 1
    if cur: cues.append(cur)
    return cues

def line_breaks(cue, P):
    zh = P["zh"]
    if seq_w(cue, zh) <= P["cpl"]: return []
    best = None
    for k in range(1, len(cue)):
        a, b = seq_w(cue[:k], zh), seq_w(cue[k:], zh)
        if a > P["cpl"] or b > P["cpl"]: continue
        key = (0 if cue[k - 1]["text"][-1] in INNER else 1, abs(a - b), k)
        if best is None or key < best[0]: best = (key, k)
    return [cue[best[1] - 1]["ids"][-1]] if best else []

def segment(tokens, profile="zh-talk", max_lines=None):
    P = dict(PROFILES[profile]); ml = min(P["max_lines"], max_lines or P["max_lines"])
    toks = merge_punct([t for t in tokens if t["text"]])
    out = []
    for s in sentences(toks, P):
        for cue in split_sentence(s, P, ml):
            out.append({"first": cue[0]["ids"][0], "last": cue[-1]["ids"][-1], "breaks": line_breaks(cue, P)})
    return out
