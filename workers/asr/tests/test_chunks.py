import json
import sys
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from zsir_asr import worker


def pcm(duration_ms, gaps=()):
    audio = np.ones(duration_ms * worker.SAMPLES_PER_MS, dtype=np.float32)
    for start, end in gaps:
        audio[start * worker.SAMPLES_PER_MS:end * worker.SAMPLES_PER_MS] = 0
    return audio


@pytest.mark.parametrize("case", json.loads((Path(__file__).resolve().parents[3] / "fixtures/regressions/asr-repetition.json").read_text()))
def test_repetition_is_removed_before_zero_width_statistics(chunk_request, monkeypatch, case):
    args, _ = chunk_request
    args.duration = "1"
    monkeypatch.setattr(worker, "decode", lambda *_: pcm(1000))
    count = case["count"]
    items = [SimpleNamespace(text="正常", start_time="0.05", end_time="0.1")]
    for index in range(count):
        start = Decimal("0.2") + Decimal(index) / 100
        items.append(SimpleNamespace(text=case["word"], start_time=start,
            end_time=start if case["zero_width"] else start + Decimal("0.005")))
    items.append(SimpleNamespace(text="继续", start_time="0.8", end_time="0.9"))

    class Fake:
        def transcribe(self, *_):
            return "正常" + case["word"] * count + "继续", "zh"

        def align(self, *_):
            return items

    output = worker.result(args, local=Fake())
    expected = ["正常", "继续"] if count > 8 else ["正常"] + [case["word"]] * count + ["继续"]
    assert [token["text"] for token in output["tokens"]] == expected
    assert output["tokens"][0] == {"text": "正常", "start_ms": 7300, "end_ms": 7350, "conf": None}
    assert output["tokens"][-1] == {"text": "继续", "start_ms": 8050, "end_ms": 8150, "conf": None}
    assert output["warnings"] == ([{
        "code": "W_ASR_REPETITION", "start_ms": 7450,
        "end_ms": 7250 + worker.seconds_to_ms(items[-2].end_time), "count": count,
    }] if count > 8 else [])
    assert worker.result(args, local=object())["warnings"] == output["warnings"]


def test_repetition_is_scoped_to_each_chunk(chunk_request):
    args, _ = chunk_request

    class Fake:
        def transcribe(self, *_):
            return "same " * 8, "en"

        def align(self, *_):
            return [SimpleNamespace(text="same", start_time=Decimal(i) / 10,
                end_time=Decimal(i) / 10 + Decimal("0.05")) for i in range(8)]

    output = worker.result(args, local=Fake())
    assert [t["text"] for t in output["tokens"]] == ["same"] * 24
    assert output["warnings"] == []


def test_multiple_repetition_runs_and_empty_result():
    tokens = [{"text": word, "start_ms": i, "end_ms": i + 1}
        for i, word in enumerate(["哎"] * 20 + ["hello"] * 9)]
    assert worker.remove_repetitions(tokens) == [
        {"code": "W_ASR_REPETITION", "start_ms": 0, "end_ms": 20, "count": 20},
        {"code": "W_ASR_REPETITION", "start_ms": 20, "end_ms": 29, "count": 9},
    ]
    assert tokens == []
    assert worker.finalize_tokens(tokens, 0, 29) == []


def test_chunk_cuts_use_lowest_energy_and_earliest_frame():
    audio = pcm(125000, [(45120, 45150), (95130, 95160)])
    original = audio.copy()
    assert worker.chunk_ranges(audio) == [
        (0, 45120 * 16), (45120 * 16, 95130 * 16), (95130 * 16, len(audio)),
    ]
    np.testing.assert_array_equal(audio, original)
    assert worker.chunk_ranges(pcm(100000)) == [(0, 40000 * 16), (40000 * 16, 80000 * 16), (80000 * 16, 100000 * 16)]


def test_chunk_energy_uses_the_whole_frame_without_integer_overflow():
    audio = np.full(61000 * 16, 30000, dtype=np.int16)
    audio[45000 * 16:45010 * 16] = 100
    audio[44000 * 16] = 0
    assert worker.chunk_ranges(audio)[0] == (0, 45000 * 16)


@pytest.mark.parametrize("duration_ms", [1, 40000, 59999])
def test_short_audio_is_not_split(duration_ms):
    assert worker.chunk_ranges(pcm(duration_ms)) == [(0, duration_ms * 16)]


def test_exactly_sixty_seconds_still_searches_for_a_cut():
    assert worker.chunk_ranges(pcm(60000)) == [(0, 40000 * 16), (40000 * 16, 60000 * 16)]


