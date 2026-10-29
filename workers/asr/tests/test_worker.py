import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from zsir_asr import worker


def test_parser_and_milliseconds():
    args = worker.parser().parse_args(["transcribe", "--input", "clip.wav", "--channels", "0", "--language", "zh", "--out", "result.json"])
    assert args.engine == "local"
    assert args.model == "1.7b"
    assert worker.milliseconds("1.125") == 1125
    assert worker.seconds_to_ms("1.125") == 1125
    with pytest.raises(worker.WorkerError, match="millisecond"):
        worker.milliseconds("1.0001")


def test_cache_key_is_stable_and_parameter_sensitive():
    args = ("input", [0], 0, 1000, "zh", "local", "asr", "align", None)
    assert worker.cache_key(*args) == worker.cache_key(*args)
    changed = list(args)
    changed[1] = [1]
    assert worker.cache_key(*args) != worker.cache_key(*changed)
    changed = list(args)
    changed[8] = "sha256:changed-terms"
    assert worker.cache_key(*args) != worker.cache_key(*changed)


def test_jieba_group_and_punctuation():
    items = [{"text": char, "start_ms": index * 80, "end_ms": (index + 1) * 80, "conf": None} for index, char in enumerate("我们。你好")]
    assert worker.group_chinese(items) == [
        {"text": "我们。", "start_ms": 0, "end_ms": 240, "conf": None},
        {"text": "你好", "start_ms": 240, "end_ms": 400, "conf": None},
    ]


def test_hotwords_group_aligned_characters_without_polluting_global_dictionary(monkeypatch, tmp_path):
    from decimal import Decimal
    from types import SimpleNamespace

    text = "飞书豆包工作"
    items = [{"text": char, "start_ms": index * 80, "end_ms": (index + 1) * 80, "conf": None} for index, char in enumerate(text)]
    baseline = worker.group_chinese(items)
    assert [token["text"] for token in baseline] == ["飞", "书", "豆包", "工作"]
    source = tmp_path / "clip.wav"
    source.write_bytes(b"fake audio")
    hotwords = tmp_path / "hotwords.txt"
    hotwords.write_text(" 飞书 \n豆包工作\n\nAgent\n")
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 1000))
    monkeypatch.setattr(worker, "decode", lambda *_: worker.np.zeros(1000 * worker.SAMPLES_PER_MS))
    monkeypatch.setattr(worker, "weight_digest", lambda _: "sha256:fake")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))

    class Fake:
        def transcribe(self, audio, language, model, words):
            return text, "zh"

        def align(self, *_):
            return [SimpleNamespace(text=item["text"], start_time=Decimal(item["start_ms"]) / 1000, end_time=Decimal(item["end_ms"]) / 1000) for item in items]

    argv = ["transcribe", "--input", str(source), "--channels", "0", "--language", "zh", "--out", str(tmp_path / "out.json")]
    args = worker.parser().parse_args(argv + ["--hotwords", str(hotwords)])
    output = worker.result(args, local=Fake())
    assert output["tokens"] == [
        {"text": "飞书", "start_ms": 0, "end_ms": 160, "conf": None},
        {"text": "豆包工作", "start_ms": 160, "end_ms": 480, "conf": None},
    ]
    assert worker.result(args, local=object())["tokens"] == output["tokens"]
    assert worker.group_chinese(items) == baseline
    assert worker.result(worker.parser().parse_args(argv), local=Fake())["tokens"] == baseline


def test_engine_selection_only_falls_back_for_opted_in_model_errors():
    def missing():
        raise worker.WorkerError("E_ASR_MODEL_UNAVAILABLE", "missing")

    assert worker.choose_engine("auto", missing, lambda: "cloud text", True) == ("cloud text", "cloud")
    with pytest.raises(worker.WorkerError):
        worker.choose_engine("auto", missing, lambda: "cloud text", False)
    with pytest.raises(worker.WorkerError):
        worker.choose_engine("local", missing, lambda: "cloud text", True)
    assert worker.choose_engine("cloud", missing, lambda: "cloud text", False) == ("cloud text", "cloud")


