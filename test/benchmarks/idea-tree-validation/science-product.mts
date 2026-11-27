// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CandidateExperiment, CandidatePreparationResult, IdeaResearchView, SessionArtifactOutput, SessionRun, SessionUsageSummary } from "@sciencediscovery/schema";

// The fixture directory contains development files only. Keep the official
// held-out inputs and scorer in a separate process until this file is locked.
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const data = env("SCIENCE_TASK_DIR");
const output = env("SCIENCE_TRIAL_DIR");
const token = env("E2E_API_TOKEN");
const origin = env("E2E_BASE_URL");
const mode = env("SCIENCE_TRIAL_ARM");
assert.ok(["A", "B", "C"].includes(mode));
assert.equal(process.env.SCIENCE_CONFIRM_ISOLATED_STACK, "1");
const model = env("REAL_LLM_MODEL");
const task = JSON.parse(await readFile(join(data, "task.json"), "utf8")) as {
  id: string; objective: string; instructions: string; metric: "mae" | "nrmse" | "accuracy"; seed: number;
};
await mkdir(output, { recursive: true });
const reportFile = join(output, `${task.id}-${mode}.json`);
if (await access(reportFile).then(() => true, () => false)) throw new Error("Choose a new output directory for this trial");
const modelToken = env("REAL_LLM_KEY");
const progress: string[] = [];
const artifacts: unknown[] = [];
const clock = performance.now();
let outcome = "failed";
let details = "";
let project: string | undefined;
let researchId: string | undefined;
let modelId: string | undefined;
let sessionPath: string | undefined;
let usage: SessionUsageSummary["totals"] | undefined;
let developmentHashes: Record<string, string> | undefined;
const ideationRound = new Map<string, number>();
let finalResearch: IdeaResearchView["research"] | undefined;
const runs: SessionRun[] = [];
let submission: { path: string; sha256: string } | undefined;
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
async function wait<T>(load: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout = 540_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await load();
    if (accept(value)) return value;
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`);
    await delay(1200);
  }
}
function step(message: string) {
  const line = `${progress.length + 1}. ${message}`;
  progress.push(line);
  console.log(line);
}

try {
  const info = await api<{ executor: string; jiuwenswarm: { reachable: boolean } }>("/agent/info");
  assert.equal(info.executor, "jiuwenswarm");
  assert.equal(info.jiuwenswarm.reachable, true);
  step(`Verified JiuwenSwarm on the isolated stack for ${task.id}, arm ${mode}`);
  const settings = await api<{ candidateValidationEnabled?: boolean }>("/api/settings/idea-tree");
  assert.equal(settings.candidateValidationEnabled, true, "Enable validation on the isolated stack before the trial");
  modelId = (await api<{ id: string }>("/api/models", "POST", { name: `Science acceptance ${task.id} ${mode}`, baseUrl: env("REAL_LLM_BASE_URL"), model,
    apiToken: modelToken, vision: false, thinkingMode: "disabled" })).id;
  const record = await api<{ id: string; project?: { id: string }; firstSession: { id: string } }>("/api/projects", "POST", { name: `Science acceptance ${task.id} ${mode} ${Date.now()}` });
  project = record.project?.id ?? record.id;
  const session = sessionPath = `/api/sessions/${record.firstSession.id}`;
  await api(session, "PATCH", { modelId });
  await api(session, "PATCH", { approvalMode: "always_allow" });
  const development = await readFile(join(data, "development.json"), "utf8");
  const baseline = await readFile(join(data, "baseline.py"), "utf8");
  const reference = await readFile(join(data, "reference.json"), "utf8");
  developmentHashes = { input: hash(development), starter: hash(baseline), reference: hash(reference) };
  const put = (path: string, content: string) => api(`${session}/files`, "POST", { path, content });
  await put("development.json", development);
  await put("baseline.py", baseline);
  await put("development-reference.json", reference);
  const research = `${session}/idea-tree/research`;
  const experiments = `${session}/idea-tree/experiments`;
  const create = await api<IdeaResearchView>(research, "POST", { operation: "create", objective: `${task.objective}` + "\n\n" + task.instructions,
    materials: "Use the provided baseline.py as the starting implementation. Propose feasible code changes.",
    settings: { explorationIntensity: "quick", candidateValidationEnabled: true, candidateValidationFeedbackEnabled: mode === "C", maxTokens: 250_000, maxDepth: 2, maxNodes: 12, maxActiveDirections: 1 } });
  researchId = create.research.id;
  assert.equal(create.research.settings.explorationIntensity, "quick");
  assert.equal(create.research.settings.maxRounds, 2);
  const action = (operation: string) => api<IdeaResearchView>(research, "POST", { operation, researchId });
  const command = <T>(body: object) => api<T>(experiments, "POST", { researchId, ...body });
  const get = async () => {
    const snapshot = await action("get");
    finalResearch = snapshot.research;
    for (const item of snapshot.graph.nodes) {
      if (item.kind === "candidate" && !ideationRound.has(item.id)) ideationRound.set(item.id, snapshot.research.round);
    }
    return snapshot;
  };
  const terminalResearch = ["paused", "completed", "interrupted", "budget_exhausted", "ended"];
  if (mode !== "A") await action("pause_for_validation");
  let view = await wait(get, value => terminalResearch.includes(value.research.status), "Idea Tree candidate");
  assert.equal(view.research.id, researchId);
  const candidate = () => view.graph.nodes.filter(node => node.kind === "candidate" && node.status === "done").at(-1)!;
  assert.ok(candidate(), view.research.reason ?? "Missing candidate");
  step(`Idea Tree evaluated ${candidate().id} in research ${researchId}`);
  assert.equal(Boolean(view.research.settings.candidateValidationEnabled), true, "Research was created with the wrong experiment setting");

  const assets = () => api<SessionArtifactOutput[]>(research, "POST", { operation: "validation_inputs", researchId });
  const sourceId = (values: SessionArtifactOutput[], name: string) => {
    const item = values.find(asset => asset.version.sourcePath === name);
    assert.ok(item, `Missing artifact ${name}`);
    return item.version.id;
  };
  async function preparedVersion(candidateId: string, inputVersionId: string, sourceVersionId: string) {
    const started = await command<CandidatePreparationResult>({ operation: "prepare", candidateId, inputVersionId, sourceVersionId });
    const settled = await wait(() => command<CandidatePreparationResult>({ operation: "prepared", runId: started.runId }), result => result.status !== "running", "JiuwenSwarm artifact", 540_000);
    const run = await api<SessionRun>(`${session}/runs/${started.runId}`);
    runs.push(run);
    assert.equal(run.candidatePreparation?.candidateId, candidateId);
    assert.equal(run.candidatePreparation?.researchId, researchId);
    assert.equal(settled.status, "ready", run.error ?? `Run ${run.id} did not publish its Python candidate`);
    assert.ok(settled.versionId);
    artifacts.push({ candidateId, preparationRunId: run.id, versionId: settled.versionId, evidenceIds: run.candidatePreparation?.evidenceIds });
    step(`JiuwenSwarm run ${run.id} published the candidate for node ${candidateId}`);
    return { run, versionId: settled.versionId };
  }
  async function lock(versionId: string, path: string) {
    const response = await fetch(`${origin}${session}/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.ok(response.ok);
    const bytes = await response.text();
    if (mode !== "A") {
      const found = (await assets()).find(entry => entry.version.id === versionId);
      assert.equal(found?.version.content.hash, hash(bytes), "Workspace output differs from the published immutable artifact");
    }
    const file = join(output, `${task.id}-${mode}.py`);
    await writeFile(file, bytes, { flag: "wx" });
    submission = { path: file, sha256: hash(bytes) };
  }
  async function evaluate(candidateId: string, inputVersionId: string, baselineScriptVersionId: string,
    candidateScriptVersionId: string, referenceVersionId: string, preparationRunId?: string) {
    const job = await command<CandidateExperiment>({ operation: "start", candidateId, inputVersionId, baselineScriptVersionId,
      candidateScriptVersionId, ...(preparationRunId ? { preparationRunId } : {}), referenceVersionId, metric: task.metric, seed: task.seed });
    const settled = await wait(() => command<CandidateExperiment>({ operation: "poll", id: job.id }), value => ["ready", "failed", "cancelled"].includes(value.status), "Runner comparison");
    artifacts.push(settled);
    step(`Runner comparison ${settled.id} finished ${settled.status}${settled.result ? ` with ${settled.result.baseline} → ${settled.result.candidate}` : ""}`);
    return settled;
  }
  if (mode === "A") {
    const candidates = view.graph.nodes.filter(node => node.kind === "candidate" && node.status === "done");
    const byRound = [...new Map(candidates.map(node => [ideationRound.get(node.id), node])).values()];
    assert.equal(byRound.length, 2, "The original Idea Tree did not complete two evaluated rounds");
    let source = "baseline.py";
    for (const [index, idea] of byRound.entries()) {
      const path = `submission-${index + 1}.py`;
      const prompt = `Implement the evaluated Idea Tree proposal: ${idea.hypothesis}\n${task.instructions}\nUse ${source} and the supplied development data. Write ${path} using workspace tools, then publish it with declare_artifact.`;
      const run = await api<SessionRun>(`${session}/runs`, "POST", { content: prompt });
      const done = await wait(() => api<SessionRun>(`${session}/runs/${run.id}`), result => !["queued", "running", "blocked"].includes(result.status), "original workflow code");
      runs.push(done);
      assert.equal(done.status, "completed", done.error);
      source = path;
      step(`JiuwenSwarm run ${run.id} prepared ${path} using the original workflow`);
    }
    await lock("", source);
    const inputs = await assets();
    const inputVersionId = sourceId(inputs, "development.json");
    const baselineScriptVersionId = sourceId(inputs, "baseline.py");
    const candidateScriptVersionId = sourceId(inputs, source);
    const referenceVersionId = sourceId(inputs, "development-reference.json");
    const comparison = await evaluate(byRound.at(-1)!.id, inputVersionId, baselineScriptVersionId, candidateScriptVersionId, referenceVersionId);
    assert.equal(comparison.status, "ready", comparison.error ?? "The original workflow candidate did not pass managed execution");
  } else {
    assert.equal(view.research.status, "paused");
    const inputs = await assets();
    const inputVersionId = sourceId(inputs, "development.json");
    const baselineScriptVersionId = sourceId(inputs, "baseline.py");
    const firstId = candidate().id;
    const first = await preparedVersion(firstId, inputVersionId, baselineScriptVersionId);
    const referenceVersionId = sourceId(await assets(), "development-reference.json");
    const one = await evaluate(firstId, inputVersionId, baselineScriptVersionId, first.versionId, referenceVersionId, first.run.id);
    assert.ok(one.validationId || one.failure?.id, one.error);
    const resumed = await action("continue");
    if (resumed.research.status === "budget_exhausted" || resumed.research.status === "interrupted") {
      throw new Error(resumed.research.reason ?? resumed.research.status);
    }
    // The quick preset has two rounds. The completed research accepts evidence for its final candidate.
    view = await wait(get, value => terminalResearch.includes(value.research.status), "feedback round");
    assert.equal(view.research.id, researchId);
    assert.notEqual(candidate()?.id, firstId, view.research.reason ?? "No follow-up candidate");
    const second = await preparedVersion(candidate().id, inputVersionId, first.versionId);
    if (mode === "C") assert.ok(second.run.candidatePreparation?.evidenceIds.includes(one.validationId ?? one.failure!.id), "The follow-up proposal did not cite the first observation");
    if (mode === "B") assert.deepEqual(second.run.candidatePreparation?.evidenceIds, []);
    const two = await evaluate(candidate().id, inputVersionId, baselineScriptVersionId, second.versionId, referenceVersionId, second.run.id);
    assert.equal(two.status, "ready", two.error ?? "The final candidate did not pass managed execution");
    await lock(second.versionId, second.run.candidatePreparation!.outputPath);
  }
  outcome = "submission_locked";
  step(`Locked the submission after completing the product workflow`);
} catch (error) {
  details = error instanceof Error ? error.message.replaceAll(modelToken, "[redacted]") : String(error);
  process.exitCode = 1;
  console.error(details);
} finally {
  usage = sessionPath ? await api<SessionUsageSummary>(`${sessionPath}/usage`).then(snapshot => snapshot.totals).catch(() => undefined) : undefined;
  await writeFile(reportFile, JSON.stringify({ task: task.id, taskSpec: task, arm: mode, executor: "jiuwenswarm", model, project, researchId,
    research: finalResearch, usage, developmentHashes, deploymentRevision: process.env.SCIENCE_DEPLOYMENT_REVISION,
    outcome, details, elapsedSeconds: (performance.now() - clock) / 1000, progress, artifacts, submission,
    runs: runs.map(run => ({ id: run.id, status: run.status, preparation: run.candidatePreparation })) }, null, 2), { flag: "wx" });
  if (modelId && outcome === "submission_locked") await api(`/api/models/${modelId}`, "DELETE").catch(() => undefined);

}
