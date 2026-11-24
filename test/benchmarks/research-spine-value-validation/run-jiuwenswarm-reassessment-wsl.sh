#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
if [[ $# -lt 3 ]]; then
  echo "Usage: $0 BASELINE_DIR OUTPUT_DIR controlled-1|controlled-2|real-1|real-2|receipt-controlled|receipt-real|scope-controlled|scope-real|tree-controlled|tree-real|observe-controlled|observe-real|native-receipt-controlled|native-receipt-real|graph-controlled|graph-real|idea-controlled|idea-real|evolve-controlled|evolve-real|calibration-real|fault-controlled|isolation-controlled|isolation-real [...]" >&2
  exit 2
fi
export SCIENCE_SPINE_BASELINE=$(realpath "$1")
mkdir -p "$2"
export SCIENCE_SPINE_LOG=$(realpath "$2")
shift 2
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
export TMPDIR="${SCIENCE_SPINE_SCRATCH:-$HOME/.cache/science-spine-tmp}"
mkdir -p "$TMPDIR"
export CI_RUNTIME_DIR="${CI_RUNTIME_DIR:-$(mktemp -d "$TMPDIR/swarm-runtime.XXXXXX")}"
export JIUWENSWARM_INSTANCE="${JIUWENSWARM_INSTANCE:-sd-spine-reassessment}"
export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task
bash scripts/with-jiuwenswarm.sh bash -c '
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
status=0
for cohort; do
  case "$cohort" in
    controlled-1|controlled-2|real-1|real-2|receipt-controlled|receipt-real|scope-controlled|scope-real|tree-controlled|tree-real|observe-controlled|observe-real|native-receipt-controlled|native-receipt-real|graph-controlled|graph-real|idea-controlled|idea-real|evolve-controlled|evolve-real|calibration-real|fault-controlled|isolation-controlled|isolation-real) ;;
    *) echo "Unknown cohort: $cohort" >&2; exit 2 ;;
  esac
  flavor=${cohort%-*}
  fixture=${cohort##*-}
  export SCIENCE_SPINE_RECEIPT_PROBE=0
  export SCIENCE_SPINE_SCOPE_PROBE=0
  export SCIENCE_SPINE_SCOPE_TREE_PROBE=0
  export SCIENCE_SPINE_SCOPE_OBSERVE_PROBE=0
  export SCIENCE_SPINE_NATIVE_RECEIPT_PROBE=0
  export SCIENCE_SPINE_SCOPE_GRAPH_PROBE=0
  export SCIENCE_SPINE_IDEA_PROBE=0
  export SCIENCE_SPINE_EVOLVE_PROBE=0
  export SCIENCE_SPINE_CALIBRATION_PROBE=0
  export SCIENCE_SPINE_SWARM_FAULT_PROBE=0
  export SCIENCE_SPINE_SWARM_ISOLATION_PROBE=0
  if [[ "$flavor" == isolation ]]; then export SCIENCE_SPINE_SWARM_ISOLATION_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == fault ]]; then export SCIENCE_SPINE_SWARM_FAULT_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == calibration ]]; then export SCIENCE_SPINE_CALIBRATION_PROBE=1; flavor=real; fixture=1; fi
  export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task
  if [[ "$flavor" == native-receipt ]]; then export SCIENCE_SPINE_NATIVE_RECEIPT_PROBE=1; export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=jiuwenswarm; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == evolve ]]; then export SCIENCE_SPINE_EVOLVE_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == idea ]]; then export SCIENCE_SPINE_IDEA_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == graph ]]; then export SCIENCE_SPINE_SCOPE_GRAPH_PROBE=1; export SCIENCE_SPINE_SCOPE_OBSERVE_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == observe ]]; then export SCIENCE_SPINE_SCOPE_OBSERVE_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == tree ]]; then export SCIENCE_SPINE_SCOPE_TREE_PROBE=1; flavor=$fixture; fixture=1; fi
  if [[ "$flavor" == receipt || "$flavor" == scope ]]; then
    if [[ "$flavor" == receipt ]]; then export SCIENCE_SPINE_RECEIPT_PROBE=1; else export SCIENCE_SPINE_SCOPE_PROBE=1; fi
    flavor=$fixture
    fixture=1
  fi
  if [[ "$fixture" == 1 && "$cohort" != receipt-real && "$cohort" != scope-real && "$cohort" != tree-real && "$cohort" != observe-real && "$cohort" != native-receipt-real && "$cohort" != graph-real && "$cohort" != idea-real && "$cohort" != evolve-real ]]; then arms=(original candidate); else arms=(candidate original); fi
  if [[ "${SCIENCE_SPINE_SWARM_MATRIX:-0}" == 1 ]]; then
    if [[ "${SCIENCE_SPINE_SWARM_MATRIX_REVERSE:-0}" == 1 ]]; then
      arms=("${arms[1]}" "${arms[0]}")
    fi
    if [[ "${arms[0]}" == original ]]; then
      arms=(original candidate-off candidate)
    else
      arms=(candidate candidate-off original)
    fi
  fi
  if [[ "${SCIENCE_SPINE_SCOPE_FOLD_PROBE:-0}" == 1 && "$flavor" =~ ^(real|controlled)$ ]]; then
    arms=(original candidate-no-fold candidate)
  fi
  for arm in "${arms[@]}"; do
    code_arm=$arm
    fold=0
    if [[ "${SCIENCE_SPINE_SCOPE_FOLD_PROBE:-0}" == 1 ]]; then
      if [[ "$arm" == candidate-no-fold ]]; then code_arm=candidate; fi
      if [[ "$arm" == candidate ]]; then fold=1; fi
    fi
    adapted="${SCIENCE_SPINE_SWARM_ADAPTED:-0}"
    if [[ "${SCIENCE_SPINE_SWARM_MATRIX:-0}" == 1 ]]; then
      adapted=0
      if [[ "$arm" == candidate-off ]]; then code_arm=candidate; fi
      if [[ "$arm" == candidate || "$arm" == candidate-no-fold ]]; then adapted=1; fi
    fi
    dir="$SCIENCE_SPINE_LOG/$cohort/$arm"
    mkdir -p "$(dirname "$dir")"
    mkdir "$dir"
    data=$(mktemp -d "$TMPDIR/jiuwen-data.XXXXXX")
    printf "%s\n" "$data" > "$dir/data-dir.txt"
    result=0
    SCIENCE_SPINE_SWARM_ADAPTED="$adapted" SCIENCE_AGENT_JIUWENSWARM_SCOPE_FOLD_CLOSED="$fold" pnpm exec tsx "$bench/run-jiuwenswarm-reassessment.ts" "$dir" "$data" "$bench/fixtures/citations/case-$fixture" "$flavor" "$code_arm" "$SCIENCE_SPINE_BASELINE" > "$dir/driver.log" 2>&1 || result=$?
    printf "%d\n" "$result" > "$dir/exit-code.txt"
    printf "%s %s exit=%d\n" "$cohort" "$arm" "$result"
    if ((result != 0)); then status=1; fi
  done
done
exit "$status"' _ "$@" | tee "$SCIENCE_SPINE_LOG/run-$1.log"
