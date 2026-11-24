#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
root="${SCIENCE_SPINE_LOG_DIR:?Set a fresh recovery log directory}"
if [[ -z "${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}" ]]; then mkdir "$root"; fi
root="$(cd "$root" && pwd)"
export SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_MODES=projection SCIENCE_SPINE_REQUIRE_REVIEW=1 SCIENCE_SPINE_RECOVERY_AUDIT=1
export SCIENCE_SPINE_RECOVERY_USAGE_AUDIT=1
receipt_mode="${SCIENCE_SPINE_RECOVERY_RECEIPT:-0}"
evidence_mode="${SCIENCE_SPINE_RECOVERY_EVIDENCE:-0}"
evidence_source="${SCIENCE_SPINE_EVIDENCE_DIAGNOSTIC_SOURCE:-}"
retire_mode="${SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY:-0}"
retire_source="${SCIENCE_SPINE_RETIRE_DISPLAY_DIAGNOSTIC_SOURCE:-}"
transport_retry_source="${SCIENCE_SPINE_RETIRE_DISPLAY_TRANSPORT_RETRY_SOURCE:-}"
diagnostic_source="${retire_source:-${evidence_source:-${SCIENCE_SPINE_RECEIPT_DIAGNOSTIC_SOURCE:-}}}"
if [[ "$receipt_mode" == 1 || "$evidence_mode" == 1 || "$retire_mode" == 1 || "${SCIENCE_SPINE_RECOVERY_HANDOFF:-0}" == 1 ]]; then
  export SCIENCE_SPINE_RECOVERY_NEXT_STEP=1