def test_cloud_missing_credentials(monkeypatch):
    monkeypatch.delenv("ZSIR_VOLC_APP_ID", raising=False)
    monkeypatch.delenv("ZSIR_VOLC_ACCESS_TOKEN", raising=False)
    with pytest.raises(worker.WorkerError) as error:
        worker.CloudEngine().transcribe(None, "zh", "1.7b", None)
    assert error.value.code == "E_ASR_CLOUD_AUTH"


def test_result_and_error_json_with_fake_engine(monkeypatch, tmp_path):
    source = tmp_path / "clip.wav"
    source.write_bytes(b"test media")
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 2000))
    monkeypatch.setattr(worker, "decode", lambda *_: worker.np.zeros(2000 * worker.SAMPLES_PER_MS))
    monkeypatch.setattr(worker, "weight_digest", lambda _: "sha256:weights")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))
    class Span:
        text = "你好"
        start_time = 0.1
        end_time = 0.5
    class Fake:
        def transcribe(self, *_):
            return "你好", "zh"
        def align(self, *_):
            return [Span()]
    args = worker.parser().parse_args(["transcribe", "--input", str(source), "--channels", "0", "--language", "zh", "--out", str(tmp_path / "out.json")])
    result = worker.result(args, local=Fake())
    assert result["schema"] == "zsir-cut/asr-result"
    assert result["input"]["duration_ms"] == 2000
    assert result["tokens"] == [{"text": "你好", "start_ms": 100, "end_ms": 500, "conf": None}]
    assert worker.result(args, local=Fake())["tokens"] == result["tokens"]
    assert len(list((tmp_path / "cache").glob("*.json"))) == 1
    error_path = tmp_path / "error.json"
    bad = worker.main(["transcribe", "--input", str(tmp_path / "missing.wav"), "--channels", "0", "--language", "zh", "--out", str(error_path)])
    assert bad == 1
    failure = json.loads(error_path.read_text())
    assert set(failure) == {"schema", "schema_version", "code", "message", "retryable"}
    assert failure["schema"] == "zsir-cut/asr-error"


def test_probe_has_no_secret(monkeypatch):
    from types import SimpleNamespace
    fake_mlx = SimpleNamespace(metal=SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "mlx", SimpleNamespace(core=fake_mlx))
    monkeypatch.setitem(sys.modules, "mlx.core", fake_mlx)
    monkeypatch.setenv("ZSIR_VOLC_APP_ID", "private-app")
    monkeypatch.setenv("ZSIR_VOLC_ACCESS_TOKEN", "private-token")
    assert "private-token" not in json.dumps(worker.probe())


def test_missing_input_writes_input_error(tmp_path):
    destination = tmp_path / "error.json"
    status = worker.main(["transcribe", "--input", str(tmp_path / "missing.wav"), "--channels", "0", "--language", "zh", "--out", str(destination)])
    assert status == 1
    assert json.loads(destination.read_text())["code"] == "E_ASR_INPUT"


@pytest.mark.parametrize("case", json.loads((Path(__file__).resolve().parents[3] / "fixtures/regressions/asr-zero-width.json").read_text()), ids=lambda case: case["name"])
def test_zero_width_regression(case):
    from copy import deepcopy
    tokens = deepcopy(case["tokens"])
    count = worker.repair_zero_width(tokens, case["start_ms"], case["start_ms"] + case["duration_ms"])
    assert tokens == case["expected"]
    assert count == case["count"]


