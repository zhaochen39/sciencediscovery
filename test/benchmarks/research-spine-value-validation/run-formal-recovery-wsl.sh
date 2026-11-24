#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
capture_dir="${1:?checkpoint capture directory}"
output="${2:?fresh output directory}"
baseline="${3:?built original checkout}"
order="${4:-original}"
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
checkpoint_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$capture_dir/checkpoint-index.json")
mkdir "$output"
output=$(realpath "$output")
case "$order" in
  original) arms=(original by-state full) ;;
  by-state) arms=(by-state original full) ;;
  full) arms=(full original by-state) ;;
  original,full,by-state) arms=(original full by-state) ;;
  by-state,full,original) arms=(by-state full original) ;;
  full,by-state,original) arms=(full by-state original) ;;
  *) printf 'Unsupported arm order: %s\n' "$order" >&2; exit 2 ;;
esac
printf '%s\n' "${arms[@]}" > "$output/arm-order.txt"
scratch="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$scratch"
export TMPDIR="$scratch"
status=0
for arm in "${arms[@]}"; do
  mkdir "$output/$arm"
  data=$(mktemp -d "$scratch/formal.XXXXXX")
  alternate=()
  if [[ "$arm" == original ]]; then alternate=("$baseline"); fi
  printf '%s\n' "$data" > "$output/$arm/data-dir.txt"
  result=0
  SCIENCE_SPINE_FORMAL_DATA_DIR="$data" pnpm exec tsx "$bench/run-formal-recovery.ts" \
    "$capture_dir/$checkpoint_id" "$output/$arm" "$arm" "${alternate[@]}" > "$output/$arm/driver.log" 2>&1 || result=$?
  printf '%s\n' "$result" > "$output/$arm/exit-code.txt"
  if [[ "$result" != 0 ]]; then status=1; fi
done
python3 "$bench/report-formal-recovery.py" "$output" --require-pass > "$output/formal-audit.jsonl" || status=1
exit "$status"
