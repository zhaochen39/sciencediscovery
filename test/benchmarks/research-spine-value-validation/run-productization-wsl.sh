#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
experiment=${1:?citations, controlled, scope or memory}
checkpoint=${2:?source checkpoint directory}
output=${3:?fresh output directory}
baseline=${4:?prebuilt original checkout}
receipt=${5:-}
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
export SCIENTIFIC_ENVS=0
mkdir -p "$TMPDIR"
mkdir "$output"
output=$(realpath "$output")
reverse=${SCIENCE_SPINE_REVERSE:-0}
case "$experiment" in
  citations|controlled)
    if [[ "$reverse" == 1 ]]; then trials=(by-state full original); else trials=(original full by-state); fi ;;
  scope)
    if [[ "$reverse" == 1 ]]; then trials=(inline separate); else trials=(separate inline); fi ;;
  memory)
    [[ -f "$receipt" ]]
    if [[ "$reverse" == 1 ]]; then trials=(bounded full); else trials=(full bounded); fi ;;
  *) printf 'Unknown experiment: %s\n' "$experiment" >&2; exit 2 ;;
esac
printf '%s\n' "${trials[@]}" > "$output/arm-order.txt"
status=0
for trial in "${trials[@]}"; do
  dir="$output/$trial"
  mkdir "$dir"
  data=$(mktemp -d "$TMPDIR/productization-e2e.XXXXXX")
  printf '%s\n' "$data" > "$dir/data-dir.txt"
  mode=original
  alternate=()
  scope= memory= controlled=
  case "$experiment" in
    citations|controlled)
      mode=$trial
      if [[ "$mode" == original ]]; then alternate=("$baseline"); fi
      if [[ "$experiment" == controlled ]]; then controlled=fixture; fi ;;
    scope)
      scope=$trial
      if [[ "$trial" == separate ]]; then alternate=("$baseline"); fi ;;
    memory)
      memory=$trial
      if [[ "$trial" == full ]]; then alternate=("$baseline"); fi ;;
  esac
  result=0
  SCIENCE_SPINE_FORMAL_DATA_DIR="$data" SCIENCE_SPINE_FORMAL_CONTROLLED="$controlled" \
    SCIENCE_SPINE_DELEGATION_EVAL="$scope" SCIENCE_SPINE_NODE_MEMORY_EVAL="$memory" \
    SCIENCE_SPINE_NODE_MEMORY_RECEIPT="$receipt" pnpm exec tsx "$bench/run-formal-recovery.ts" \
    "$checkpoint" "$dir" "$mode" "${alternate[@]}" > "$dir/driver.log" 2>&1 || result=$?
  printf '%s\n' "$result" > "$dir/exit-code.txt"
  if (( result != 0 )); then status=1; fi
done
if [[ "$experiment" == citations || "$experiment" == controlled ]]; then
  python3 "$bench/report-formal-recovery.py" "$output" --require-pass > "$output/formal-audit.jsonl" || status=1
fi
exit "$status"
