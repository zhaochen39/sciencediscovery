// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

// Run from the repository with pnpm exec tsx test/api/idea-candidate-validation.ts.
// Requires an isolated JiuwenSwarm product stack, a managed local Runner, and E2E_API_TOKEN.
// The model fixture controls the checkpoint and captures the second ideation input.
import assert from "node:assert/strict";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openProjectSession } from "../helpers/journeys.js";

import { ideaResearchModel } from "../helpers/idea-research-model.js";
import type { CandidateExperiment, IdeaResearchView, SessionArtifactOutput } from "@sciencediscovery/schema";

const origin = process.env.E2E_BASE_URL;
const auth = process.env.E2E_API_TOKEN;
if (!origin || !auth || !process.env.E2E_VALIDATION_REPORT) throw new Error("Set E2E_BASE_URL, E2E_API_TOKEN and E2E_VALIDATION_REPORT for the isolated stack");
const log: string[] = [];
const step = (text: string) => { log.push(`${log.length + 1}. ${text}`); console.log(log.at(-1)); };
async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
  const res = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(`${method} ${path} HTTP ${res.status} ${detail.error ?? ""}`);
  }
  return await res.json() as T;
}
async function until<T>(read: () => Promise<T>, condition: (result: T) => boolean, label: string): Promise<T> {
  const expires = Date.now() + 130_000;
  while (Date.now() < expires) {
    const value = await read();
    if (condition(value)) return value;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rejects(path: string, body: object, message: RegExp) {
  await assert.rejects(request(path, "POST", body), message);
}

const stub = await ideaResearchModel();
let project: string | undefined;
let model: string | undefined;
let browser: Browser | undefined;
let restoreSettings: Record<string, unknown> | undefined;
try {
  const info = await until(() => request<{ executor: string; jiuwenswarm: { reachable: boolean } }>("/agent/info"), value => value.jiuwenswarm.reachable, "JiuwenSwarm");
  assert.equal(info.executor, "jiuwenswarm");
  const settings = await request<{ candidateValidationEnabled?: boolean; explorationIntensity: string }>("/api/settings/idea-tree");
  const keepSettings = process.env.E2E_KEEP_SETTINGS === "1";
  if (keepSettings) assert.equal(settings.candidateValidationEnabled, true);
  else {
    assert.notEqual(settings.candidateValidationEnabled, true);
    restoreSettings = { candidateValidationEnabled: false, explorationIntensity: settings.explorationIntensity };
  }
  model = (await request<{ id: string }>("/api/models", "POST", { name: "Validation fixture", baseUrl: stub.baseUrl, model: stub.model, apiToken: stub.apiToken, vision: false })).id;
  const name = `Validation fixture ${Date.now()}`;
  const created = await request<{ id: string; project?: { id: string }; firstSession: { id: string } }>("/api/projects", "POST", { name });
  project = created.project?.id ?? created.id;
  const session = created.firstSession.id;
  const sessionApi = `/api/sessions/${session}`;
  const record = await request<{ id: string; projectId: string; title: string }>(sessionApi, "PATCH", { modelId: model, title: name });
  const fixture = { project: { id: project!, name }, session: record, modelOwned: false };
  step(keepSettings ? "Verified the isolated JiuwenSwarm backend" : "Verified the isolated JiuwenSwarm backend and default-off setting");

  let web: Page | undefined;
  let desktop: Page | undefined;
  const desktopOrigin = process.env.E2E_DESKTOP_URL;
  if (desktopOrigin) {
    browser = await chromium.launch();
    web = await browser.newPage({ baseURL: origin, locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    desktop = await browser.newPage({ baseURL: desktopOrigin, locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    for (const page of [web, desktop]) {
      await page.addInitScript(token => {
        localStorage.setItem("sciencediscovery-token", token);
        localStorage.setItem("sciencediscovery-desktop:guide", "1");
      }, auth);
    }
    await openProjectSession(web, fixture);
  }
  if (!keepSettings) {
    if (web) {
      await web.getByRole("button", { name: /^(System configuration|系统设置)/u }).click();
      const dialog = web.getByRole("dialog", { name: /System configuration|系统设置/u });
      await dialog.getByRole("button", { name: /^Idea Tree/u }).click();
      const panel = dialog.locator(".idea-tree-settings");
      const toggle = panel.getByRole("checkbox", { name: "为新建研究启用候选实验验证" });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      const saved = web.waitForResponse(response => response.url().endsWith("/api/settings/idea-tree") && response.request().method() === "PUT");
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      assert.ok((await saved).ok());
      await web.reload();
    } else await request("/api/settings/idea-tree", "PUT", { candidateValidationEnabled: true });
  }
  const researchAPI = `${sessionApi}/idea-tree/research`;
  const command = (operation: string, data: object = {}) => request<IdeaResearchView>(researchAPI, "POST", { operation, ...data });
  const createdResearch = await command("create", { content: "/idea-tree Compare numerical estimators", materials: "Use the supplied numeric fixture only.", settings: { maxRounds: 2 } });
  const researchId = createdResearch.research.id;
  const read = () => command("get", { researchId });
  await command("pause_for_validation", { researchId });
  stub.resume();
  const view = await until(read, value => value.research.status === "paused", "first-round checkpoint");
  assert.equal(view.research.round, 1);
  assert.equal(view.research.settings.candidateValidationEnabled, true);
  const candidateId = view.graph.nodes.find(node => node.kind === "candidate" && node.status === "done")?.id;
  assert.ok(candidateId);
  assert.equal((await read()).research.settings.candidateValidationEnabled, true);
  step(`Reached round checkpoint on research ${researchId} and checked settings snapshot`);

  for (const [path, content] of [
    ["validation-input.json", JSON.stringify([{ id: "a", feature: 3 }, { id: "b", feature: 7 }])],
    ["validation-reference.json", JSON.stringify([{ id: "a", value: 3 }, { id: "b", value: 7 }])],
    ["baseline.py", "import json, sys\nrows = json.load(open(sys.argv[1]))\nprint(json.dumps([dict(id=r['id'], value=0) for r in rows]))\n"],
    ["candidate.py", "import json, pathlib, sys\nassert not pathlib.Path('validation-reference.json').exists()\nrows = json.load(open(sys.argv[1]))\nprint(json.dumps([dict(id=r['id'], value=r['feature']) for r in rows]))\n"],
  ]) await request(`${sessionApi}/files`, "POST", { path, content });
  const assets = await request<SessionArtifactOutput[]>(researchAPI, "POST", { operation: "validation_inputs", researchId });
  const version = (name: string) => {
    const match = assets.find(item => item.version.sourcePath === name);
    assert.ok(match, `Missing artifact version for ${name}`);
    return match.version.id;
  };
  const experiments = `${sessionApi}/idea-tree/experiments`;
  const plan = { operation: "start", researchId, candidateId, metric: "mae", inputVersionId: version("validation-input.json"),
    referenceVersionId: version("validation-reference.json"), baselineScriptVersionId: version("baseline.py"),
    candidateScriptVersionId: version("candidate.py") };
  const missingId = { ...plan, inputVersionId: "version-from-another-session" };
  await rejects(experiments, missingId, /outside this session/);
  await rejects(researchAPI, { operation: "validate_candidate", researchId, candidateId }, /Unknown research operation/);
  if (web) {
    await openProjectSession(web, fixture);
    await web.getByRole("button", { name: /查看研究进度/u }).click({ timeout: 15_000 });
    await web.getByRole("button", { name: new RegExp(`^${candidateId}:`, "u") }).press("Enter");
    await web.getByRole("button", { name: "验证此候选" }).click();
    const validation = web.getByRole("region", { name: "实测验证" });
    const selectors = validation.getByRole("combobox");
    await selectors.nth(1).selectOption(plan.inputVersionId);
    await selectors.nth(2).selectOption(plan.referenceVersionId);
    await selectors.nth(3).selectOption(plan.baselineScriptVersionId);
    await selectors.nth(4).selectOption(plan.candidateScriptVersionId);
    assert.deepEqual(await request(experiments, "POST", { operation: "list", researchId }), []);
    const posted = web.waitForResponse(r => r.url().endsWith("/idea-tree/experiments") && r.request().postDataJSON()?.operation === "start");
    await validation.getByRole("button", { name: "确认运行并评分" }).click();
    assert.ok((await posted).ok());
  }
  const job = await request<CandidateExperiment>(experiments, "POST", plan);
  await rejects(researchAPI, { operation: "continue", researchId }, /Wait for the candidate experiment/);
  const jobs = () => request<CandidateExperiment[]>(experiments, "POST", { operation: "list", researchId });
  const terminal = (value: CandidateExperiment) => ["ready", "failed", "cancelled"].includes(value.status);
  // Read-only listing is deliberately used here. The background worker must
  // advance both roles even when no experiment panel is polling the job.
  const waitFor = async (id: string) => (await until(jobs, values => values.some(value => value.id === id && terminal(value)), id))
    .find(value => value.id === id)!;
  const settled = await waitFor(job.id);
  assert.equal(settled.status, "ready", settled.error);
  assert.ok(settled.executionIds.baseline && settled.executionIds.candidate);
  assert.notEqual(settled.executionIds.baseline, settled.executionIds.candidate);
  assert.equal(settled.result?.improvement, 5);
  assert.match(settled.plan?.digest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(settled.result?.planDigest, settled.plan?.digest);
  assert.equal(settled.attempt, 1);
  const duplicate = await request<CandidateExperiment>(experiments, "POST", plan);
  assert.deepEqual(duplicate, settled);
  const result = (await read()).graph.nodes.find(node => node.id === candidateId)?.validations?.[0];
  assert.ok(result);
  assert.equal(result.baseline, 5);
  assert.equal(result.candidate, 0);
  assert.equal(result.improvement, 5);
  assert.equal(result.sampleCount, 2);
  if (web && desktop) {
    await expect(web.getByRole("region", { name: "实测验证" })).toContainText("改善量 5", { timeout: 15_000 });
    await web.reload();
    await web.getByRole("button", { name: /查看研究进度/u }).click({ timeout: 15_000 });
    await web.getByRole("button", { name: new RegExp(`^${candidateId}:`, "u") }).press("Enter");
    await expect(web.getByRole("region", { name: "实测验证" })).toContainText("改善量 5", { timeout: 15_000 });
    await desktop.goto("/");
    await desktop.locator(".side-session", { hasText: record.title }).first().click({ timeout: 15_000 });
    await expect(desktop.locator(".task-head-title")).toContainText(record.title);
    await desktop.locator(".idea-run-card").filter({ hasText: "Compare numerical estimators" }).click({ timeout: 15_000 });
    await desktop.getByRole("button", { name: /Candidate 1: reduce metal leaching/u }).press("Enter");
    const validation = desktop.getByRole("region", { name: "实测验证" });
    await expect(validation).toContainText("改善量 5", { timeout: 15_000 });
    await validation.getByText("MAE · 改善量 5", { exact: true }).click();
    await expect(validation.getByText(result.candidateExecutionId, { exact: true })).toBeVisible();
    const download = desktop.waitForEvent("download", { timeout: 10_000 });
    await validation.getByRole("button", { name: "候选预测" }).click();
    const file = await download;
    assert.equal(await file.failure(), null);
    assert.deepEqual(JSON.parse(await readFile(await file.path(), "utf8")), [{ id: "a", value: 3 }, { id: "b", value: 7 }]);
    step("Submitted from Web, checked score after reload, and opened the same candidate run and predictions from Desktop");
  }
  step(`Scored two runner executions as MAE 5 and 0. Confirmed replay is idempotent and restored the result ${result.id}`);
  for (const [path, content] of [
    ["invalid.py", "print('[{\"id\": \"a\", \"value\": 3}]')\n"],
    ["regressed.py", "import json; print(json.dumps([{'id': 'a', 'value': -1}, {'id': 'b', 'value': -1}]))\n"],
    ["long.py", "import time; time.sleep(60)\n"],
  ]) await request(`${sessionApi}/files`, "POST", { path, content });
  const more = await request<SessionArtifactOutput[]>(researchAPI, "POST", { operation: "validation_inputs", researchId });
  const startWith = (name: string) => request<CandidateExperiment>(experiments, "POST", { ...plan,
    candidateScriptVersionId: more.find(item => item.version.sourcePath === name)?.version.id });
  const invalid = await waitFor((await startWith("invalid.py")).id);
  assert.equal(invalid.status, "failed");
  assert.ok(invalid.executionIds.candidate);
  assert.equal(invalid.validationId, undefined);
  let negativeJob: CandidateExperiment;
  if (desktop) {
    await desktop.getByRole("button", { name: "验证此候选" }).click();
    const validation = desktop.getByRole("region", { name: "实测验证" });
    const selectors = validation.getByRole("combobox");
    const negativeVersion = more.find(item => item.version.sourcePath === "regressed.py")?.version.id;
    assert.ok(negativeVersion);
    await selectors.nth(1).selectOption(plan.inputVersionId);
    await selectors.nth(2).selectOption(plan.referenceVersionId);
    await selectors.nth(3).selectOption(plan.baselineScriptVersionId);
    await selectors.nth(4).selectOption(negativeVersion);
    const posted = desktop.waitForResponse(r => r.url().endsWith("/idea-tree/experiments") && r.request().postDataJSON()?.operation === "start");
    await validation.getByRole("button", { name: "确认运行并评分" }).click();
    const response = await posted;
    assert.ok(response.ok());
    negativeJob = await response.json();
    await expect(validation).toContainText("改善量 -1", { timeout: 15_000 });
    step("Submitted a regressed candidate from Desktop and verified that its signed result was shown");
  } else negativeJob = await startWith("regressed.py");
  const regressed = await waitFor(negativeJob.id);
  assert.equal(regressed.status, "ready", regressed.error);
  const negative = (await read()).graph.nodes.find(node => node.id === candidateId)?.validations?.find(value => value.id === regressed.validationId);
  assert.equal(negative?.improvement, -1);
  const long = await startWith("long.py");
  await until(jobs, values => values.some(value => value.id === long.id && value.executionIds.candidate), "running slow candidate");
  await request(experiments, "POST", { operation: "cancel", id: long.id });
  const cancelled = await waitFor(long.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.validationId, undefined);
  step("Confirmed wrong sample sets, cross-session version IDs, and cancelled runs cannot attach scores; negative improvement is retained");
  if (desktop) await desktop.locator(".idea-panel-actions").getByRole("button", { name: "继续", exact: true }).click();
  else await command("continue", { researchId });
  const completed = await until(read, value => value.research.status === "completed", "completion after validation");
  const payload = stub.requests.find(({ payload }) => payload.maximumCandidates && payload.round === 2)?.payload;
  assert.deepEqual(payload?.candidateValidation?.filter((value: { metric?: string }) => value.metric)
    .map((value: { id: string }) => value.id), [regressed.validationId, result.id]);
  assert.ok(payload?.candidateValidation?.some((value: { failureCode?: string }) => value.failureCode === "invalid_predictions"));
  const followUp = completed.graph.nodes.find(node => node.id !== candidateId && node.basedOnValidationIds?.length);
  assert.ok(followUp);
  assert.deepEqual(followUp.basedOnValidationIds, [regressed.validationId]);
  const finalCandidate = await request<CandidateExperiment>(experiments, "POST", { ...plan, candidateId: followUp.id });
  const finalResult = await waitFor(finalCandidate.id);
  assert.equal(finalResult.status, "ready", finalResult.error);
  assert.equal(finalResult.result?.planDigest, finalResult.plan?.digest);
  const finalView = await read();
  assert.equal(finalView.research.status, "completed");
  assert.ok(finalView.graph.nodes.find(node => node.id === followUp.id)?.validations?.some(result => result.id === finalResult.validationId));
  await rejects(researchAPI, { operation: "continue", researchId }, /not resumable/u);
  step("Verified next-round evidence and measured the final candidate after completion without reopening research");
  if (!keepSettings) {
    if (desktop) {
      await desktop.getByRole("button", { name: "设置", exact: true }).click();
      await desktop.getByRole("button", { name: /^Idea Tree/u }).click();
      const toggle = desktop.getByRole("checkbox", { name: "为新建研究启用候选实验验证" });
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      const saved = desktop.waitForResponse(response => response.url().endsWith("/api/settings/idea-tree") && response.request().method() === "PUT");
      await desktop.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
      assert.ok((await saved).ok());
    } else await request("/api/settings/idea-tree", "PUT", { candidateValidationEnabled: false });
    assert.equal((await read()).research.settings.candidateValidationEnabled, true);
    const off = await command("create", { objective: "Default workflow", settings: { candidateValidationEnabled: true } });
    assert.notEqual(off.research.settings.candidateValidationEnabled, true);
    await rejects(researchAPI, { operation: "validation_inputs", researchId: off.research.id }, /disabled for this research/);
    await until(() => command("get", { researchId: off.research.id }), value => value.research.status === "completed", "default workflow");
    const offPrompts = stub.requests.filter(({ payload }) => payload.objective === "Default workflow" && payload.maximumCandidates);
    assert.ok(offPrompts.length);
    assert.ok(offPrompts.every(({ payload }) => payload.candidateValidation === undefined));
    step("Verified both settings writers, immutable opt-in, and the original prompt path for a new opted-out research");
  }
} catch (error) {
  log.push(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  throw error;
} finally {
  await writeFile(process.env.E2E_VALIDATION_REPORT, log.join("\n") + "\n", "utf8");
  await browser?.close();
  if (restoreSettings) await request("/api/settings/idea-tree", "PUT", restoreSettings).catch(() => undefined);
  await stub.stop();
  if (project) await request(`/api/projects/${project}`, "DELETE", { confirmProjectId: project }).catch(() => undefined);
  if (model) await request(`/api/models/${model}`, "DELETE").catch(() => undefined);
}
