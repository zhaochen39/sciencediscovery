// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Ordered process supervision for `serve`.
 *
 * The start order and health gating mirror `scripts/start-stack.sh` local
 * mode — gateway, then runner, then the control API that serves the Web UI —
 * so the binary and the repository launcher bring the same stack up the same
 * way. Any service exiting takes the whole stack down, because a half-running
 * stack silently loses tool execution or agent turns.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ServiceDefinition {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Endpoint polled until it answers before the next service starts. */
  healthUrl?: string;
}

export interface SupervisorOptions {
  /** Poll budget per service; the payload's first gateway import is slow. */
  healthAttempts?: number;
  healthIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL during shutdown. */
  shutdownGraceMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_HEALTH_ATTEMPTS = 300;
const DEFAULT_HEALTH_INTERVAL_MS = 200;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

async function probeHealth(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
    return response.ok;
  } catch {
    return false;
  }
}

interface RunningService {
  child: ChildProcess;
  definition: ServiceDefinition;
  /** Resolves once the process is gone, with how it ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  settled: boolean;
  healthy: boolean;
}

export class Supervisor {
  private readonly running: RunningService[] = [];
  private readonly options: Required<Omit<SupervisorOptions, "log">> & { log: (message: string) => void };
  private readonly startup = new AbortController();
  private readonly firstExit = Promise.withResolvers<{ name: string; code: number | null; signal: NodeJS.Signals | null }>();
  private stopWork?: Promise<void>;

  get startupSignal(): AbortSignal { return this.startup.signal; }

  constructor(options: SupervisorOptions = {}) {
    this.options = {
      healthAttempts: options.healthAttempts ?? DEFAULT_HEALTH_ATTEMPTS,
      healthIntervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      log: options.log ?? ((message: string) => process.stderr.write(`${message}\n`)),
    };
  }

  /** Spawn each service in order, gating on health before starting the next. */
  async start(services: readonly ServiceDefinition[], signal = this.startupSignal): Promise<void> {
    const startupSignal = AbortSignal.any([this.startupSignal, signal]);
    for (const definition of services) {
      startupSignal.throwIfAborted();
      this.options.log(`Starting ${definition.name}...`);
      startupSignal.throwIfAborted();
      const child = spawn(definition.command, definition.args, {
        cwd: definition.cwd,
        env: definition.env,
        stdio: "inherit",
      });
      const exit = Promise.withResolvers<Awaited<RunningService["exited"]>>();
      const service: RunningService = { child, definition, settled: false, healthy: !definition.healthUrl, exited: exit.promise };
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (service.settled) return;
        service.settled = true;
        exit.resolve({ code, signal: exitSignal });
        this.firstExit.resolve({ name: definition.name, code, signal: exitSignal });
        const outcome = exitSignal ? `signal ${exitSignal}` : `status ${String(code)}`;
        const phase = service.healthy ? "during startup" : "before becoming healthy";
        this.startup.abort(new Error(`${definition.name} exited ${phase} (${outcome}). See the output above.`));
      };
      child.once("exit", onExit);
      child.on("error", (error) => {
        this.options.log(`${definition.name} could not be started: ${error.message}`);
        if (child.pid === undefined) onExit(127, null);
      });
      this.running.push(service);
      if (definition.healthUrl) {
        await this.waitHealthy(service, definition.healthUrl, startupSignal);
        service.healthy = true;
      }
      startupSignal.throwIfAborted();
    }
  }

  private async waitHealthy(service: RunningService, url: string, signal: AbortSignal): Promise<void> {
    try {
      for (let attempt = 0; attempt < this.options.healthAttempts; attempt += 1) {
        signal.throwIfAborted();
        const healthy = await probeHealth(url, signal);
        signal.throwIfAborted();
        if (healthy) return;
        await delay(this.options.healthIntervalMs, undefined, { signal });
      }
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    throw new Error(`${service.definition.name} did not become healthy at ${url}.`);
  }

  /** True while the named service is still running. Lets a caller outside the class (e.g. a port-discovery poll for a service with no healthUrl) notice it died instead of polling forever. */
  isRunning(name: string): boolean {
    return this.running.some((service) => service.definition.name === name && !service.settled);
  }

  /**
   * Resolve when the first service exits. `serve` awaits this so that a dead
   * gateway or runner brings the stack down instead of leaving a broken UI up.
   */
  waitForFirstExit(): Promise<{ name: string; code: number | null; signal: NodeJS.Signals | null }> {
    return this.firstExit.promise;
  }

  /** SIGTERM every service in reverse start order, escalating to SIGKILL. */
  stop(): Promise<void> {
    this.stopWork ??= Promise.resolve().then(() => this.stopChildren());
    this.startup.abort(new Error("Service startup cancelled by shutdown"));
    return this.stopWork;
  }

  private async stopChildren(): Promise<void> {
    for (const service of [...this.running].reverse()) {
      if (!service.settled) service.child.kill("SIGTERM");
    }
    const pending = this.running.filter((service) => !service.settled);
    const grace = new AbortController();
    try {
      await Promise.race([
        Promise.all(pending.map((service) => service.exited)),
        delay(this.options.shutdownGraceMs, undefined, { signal: grace.signal }),
      ]);
    } finally { grace.abort(); }
    for (const service of this.running) {
      if (!service.settled) {
        this.options.log(`${service.definition.name} ignored SIGTERM; sending SIGKILL.`);
        service.child.kill("SIGKILL");
      }
    }
    await Promise.all(this.running.map((service) => service.exited));
  }
}
