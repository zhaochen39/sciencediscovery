#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
root="${SCIENCE_SPINE_LOG_DIR:?Set a fresh log directory}"
count="${SCIENCE_SPINE_REPETITIONS:-6}"
workload="${SCIENCE_SPINE_CASE:-solar}"
controlled="${SCIENCE_SPINE_RECOVERY_CONTROLLED:-0}"
if [[ "$workload" != solar && "$workload" != calibration-review ]]; then exit 2; fi
if [[ "$controlled" != 1 && "$count" != 6 ]]; then exit 2; fi
mkdir "$root"
root="$(cd "$root" && pwd)"
export SCIENCE_SPINE_CASE="$workload" SCIENCE_SPINE_RECOVERY_BY_STATE=1 SCIENCE_SPINE_REPETITIONS=1
export SCIENCE_SPINE_MODES=projection SCIENCE_SPINE_REQUIRE_REVIEW=1 SCIENCE_SPINE_RECOVERY_USAGE_AUDIT=1
export SCIENCE_SPINE_THINKING_MODE=disabled SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0 SCIENCE_SPINE_VALIDATE_ON_TOOL=1
export SCIENCE_AGENT_LLM_MAX_TOKENS=4096 SCIENCE_AGENT_LLM_MAX_RETRIES=8 SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS=32768
export SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS=1 SCIENCE_SPINE_MAX_MODEL_TURNS=16
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=2 SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 SCIENCE_AGENT_SCOPE_MEMORY_CHARS=6000
export SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES=16384 SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES=600
run() {
  local directory="$1" status=0
  shift
  mkdir "$directory"
  local -a runner=(bash "$bench/run-wsl.sh")
  if [[ "$controlled" == 1 ]]; then
    runner=(pnpm exec tsx "$bench/run-live.ts")
  fi
  local TIMEFORMAT='%3R'
  date +%s%3N > "$directory/started-epoch-ms.txt"
  { time SCIENCE_SPINE_LOG_DIR="$directory" "${runner[@]}" "$@" > "$directory/runner.log" 2>&1; } 2> "$directory/wall-seconds.txt" || status=$?
  printf '%s\n' "$status" > "$directory/exit-code.txt"
  return "$status"
}
run_arms() {
  local directory="$1" checkpoint="$2" first="$3" arm status=0
  local -a order=(full by-state)
  if [[ "$first" == by-state ]]; then order=(by-state full); fi
  printf '%s\n' "${order[@]}" > "$directory/arm-order.txt"
  for arm in "${order[@]}"; do
    if [[ "$arm" == full ]]; then
      SCIENCE_SPINE_NATIVE_ROOT="${SCIENCE_SPINE_BASELINE_ROOT:-}" run "$directory/$arm" --checkpoint-resume "$checkpoint" || status=1
    else
      run "$directory/$arm" --checkpoint-resume-by-state "$checkpoint" || status=1
    fi
  done
  return "$status"
}
for ((pair=1; pair<=count; pair++)); do
  directory="$root/pair-$pair"
  mkdir "$directory"
  state=pending
  first=full
  if ((pair % 2 == 0)); then state=displayed; fi
  # Balance ordering within both checkpoint states across the batch.
  if ((pair % 4 == 2 || pair % 4 == 3)); then first=by-state; fi
  state="${SCIENCE_SPINE_CAPTURE_REVIEW:-$state}"
  printf '%s\n' "$state" > "$directory/capture-review.txt"
  printf 'Running %s block %d/%d (%s)\n' "$workload" "$pair" "$count" "$state"
  for attempt in 1 2 3; do
    if SCIENCE_SPINE_CAPTURE_REVIEW="$state" run "$directory/capture" --checkpoint-capture; then break; fi
    mkdir -p "$directory/capture-attempts"
    mv -- "$directory/capture" "$directory/capture-attempts/attempt-$attempt"
  done
  if [[ ! -f "$directory/capture/checkpoint-index.json" ]]; then continue; fi
  checkpoint_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$directory/capture/checkpoint-index.json")"
  checkpoint="$directory/capture/$checkpoint_id"
  if [[ "$controlled" == 1 && "${SCIENCE_SPINE_CONTROLLED_UNVERIFIED_DISPLAY:-0}" == 1 ]]; then
    python3 "$bench/report-state-recovery.py" --degrade-receipt "$checkpoint"
  fi
  if ! run_arms "$directory" "$checkpoint" "$first"; then
    # Allow a pre-tool transport interruption to be repeated as a whole pair.
    if [[ "$controlled" != 1 ]] && python3 "$bench/report-state-recovery.py" --can-retry "$directory"; then
      mkdir "$directory/transport-attempt"
      mv -- "$directory/full" "$directory/by-state" "$directory/arm-order.txt" "$directory/transport-attempt/"
      run_arms "$directory" "$checkpoint" "$first" || true
    fi
  fi
  if [[ "$controlled" == 1 && "${SCIENCE_SPINE_CONTROLLED_CORRUPT_CHECKPOINT:-0}" == 1 ]]; then
    cp -a -- "$checkpoint" "$directory/corrupted-checkpoint"
    control_file=site_qc.csv
    if [[ "$workload" == calibration-review ]]; then control_file=cleaned.csv; fi
    printf '\n' >> "$directory/corrupted-checkpoint/workspace/$control_file"
    if run "$directory/corrupt-rejected" --checkpoint-resume-by-state "$directory/corrupted-checkpoint"; then exit 1; fi
    if ! grep -Fq 'Checkpoint file or history integrity verification failed' "$directory/corrupt-rejected/runner.log" || grep -Fq '[model-sse-summary]' "$directory/corrupt-rejected/runner.log"; then exit 1; fi
  fi
  if [[ "$controlled" != 1 ]] && python3 "$bench/report-state-recovery.py" --slow-pair "$directory"; then
    printf 'Rechecking %s block %d from the same checkpoint\n' "$workload" "$pair"
    mkdir "$directory/latency-recheck"
    reverse=full
    if [[ "$first" == full ]]; then reverse=by-state; fi
    run_arms "$directory/latency-recheck" "$checkpoint" "$reverse" || true
  fi
done
audit_options=()
if [[ "$workload" == calibration-review ]]; then audit_options+=(--require-calibration-handoff); fi
python3 "$bench/report-state-recovery.py" "$root" --workload "$workload" --pairs "$count" "${audit_options[@]}" > "$root/recovery-evidence.md"
