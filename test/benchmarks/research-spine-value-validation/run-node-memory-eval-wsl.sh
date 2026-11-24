#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
capture="${1:?source capture directory}"
arm="${2:?completed solar recovery arm accepted by independent audit}"
output="${3:?fresh output root}"
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$TMPDIR"
mkdir "$output"
checkpoint=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$capture/checkpoint-index.json")
export SCIENCE_SPINE_NODE_MEMORY_RECEIPT="$output/receipt.log"
pnpm exec tsx "$bench/inspect-node-memory.ts" "$arm" > "$SCIENCE_SPINE_NODE_MEMORY_RECEIPT" 2>&1
status=0
for trial in full bounded; do
  dir="$output/$trial"
  mkdir "$dir"
  data=$(mktemp -d "$TMPDIR/memory-reuse.XXXXXX")
  printf '%s\n' "$data" > "$dir/data-dir.txt"
  rc=0
  SCIENCE_SPINE_NODE_MEMORY_EVAL="$trial" SCIENCE_SPINE_FORMAL_DATA_DIR="$data"     pnpm exec tsx "$bench/run-formal-recovery.ts" "$capture/$checkpoint" "$dir" original > "$dir/driver.log" 2>&1 || rc=$?
  printf '%s\n' "$rc" > "$dir/exit-code.txt"
  if (( rc != 0 )); then status=1; fi
done
exit "$status"
