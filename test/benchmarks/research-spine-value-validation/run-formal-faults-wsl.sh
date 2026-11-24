#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
capture="${1:?displayed solar capture directory}"
output="${2:?fresh output root}"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$TMPDIR"
checkpoint_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$capture/checkpoint-index.json")
mkdir "$output"
status=0
for fault in cancel-shell runner-unavailable crash-before-commit retry-after-restart; do
  arm="$output/$fault"
  mkdir "$arm"
  data=$(mktemp -d "$TMPDIR/fault.XXXXXX")
  printf '%s\n' "$data" > "$arm/data-dir.txt"
  result=0
  SCIENTIFIC_ENVS=0 SCIENCE_SPINE_FORMAL_CONTROLLED=fixture SCIENCE_SPINE_FORMAL_FAULT="$fault" SCIENCE_SPINE_FORMAL_DATA_DIR="$data" \
    timeout 240 pnpm exec tsx "$bench/run-formal-recovery.ts" "$capture/$checkpoint_id" "$arm" by-state > "$arm/driver.log" 2>&1 || result=$?
  printf '%s\n' "$result" > "$arm/exit-code.txt"
  if [[ "$result" != 0 ]]; then status=1; fi
done
python3 "$bench/report-formal-recovery.py" "$output" --require-fault-pass > "$output/formal-audit.jsonl" || status=1
exit "$status"