@pytest.mark.parametrize(("text", "counts", "expected"), [
    ("abcdefghijk", [1, 2, 1], ["ab", "cdefgh", "ijk"]),
    ("甲乙丙，丁戊己。庚辛壬", [1, 1, 1], ["甲乙丙，", "丁戊己。", "庚辛壬"]),
    ("one two three", [1, 1], ["one two ", "three"]),
    ("甲乙、丙丁", [3, 2], ["甲乙、", "丙丁"]),
    ("甲乙」丙丁", [2, 3], ["甲乙」", "丙丁"]),
    ("x" * 21 + ",tail", [1, 21], ["x", "x" * 20 + ",tail"]),
    ("a" + "b" * 9 + ",tail", [1, 14], ["a" + "b" * 9 + ",", "tail"]),
    ("a" + "b" * 10 + ",tail", [1, 15], ["a", "b" * 10 + ",tail"]),
    ("a,b", [0, 1, 0, 1], ["", "a,", "", "b"]),
    ("a,b", [1, 1, 1], ["a,", "", "b"]),
])
def test_align_text_proportions_and_forward_separator_limit(text, counts, expected):
    parts = worker.split_text(text, counts)
    assert parts == expected
    assert "".join(parts) == text


@pytest.fixture
def chunk_request(monkeypatch, tmp_path):
    source = tmp_path / "clip.wav"
    source.write_bytes(b"synthetic PCM supplied by decoder stub")
    audio = pcm(125000, [(45120, 45150), (95130, 95160)])
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 132250))
    monkeypatch.setattr(worker, "decode", lambda *_: audio)
    monkeypatch.setattr(worker, "weight_digest", lambda _: "sha256:fake")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))
    args = worker.parser().parse_args([
        "transcribe", "--input", str(source), "--channels", "0", "--language", "en",
        "--start", "7.25", "--duration", "125", "--out", str(tmp_path / "out.json"),
    ])
    return args, audio


def test_transcribe_chunks_offsets_hotwords_and_no_lost_or_duplicated_words(chunk_request, tmp_path):
    args, audio = chunk_request
    hotwords = tmp_path / "hotwords.txt"
    hotwords.write_text("zsir-cut\nBill\n")
    args.hotwords = str(hotwords)
    calls = []

    class Fake:
        def transcribe(self, chunk, language, model, words):
            assert words == ["zsir-cut", "Bill"]
            assert (language, model) == ("en", "1.7b")
            calls.append(("transcribe", len(chunk)))
            return "same same", "en"

        def align(self, chunk, text, language):
            assert (text, language) == ("same same", "en")
            calls.append(("align", len(chunk)))
            duration = Decimal(len(chunk)) / 16000
            return [
                SimpleNamespace(text="same", start_time="0", end_time="0.1"),
                SimpleNamespace(text="same", start_time=duration - Decimal("0.1"), end_time=duration),
            ]

    output = worker.result(args, local=Fake())
    lengths = [b - a for a, b in worker.chunk_ranges(audio)]
    assert calls == [(verb, size) for size in lengths for verb in ("transcribe", "align")]
    assert [(t["start_ms"], t["end_ms"]) for t in output["tokens"]] == [
        (7250, 7350), (52270, 52370), (52370, 52470),
        (102280, 102380), (102380, 102480), (132150, 132250),
    ]
    assert [t["text"] for t in output["tokens"]] == ["same"] * 6
    assert output["warnings"] == []
    assert worker.result(args, local=object())["tokens"] == output["tokens"]


