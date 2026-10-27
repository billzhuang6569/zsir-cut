"""CLI boundary for local speech recognition and alignment."""

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

import jieba
import numpy as np

from . import __version__

HOME = Path.home() / ".zsir-cut"
MODELS = HOME / "models"
ASR_NAMES = {"1.7b": "Qwen3-ASR-1.7B-8bit", "0.6b": "Qwen3-ASR-0.6B-8bit"}
ALIGN_NAME = "Qwen3-ForcedAligner-0.6B-8bit"
PUNCT = "。！？.!?，、；：,;:"


class WorkerError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def milliseconds(value):
    try:
        number = Decimal(str(value)) * 1000
    except InvalidOperation as exc:
        raise WorkerError("E_ASR_INPUT", "Invalid time value") from exc
    if not number.is_finite() or number < 0 or number != number.to_integral_value():
        raise WorkerError("E_ASR_INPUT", "Time must be a nonnegative whole millisecond")
    return int(number)


def seconds_to_ms(value):
    return int((Decimal(str(value)) * 1000).to_integral_value())


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(path):
    size = path.stat().st_size
    if size <= 12 * 1024 * 1024:
        return file_sha(path)
    block = 4 * 1024 * 1024
    digest = hashlib.sha256()
    digest.update(f"{size}\n".encode())
    with open(path, "rb") as stream:
        for offset in (0, (size - block) // 2, size - block):
            stream.seek(offset)
            digest.update(stream.read(block))
    return digest.hexdigest()


def weight_digest(path):
    weights = sorted(path.glob("*.safetensors"))
    if not weights:
        raise WorkerError("E_ASR_MODEL_UNAVAILABLE", f"Model unavailable: {path}")
    digest = hashlib.sha256()
    for weight in weights:
        digest.update(weight.name.encode())
        digest.update(bytes.fromhex(file_sha(weight)))
    return "sha256:" + digest.hexdigest()


def cache_key(input_digest, channels, start_ms, duration_ms, language, engine, asr_digest, align_digest, hotword_digest):
    parts = [input_digest, channels, start_ms, duration_ms, language, engine, asr_digest, align_digest, __version__, hotword_digest]
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def media_info(path):
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, check=True)
        data = json.loads(result.stdout)
        audio = next(stream for stream in data["streams"] if stream["codec_type"] == "audio")
        return int(audio["channels"]), seconds_to_ms(data["format"]["duration"])
    except (OSError, subprocess.CalledProcessError, KeyError, StopIteration, ValueError) as exc:
        raise WorkerError("E_ASR_INPUT", f"Cannot read audio: {path}") from exc


