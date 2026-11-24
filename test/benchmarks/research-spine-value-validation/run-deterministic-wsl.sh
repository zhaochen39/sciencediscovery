#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
export CI=true
export SCIENCE_SPINE_REPETITIONS="${SCIENCE_SPINE_REPETITIONS:-20}"
export SCIENCE_SPINE_LOG_DIR="${SCIENCE_SPINE_LOG_DIR:-$repo_root/test/benchmarks/research-spine-value-validation/logs/deterministic-$(date +%Y%m%d-%H%M%S)}"
pnpm exec tsx test/benchmarks/research-spine-value-validation/run-deterministic.ts