@pytest.mark.parametrize("recognized", [["a", "bbb", "cc"], ["", "", ""]])
def test_align_recognizes_counts_then_aligns_assigned_text(chunk_request, tmp_path, recognized):
    args, audio = chunk_request
    args.command = "align"
    text = "甲乙丙，丁戊己。庚辛壬。癸子丑。"
    text_path = tmp_path / "text.txt"
    text_path.write_text(text)
    args.text = str(text_path)
    calls = []
    aligned = []

    class Fake:
        def transcribe(self, chunk, language, model, words):
            assert (language, model, words) == ("en", "1.7b", None)
            calls.append(len(chunk))
            return recognized[len(calls) - 1], "en"

        def align(self, chunk, part, language):
            aligned.append(part)
            return [SimpleNamespace(text=part, start_time="0", end_time="0.1")]

    output = worker.result(args, local=Fake())
    lengths = [b - a for a, b in worker.chunk_ranges(audio)]
    counts = [len(part) for part in recognized]
    parts = worker.split_text(text, counts if sum(counts) else lengths)
    assert calls == lengths
    assert aligned == [part for part in parts if part.strip()]
    assert "".join(t["text"] for t in output["tokens"]) == text
    offsets = [7250 + a // 16 for a, _ in worker.chunk_ranges(audio)]
    assert [t["start_ms"] for t in output["tokens"]] == [offset for offset, part in zip(offsets, parts) if part.strip()]
    assert output["asr"]["weights_digest"] == "sha256:fake"
    assert worker.result(args, local=object())["tokens"] == output["tokens"]
    # Human edits to the supplied transcript must not hit the old align cache.
    text_path.write_text("changed transcript")
    calls.clear()
    aligned.clear()
    changed = worker.result(args, local=Fake())
    assert calls == lengths
    assert "".join(aligned) == "changed transcript"
    assert changed["tokens"] != output["tokens"]


@pytest.mark.parametrize(("zero_count", "total"), [(0, 0), (0, 20), (1, 20), (1, 19), (2, 20)])
def test_degraded_threshold_counts_before_zero_width_repair(zero_count, total):
    tokens = [
        {"text": str(i), "start_ms": i * 100, "end_ms": i * 100 + (0 if i < zero_count else 50), "conf": None}
        for i in range(total)
    ]
    warnings = worker.finalize_tokens(tokens, 0, 2000)
    degraded = [w for w in warnings if w["code"] == "W_ASR_ALIGN_DEGRADED"]
    assert degraded == ([{"code": "W_ASR_ALIGN_DEGRADED", "ratio": zero_count / total}] if zero_count * 20 > total else [])
    assert all(t["end_ms"] > t["start_ms"] for t in tokens)
    if zero_count:
        assert {"code": "W_ASR_ZERO_WIDTH", "count": zero_count} in warnings


def test_merged_tokens_are_sorted_clamped_and_nonoverlapping():
    tokens = [
        {"text": "last", "start_ms": 180, "end_ms": 300, "conf": None},
        {"text": "first", "start_ms": -10, "end_ms": 100, "conf": None},
        {"text": "middle", "start_ms": 80, "end_ms": 200, "conf": None},
    ]
    worker.finalize_tokens(tokens, 0, 250)
    assert [(t["text"], t["start_ms"], t["end_ms"]) for t in tokens] == [
        ("first", 0, 100), ("middle", 100, 200), ("last", 200, 250),
    ]


@pytest.mark.parametrize("zero_count", [6, 7])
def test_five_minute_transcribe_uses_global_degradation_ratio(chunk_request, monkeypatch, zero_count):
    args, _ = chunk_request
    args.start, args.duration = "0", "300"
    audio = pcm(300000, [(cut, cut + 20) for cut in range(50000, 300000, 50000)])
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 300000))
    monkeypatch.setattr(worker, "decode", lambda *_: audio)
    aligned = 0

    class Fake:
        def transcribe(self, *_):
            return "words", "en"

        def align(self, *_):
            nonlocal aligned
            aligned += 1
            return [
                SimpleNamespace(
                    text=f"{aligned}-{i}", start_time=Decimal(i) / 10,
                    end_time=Decimal(i) / 10 + (0 if aligned == 1 and i < zero_count else Decimal("0.05")),
                ) for i in range(20)
            ]

    output = worker.result(args, local=Fake())
    assert aligned == 6
    assert len(output["tokens"]) == 120
    degraded = [w for w in output["warnings"] if w["code"] == "W_ASR_ALIGN_DEGRADED"]
    assert degraded == ([{"code": "W_ASR_ALIGN_DEGRADED", "ratio": zero_count / 120}] if zero_count == 7 else [])
    assert {"code": "W_ASR_ZERO_WIDTH", "count": zero_count} in output["warnings"]
    assert all(a["end_ms"] <= b["start_ms"] for a, b in zip(output["tokens"], output["tokens"][1:]))
    assert worker.result(args, local=object())["warnings"] == output["warnings"]


@pytest.mark.parametrize("stage", ["transcribe", "align"])
def test_chunk_failure_does_not_cache_partial_results(chunk_request, monkeypatch, tmp_path, stage):
    args, _ = chunk_request
    monkeypatch.setattr(worker, "cloud_fallback_enabled", lambda: False)
    calls = {"transcribe": 0, "align": 0}

    def check(name):
        calls[name] += 1
        if stage == name and calls[name] == 2:
            raise worker.WorkerError("E_ASR_OOM", "fake failure", True)

    class Fake:
        def transcribe(self, *_):
            check("transcribe")
            return "word", "en"

        def align(self, *_):
            check("align")
            return [SimpleNamespace(text="word", start_time="0", end_time="0.1")]

    with pytest.raises(worker.WorkerError) as error:
        worker.result(args, local=Fake())
    assert error.value.code == "E_ASR_OOM"
    assert not list((tmp_path / "cache").glob("*.json"))


def test_worker_version_invalidates_cache(monkeypatch):
    args = ("input", [0], 0, 1000, "zh", "local", "asr", "align", None)
    new_key = worker.cache_key(*args)
    monkeypatch.setattr(worker, "__version__", "0.2.2")
    assert worker.cache_key(*args) != new_key


def test_local_models_are_reused_between_chunks(monkeypatch, tmp_path):
    name = worker.ASR_NAMES["1.7b"]
    (tmp_path / name).mkdir()
    monkeypatch.setattr(worker, "MODELS", tmp_path)
    loaded = []

    def load(path):
        loaded.append(path)
        return object()

    stt = SimpleNamespace(load=load)
    monkeypatch.setitem(sys.modules, "mlx_audio", SimpleNamespace(stt=stt))
    monkeypatch.setitem(sys.modules, "mlx_audio.stt", stt)
    engine = worker.LocalEngine()
    assert engine.load(name) is engine.load(name)
    assert loaded == [tmp_path / name]
