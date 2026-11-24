// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { VersionStore } from "@sciencediscovery/cas";
import { SessionStore } from "../store.js";
import { loadResearchCheckpoint, sealResearchCheckpoint } from "./research-checkpoint.js";

const input = "batch,sample_id,setpoint,reading,status\nreference,a,0,1,ok\nreference,b,1,2,ok\nproduction_a,a,0,1,ok\nproduction_a,b,1,2,ok\nproduction_b,a,0,1,ok\nproduction_b,b,1,3,ok\n";
const qc = JSON.stringify({ raw_rows: 6, clean_rows: 6, excluded_status_rows: 0, duplicate_rows: 0 });

test("a persisted research checkpoint is idempotent, version-bound and independently verified", async context => {
  const root = resolve(".tmp", "research-checkpoint-test", randomUUID());
  let store = new SessionStore(root);
  const previousMode = process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE;
  const previousSessions = process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS;
  const previousWorkflows = process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS;
  context.after(async () => {
    store.close();
    if (previousMode === undefined) delete process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE;
    else process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = previousMode;
    if (previousSessions === undefined) delete process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS;
    else process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = previousSessions;
    if (previousWorkflows === undefined) delete process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS;
    else process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = previousWorkflows;
    await rm(root, { recursive: true, force: true });
  });
  await store.load();
  const project = await store.createProject("Research Checkpoint");
  const session = await store.createSession(project.id, "Calibration", {}, {}, { allowUnconfiguredModel: true });
  const workspace = store.workspacePath(session.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "instrument.csv"), input);
  await writeFile(resolve(workspace, "cleaned.csv"), input);
  await writeFile(resolve(workspace, "qc.json"), qc);
  const settingsSnapshot = store.resolveRuntimeSettings(session.id).effective;
  const source = await store.createSessionRun({ sessionId: session.id, prompt: "Validate the calibration input", settingsSnapshot });
  const user = await store.appendMessage(session.id, "user", source.prompt);
  const history = [{ role: "assistant", content: null, tool_calls: [{ id: "display", type: "function", function: { name: "run_shell", arguments: "{}" } }] },
    { role: "tool", name: "run_shell", tool_call_id: "display", content: JSON.stringify({ executionId: `shell:${"a".repeat(64)}`, state: "completed", exitCode: 0 }) + "\nstdout:\n" + input }];
  const assistant = await store.appendMessage(session.id, "assistant", "Quality accepted", undefined, undefined, undefined, "message", history);
  await store.updateSessionRunStatus(session.id, source.id, "completed", { userMessageId: user.id, assistantMessageId: assistant.id });
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = "pilot";
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = "solar";
  await assert.rejects(sealResearchCheckpoint(store, session.id, source.id, "calibration", "by-state"), /not enrolled/);
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = "calibration";
  const binding = await sealResearchCheckpoint(store, session.id, source.id, "calibration", "by-state");
  const request = { sessionId: session.id, prompt: "Fit the batches", settingsSnapshot, researchResume: binding };
  const duplicates = await Promise.all([store.createSessionRun(request), store.createSessionRun(request)]);
  assert.equal(duplicates[0].id, duplicates[1].id);
  await assert.rejects(store.createSessionRun({ ...request, prompt: "Different action" }), /different continuation/);
  store.close();
  store = new SessionStore(root);
  await store.load();
  const persisted = (await store.getSessionRun(session.id, duplicates[0].id))?.researchResume;
  assert.deepEqual(persisted, binding);
  const fallback = await loadResearchCheckpoint(store, session.id, binding);
  assert.equal(fallback.route, "full");
  assert.equal(fallback.restrictedTools, true, "rollback must retain the accepted checkpoint tool boundary");
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = "by-state";
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = session.id;
  const reopened = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { SessionStore } from './services/api/src/store.ts';
    import { loadResearchCheckpoint } from './services/api/src/runs/research-checkpoint.ts';
    const [root, sessionId, runId] = process.argv.slice(1);
    const store = new SessionStore(root);
    await store.load();
    try {
      const run = await store.getSessionRun(sessionId, runId);
      const result = await loadResearchCheckpoint(store, sessionId, run.researchResume);
      console.log(JSON.stringify({ pid: process.pid, route: result.route }));
    } finally { store.close(); }
  `, root, session.id, duplicates[0].id], { timeout: 30_000 });
  const readback = JSON.parse(reopened.stdout.trim().split("\n").at(-1)!);
  assert.notEqual(readback.pid, process.pid);
  assert.equal(readback.route, "retire-display");
  const resume = await loadResearchCheckpoint(store, session.id, binding);
  assert.equal(resume.route, "retire-display");
  assert.ok(resume.createProjection);
  const projectHistory = resume.createProjection(() => {});
  assert.deepEqual(await projectHistory(history, 0), history);
  await writeFile(resolve(workspace, "fits.json"), "{}");
  assert.deepEqual(await projectHistory(history, 1), history);
  const correctFits = JSON.stringify({ reference: { n: 2, slope: 1, intercept: 1 }, production_a: { n: 2, slope: 1, intercept: 1 }, production_b: { n: 2, slope: 2, intercept: 1 } });
  await writeFile(resolve(workspace, "fits.json"), correctFits);
  assert.deepEqual(await projectHistory(history, 2), []);
  await writeFile(resolve(workspace, "drift.json"), JSON.stringify({ baseline_batch: "reference", threshold: 0.05, slope_deltas: { production_a: 0, production_b: 1 }, flagged_batches: ["production_b"] }));
  await writeFile(resolve(workspace, "calibration_report.md"), "Sources: qc.json cleaned.csv fits.json drift.json\n    clean_rows: 6\n    reference_slope: 1\n    drift_threshold: 0.05\n    flagged_batches: production_b\n");
  await resume.verifyDelivery();
  await writeFile(resolve(workspace, "qc.json"), qc + "\n");
  assert.deepEqual(await projectHistory(history, 3), history);
  await assert.rejects(resume.verifyDelivery(), /independent verification/);
  await assert.rejects(loadResearchCheckpoint(store, session.id, binding), /artifacts changed/);
  const object = new VersionStore(root).objectPath(binding.ref);
  const bytes = await readFile(object);
  await writeFile(object, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(loadResearchCheckpoint(store, session.id, binding));
});

test("pending recovery verifies a full log page from its own completed display execution", async context => {
  const root = resolve(".tmp", "research-checkpoint-test", randomUUID());
  const store = new SessionStore(root);
  context.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.load();
  const project = await store.createProject("Calibration");
  const session = await store.createSession(project.id, "Pending calibration", {}, {}, { allowUnconfiguredModel: true });
  const workspace = store.workspacePath(session.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "instrument.csv"), input);
  await writeFile(resolve(workspace, "cleaned.csv"), input);
  await writeFile(resolve(workspace, "qc.json"), qc);
  const settingsSnapshot = store.resolveRuntimeSettings(session.id).effective;
  const source = await store.createSessionRun({ sessionId: session.id, prompt: "Validate the calibration input", settingsSnapshot });
  const user = await store.appendMessage(session.id, "user", source.prompt);
  const assistant = await store.appendMessage(session.id, "assistant", "Quality accepted", undefined, undefined, undefined, "message",
    [{ role: "assistant", content: "Quality accepted" }]);
  await store.updateSessionRunStatus(session.id, source.id, "completed", { userMessageId: user.id, assistantMessageId: assistant.id });
  const binding = await sealResearchCheckpoint(store, session.id, source.id, "calibration", "full");
  const load = () => loadResearchCheckpoint(store, session.id, binding);
  const [valid, different, truncated, precomputed] = await Promise.all([load(), load(), load(), load()]);
  await writeFile(resolve(workspace, "fits.json"), JSON.stringify({ reference: { n: 2, slope: 1, intercept: 1 }, production_a: { n: 2, slope: 1, intercept: 1 }, production_b: { n: 2, slope: 2, intercept: 1 } }));
  await writeFile(resolve(workspace, "drift.json"), JSON.stringify({ baseline_batch: "reference", threshold: 0.05, slope_deltas: { production_a: 0, production_b: 1 }, flagged_batches: ["production_b"] }));
  await writeFile(resolve(workspace, "calibration_report.md"), "Sources: qc.json cleaned.csv fits.json drift.json\nclean_rows: 6\nreference_slope: 1\ndrift_threshold: 0.05\nflagged_batches: production_b\n");

  const executionId = `shell:${"a".repeat(64)}`;
  const other = `shell:${"b".repeat(64)}`;
  const status = { executionId, state: "completed", exitCode: 0, createdFiles: [], modifiedFiles: [] };
  const page = { state: "completed", truncated: false, retentionTruncated: false, chunks: [
    { stream: "stdout", cursor: 1, text: input.slice(0, 45) },
    { stream: "stdout", cursor: 2, text: input.slice(45) },
  ] };
  precomputed.observeTool("run_shell", false, { state: "completed", createdFiles: ["fits.json"] }, undefined);
  for (const run of [valid, different, truncated, precomputed]) {
    assert.equal(run.route, "full");
    run.observeTool("run_shell", false, { executionId, state: "running" }, undefined);
    run.observeTool("execution_status", false, status, undefined, { execution_id: executionId });
  }
  await assert.rejects(valid.verifyDelivery(), /must be displayed/);
  valid.observeTool("execution_logs", false, page, JSON.stringify(page), { execution_id: executionId });
  different.observeTool("execution_logs", false, page, JSON.stringify(page), { execution_id: other });
  truncated.observeTool("execution_logs", false, page, JSON.stringify({ ...page, truncated: true }), { execution_id: executionId });
  precomputed.observeTool("execution_logs", false, page, JSON.stringify(page), { execution_id: executionId });
  await valid.verifyDelivery();
  for (const run of [different, truncated, precomputed]) await assert.rejects(run.verifyDelivery(), /must be displayed/);
});
