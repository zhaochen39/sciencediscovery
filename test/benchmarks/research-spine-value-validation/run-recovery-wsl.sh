#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
root="${SCIENCE_SPINE_LOG_DIR:?Set a fresh recovery log directory}"
mkdir "$root"
root="$(cd "$root" && pwd)"
export SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_MODES=projection SCIENCE_SPINE_REQUIRE_REVIEW=1 SCIENCE_SPINE_RECOVERY_AUDIT=1
export SCIENCE_SPINE_THINKING_MODE=disabled SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0 SCIENCE_SPINE_VALIDATE_ON_TOOL=1
export SCIENCE_AGENT_LLM_MAX_TOKENS=4096 SCIENCE_AGENT_LLM_MAX_RETRIES=8 SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS=32768
export SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS=1 SCIENCE_SPINE_MAX_MODEL_TURNS=16
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=2 SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 SCIENCE_AGENT_SCOPE_MEMORY_CHARS=6000
export SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES=16384 SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES=600
run() {
  local directory="$1"
  shift
  mkdir "$directory"
  SCIENCE_SPINE_LOG_DIR="$directory" bash "$bench/run-wsl.sh" "$@" > "$directory/runner.log" 2>&1
}
run_pair() {
  local pair="$1" directory="$root/pair-$1" checkpoint_id checkpoint
  mkdir "$directory"
  run "$directory/capture" --checkpoint-capture
  checkpoint_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$directory/capture/checkpoint-index.json")"
  checkpoint="$directory/capture/$checkpoint_id"
  if (( pair % 2 == 0 )); then
    run "$directory/restart"
    run "$directory/resume" --checkpoint-resume "$checkpoint"
  else
    run "$directory/resume" --checkpoint-resume "$checkpoint"
    run "$directory/restart"
  fi
}
pids=()
for ((pair=1; pair<=${SCIENCE_SPINE_REPETITIONS:-3}; pair++)); do
  # Each invocation handles one trial. Reset the child count to one for the fresh baseline.
  (export SCIENCE_SPINE_REPETITIONS=1; run_pair "$pair") &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
if ((status == 0)); then
  python3 "$bench/report-paired.py" "$root" --recovery > "$root/recovery-evidence.md"
fi
exit "$status"
