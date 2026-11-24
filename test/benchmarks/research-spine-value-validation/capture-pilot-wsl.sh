#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
workload="${1:?solar or calibration-review}"
root="${2:?new capture root}"
[[ "$workload" == solar || "$workload" == calibration-review ]]
shift 2
pairs=("$@")
if (( ${#pairs[@]} == 0 )); then pairs=(1 2 3 4 5 6); fi
mkdir "$root"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$TMPDIR"
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
export SCIENCE_SPINE_CASE="$workload" SCIENCE_SPINE_RECOVERY_BY_STATE=1 SCIENCE_SPINE_REPETITIONS=1
export SCIENCE_SPINE_MODES=projection SCIENCE_SPINE_REQUIRE_REVIEW=1 SCIENCE_SPINE_RECOVERY_USAGE_AUDIT=1
export SCIENCE_SPINE_THINKING_MODE=disabled SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0 SCIENCE_SPINE_VALIDATE_ON_TOOL=1
export SCIENCE_AGENT_LLM_MAX_TOKENS=4096 SCIENCE_AGENT_LLM_MAX_RETRIES=8 SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS=32768
export SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS=1 SCIENCE_SPINE_MAX_MODEL_TURNS=16
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=2 SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 SCIENCE_AGENT_SCOPE_MEMORY_CHARS=6000
export SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES=16384 SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES=600
status=0
for pair in "${pairs[@]}"; do
  [[ "$pair" =~ ^[1-6]$ ]]
  state=pending; if ((pair % 2 == 0)); then state=displayed; fi
  dir="$root/pair-$pair"
  mkdir "$dir"
  printf '%s\n' "$state" > "$dir/capture-review.txt"
  for attempt in 1 2 3; do
    mkdir "$dir/capture"
    rc=0
    SCIENCE_SPINE_CAPTURE_REVIEW="$state" SCIENCE_SPINE_LOG_DIR="$dir/capture" \
      bash "$bench/run-wsl.sh" --checkpoint-capture > "$dir/capture/runner.log" 2>&1 || rc=$?
    printf '%s\n' "$rc" > "$dir/capture/exit-code.txt"
    if [[ "$rc" == 0 && -f "$dir/capture/checkpoint-index.json" ]]; then break; fi
    mkdir -p "$dir/capture-attempts"
    mv -- "$dir/capture" "$dir/capture-attempts/attempt-$attempt"
  done
  if [[ -f "$dir/capture/checkpoint-index.json" ]]; then
    printf '%s pair %s frozen (%s)\n' "$workload" "$pair" "$state"
  else
    printf '%s pair %s capture failed (%s)\n' "$workload" "$pair" "$state"
    status=1
  fi
done
exit "$status"
