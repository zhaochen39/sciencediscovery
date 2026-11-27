// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CandidateExperiment, IdeaResearchView, SessionArtifactOutput } from "@sciencediscovery/schema";
import { ideaResearchModel } from "../../helpers/idea-research-model.js";

// The experiment fits public training data once, evaluates the same ensemble
// family on both arms, and spends one real JiuwenSwarm turn per arm to generate
// a new weighted ensemble. Remaining Evolve roles use a deterministic fixture.
// No test labels or scores are loaded before all decisions are locked to disk.
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const apiOrigin = required("E2E_BASE_URL");
const apiToken = required("E2E_API_TOKEN");
const task = process.env.VALIDATION_TASK ?? "imdb";
assert.ok(task === "imdb" || task === "burgers");
const burgers = task === "burgers";
const inputDirectory = required("VALIDATION_DATA");
const reportPath = required("VALIDATION_REPORT");
const model = { model: required("REAL_LLM_MODEL"), baseUrl: required("REAL_LLM_BASE_URL"), apiKey: required("REAL_LLM_KEY") };
const pairCount = Number(process.env.VALIDATION_PAIRS ?? 10);
assert.ok(Number.isSafeInteger(pairCount) && pairCount > 0 && pairCount <= 10);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const candidateNames = burgers ? [
  "512-point Fourier Strang splitting, CFL 0.22", "256-point Fourier Strang splitting, CFL 0.22",
  "1024-point Fourier Strang splitting, CFL 0.40", "1024-point Fourier Strang splitting, CFL 0.12",
] : ["word unigram", "stopword-filtered unigram", "word unigram+bigram", "character 3–5-gram"];
const taskName = burgers ? "CodePDE Burgers solver refinement" : "MLAgentBench IMDb frozen-ensemble adaptation";
const objective = burgers ? "Minimize nRMSE for the 1-D viscous Burgers equation on unseen periodic initial conditions (nu = 0.01/pi)."
  : "Improve IMDb sentiment accuracy on unseen movie reviews.";
const outputRule = burgers ? "The output is the weighted average of the component solutions, aligned on the official 1024-point grid."
  : "The output label is 1 iff the weighted average of the component probabilities is above 0.5.";
const metric = burgers ? "nrmse" : "accuracy";
const better = (left: number, right: number) => burgers ? left < right : left > right;
type Weights = [number, number, number, number];
type Arm = "A" | "B";
const baseline: Weights = burgers ? [1, 0, 0, 0] : [0, 0, 1, 0];
const first: Weights = [0, 1, 0, 0];
const solver = (weights: Weights) => {
  const prediction = "sum(x * y for x, y in zip(row, w))";
  const value = burgers ? prediction : `int(${prediction} > 0.5)`;
  return `import json, sys\nw = ${JSON.stringify(weights)}\nwith open(sys.argv[1]) as stream:\n    rows = json.load(stream)\nprint(json.dumps([dict(id=str(i), value=${value}) for i, row in enumerate(rows)]))\n`;
};

