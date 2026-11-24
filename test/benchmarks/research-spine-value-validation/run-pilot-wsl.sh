#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
captures="${1:?capture root}"
output="${2:?fresh output root}"
baseline="${3:?built original checkout}"
shift 3
pairs=("$@")
if (( ${#pairs[@]} == 0 )); then pairs=(1 2 3 4 5 6); fi
source "${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
candidate_sha="${SCIENCE_SPINE_CANDIDATE_SHA:-$(git rev-parse HEAD)}"
baseline_sha="${SCIENCE_SPINE_BASELINE_SHA:-$(git -C "$baseline" rev-parse HEAD)}"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ && "$baseline_sha" =~ ^[0-9a-f]{40}$ ]]
mkdir "$output"
printf 'candidate=%s\nbaseline=%s\nmodel=%s\napi_variant=%s\nparallel_batches=%s\nstarted_utc=%s\n' \
  "$candidate_sha" "$baseline_sha" \
  "${E2E_LLM_MODEL:?}" "${E2E_LLM_API_VARIANT:-openai}" "${SCIENCE_SPINE_BATCH_PARALLEL_WORKFLOWS:-1}" "$(date -u +%FT%TZ)" > "$output/config.txt"
orders=(original by-state full full,by-state,original original,full,by-state by-state,full,original)
status=0
for pair in "${pairs[@]}"; do
  [[ "$pair" =~ ^[1-6]$ ]]
  capture="$captures/pair-$pair/capture"
  if [[ ! -f "$capture/checkpoint-index.json" ]]; then
    printf 'pair-%s missing capture\n' "$pair" | tee -a "$output/status.txt"
    status=1
    continue
  fi
  dir="$output/pair-$pair"
  rc=0
  bash "$bench/run-formal-recovery-wsl.sh" "$capture" "$dir" "$baseline" "${orders[pair-1]}" || rc=$?
  printf 'pair-%s %s\n' "$pair" "$rc" | tee -a "$output/status.txt"
  if [[ "$rc" != 0 ]]; then status=1; fi
done
exit "$status"
