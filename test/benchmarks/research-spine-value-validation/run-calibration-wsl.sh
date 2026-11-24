#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
root="${SCIENCE_SPINE_LOG_DIR:?Set a new log directory}"
mkdir "$root"
root="$(cd "$root" && pwd)"
export SCIENCE_SPINE_CASE="${SCIENCE_SPINE_CASE:-calibration}"
export SCIENCE_SPINE_THINKING_MODE=disabled SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0 SCIENCE_SPINE_VALIDATE_ON_TOOL=1
export SCIENCE_AGENT_LLM_MAX_TOKENS=4096 SCIENCE_AGENT_LLM_MAX_RETRIES=8 SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS=32768 SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS=1
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=2 SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 SCIENCE_AGENT_SCOPE_MEMORY_CHARS=6000
export SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES=16384 SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES=600
export SCIENCE_SPINE_MAX_MODEL_TURNS=16
run_case() {
  local dir="$root/$1"
  mkdir "$dir"
  SCIENCE_SPINE_LOG_DIR="$dir" SCIENCE_SPINE_FIRST_PAIR="$2" SCIENCE_SPINE_REPETITIONS="$3" \
    SCIENCE_SPINE_MODES="$4" SCIENCE_SPINE_FORK="$5" bash "$bench/run-wsl.sh" > "$dir/runner.log" 2>&1
}
case "${SCIENCE_SPINE_EXPERIMENT:-${SCIENCE_CALIBRATION_EXPERIMENT:-paired}}" in
  shadow) run_case shadow 1 "${SCIENCE_SPINE_REPETITIONS:-3}" "${SCIENCE_SPINE_MODES:-dynamic-shadow}" 0;;
  fork) run_case fork "${SCIENCE_SPINE_FIRST_PAIR:-1}" "${SCIENCE_SPINE_REPETITIONS:-1}" "${SCIENCE_SPINE_MODES:-dynamic,projection}" 1;;
  serial) run_case serial 1 "${SCIENCE_SPINE_REPETITIONS:-3}" "${SCIENCE_SPINE_MODES:-dynamic,projection,projection-linked}" 0;;
  paired)
    pids=()
    for shard in '1 3' '4 3' '7 2' '9 2'; do
      read -r first count <<< "$shard"
      run_case "pairs-$first" "$first" "$count" "${SCIENCE_SPINE_MODES:-dynamic,projection}" 0 &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do wait "$pid" || status=1; done
    python3 "$bench/report-paired.py" "$root" --merge-shards
    exit "$status"
    ;;
  *) exit 2;;
esac
