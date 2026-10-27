#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
node fixtures/synth/cli.ts spoken
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd workers/asr
export ZSIR_CACHE_DIR="$scratch/cache-one"
if ! ./.venv/bin/python -m zsir_asr transcribe --input ../../fixtures/.media/shared/台词朗读.wav --channels 0 --language zh --engine local --out "$scratch/first.json"; then
  cat "$scratch/first.json"
  exit 1
fi
export ZSIR_CACHE_DIR="$scratch/cache-two"
if ! ./.venv/bin/python -m zsir_asr transcribe --input ../../fixtures/.media/shared/台词朗读.wav --channels 0 --language zh --engine local --out "$scratch/second.json"; then
  cat "$scratch/second.json"
  exit 1
fi
./.venv/bin/python - "$scratch/first.json" "$scratch/second.json" <<'PY'
import json
import sys

from zsir_asr.evaluation import distance, normalized

first = json.load(open(sys.argv[1]))
second = json.load(open(sys.argv[2]))
assert first['tokens'] == second['tokens'], 'tokens differ between runs'
script = json.load(open('../../fixtures/synth/script.json'))
chinese = lambda text: ''.join(char for char in normalized(text) if '\u4e00' <= char <= '\u9fff')
reference = chinese(''.join(sentence['text'] for sentence in script['sentences']))
hypothesis = chinese(''.join(token['text'] for token in first['tokens']))
cer = distance(reference, hypothesis) / len(reference)
print(f"Chinese CER: {cer:.2%}; seconds: {first['runtime']['seconds']}; peak memory MB: {first['runtime']['peak_memory_mb']}; tokens identical: true")
assert cer < 0.10, f'Chinese CER {cer:.2%} is not below 10%'
PY
