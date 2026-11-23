#!/usr/bin/env node
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { createWriteStream, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function run(command, args, { cwd, env, logPath, echo = false } = {}) {
  return new Promise((resolveRun, reject) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = chunk => {
      log.write(chunk);
      if (echo) process.stdout.write(chunk);
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('error', error => {
      log.end();
      reject(error);
    });
    child.on('close', code => {
      log.end();
      resolveRun(code ?? 1);
    });
  });
}
function removeWorktree(repositoryRoot, worktree) {
  return new Promise(resolveRemoval => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      rmSync(worktree, { recursive: true, force: true });
      resolveRemoval();
    };
    const child = spawn('git', ['worktree', 'remove', '--force', worktree], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}


async function prepare(worktree, env, logPath) {
  const steps = [
    ['pnpm', ['install', '--frozen-lockfile']],
    ['pnpm', ['build']],
  ];
  for (const [project, extras] of [
    ['paper', []],
    ['gateway', []],
    ['memory-graph', ['--extra', 'test']],
    ['evolve', ['--extra', 'test', '--extra', 'candidates']],
    ['adapter', ['--extra', 'test']],
  ]) {
    steps.push(['uv', ['sync', '--project', `services/${project}`, '--locked', ...extras], {
      UV_PROJECT_ENVIRONMENT: join(worktree, 'services', project, '.venv'),
    }]);
  }
  steps.push(
    ['node', ['test/sync-e2e.mjs', '--write']],
    ['npm', ['ci', '--prefix', '.e2e']],
    ['.e2e/node_modules/.bin/playwright', ['install', 'chromium']],
  );
  for (const [command, args, stepEnv] of steps) {
    const code = await run(command, args, { cwd: worktree, env: { ...env, ...stepEnv }, logPath, echo: true });
    if (code !== 0) return code;
  }
  return 0;
}

async function execute(config) {
  const repositoryRoot = resolve(config.repositoryRoot);
  const outputDir = resolve(config.outputDir);
  const instance = safeName(config.instance);
  const worktree = join(repositoryRoot, '.ci-retry', instance);
  const worktreePlan = join(worktree, '.ci-retry-plan.json');
  const logPath = resolve(config.logPath);
  const browserPath = join(worktree, '.e2e', 'browsers');
  const runtimePath = join(worktree, '.ci-runtime', instance);
  const resultsPath = resolve(config.resultsPath);
  let worktreeAdded = false;
  let exitCode = 1;

  await removeWorktree(repositoryRoot, worktree);
  mkdirSync(dirname(worktree), { recursive: true });
  try {
    exitCode = await run('git', ['worktree', 'add', '--detach', '--force', worktree, 'HEAD'], {
      cwd: repositoryRoot,
      env: process.env,
      logPath,
      echo: true,
    });
    if (exitCode !== 0) return exitCode;
    worktreeAdded = true;

    // A retry worktree represents a fresh checkout, so materialize the full
    // revision even when the parent checkout uses sparse-checkout locally.
    await run('git', ['sparse-checkout', 'disable'], {
      cwd: worktree,
      env: process.env,
      logPath,
      echo: true,
    });

    copyFileSync(resolve(config.planPath), worktreePlan);
    const env = {
      ...process.env,
      CI: '1',
      CI_RETRY_ATTEMPT: String(config.attempt ?? 1),
      CI_RETRY_REASON: config.reason ?? 'case_failure',
      CI_E2E_BACKEND: config.backend ?? process.env.CI_E2E_BACKEND ?? 'jiuwenswarm',
      CI_E2E_BROWSERS_DIR: browserPath,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
      CI_RESULTS_DIR: resultsPath,
      CI_RUNTIME_DIR: runtimePath,
      JIUWENSWARM_HOME: join(runtimePath, 'jiuwenswarm'),
      JIUWENSWARM_INSTANCE: `sd-e2e-${instance}`,
      SCIENCE_TAG_PLAN: worktreePlan,
      SCIENCE_TAG_PW_REPORT: resolve(config.reportPath),
      SCIENCE_DISCOVERY_DATA_DIR: join(runtimePath, 'data'),
      SCIENCE_AGENT_DATA_DIR: join(runtimePath, 'data'),
      SCIENCE_TEST_PYTHON: join(worktree, 'services', 'gateway', '.venv', 'bin', 'python'),
      UV_CACHE_DIR: join(worktree, '.tmp', 'cache', 'uv'),
      UV_PYTHON_INSTALL_DIR: join(worktree, '.tmp', 'python'),
      npm_config_cache: join(worktree, '.tmp', 'cache', 'npm'),
    };
    delete env.CI_E2E_PREPARED;
    delete env.CI_E2E_PREPARE_ONLY;
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(resultsPath, { recursive: true });

    exitCode = await prepare(worktree, env, logPath);
    if (exitCode !== 0) return exitCode;

    // Preparation completed in this fresh worktree. The launcher can now use
    // its prepared path without repeating installation in the same attempt.
    env.CI_E2E_PREPARED = '1';
    return await run('bash', ['.ci/run-e2e.sh', config.group], {
      cwd: worktree,
      env,
      logPath,
      echo: true,
    });
  } finally {
    if (worktreeAdded) await removeWorktree(repositoryRoot, worktree);
  }
}

export async function runIsolatedRetry(config) {
  const childConfig = join(resolve(config.outputDir), `${safeName(config.instance)}-config.json`);
  const logPath = resolve(config.logPath);
  mkdirSync(dirname(childConfig), { recursive: true });
  writeFileSync(childConfig, JSON.stringify({
    ...config,
    planPath: resolve(config.planPath),
    reportPath: resolve(config.reportPath),
    outputDir: resolve(config.outputDir),
    logPath,
    resultsPath: resolve(config.resultsPath),
  }, null, 2));
  try {
    return await run(process.execPath, [scriptPath, childConfig], {
      cwd: resolve(config.repositoryRoot),
      env: process.env,
      logPath,
      echo: true,
    });
  } finally {
    rmSync(childConfig, { force: true });
  }
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: retry-runner.mjs <config.json>');
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
  process.exitCode = await execute(config);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