def decode(path, channel, start_ms, duration_ms):
    command = ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-af", f"pan=mono|c0=c{channel}", "-ss", f"{Decimal(start_ms) / 1000}", "-t", f"{Decimal(duration_ms) / 1000}", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"]
    try:
        result = subprocess.run(command, capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise WorkerError("E_ASR_INPUT", "Audio decode failed") from exc
    samples = np.frombuffer(result.stdout, dtype="<f4")
    if not len(samples):
        raise WorkerError("E_ASR_INPUT", "Selected audio range is empty")
    return samples


def group_chinese(items):
    """Join aligned Chinese characters using jieba, retaining Latin words."""
    grouped = []
    index = 0
    while index < len(items):
        item = items[index]
        if item["text"] in PUNCT:
            if grouped:
                grouped[-1]["text"] += item["text"]
                grouped[-1]["end_ms"] = max(grouped[-1]["end_ms"], item["end_ms"])
            index += 1
            continue
        if len(item["text"]) == 1 and "\u4e00" <= item["text"] <= "\u9fff":
            end = index
            while end < len(items) and len(items[end]["text"]) == 1 and "\u4e00" <= items[end]["text"] <= "\u9fff":
                end += 1
            words = list(jieba.cut("".join(part["text"] for part in items[index:end]), HMM=False))
            cursor = index
            for word in words:
                spans = items[cursor:cursor + len(word)]
                grouped.append({"text": word, "start_ms": min(part["start_ms"] for part in spans), "end_ms": max(part["end_ms"] for part in spans), "conf": None})
                cursor += len(word)
            index = end
        else:
            grouped.append(dict(item))
            index += 1
    return grouped


def normalize_items(items, offset_ms, language):
    tokens = []
    for item in items:
        text = item.text.strip()
        if text:
            tokens.append({"text": text, "start_ms": offset_ms + seconds_to_ms(item.start_time), "end_ms": offset_ms + seconds_to_ms(item.end_time), "conf": None})
    if language == "zh":
        tokens = group_chinese(tokens)
    tokens.sort(key=lambda item: item["start_ms"])
    previous = offset_ms
    for token in tokens:
        token["start_ms"] = max(previous, token["start_ms"])
        token["end_ms"] = max(token["start_ms"], token["end_ms"])
        previous = token["end_ms"]
    return tokens


class LocalEngine:
    def load(self, name):
        path = MODELS / name
        if not path.is_dir():
            raise WorkerError("E_ASR_MODEL_UNAVAILABLE", f"Model unavailable: {path}")
        try:
            from mlx_audio.stt import load
            return load(path)
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            if "memory" in str(exc).lower() or "oom" in str(exc).lower():
                raise WorkerError("E_ASR_OOM", str(exc), True) from exc
            raise WorkerError("E_ASR_MODEL_UNAVAILABLE", str(exc)) from exc

    def transcribe(self, audio, language, model, hotwords):
        try:
            result = self.load(ASR_NAMES[model]).generate(audio, language={"zh": "Chinese", "en": "English"}.get(language), hotwords=hotwords)
        except (MemoryError, RuntimeError) as exc:
            if "memory" in str(exc).lower() or "oom" in str(exc).lower():
                raise WorkerError("E_ASR_OOM", str(exc), True) from exc
            raise
        detected = result.language[0] if isinstance(result.language, list) and result.language else result.language
        return result.text, ({"chinese": "zh", "english": "en"}.get(str(detected).lower()) or (language if language != "auto" else "zh"))

    def align(self, audio, text, language):
        try:
            return self.load(ALIGN_NAME).generate(audio, text, language={"zh": "Chinese", "en": "English"}[language]).items
        except (MemoryError, RuntimeError) as exc:
            if "memory" in str(exc).lower() or "oom" in str(exc).lower():
                raise WorkerError("E_ASR_OOM", str(exc), True) from exc
            raise


class CloudEngine:
    def transcribe(self, audio, language, model, hotwords):
        if not os.getenv("ZSIR_VOLC_APP_ID") or not os.getenv("ZSIR_VOLC_ACCESS_TOKEN"):
            raise WorkerError("E_ASR_CLOUD_AUTH", "Volcengine credentials are missing")
        # TODO: Call the Volcengine ASR API and normalize its text and timing.
        raise WorkerError("E_ASR_INTERNAL", "Volcengine API client is not implemented")


def cloud_fallback_enabled():
    try:
        return json.loads((HOME / "config.json").read_text()).get("asr", {}).get("cloud_fallback") is True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def choose_engine(requested, local_call, cloud_call, fallback_enabled):
    if requested == "cloud":
        return cloud_call(), "cloud"
    try:
        return local_call(), "local"
    except WorkerError as exc:
        if requested == "auto" and fallback_enabled and exc.code in ("E_ASR_OOM", "E_ASR_MODEL_UNAVAILABLE"):
            return cloud_call(), "cloud"
        if requested == "auto" and exc.code in ("E_ASR_OOM", "E_ASR_MODEL_UNAVAILABLE"):
            raise WorkerError(exc.code, f"{exc}. Enable asr.cloud_fallback in ~/.zsir-cut/config.json to allow cloud fallback", exc.retryable) from exc
        raise


def result(args, local=None, cloud=None):
    started = time.monotonic()
    path = Path(args.input)
    channels, total_ms = media_info(path)
    if args.channels < 0 or args.channels >= channels:
        raise WorkerError("E_ASR_INPUT", "Audio channel is out of range")
    start_ms = milliseconds(getattr(args, "start", None) or "0")
    requested_duration = getattr(args, "duration", None)
    duration_ms = milliseconds(requested_duration) if requested_duration is not None else total_ms - start_ms
    if start_ms >= total_ms or duration_ms <= 0 or start_ms + duration_ms > total_ms:
        raise WorkerError("E_ASR_INPUT", "Audio range is out of bounds")
    local = local or LocalEngine()
    cloud = cloud or CloudEngine()
    is_transcribe = args.command == "transcribe"
    if is_transcribe and args.engine == "cloud" and (not os.getenv("ZSIR_VOLC_APP_ID") or not os.getenv("ZSIR_VOLC_ACCESS_TOKEN")):
        raise WorkerError("E_ASR_CLOUD_AUTH", "Volcengine credentials are missing")
    asr_name = ASR_NAMES[args.model] if is_transcribe else None
    def available_digest(name):
        try:
            return weight_digest(MODELS / name)
        except WorkerError as exc:
            if exc.code != "E_ASR_MODEL_UNAVAILABLE":
                raise
            return None
    asr_digest = available_digest(asr_name) if asr_name and args.engine != "cloud" else None
    align_digest = available_digest(ALIGN_NAME)
    hotwords_path = getattr(args, "hotwords", None)
    try:
        hotwords = Path(hotwords_path).read_text().splitlines() if hotwords_path else None
        hotword_digest = file_sha(hotwords_path) if hotwords_path else None
    except OSError as exc:
        raise WorkerError("E_ASR_INPUT", f"Cannot read hotwords: {hotwords_path}") from exc
    input_digest = fingerprint(path)
    key = cache_key(input_digest, [args.channels], start_ms, duration_ms, args.language, getattr(args, "engine", "local"), asr_digest, align_digest, hotword_digest)
    cache = Path(os.getenv("ZSIR_CACHE_DIR", str(HOME / "cache" / "asr"))) / f"{key}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    audio = decode(path, args.channels, start_ms, duration_ms)
    warnings = []
    if is_transcribe:
        (recognized, language), engine_used = choose_engine(args.engine, lambda: local.transcribe(audio, args.language, args.model, hotwords), lambda: cloud.transcribe(audio, args.language, args.model, hotwords), cloud_fallback_enabled())
        text = recognized
    else:
        try:
            text = Path(args.text).read_text().strip()
        except OSError as exc:
            raise WorkerError("E_ASR_INPUT", f"Cannot read text: {args.text}") from exc
        if not text:
            raise WorkerError("E_ASR_INPUT", "Alignment text is empty")
        language = args.language
        engine_used = "local"
    try:
        items = local.align(audio, text, language)
        tokens = normalize_items(items, start_ms, language)
        alignment = {"name": "qwen3-forced-aligner", "model": ALIGN_NAME, "version": "0.5.8", "weights_digest": align_digest}
    except WorkerError as exc:
        if engine_used != "cloud":
            raise
        warnings.append("W_ASR_CLOUD_TIMING")
        # TODO: Normalize cloud token times once the Volcengine client exists.
        tokens = []
        alignment = {"name": "cloud", "model": "volcengine", "version": None, "weights_digest": None}
    payload = {"schema": "zsir-cut/asr-result", "schema_version": "0.1", "input": {"path": str(path), "size_bytes": path.stat().st_size, "fingerprint": input_digest, "channels": [args.channels], "start_ms": start_ms, "duration_ms": duration_ms}, "language": language, "asr": {"name": "qwen3-asr" if engine_used == "local" else "volcengine", "model": asr_name if engine_used == "local" else "volcengine", "version": "0.5.8" if engine_used == "local" else None, "weights_digest": asr_digest if engine_used == "local" else None}, "align": alignment, "tokens": tokens, "runtime": {"seconds": round(time.monotonic() - started, 3), "peak_memory_mb": peak_memory_mb(), "engine_used": engine_used}, "warnings": warnings}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return payload


def peak_memory_mb():
    import resource
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024), 1)


