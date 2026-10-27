"""Local evaluation of reference transcripts; no media or references are copied."""

import json
import os
import re
import statistics
from pathlib import Path

from .worker import WorkerError, parser, result


def distance(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for index, expected in enumerate(reference, 1):
        following = [index]
        for column, actual in enumerate(hypothesis, 1):
            following.append(min(following[-1] + 1, row[column] + 1, row[column - 1] + (expected != actual)))
        row = following
    return row[-1]


def normalized(text):
    return "".join(character.casefold() for character in text if character.isalnum())


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def evaluate(manifest_path: Path, out: Path):
    manifest = json.loads(manifest_path.read_text())
    media_root = Path(os.environ.get("ZSIR_EVAL_DIR", ""))
    if manifest.get("items") and not os.environ.get("ZSIR_EVAL_DIR"):
        raise WorkerError("E_ASR_INPUT", "ZSIR_EVAL_DIR is required")
    reports = []
    for item in manifest["items"]:
        media = media_root / item["file"]
        reference = json.loads((media_root / item["reference_transcript"]).read_text())
        sentences = reference["sentences"]
        args = parser().parse_args(["transcribe", "--input", str(media), "--channels", "0", "--language", "zh" if item["language"].startswith("zh") else "en", "--engine", "local", "--out", str(out / "unused.json")])
        try:
            output = result(args)
        except WorkerError as exc:
            reports.append({"id": item["id"], "failed": True, "error_code": exc.code})
            continue
        actual = "".join(token["text"] for token in output["tokens"])
        expected = "".join(sentence["text"] for sentence in sentences)
        zh_expected = "".join(character for character in normalized(expected) if "\u4e00" <= character <= "\u9fff")
        zh_actual = "".join(character for character in normalized(actual) if "\u4e00" <= character <= "\u9fff")
        en_expected = re.findall(r"[a-z]+", expected.casefold())
        en_actual = re.findall(r"[a-z]+", actual.casefold())
        brands = item.get("brand_terms", [])
        boundaries = []
        boundary_file = item.get("word_boundary_reference")
        if boundary_file:
            for reference_word, actual_word in zip(json.loads((media_root / boundary_file).read_text())["tokens"], output["tokens"]):
                if normalized(reference_word["text"]) == normalized(actual_word["text"]):
                    boundaries.extend([abs(reference_word["start_ms"] - actual_word["start_ms"]), abs(reference_word["end_ms"] - actual_word["end_ms"])])
        duration_minutes = output["input"]["duration_ms"] / 60000
        reports.append({"id": item["id"], "chinese_cer": distance(zh_expected, zh_actual) / len(zh_expected) if zh_expected else None, "english_wer": distance(en_expected, en_actual) / len(en_expected) if en_expected else None, "brand_accuracy": sum(normalized(term) in normalized(actual) for term in brands) / len(brands) if brands else None, "boundary_p50_ms": percentile(boundaries, 0.5), "boundary_p95_ms": percentile(boundaries, 0.95), "omissions": None, "repetitions": None, "false_speech": None, "recognition_seconds_per_media_minute": output["runtime"]["seconds"] / duration_minutes, "peak_memory_mb": output["runtime"]["peak_memory_mb"], "failed": False, "human_correction_seconds_per_media_minute": None})
    out.mkdir(parents=True, exist_ok=True)
    report = {"schema": "zsir-cut/asr-eval", "schema_version": "0.1", "items": reports, "failure_rate": sum(r["failed"] for r in reports) / len(reports) if reports else None, "mean_chinese_cer": statistics.mean(r["chinese_cer"] for r in reports if r.get("chinese_cer") is not None) if any(r.get("chinese_cer") is not None for r in reports) else None}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report
