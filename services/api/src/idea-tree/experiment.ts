// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareShellExecutionContext, type ProvenanceRecorder, type RecordShellExecutionOptions } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import { NO_SANDBOX_NETWORK_ACCESS, type CandidateExperiment, type CandidateExperimentRequest, type CandidateValidationFailure, type IdeaResearchView } from "@sciencediscovery/schema";
import { ResearchTransportError } from "./research.js";
import { validationMetric } from "./validation.js";
import { candidatePreparationOutput } from "./preparation.js";
import type { SessionStore } from "../store.js";

const TIMEOUT_MS = 120_000;
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_SCRIPT = 256 * 1024;
const EXPERIMENT_LIMIT = 20;
const ROLES = ["baseline", "candidate"] as const;
type Role = (typeof ROLES)[number];
const PLAN_ARTIFACTS = [
  ["inputVersionId", "inputHash", MAX_INPUT],
  ["referenceVersionId", "referenceHash", MAX_INPUT],
  ["baselineScriptVersionId", "baselineScriptHash", MAX_SCRIPT],
  ["candidateScriptVersionId", "candidateScriptHash", MAX_SCRIPT],
] as const;

function planDigest(sessionId: string, input: CandidateExperimentRequest, plan: Omit<NonNullable<CandidateExperiment["plan"]>, "digest">) {
  const ids = PLAN_ARTIFACTS.map(([key]) => input[key]);
  return createHash("sha256").update(JSON.stringify([
    sessionId, input.researchId, input.candidateId, input.metric, ...ids, input.preparationRunId, plan,
  ])).digest("hex");
}