fi
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
  if [[ "${SCIENCE_SPINE_RECOVERY_CONTROLLED:-0}" == 1 ]]; then
    runner=(pnpm exec tsx "$bench/run-live.ts")
  fi
  # Start timing before the runner launches, including checkpoint validation,
  # workspace preparation and process startup for all three arms.
  local TIMEFORMAT='%3R'
  date +%s%3N > "$directory/started-epoch-ms.txt"
  { time SCIENCE_SPINE_LOG_DIR="$directory" "${runner[@]}" "$@" > "$directory/runner.log" 2>&1; } 2> "$directory/wall-seconds.txt" || status=$?
  printf '%s\n' "$status" > "$directory/exit-code.txt"
  return "$status"
}
archive_capture() {
  local directory="$1" archive="$1/capture-attempts" attempt=1
  mkdir -p "$archive" || return 1
  while [[ -e "$archive/attempt-$attempt" ]]; do attempt=$((attempt + 1)); done
  mv -- "$directory/capture" "$archive/attempt-$attempt"
}
run_pair() {
  local pair="$1" directory="$root/pair-$1" checkpoint_id checkpoint arm status=0
  local -a order
  if [[ "${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}" != "$pair" ]]; then
    mkdir "$directory" || return 1
  fi
  if [[ -n "$diagnostic_source" ]]; then
    local source_block="$diagnostic_source/pair-$((pair * 2))"
    if [[ "$(cat "$source_block/capture-review.txt")" != displayed ]]; then return 1; fi
    cp -a -- "$source_block/capture" "$directory/capture" || return 1
    cp -- "$source_block/capture-review.txt" "$directory/capture-review.txt" || return 1
    printf '%s\n' "$source_block" > "$directory/diagnostic-source.txt"
  elif [[ "${SCIENCE_SPINE_RECOVERY_NEXT_STEP:-0}" == 1 ]]; then
    local review_state="${SCIENCE_SPINE_CAPTURE_REVIEW:-pending}"
    if [[ -z "${SCIENCE_SPINE_CAPTURE_REVIEW:-}" ]] && ((pair % 2 == 0)); then review_state=displayed; fi
    printf '%s\n' "$review_state" > "$directory/capture-review.txt"
    local attempt=1
    until SCIENCE_SPINE_CAPTURE_REVIEW="$review_state" run "$directory/capture" --checkpoint-capture; do
      # A capture is eligible by QC state only. No delivery arm has started yet.
      if ((attempt >= 3)); then return 1; fi
      archive_capture "$directory" || return 1
      attempt=$((attempt + 1))
    done
  else
    run "$directory/capture" --checkpoint-capture || return 1
  fi
  checkpoint_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$directory/capture/checkpoint-index.json")" || return 1
  checkpoint="$directory/capture/$checkpoint_id"
  case $(( (pair - 1) % 3 )) in
    0) order=(resume compact restart) ;;
    1) order=(compact restart resume) ;;
    2) order=(restart resume compact) ;;
  esac
  if [[ "${SCIENCE_SPINE_RECOVERY_NEXT_STEP:-0}" == 1 ]]; then
    case $(( (pair - 1) % 6 )) in
      0) order=(resume compact restart next-step) ;;
      1) order=(compact next-step resume restart) ;;
      2) order=(next-step restart compact resume) ;;
      3) order=(restart resume next-step compact) ;;
      4) order=(next-step resume compact restart) ;;
      5) order=(restart compact resume next-step) ;;
    esac
  fi
  if [[ "${SCIENCE_SPINE_RECOVERY_HANDOFF:-0}" == 1 ]]; then
    case $(( (pair - 1) % 6 )) in
      0) order=(resume compact handoff next-step) ;;
      1) order=(compact next-step resume handoff) ;;
      2) order=(next-step handoff compact resume) ;;
      3) order=(handoff resume next-step compact) ;;
      4) order=(compact resume next-step handoff) ;;
      5) order=(next-step handoff resume compact) ;;
    esac
  fi
  if [[ -n "$retire_source" ]]; then
    case "$pair" in
      1) order=(handoff evidence retire-display) ;;
      2) order=(evidence retire-display handoff) ;;
      3) order=(retire-display handoff evidence) ;;
    esac
  elif [[ -n "$diagnostic_source" ]]; then
    if ((pair == 1)); then order=(handoff receipt); else order=(receipt handoff); fi
  elif [[ "$receipt_mode" == 1 || "$evidence_mode" == 1 || "$retire_mode" == 1 ]]; then
    case $(( (pair - 1) % 6 )) in
      0) order=(resume compact receipt handoff) ;;
      1) order=(compact handoff resume receipt) ;;
      2) order=(handoff receipt compact resume) ;;
      3) order=(receipt resume handoff compact) ;;
      4) order=(compact resume handoff receipt) ;;
      5) order=(handoff receipt resume compact) ;;
    esac
  fi
  if [[ "$evidence_mode" == 1 ]]; then order=("${order[@]/receipt/evidence}"); fi
  if [[ "$retire_mode" == 1 && -z "$retire_source" ]]; then order=("${order[@]/receipt/retire-display}"); fi
  printf '%s\n' "${order[@]}" > "$directory/arm-order.txt"
  for arm in "${order[@]}"; do
    case "$arm" in
      resume) run "$directory/$arm" --checkpoint-resume "$checkpoint" || status=1 ;;
      compact) run "$directory/$arm" --checkpoint-resume-compact "$checkpoint" || status=1 ;;
      retire-display) run "$directory/$arm" --checkpoint-resume-retire-display "$checkpoint" || status=1 ;;
      evidence) run "$directory/$arm" --checkpoint-resume-evidence "$checkpoint" || status=1 ;;
      receipt) run "$directory/$arm" --checkpoint-resume-receipt "$checkpoint" || status=1 ;;
      handoff) run "$directory/$arm" --checkpoint-resume-handoff "$checkpoint" || status=1 ;;
      next-step) run "$directory/$arm" --checkpoint-resume-next-step "$checkpoint" || status=1 ;;
      restart) run "$directory/$arm" || status=1 ;;
    esac
  done
  return "$status"
}

count="${SCIENCE_SPINE_REPETITIONS:-3}"
if [[ ! "$count" =~ ^[1-9][0-9]*$ ]]; then
  echo "Expected a positive SCIENCE_SPINE_REPETITIONS count" >&2
  exit 2
fi
if [[ -n "$retire_source" ]]; then
  if [[ "$retire_mode" != 1 || "$count" != 3 || -n "${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}" ]]; then
    echo "Display retirement diagnostics require retirement mode, three blocks, and fresh output" >&2
    exit 2
  fi
elif [[ -n "$evidence_source" ]]; then
  if [[ "$evidence_mode" != 1 || "$count" != 3 || -n "${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}" ]]; then
    echo "Evidence diagnostics require evidence mode, three blocks, and fresh output" >&2
    exit 2
  fi