async function request<T>(path: string, method = "GET", data?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method, headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return await response.json() as T;
}
async function until<T>(read: () => Promise<T>, accept: (result: T) => boolean, timeout = 100_000): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(500);
  } while (Date.now() < end);
  throw new Error("Timed out waiting for persisted state");
}
function weightsFrom(text: string): Weights {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  const values = JSON.parse(trimmed).weights;
  if (!Array.isArray(values) || values.length !== 4 || values.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
    throw new Error("Invalid weights");
  }
  const sum = values.reduce((a, b) => a + b, 0);
  if (!sum) throw new Error("All weights are zero");
  return values.map(value => value / sum) as Weights;
}
interface Ideation {
  runId: string;
  status: string;
  wallSeconds: number;
  tokens: number | null;
  promptSha256: string;
  feedbackIds: string[];
  weights?: Weights;
}
async function ideate(arm: Arm, payload: Record<string, unknown>): Promise<Ideation> {
  const runId = `validation-${task}-${randomUUID()}`;
  const evidence = arm === "B" && Array.isArray(payload.candidateValidation) ? payload.candidateValidation : [];
  const prompt = JSON.stringify({ objective,
    components: candidateNames, baseline, firstRoundCandidate: first,
    decision: `Generate an ensemble of the four frozen components. ${outputRule} Return JSON with only weights, four non-negative numbers summing to 1. The same validation and selection budget applies to all approaches.`,
    ...(arm === "B" ? { candidateValidation: evidence, guidance: payload.candidateValidationGuidance } : {}),
  });
  const begin = performance.now();
  let tokens: number | null = null;
  let status = "no_completion";
  let weights: Weights | undefined;
  try {
    const response = await fetch(`${apiOrigin}/agent/runs`, {
      method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: runId, runId, agentId: "main", prompt, tools: [],
        systemPrompt: "You are designing one reproducible ML experiment. Respond in the requested JSON format only.", model }),
      signal: AbortSignal.timeout(100_000),
    });
    if (!response.ok || !response.body) throw new Error(`adapter_http_${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.event?.type === "model.usage" && Number.isFinite(row.event.usage.totalTokens)) {
          tokens = (tokens ?? 0) + row.event.usage.totalTokens;
        }
        if (row.done) {
          status = row.done.status;
          if (status === "completed") weights = weightsFrom(row.done.finalText);
        }
      }
      if (done) break;
    }
  } catch (error) {
    status = error instanceof Error && /^adapter_http_\d+$/u.test(error.message) ? error.message : "model_or_transport_error";
  }
  return { runId, status, wallSeconds: (performance.now() - begin) / 1000, tokens, weights,
    promptSha256: hash(prompt), feedbackIds: evidence.map(row => row.id) };
}

const readData = (name: string) => readFile(resolve(inputDirectory, name), "utf8");
const devInput = await readData("dev-input.json");
const devReference = await readData("dev-reference.json");
const manifest = JSON.parse(await readData("manifest.json"));
assert.equal(hash(devInput), manifest.files["dev-input.json"]);
assert.equal(hash(devReference), manifest.files["dev-reference.json"]);
const info = await request<{ executor: string; jiuwenswarm: { reachable: boolean } }>("/agent/info");
assert.equal(info.executor, "jiuwenswarm");
assert.ok(info.jiuwenswarm.reachable);
const originalSettings = await request<Record<string, unknown>>("/api/settings/idea-tree");

interface ArmResult {
  arm: Arm;
  wallSeconds: number;
  researchId?: string;
  ideation?: Ideation;
  experiments: CandidateExperiment[];
  developmentScore?: number;
  selected?: Weights;
  selectedSha256?: string;
  testAccuracy?: number;
  error?: string;
}
async function armRun(number: number, arm: Arm): Promise<ArmResult> {
  const begin = performance.now();
  const result: ArmResult = { arm, wallSeconds: 0, experiments: [] };
  let project: string | undefined;
  let fixtureModel: string | undefined;
  const stub = await ideaResearchModel({ nextHypothesis: async payload => {
    result.ideation ??= await ideate(arm, payload);
    return result.ideation.weights ? `Weighted ensemble ${JSON.stringify(result.ideation.weights)}` : "Model experiment unavailable";
  } });
  try {
    fixtureModel = (await request<{ id: string }>("/api/models", "POST", { name: `Validation protocol ${task} ${number}-${arm}`,
      baseUrl: stub.baseUrl, model: stub.model, apiToken: stub.apiToken, vision: false })).id;
    const created = await request<{ id: string; project?: { id: string }; firstSession: { id: string } }>("/api/projects", "POST", {
      name: `Validation ${task} ${number}-${arm} ${Date.now()}`,
    });
    project = created.project?.id ?? created.id;
    const session = `/api/sessions/${created.firstSession.id}`;
    await request(session, "PATCH", { modelId: fixtureModel });
    const research = `${session}/idea-tree/research`;
    const experiment = `${session}/idea-tree/experiments`;
    const create = await request<IdeaResearchView>(research, "POST", { operation: "create", objective,
      materials: "Component training and data split are fixed. Use only the development comparison for reasoning about experimental results.",
      settings: { maxRounds: 3, candidatesPerRound: 1 } });
    const researchId = result.researchId = create.research.id;
    const command = (operation: string) => request<IdeaResearchView>(research, "POST", { operation, researchId });
    await command("pause_for_validation");
    stub.resume();
    const state = await until(() => command("get"), view => view.research.status === "paused");
    assert.equal(state.research.round, 1);
    const candidate1 = state.graph.nodes.find(node => node.kind === "candidate" && node.status === "done")?.id;
    assert.ok(candidate1);
    const put = (path: string, content: string) => request(`${session}/files`, "POST", { path, content });
    for (const [file, body] of [["dev.json", devInput], ["labels.json", devReference], ["baseline.py", solver(baseline)], ["first.py", solver(first)]]) {
      await put(file, body);
    }
    async function score(candidateId: string, filename: string) {
      const assets = await request<SessionArtifactOutput[]>(research, "POST", { operation: "validation_inputs", researchId });
      const version = (name: string): string => {
        const artifact = assets.find(item => item.version.sourcePath === name);
        assert.ok(artifact, name);
        return artifact.version.id;
      };
      const run = await request<CandidateExperiment>(experiment, "POST", { operation: "start", researchId, candidateId, metric,
        inputVersionId: version("dev.json"), referenceVersionId: version("labels.json"), baselineScriptVersionId: version("baseline.py"), candidateScriptVersionId: version(filename) });
      const settled = await until(() => request<CandidateExperiment>(experiment, "POST", { operation: "poll", id: run.id }),
        value => ["ready", "cancelled", "failed"].includes(value.status), 45_000);
      result.experiments.push(settled);
      assert.equal(settled.status, "ready", settled.error);
      const view = await command("get");
      const scored = view.graph.nodes.find(node => node.id === candidateId)?.validations?.find(item => item.id === settled.validationId);
      assert.ok(scored);
      return scored;
    }
    const firstScore = await score(candidate1, "first.py");
    const firstImproved = better(firstScore.candidate, firstScore.baseline);
    result.developmentScore = firstImproved ? firstScore.candidate : firstScore.baseline;
    result.selected = firstImproved ? first : baseline;
    // A pause request needs to land before the design finishes. Arm the
    // fixture at that phase so timing cannot skip the second checkpoint.
    stub.holdDesign();
    await command("continue");
    await command("pause_for_validation");
    stub.resume();
    const second = await until(() => command("get"), view => view.research.status === "paused" && view.research.round === 2);
    assert.ok(result.ideation);
    assert.deepEqual(result.ideation.feedbackIds, arm === "A" ? [] : [firstScore.id]);
    if (result.ideation.weights) {
      const candidate2 = second.graph.nodes.find(node => node.kind === "candidate" && node.status === "done" && node.id !== candidate1)?.id;
      assert.ok(candidate2);
      await put("next.py", solver(result.ideation.weights));
      const measured = await score(candidate2, "next.py");
      if (better(measured.candidate, result.developmentScore)) {
        result.selected = result.ideation.weights;
        result.developmentScore = measured.candidate;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    delete result.selected;
    delete result.developmentScore;
  } finally {
    result.wallSeconds = (performance.now() - begin) / 1000;
    if (result.selected) result.selectedSha256 = hash(solver(result.selected));
    await stub.stop();
    if (project) await request(`/api/projects/${project}`, "DELETE", { confirmProjectId: project }).catch(() => undefined);
    if (fixtureModel) await request(`/api/models/${fixtureModel}`, "DELETE").catch(() => undefined);
  }
  return result;
}

const report = { task: taskName, executor: info.executor, model: model.model,
  design: { pairs: pairCount, order: "alternating", selection: "best development score, retain incumbent on ties",
    maximumRealModelTurnsPerArm: 1, metric: burgers ? "official test mean per-trajectory nRMSE" : "official test accuracy" }, manifest,
  pairs: [] as { pair: number; order: Arm[]; arms: ArmResult[] }[] };
async function save() { await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n"); }
try {
  await request("/api/settings/idea-tree", "PUT", { candidateValidationEnabled: true, explorationIntensity: "standard" });
  await save();
  for (let pair = 1; pair <= pairCount; pair += 1) {
    const order: Arm[] = pair % 2 ? ["A", "B"] : ["B", "A"];
    const record = { pair, order, arms: [] as ArmResult[] };
    report.pairs.push(record);
    for (const arm of order) {
      const result = await armRun(pair, arm);
      record.arms.push(result);
      await save();
      console.log(JSON.stringify({ pair, arm, developmentScore: result.developmentScore, error: result.error,
        ideation: result.ideation?.status, elapsedSeconds: result.wallSeconds }));
    }
  }
  await writeFile(`${reportPath}.locked`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (!burgers) await gradeImdb();
} finally {
  await request("/api/settings/idea-tree", "PUT", { candidateValidationEnabled: originalSettings.candidateValidationEnabled ?? false,
    explorationIntensity: originalSettings.explorationIntensity }).catch(() => undefined);
}

async function gradeImdb() {
  const testInput = await readData("test-input.json");
  const testReference = await readData("test-reference.json");
  assert.equal(hash(testInput), manifest.files["test-input.json"]);
  assert.equal(hash(testReference), manifest.files["test-reference.json"]);
  const inputs = JSON.parse(testInput) as Weights[];
  const labels = JSON.parse(testReference) as { id: string; value: number }[];
  assert.equal(inputs.length, 25_000);
  assert.equal(labels.length, inputs.length);
  for (const pair of report.pairs) {
    for (const arm of pair.arms) {
      const weights = arm.selected;
      if (!weights) continue;
      arm.testAccuracy = labels.reduce((correct, label, i) => {
        assert.equal(label.id, String(i));
        const probability = inputs[i]!.reduce((sum, value, j) => sum + value * weights[j]!, 0);
        return correct + Number(Number(probability > 0.5) === label.value);
      }, 0) / labels.length;
    }
  }
  await save();
}