export function createExperimentValidation(options: {
  store: SessionStore;
  runner: RunnerClient;
  recorder: ProvenanceRecorder;
  readResearch: (sessionId: string, researchId: string) => Promise<IdeaResearchView>;
  score: (sessionId: string, input: Record<string, unknown>, job: CandidateExperiment) => Promise<IdeaResearchView>;
  attachFailure?: (sessionId: string, job: CandidateExperiment, failure: CandidateValidationFailure) => Promise<unknown>;
}) {
  const { store, runner, recorder } = options;
  const inFlight = new Map<string, Promise<unknown>>();
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const owner = (sessionId: string) => ({ sessionId, agentId: "idea-validation" });
  const root = (sessionId: string) => join(dirname(store.workspacePath(sessionId)), "idea-validations");
  const jobPath = (sessionId: string, id: string) => {
    if (!/^experiment-[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid experiment ID");
    return join(root(sessionId), `${id}.json`);
  };
  const read = async (sessionId: string, id: string): Promise<CandidateExperiment> =>
    JSON.parse(await readFile(jobPath(sessionId, id), "utf8"));
  async function save(sessionId: string, job: CandidateExperiment) {
    const file = jobPath(sessionId, job.id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async function list(sessionId: string, researchId?: string) {
    const names = await readdir(root(sessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const rows = await Promise.all(names.filter(name => /^experiment-[a-f0-9]{64}\.json$/u.test(name))
      .map(name => read(sessionId, name.slice(0, -5))));
    return rows.filter(row => researchId === undefined || row.researchId === researchId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  function active(job: CandidateExperiment) {
    return job.status === "running" || job.status === "unconfirmed";
  }
  async function exclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    while (inFlight.has(sessionId)) await inFlight.get(sessionId)?.catch(() => undefined);
    const task = action();
    inFlight.set(sessionId, task);
    try { return await task; }
    finally { inFlight.delete(sessionId); }
  }
  function version(sessionId: string, id: unknown, maximum: number) {
    if (typeof id !== "string" || id.length > 256) throw new Error("Choose exact artifact versions");
    const artifact = store.getArtifactVersion(sessionId, id);
    if (!artifact || artifact.sessionId !== sessionId || artifact.content.size < 1 || artifact.content.size > maximum) {
      throw new Error("Artifact version is outside this session or exceeds the input limit");
    }
    return artifact;
  }
  function assertPlan(sessionId: string, job: CandidateExperiment) {
    if (!job.plan) return;
    const { digest, ...plan } = job.plan;
    if (digest !== planDigest(sessionId, job, plan) || plan.seed !== job.seed || plan.timeoutMs !== job.timeoutMs
        || PLAN_ARTIFACTS.some(([key, hash, limit]) => version(sessionId, job[key], limit).content.hash !== plan[hash])) {
      throw new Error("Experiment plan or artifact versions changed; start a new comparison");
    }
  }
  async function stage(sessionId: string, job: CandidateExperiment, role: Role): Promise<RecordShellExecutionOptions> {
    store.assertSessionWritable(sessionId);
    store.assertSessionAllowsRunner(sessionId, "local");
    const epoch = store.getSessionPermissionEpoch(sessionId);
    if (!epoch) throw new Error("Session has no execution permission epoch");
    const health = await runner.health();
    if (health.platform !== "linux" || health.sandbox !== "bubblewrap" || health.execution?.readyFor?.shell !== true) {
      throw new Error("Validation requires a ready local managed Bubblewrap Runner");
    }
    const script = version(sessionId, job[role === "baseline" ? "baselineScriptVersionId" : "candidateScriptVersionId"], MAX_SCRIPT);
    const input = version(sessionId, job.inputVersionId, MAX_INPUT);
    const workspaceRoot = join(root(sessionId), job.id, role);
    await mkdir(workspaceRoot, { recursive: true });
    // The API-private workspace contains exactly the selected script and split inputs.
    // The grader's reference Artifact is never staged into it.
    await writeFile(join(workspaceRoot, "solver.py"), await recorder.cas.read(script.content.hash), { flag: "wx", mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await writeFile(join(workspaceRoot, "input.json"), await recorder.cas.read(input.content.hash), { flag: "wx", mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const quota = store.getQuotaSettings();
    return {
      sessionId, agentId: owner(sessionId).agentId, runnerClient: runner, runnerId: "local",
      workspaceRoot, turnId: job.id, toolCallId: role, kernelMode: "ephemeral", explicitHandoff: true,
      executionTimeoutMs: job.timeoutMs,
      maxOutputBytes: job.plan?.maxOutputBytes ?? Math.min(quota.runnerMaxOutputBytes || MAX_INPUT, MAX_INPUT),
      maxWorkspaceBytes: job.plan?.maxWorkspaceBytes ?? Math.min(quota.runnerMaxWorkspaceBytes || 64 * 1024 * 1024, 64 * 1024 * 1024),
      permissionEpoch: { ...epoch, networkPolicy: "none", networkAccess: NO_SANDBOX_NETWORK_ACCESS, secretRefs: [] },
      code: `PYTHONHASHSEED=${job.plan?.seed ?? 0} SCIDISCOVERY_EXPERIMENT_SEED=${job.plan?.seed ?? 0} python3 -s -B solver.py input.json\n`,
    };
  }
  const intent = (sessionId: string, job: CandidateExperiment, role: Role) =>
    store.shellExecutions.list(owner(sessionId)).find(row => row.turnId === job.id && row.workspaceId === `${job.id}:${role}`);

  function schedule(sessionId: string, job: CandidateExperiment) {
    if (closed || !active(job) || scheduled.has(job.id)) return;
    const timer = setTimeout(async () => {
      scheduled.delete(job.id);
      try {
        const result = await exclusive(sessionId, async () => {
          if (closed || !store.getSession(sessionId)) return;
          return advance(sessionId, await read(sessionId, job.id));
        });
        if (result) schedule(sessionId, result);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") schedule(sessionId, job);
      }
    }, job.status === "unconfirmed" ? 5_000 : 800);
    scheduled.set(job.id, timer);
    timer.unref();
  }

  async function cancelExecution(sessionId: string, job: CandidateExperiment) {
    const execution = job.executionIds.candidate ?? intent(sessionId, job, "candidate")?.id
      ?? job.executionIds.baseline ?? intent(sessionId, job, "baseline")?.id;
    if (execution) {
      const record = await store.shellExecutions.cancel(execution, owner(sessionId), () => runner);
      if (["unknown", "queued", "running"].includes(record.state)) {
        job.status = "unconfirmed";
        await save(sessionId, job);
        return job;
      }
    }
    job.status = "cancelled";
    await save(sessionId, job);
    return job;
  }

  async function finishFailure(sessionId: string, job: CandidateExperiment) {
    try {
      if (job.failure) await options.attachFailure?.(sessionId, job, job.failure);
      job.status = "failed";
    } catch (error) {
      job.status = error instanceof ResearchTransportError ? "unconfirmed" : "failed";
    }
    await save(sessionId, job);
    return job;
  }

  async function fail(sessionId: string, job: CandidateExperiment, failure: Omit<CandidateValidationFailure, "id">) {
    job.status = "unconfirmed";
    job.failure = { id: job.id, ...failure };
    await save(sessionId, job);
    return finishFailure(sessionId, job);
  }

  async function advance(sessionId: string, job: CandidateExperiment) {
    if (!active(job)) return job;
    try {
      if (job.stopRequested) return await cancelExecution(sessionId, job);
      if (job.failure) return await finishFailure(sessionId, job);
      assertPlan(sessionId, job);
      for (const role of ROLES) {
        job.stage = role === "baseline" ? "baseline_execution" : "candidate_execution";
        const id = job.executionIds[role];
        const wsIdentity = (role: Role) => `${job.id}:${role}`;
        let record;
        if (id) {
          record = await store.shellExecutions.wait(id, owner(sessionId), 0, undefined, () => runner);
        } else {
          // Reuse a durable intent if the API stopped between Runner acceptance and saving the job.
          const existing = intent(sessionId, job, role);
          if (existing) record = await store.shellExecutions.wait(existing.id, owner(sessionId), 0, undefined, () => runner);
          else {
            const prepared = await stage(sessionId, job, role);
            record = await store.shellExecutions.start(owner(sessionId), {
              runnerId: "local", turnId: job.id, workspaceId: wsIdentity(role),
            }, () => runner,
            (executionId, dispatch, completionStatus) => recorder.executeShell({ ...prepared, executionId, dispatch, completionStatus }),
            executionId => prepareShellExecutionContext({ ...prepared, executionId }),
            (context, failure) => recorder.commitExistingShellExecutionFailure(context, failure));
          }
          job.executionIds[role] = record.id;
          await save(sessionId, job);
        }
        if (record.state === "queued" || record.state === "running") return job;
        if (record.state === "unknown" || record.provenance === "unconfirmed") {
          job.status = "unconfirmed";
          await save(sessionId, job);
          return job;
        }
        if (record.state !== "completed" || record.provenance !== "committed") {
          job.status = record.state === "cancelled" ? "cancelled" : "failed";
          job.error = `${role}: ${record.error ?? record.state}`;
          if (job.status === "failed") {
            const code = /timeout|timed out/u.test(job.error.toLowerCase()) ? "timeout" : "execution_failed";
            return await fail(sessionId, job, { stage: job.stage, code, executionId: record.id });
          }
          await save(sessionId, job);
          return job;
        }
        job.status = "running";
        if (job.predictionVersionIds[role]) continue;
        const receipt = (await store.listExecutionRuns(sessionId)).findLast(run => run.id === record.id);
        if (!receipt || receipt.status !== "succeeded") throw new Error(`${role}: committed execution receipt is missing`);
        if (role === "candidate") {
          const baseline = (await store.listExecutionRuns(sessionId)).findLast(run => run.id === job.executionIds.baseline);
          if (!baseline || baseline.environmentRevisionId !== receipt.environmentRevisionId
            || baseline.runnerVersion !== receipt.runnerVersion || baseline.permissionEpochId !== receipt.permissionEpochId
            || baseline.envSnapshot?.hash !== receipt.envSnapshot?.hash) {
            throw new Error("Baseline and candidate execution environments changed during the comparison");
          }
        }
        const content = receipt.stdout;
        if (content.size < 1 || content.size >= MAX_INPUT
          || record.result?.stdout.includes("...[output truncated:") || record.result?.stderr.includes("...[output truncated:")) {
          job.error = `${role}: prediction output is empty, truncated, or too large`;
          return await fail(sessionId, job, { stage: "scoring", code: "invalid_predictions", executionId: receipt.id });
        }
        const logicalName = `idea-validation/${job.id}/${role}.json`;
        // Publication and job state are persisted separately. Recover the
        // version created before a crash instead of publishing it twice.
        const prior = store.listArtifacts(sessionId).find(artifact => artifact.name === logicalName && artifact.origin === "server_generated");
        const recovered = prior && store.listArtifactVersions(sessionId, prior.id).find(version =>
          version.sessionId === sessionId && version.turnId === job.id && version.executionRunIds.includes(record.id)
          && version.content.hash === content.hash && version.content.size === content.size);
        const prediction = recovered ?? (await store.createArtifactVersion({
          sessionId, logicalName, sourcePath: "predictions.json", origin: "server_generated",
          kind: "json", mediaType: "application/json", content, turnId: job.id,
          executionRunIds: [record.id], inputArtifactVersionIds: [job.inputVersionId, job[role === "baseline" ? "baselineScriptVersionId" : "candidateScriptVersionId"]],
        })).version;
        job.predictionVersionIds[role] = prediction.id;
        await save(sessionId, job);
      }
      job.stage = "scoring";
      const view = await options.score(sessionId, { researchId: job.researchId, candidateId: job.candidateId,
        metric: job.metric, referenceVersionId: job.referenceVersionId, baselineVersionId: job.predictionVersionIds.baseline,
        candidateVersionId: job.predictionVersionIds.candidate }, job);
      job.stage = "attachment";
      const result = view.graph.nodes.find(node => node.id === job.candidateId)?.validations?.find(result =>
        result.candidateVersionId === job.predictionVersionIds.candidate && result.baselineVersionId === job.predictionVersionIds.baseline
        && result.referenceVersionId === job.referenceVersionId && result.metric === job.metric
        && result.baselineExecutionId === job.executionIds.baseline && result.candidateExecutionId === job.executionIds.candidate
        && (!job.plan || (result.planDigest === job.plan.digest && result.seed === job.plan.seed && result.scorerVersion === job.plan.scorerVersion)));
      if (!result) throw new ResearchTransportError("Validation attachment could not be confirmed");
      job.validationId = result.id;
      job.result = result;
      job.status = "ready";
      delete job.error;
    } catch (error) {
      job.status = error instanceof ResearchTransportError || job.stopRequested ? "unconfirmed" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
      if (job.status === "failed" && job.stage === "scoring") {
        return await fail(sessionId, job, { stage: "scoring", code: "invalid_predictions", executionId: job.executionIds.candidate });
      }
    }
    await save(sessionId, job);
    return job;
  }
  async function start(sessionId: string, input: CandidateExperimentRequest, prior?: CandidateExperiment) {
    store.assertSessionWritable(sessionId);
    const view = await options.readResearch(sessionId, input.researchId);
    if (!view.research.settings.candidateValidationEnabled || !["paused", "interrupted", "completed"].includes(view.research.status)
      || !view.graph.nodes.some(node => node.id === input.candidateId && node.kind === "candidate" && node.status === "done")) {
      throw new Error("Choose an evaluated candidate in an opted-in research that is paused or complete");
    }
    const preparationRunId = input.preparationRunId;
    if (preparationRunId !== undefined) {
      if (typeof preparationRunId !== "string") throw new Error("Invalid preparation run ID");
      const run = await store.getSessionRun(sessionId, preparationRunId);
      const preparation = run?.candidatePreparation;
      if (!run || !preparation || preparation.researchId !== input.researchId || preparation.candidateId !== input.candidateId
          || preparation.inputVersionId !== input.inputVersionId
          || candidatePreparationOutput(store, sessionId, run).versionId !== input.candidateScriptVersionId) {
        throw new Error("The candidate script must be the published output of its preparation run");
      }
    }
    const metric = validationMetric(input.metric);
    const ids = PLAN_ARTIFACTS.map(([key]) => input[key]);
    const versions = PLAN_ARTIFACTS.map(([key, , limit]) => version(sessionId, input[key], limit));
    if (new Set(ids).size !== ids.length || versions[0]?.content.hash === versions[1]?.content.hash) {
      throw new Error("Choose separate split inputs, reference labels and two scripts");
    }
    if (versions.slice(2).some(item => !item.sourcePath?.toLowerCase().endsWith(".py") && item.mediaType !== "text/x-python")) {
      throw new Error("Both solver artifacts must be Python scripts");
    }
    const seed = input.seed ?? 0;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("Choose a 32-bit unsigned seed");
    const quota = store.getQuotaSettings();
    const timeoutMs = Math.min(store.getTimeoutSettings().runnerExecTimeoutMs || TIMEOUT_MS, TIMEOUT_MS);
    const [data, reference, baseline, candidate] = versions;
    const descriptor = {
      schemaVersion: 1 as const, seed, scorerVersion: "matched-json-samples/v1" as const,
      inputHash: data!.content.hash, referenceHash: reference!.content.hash,
      baselineScriptHash: baseline!.content.hash, candidateScriptHash: candidate!.content.hash,
      timeoutMs, maxOutputBytes: Math.min(quota.runnerMaxOutputBytes || MAX_INPUT, MAX_INPUT),
      maxWorkspaceBytes: Math.min(quota.runnerMaxWorkspaceBytes || 64 * 1024 * 1024, 64 * 1024 * 1024),
    };
    if (prior) assertPlan(sessionId, prior);
    const plan = prior?.plan ?? { ...descriptor, digest: planDigest(sessionId, { ...input, metric }, descriptor) };
    const attempt = (prior?.attempt ?? 0) + 1;
    const id = `experiment-${createHash("sha256").update(JSON.stringify([prior?.id ?? plan.digest, attempt])).digest("hex")}`;
    const jobs = await list(sessionId);
    const existing = jobs.find(job => job.id === id || (!prior && !job.plan && seed === 0
      && job.researchId === input.researchId && job.candidateId === input.candidateId && job.metric === metric
      && job.inputVersionId === input.inputVersionId && job.referenceVersionId === input.referenceVersionId
      && job.baselineScriptVersionId === input.baselineScriptVersionId && job.candidateScriptVersionId === input.candidateScriptVersionId));
    if (existing) {
      schedule(sessionId, existing);
      return existing;
    }
    if (jobs.some(active) || jobs.length >= EXPERIMENT_LIMIT) throw new Error("A validation is already active or the session limit has been reached");
    const job: CandidateExperiment = { id, researchId: input.researchId, candidateId: input.candidateId, metric,
      inputVersionId: input.inputVersionId, referenceVersionId: input.referenceVersionId, baselineScriptVersionId: input.baselineScriptVersionId,
      candidateScriptVersionId: input.candidateScriptVersionId, status: "running", createdAt: new Date().toISOString(),
      timeoutMs: plan.timeoutMs, plan, seed, preparationRunId, attempt, retryOf: prior?.id, executionIds: {}, predictionVersionIds: {} };
    await save(sessionId, job);
    schedule(sessionId, job);
    return job;
  }

  return {
    list,
    assertNoPreparation: async (sessionId: string, researchId: unknown) => {
      const preparing = (await store.listSessionRuns(sessionId)).some(run => run.candidatePreparation?.researchId === researchId
        && ["queued", "running", "blocked"].includes(run.status));
      if (preparing) throw new Error("Wait for the candidate preparation to finish or stop that Agent run before resuming research");
    },
    async resume() {
      for (const project of store.listProjects()) {
        for (const session of store.listSessions(project.id)) {
          for (const job of await list(session.id)) schedule(session.id, job);
        }
      }
    },
    close() {
      closed = true;
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    },
    control: <T>(sessionId: string, researchId: unknown, apply: () => Promise<T>) => exclusive(sessionId, async () => {
      if ((await list(sessionId)).some(job => job.researchId === researchId && active(job))) {
        throw new Error("Wait for the candidate experiment to settle or cancel it before resuming research");
      }
      return apply();
    }),
    start: (sessionId: string, input: CandidateExperimentRequest) => exclusive(sessionId, () => start(sessionId, input)),
    retry: (sessionId: string, id: string) => exclusive(sessionId, async () => {
      const prior = await read(sessionId, id);
      if (prior.status !== "failed" && prior.status !== "cancelled") throw new Error("Retry a settled failed or cancelled experiment");
      return start(sessionId, prior, prior);
    }),
    poll: read,
    cancel: (sessionId: string, id: string) => exclusive(sessionId, async () => {
      store.assertSessionWritable(sessionId);
      const job = await read(sessionId, id);
      if (!active(job)) return job;
      job.stopRequested = true;
      await save(sessionId, job);
      schedule(sessionId, job);
      return job;
    }),
  };
}
