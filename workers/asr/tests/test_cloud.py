import io
import json
import unicodedata
from pathlib import Path
from types import SimpleNamespace
import pytest
from zsir_asr import worker

class Response(io.BytesIO):
    def __init__(self, code, payload=None, logid="log-123"):
        super().__init__(json.dumps(payload or {}).encode())
        self.headers = {"X-Api-Status-Code": code, "X-Tt-Logid": logid}

def setup(monkeypatch, code="20000000", payload=None):
    monkeypatch.setenv("ZSIR_VOLC_API_KEY", "secret-key")
    calls = []
    def transcode(args, **kwargs):
        assert args[0] == "ffmpeg"
        assert args[args.index("-ar") + 1] == "16000"
        assert args[args.index("-ac") + 1] == "1"
        assert args[args.index("-b:a") + 1] == "64k"
        Path(args[-1]).write_bytes(b"mp3")
        calls.append(args)
    monkeypatch.setattr(worker.subprocess, "run", transcode)
    requests = []
    def http(request, **kwargs):
        requests.append(request)
        assert request.get_header("X-api-key") == "secret-key"
        assert request.get_header("X-api-resource-id") == "volc.bigasr.auc_turbo"
        assert request.get_header("X-api-sequence") == "-1"
        return Response(code, payload)
    monkeypatch.setattr(worker.urllib.request, "urlopen", http)
    return calls, requests

@pytest.mark.parametrize("status,code", [("45000010", "E_ASR_CLOUD_AUTH"), ("45000030", "E_ASR_CLOUD_AUTH"), ("45000099", "E_ASR_INTERNAL"), ("55000001", "E_ASR_CLOUD_NETWORK")])
def test_status_mapping_and_safe_errors(monkeypatch, status, code):
    setup(monkeypatch, status)
    with pytest.raises(worker.WorkerError) as error:
        worker.CloudEngine().transcribe("clip.wav", 0, 0, 5000, "zh")
    assert error.value.code == code
    assert "secret-key" not in str(error.value)
    if code == "E_ASR_INTERNAL": assert "log-123" in str(error.value)
    if code == "E_ASR_CLOUD_AUTH": assert status in str(error.value)

@pytest.mark.parametrize("status", ["20000000", "20000003"])
def test_success_silence_and_long_audio_offsets(monkeypatch, status):
    payload = {"result": {"utterances": [{"text": "刚", "words": [{"text": "刚", "start_time": 480, "end_time": 600, "confidence": 0}]}]}}
    calls, requests = setup(monkeypatch, status, payload)
    tokens, language = worker.CloudEngine().transcribe("clip.wav", 1, 1000, 2 * 60 * 60 * 1000 + 5000, "auto")
    assert len(calls) == len(requests) == 2
    assert calls[1][calls[1].index("-ss") + 1] == "5401"
    assert json.loads(requests[0].data)["audio"] == {"format": "mp3", "data": "bXAz"}
    if status == "20000003": assert tokens == []
    else:
        assert language == "zh"
        assert tokens == [{"text": "刚", "start_ms": 1480, "end_ms": 1600, "conf": 0}, {"text": "刚", "start_ms": 5401480, "end_ms": 5401600, "conf": 0}]

@pytest.mark.parametrize("exception", [worker.urllib.error.URLError("secret-key"), worker.http.client.IncompleteRead(b"secret-key")])
def test_network_error_does_not_leak_key(monkeypatch, exception):
    setup(monkeypatch)
    def fail(*args, **kwargs): raise exception
    monkeypatch.setattr(worker.urllib.request, "urlopen", fail)
    with pytest.raises(worker.WorkerError) as error: worker.CloudEngine().transcribe("clip.wav", 0, 0, 5000, "zh")
    assert error.value.code == "E_ASR_CLOUD_NETWORK"
    assert "secret-key" not in str(error.value)

