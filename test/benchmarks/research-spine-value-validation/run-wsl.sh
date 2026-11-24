#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
env_file="${SCIENCE_SPINE_ENV_FILE:-/mnt/d/work/agent/ci_bench/env.sh}"
if [[ ! -f "$env_file" ]]; then
  echo "missing model environment file: $env_file" >&2
  exit 2
fi
source "$env_file"
export CI="true"
cd "$repo_root"
export SCIENCE_AGENT_CONTEXT_TRACE="1"
export SCIENCE_SPINE_LOG_DIR="${SCIENCE_SPINE_LOG_DIR:-$repo_root/test/benchmarks/research-spine-value-validation/logs}"
pnpm exec tsx test/benchmarks/research-spine-value-validation/run-live.ts "$@"