def test_zero_width_warning_and_silence_with_fake_engine(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from decimal import Decimal
    source = tmp_path / "clip.wav"
    source.write_bytes(b"fake audio")
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 1000))
    monkeypatch.setattr(worker, "decode", lambda *_: worker.np.zeros(1000 * worker.SAMPLES_PER_MS))
    monkeypatch.setattr(worker, "weight_digest", lambda _: "sha256:fake")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))
    class Fake:
        def transcribe(self, *_):
            return "hello", "en"
        def align(self, *_):
            return [SimpleNamespace(text="hello", start_time=Decimal("0.1"), end_time=Decimal("0.1"))]
    args = worker.parser().parse_args(["transcribe", "--input", str(source), "--channels", "0", "--language", "en", "--out", str(tmp_path / "out.json")])
    output = worker.result(args, local=Fake())
    assert output["tokens"][0]["end_ms"] == 140
    expected = [{"code": "W_ASR_ALIGN_DEGRADED", "ratio": 1}, {"code": "W_ASR_ZERO_WIDTH", "count": 1}]
    assert output["warnings"] == expected
    assert worker.result(args, local=Fake())["warnings"] == expected
    cache = next((tmp_path / "cache").glob("*.json"))
    old = json.loads(cache.read_text())
    old["tokens"][0]["end_ms"] = 100
    old["warnings"] = []
    cache.write_text(json.dumps(old))
    assert worker.result(args, local=Fake())["warnings"] == expected
    class Silent:
        def transcribe(self, *_):
            return " ", "en"
        def align(self, *_):
            raise AssertionError("silence must not call align")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "silence-cache"))
    assert worker.result(args, local=Silent())["tokens"] == []


@pytest.mark.parametrize(("command", "language"), [
    ("transcribe", "zh"), ("transcribe", "en"), ("transcribe", "auto"), ("align", "zh"), ("align", "en"),
])
def test_zero_width_warnings_count_output_words_after_grouping(monkeypatch, tmp_path, command, language):
    from decimal import Decimal
    from types import SimpleNamespace

    source = tmp_path / "clip.wav"
    source.write_bytes(b"fake audio")
    phrases = ["你好。" if i % 2 else "您好。" for i in range(19)]
    text = "".join(phrases) + "Bill AI 我们"
    items = []

    def item(text, start_ms, end_ms):
        return SimpleNamespace(text=text, start_time=Decimal(start_ms) / 1000, end_time=Decimal(end_ms) / 1000)

    for index in range(19):
        start = index * 40
        items.extend([item(phrases[index][0], start, start + 20), item("好", start + 20, start + 20), item("。", start + 20, start + 20)])
    items.extend([item("Bill", 760, 780), item("AI", 800, 820), item("我", 850, 850), item("们", 850, 850)])
    assert sum(span.start_time == span.end_time for span in items) * 2 > len(items)

    class Fake:
        def transcribe(self, *_):
            return text, "en" if language == "auto" else language

        def align(self, *_):
            return items

    monkeypatch.setattr(worker, "media_info", lambda _: (1, 1000))
    monkeypatch.setattr(worker, "decode", lambda *_: worker.np.zeros(1000 * worker.SAMPLES_PER_MS))
    monkeypatch.setattr(worker, "weight_digest", lambda _: "sha256:fake")
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))
    argv = [command, "--input", str(source), "--channels", "0", "--language", language, "--out", str(tmp_path / "out.json")]
    if command == "align":
        transcript = tmp_path / "text.txt"
        transcript.write_text(text)
        argv.extend(["--text", str(transcript)])
    args = worker.parser().parse_args(argv)
    output = worker.result(args, local=Fake())
    assert output["warnings"] == [{"code": "W_ASR_ZERO_WIDTH", "count": 1}]
    assert [token["text"] for token in output["tokens"]] == phrases + ["Bill", "AI", "我们"]
    assert [(token["start_ms"], token["end_ms"]) for token in output["tokens"]] == [
        (i * 40, i * 40 + 20) for i in range(19)
    ] + [(760, 780), (800, 820), (850, 890)]
    assert worker.result(args, local=object())["warnings"] == output["warnings"]
