#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
old_logs="${1:?admission recheck log directory}"
output="${2:?fresh output root}"
baseline="${3:?built original checkout}"
shift 3
cases=("$@")
if (( ${#cases[@]} == 0 )); then
  cases=(solar-pending-1 calibration-pending-5 solar-pending-5 solar-displayed-2 calibration-displayed-2
    solar-displayed-4 calibration-displayed-4 solar-displayed-6 calibration-displayed-6)
fi
mkdir "$output"
status=0
for case_id in "${cases[@]}"; do
  [[ "$case_id" =~ ^(solar|calibration)-(pending|displayed)-([1-6])$ ]]
  workflow="${BASH_REMATCH[1]}" state="${BASH_REMATCH[2]}" pair="${BASH_REMATCH[3]}"
  pilot=0
  if [[ "$state" == displayed ]]; then pilot=1; fi
  rc=0
  SCIENCE_SPINE_FORMAL_PILOT="$pilot" bash "$bench/rerun-pilot-pair-wsl.sh"     "$old_logs/pilot-captures-$workflow/pair-$pair/capture" "$output/$case_id" "$baseline"     "$old_logs/pilot-formal-$workflow-$state/pair-$pair" || rc=$?
  printf '%s %s\n' "$case_id" "$rc" | tee -a "$output/status.txt"
  if (( rc != 0 )); then status=1; fi
done
exit "$status"