def test_cloud_result_skips_local_models_alignment_and_cache_for_test(monkeypatch, tmp_path):
    setup(monkeypatch, payload={"result": {"utterances": [{"text": "测试", "words": [{"text": "测试", "start_time": 1, "end_time": 100}]}]}})
    source = tmp_path / "clip.wav"; source.write_bytes(b"audio")
    monkeypatch.setattr(worker, "media_info", lambda _: (1, 1000))
    monkeypatch.setenv("ZSIR_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ZSIR_ASR_NO_CACHE", "1")
    def forbidden(*args): raise AssertionError("local code used")
    monkeypatch.setattr(worker, "weight_digest", forbidden)
    monkeypatch.setattr(worker, "decode", forbidden)
    args = worker.parser().parse_args(["transcribe", "--input", str(source), "--channels", "0", "--language", "zh", "--engine", "cloud", "--out", str(tmp_path / "out.json")])
    output = worker.result(args, local=object())
    assert output["tokens"][0]["text"] == "测试"
    assert output["runtime"]["engine_used"] == "cloud"
    assert output["warnings"] == []
    assert not (tmp_path / "cache").exists()
    assert "secret-key" not in json.dumps(output)


def test_two_hour_limit_hotwords_and_language(monkeypatch):
    calls, requests = setup(monkeypatch, "20000003")
    worker.CloudEngine().transcribe("clip.wav", 0, 0, 2 * 60 * 60 * 1000, "en", ["飞书"])
    assert len(calls) == 1
    payload = json.loads(requests[0].data)
    assert payload["audio"]["language"] == "en-US"
    assert payload["request"]["show_utterances"] is True
    assert json.loads(payload["request"]["corpus"]["context"])["hotwords"] == [{"word": "飞书"}]


def test_real_english_spaces_preserve_text_and_monotonic_timing(monkeypatch):
    fixtures = Path(__file__).parent / "fixtures"
    payload = json.loads((fixtures / "volc-flash-english.json").read_text())
    setup(monkeypatch, payload=payload)
    tokens, language = worker.CloudEngine().transcribe("clip.wav", 0, 0, 30132, "auto")
    assert tokens == json.loads((fixtures / "volc-flash-english.tokens.json").read_text())
    assert language == "zh"
    assert all(token["text"].strip() and 0 <= token["start_ms"] < token["end_ms"] <= 30132 for token in tokens)
    assert all(left["end_ms"] <= right["start_ms"] for left, right in zip(tokens, tokens[1:]))
    text = "".join(token["text"] for token in tokens)
    assert "Final Cut Pro" in text
    without_punctuation = lambda value: "".join(char for char in value if not unicodedata.category(char).startswith("P"))
    assert without_punctuation(text) == without_punctuation(payload["result"]["text"])


@pytest.mark.parametrize("text", ["", " ", "\t \n"])
def test_whitespace_items_do_not_need_timing_or_confidence(monkeypatch, text):
    payload = {"result": {"utterances": [{"words": [
        {"text": "Final", "start_time": 10, "end_time": 20},
        {"text": text, "start_time": -1, "end_time": -1, "confidence": -1},
        {"text": "Cut", "start_time": 20, "end_time": 30},
    ]}]}}
    setup(monkeypatch, payload=payload)
    tokens, _ = worker.CloudEngine().transcribe("clip.wav", 0, 1000, 100, "en")
    assert [token["text"] for token in tokens] == ["Final" + text, "Cut"]
    assert [(token["start_ms"], token["end_ms"]) for token in tokens] == [(1010, 1020), (1020, 1030)]


@pytest.mark.parametrize("start,end", [(-1, 20), (10, -1), (-1, -1)])
def test_nonblank_words_still_reject_negative_timing(monkeypatch, start, end):
    setup(monkeypatch, payload={"result": {"utterances": [{"words": [
        {"text": " Final ", "start_time": start, "end_time": end},
    ]}]}})
    with pytest.raises(worker.WorkerError, match="Invalid Volcengine word timing") as error:
        worker.CloudEngine().transcribe("clip.wav", 0, 0, 100, "en")
    assert error.value.code == "E_ASR_INTERNAL"