def probe():
    try:
        import mlx.core as mx
        mlx_available = bool(mx.metal.is_available())
    except (ImportError, RuntimeError):
        mlx_available = False
    memory = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() if sys.platform == "darwin" else ""
    return {"chip": platform.machine(), "memory_bytes": int(memory) if memory.isdigit() else None, "mlx_available": mlx_available, "models": [name for name in (*ASR_NAMES.values(), ALIGN_NAME) if (MODELS / name / "model.safetensors").exists()], "cloud_credentials_configured": bool(os.getenv("ZSIR_VOLC_APP_ID") and os.getenv("ZSIR_VOLC_ACCESS_TOKEN"))}


def parser():
    root = argparse.ArgumentParser(prog="python -m zsir_asr")
    commands = root.add_subparsers(dest="command", required=True)
    transcribe = commands.add_parser("transcribe")
    align = commands.add_parser("align")
    probe_command = commands.add_parser("probe")
    evaluate = commands.add_parser("eval")
    for command in (transcribe, align):
        command.add_argument("--input", required=True)
        command.add_argument("--channels", type=int, required=True)
        command.add_argument("--language", choices=("zh", "en", "auto") if command is transcribe else ("zh", "en"), required=True)
        command.add_argument("--out", required=True)
    transcribe.add_argument("--start")
    transcribe.add_argument("--duration")
    transcribe.add_argument("--engine", choices=("local", "cloud", "auto"), default="local")
    transcribe.add_argument("--model", choices=tuple(ASR_NAMES), default="1.7b")
    transcribe.add_argument("--hotwords")
    align.add_argument("--text", required=True)
    probe_command.add_argument("--out", required=True)
    evaluate.add_argument("--manifest", required=True)
    evaluate.add_argument("--out", required=True)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "probe":
            payload = probe()
        elif args.command == "eval":
            from .evaluation import evaluate
            payload = evaluate(Path(args.manifest), Path(args.out))
        else:
            payload = result(args)
        destination = Path(args.out)
        if args.command != "eval":
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return 0
    except WorkerError as exc:
        payload = {"schema": "zsir-cut/asr-error", "schema_version": "0.1", "code": exc.code, "message": str(exc), "retryable": exc.retryable}
    except Exception as exc:
        code = "E_ASR_OOM" if isinstance(exc, MemoryError) else "E_ASR_INTERNAL"
        payload = {"schema": "zsir-cut/asr-error", "schema_version": "0.1", "code": code, "message": str(exc), "retryable": isinstance(exc, MemoryError)}
    if args.command == "eval":
        destination = Path(args.out) / "error.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        destination = Path(args.out)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return 1