elif [[ -n "$diagnostic_source" && ( "$receipt_mode" != 1 || "$count" != 2 || -n "${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}" ) ]]; then
  echo "Receipt diagnostics require receipt mode, two blocks, and fresh output" >&2
  exit 2
fi
if [[ -n "$transport_retry_source" && -z "$retire_source" ]]; then
  echo "Transport retry requires a retirement diagnostic source" >&2
  exit 2
fi
export SCIENCE_SPINE_REPETITIONS=1
status=0
retry="${SCIENCE_SPINE_RETRY_CAPTURE_BLOCK:-}"
if [[ -n "$retry" ]]; then
  if [[ ! "$retry" =~ ^[1-9][0-9]*$ ]] || (( retry > count )) || [[ "${SCIENCE_SPINE_RECOVERY_NEXT_STEP:-0}" != 1 ]]; then
    echo "Retry requires a next-step block number within the original batch" >&2
    exit 2
  fi
  directory="$root/pair-$retry"
  if [[ ! -f "$directory/capture/exit-code.txt" ]] || [[ "$(cat "$directory/capture/exit-code.txt")" == 0 ]] \
    || [[ -e "$directory/resume" || -e "$directory/compact" || -e "$directory/next-step" || -e "$directory/restart" || -e "$directory/handoff" || -e "$directory/receipt" || -e "$directory/evidence" || -e "$directory/retire-display" ]]; then
    echo "Only a failed capture with no started delivery arms can be retried" >&2
    exit 2
  fi
  archive_capture "$directory"
  echo "Retrying capture for recovery block $retry/$count"
  run_pair "$retry" || status=1
else
  if [[ -n "$transport_retry_source" ]]; then
    transport_retry_source="$(cd "$transport_retry_source" && pwd)"
    # Reuse complete blocks only. Repeat every arm of a block interrupted by the gateway.
    retry_blocks="$(python3 - "$transport_retry_source" "$count" <<'PY'
import json
from pathlib import Path
import sys

root, count = Path(sys.argv[1]), int(sys.argv[2])
if not (root / "recovery-evidence.md").is_file():
    raise SystemExit("The previous diagnostic has not finished")
for pair in range(1, count + 1):
    failed = False
    for arm in ("handoff", "evidence", "retire-display"):
        directory = root / f"pair-{pair}" / arm
        if (directory / "exit-code.txt").read_text().strip() == "0":
            continue
        result = json.loads((directory / "recovery-result.json").read_text())["result"]
        if result["toolCalls"] or result["modelTurns"] != 1 or not (result.get("error") or "").startswith(
                "ModelRequestError: Model request failed with status 502:"):
            raise SystemExit(f"Block {pair} contains a failure outside the transport retry rule")
        failed = True
    if failed:
        print(pair)
PY
)"
    printf '%s\n' "$transport_retry_source" > "$root/transport-retry-source.txt"
  fi
  for ((pair=1; pair<=count; pair++)); do
    if [[ -n "$transport_retry_source" ]] && ! grep -Fxq "$pair" <<< "$retry_blocks"; then
      ln -s "$transport_retry_source/pair-$pair" "$root/pair-$pair"
      continue
    fi
    echo "Running recovery block $pair/$count"
    run_pair "$pair" || status=1
  done
fi
report=--compact-recovery
if [[ "${SCIENCE_SPINE_RECOVERY_NEXT_STEP:-0}" == 1 ]]; then report=--next-step-recovery; fi
if [[ "${SCIENCE_SPINE_RECOVERY_HANDOFF:-0}" == 1 ]]; then report=--workspace-handoff-recovery; fi
if [[ "$receipt_mode" == 1 ]]; then report=--display-receipt-recovery; fi
if [[ -n "${SCIENCE_SPINE_RECEIPT_DIAGNOSTIC_SOURCE:-}" ]]; then report=--receipt-diagnostic; fi
if [[ "$evidence_mode" == 1 ]]; then report=--display-evidence-recovery; fi
if [[ -n "$evidence_source" ]]; then report=--evidence-diagnostic; fi
if [[ "$retire_mode" == 1 ]]; then report=--retire-display-recovery; fi
if [[ -n "$retire_source" ]]; then report=--retire-display-diagnostic; fi
python3 "$bench/report-paired.py" "$root" "$report" --expected-pairs "$count" > "$root/recovery-evidence.md" || status=1
exit "$status"
