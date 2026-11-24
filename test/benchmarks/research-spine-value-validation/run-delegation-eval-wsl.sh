#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
capture="${1:?displayed solar capture directory}"
output="${2:?fresh output root}"
shift 2
orders=("$@")
if (( ${#orders[@]} == 0 )); then orders=(separate inline); fi
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$TMPDIR"
mkdir "$output"
checkpoint=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$capture/checkpoint-index.json")
status=0
for mode in "${orders[@]}"; do
  [[ "$mode" == separate || "$mode" == inline || "$mode" == partial ]]
  controlled=
  if [[ "$mode" == partial ]]; then controlled=fixture; fi
  dir="$output/$mode"
  mkdir "$dir"
  data=$(mktemp -d "$TMPDIR/scopes.XXXXXX")
  printf '%s\n' "$data" > "$dir/data-dir.txt"
  rc=0
  SCIENCE_SPINE_DELEGATION_EVAL="$mode" SCIENCE_SPINE_FORMAL_CONTROLLED="$controlled" SCIENCE_SPINE_FORMAL_DATA_DIR="$data"     pnpm exec tsx "$bench/run-formal-recovery.ts" "$capture/$checkpoint" "$dir" original > "$dir/driver.log" 2>&1 || rc=$?
  printf '%s\n' "$rc" > "$dir/exit-code.txt"
  if (( rc != 0 )); then status=1; fi
done
exit "$status"
