#!/usr/bin/env bash
set -euo pipefail
bench=test/benchmarks/research-spine-value-validation
capture="${1:?original capture directory}"
output="${2:?fresh retry directory}"
baseline="${3:?built original checkout}"
previous="${4:?original experiment directory}"
mapfile -t arms < "$previous/arm-order.txt"
if [[ "${#arms[@]}" != 3 ]]; then
  printf 'Expected three arms in %s\n' "$previous/arm-order.txt" >&2
  exit 2
fi
case "${arms[2]},${arms[1]},${arms[0]}" in
  original,by-state,full) order=original ;;
  by-state,original,full) order=by-state ;;
  full,original,by-state) order=full ;;
  original,full,by-state|by-state,full,original|full,by-state,original) order="${arms[2]},${arms[1]},${arms[0]}" ;;
  *) printf 'Unexpected arm order in %s\n' "$previous/arm-order.txt" >&2; exit 2 ;;
esac
bash "$bench/run-formal-recovery-wsl.sh" "$capture" "$output" "$baseline" "$order"
