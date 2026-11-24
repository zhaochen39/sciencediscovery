import { createHash } from "node:crypto";
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import { resolveContextBudget } from "./budget.js";
import { ContextContributorRegistry, StaticSystemPromptContributor } from "./contributor.js";
import { DynamicContextAssembler, type DynamicContextTrace } from "./dynamic-assembler.js";
import { HistoryCompactor } from "./history-compactor.js";
import { resolveContextAssemblyMode } from "./mode.js";
import { createStateView, type StateView } from "./state-view.js";
import { ConservativeTokenEstimator, type TokenEstimator } from "./token-estimator.js";
import { projectVerifiedStages, VERIFIED_STAGE_STATE } from "./verified-stage-projection.js";

type Message = RuntimeMessage & { content?: string };

function assembler(mode: "dynamic" | "dynamic-shadow" | "shadow" | "projection", options: {
  budget?: NodeJS.ProcessEnv;
  registry?: ContextContributorRegistry<Message>;
  stateView?(): StateView;
  tokenEstimator?: TokenEstimator<Message>;
  trace?(value: DynamicContextTrace<Message>): void;
} = {}) {
  return new DynamicContextAssembler<Message>({
    budget: resolveContextBudget(options.budget ?? {}),
    compactor: new HistoryCompactor(async () => "summary"),
    contextId: "run-1",
    mode,
    ...(options.stateView ? { stateView: options.stateView } : {}),
    onTrace: options.trace,
    registry: options.registry ?? new ContextContributorRegistry<Message>()
      .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
      .freeze(),
    scope: "main",
    systemPrompt: "legacy prompt",
    tokenEstimator: options.tokenEstimator,
    tools: () => [{ description: "search", name: "web_search", parameters: { type: "object" } }],
  });
}

test("dynamic mode renders invocation input and keeps Node history canonical", async () => {
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "ephemeral", scopes: ["main"], async contribute() {
      return { attachments: [{ content: "retrieved data", id: "data.one", source: "test", trust: "untrusted_data" }] };
    } })
    .freeze();
  const result = await assembler("dynamic", { registry }).assemble({
    history: [{ role: "user", content: "question" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.deepEqual(result.history, [{ role: "user", content: "question" }]);
  assert.equal(result.modelInput.history.length, 2);
  assert.match(String(result.modelInput.history[1]?.content), /retrieved data/u);
  assert.equal(result.modelInput.systemPrompt, "legacy prompt");
});

test("shadow mode traces dynamic assembly while preserving legacy model input", async () => {
  let trace: DynamicContextTrace<Message> | undefined;
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "optional", scopes: ["main"], async contribute() {
      return { systemSections: [{ content: "optional context ".repeat(10), id: "optional", slot: "working_context" }] };
    } })
    .freeze();
  const result = await assembler("shadow", {
    budget: { SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS: "80" },
    registry,
    trace(value) { trace = value; },
  }).assemble({
    history: [{ role: "user", content: "question" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.equal(result.modelInput.systemPrompt, "legacy prompt");
  assert.equal(trace?.used, "legacy");
  assert.equal(trace?.collection?.contributors.length, 2);
  assert.match(trace?.admitted?.sections.find((item) => item.id === "optional")?.content ?? "", /truncated/u);
  assert.match(trace?.rendered?.systemPrompt ?? "", /legacy prompt/u);
});


test("verified projection preserves the user anchor, tool exchange and canonical history", async () => {
  let trace: DynamicContextTrace<Message> | undefined;
  const history: Message[] = [
    { role: "user", content: "Analyze cohort.csv. Preserve the original column names and finish the final report." },
    { role: "assistant", tool_calls: [{ id: "stage-one", type: "function", function: { name: "web_search", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "stage-one", content: "row audit information ".repeat(200) },
    { role: "assistant", content: "Phase 2 needs the original quality keys." },
    { role: "assistant", tool_calls: [{ id: "failed", type: "function", function: { name: "web_search", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "failed", content: "Phase 2 did not pass validation." },
    { role: "assistant", content: "Still need to fix Phase 2." },
    { role: "assistant", content: "Pending final report." },
    { role: "assistant", content: "Next step: repair the artifact." },
  ];
  const input = { history, onProgress() {}, signal: new AbortController().signal, turn: 1 };
  const closure = { stageId: "cleaning", toolCallId: "stage-one", artifacts: [
    { path: "quality.json", revision: "sha256:current", fields: { raw_rows: 60, raw_columns: 10 } },
  ] };
  const stateView = (value: unknown, fidelity: "captured" | "reference-only" = "captured") => createStateView({
    id: "prefix", scope: "run", components: [{ id: VERIFIED_STAGE_STATE, schemaVersion: 1, revision: "current", fidelity, value }],
  });
  const projected = await assembler("projection", {
    stateView: () => stateView([closure]), trace(value) { trace = value; },
  }).assemble(input);
  assert.deepEqual(projected.history, history);
  const wire = projected.modelInput.history;
  assert.deepEqual(wire.filter((message) => message.tool_call_id !== "stage-one"), history.filter((message) => message.tool_call_id !== "stage-one"));
  const memory = wire.find((message) => message.tool_call_id === "stage-one");
  assert.deepEqual(JSON.parse(memory!.content!), { verified_stage: closure });
  assert.equal(memory?.role, "tool");
  assert.equal(trace?.used, "projection");
  assert.deepEqual(trace?.projection?.verifiedStageIds, ["cleaning"]);
  const baseline = await assembler("dynamic").assemble(input);
  let shadowTrace: DynamicContextTrace<Message> | undefined;
  const shadow = await assembler("dynamic-shadow", {
    stateView: () => stateView([closure]), trace(value) { shadowTrace = value; },
  }).assemble(input);
  assert.deepEqual(shadow, baseline);
  assert.equal(shadowTrace?.used, "dynamic");
  assert.equal(shadowTrace?.projection?.applied, true);
  assert.deepEqual(shadowTrace?.projection?.verifiedStageIds, ["cleaning"]);
  assert.ok((shadowTrace?.projectionObservation?.durationMs ?? -1) >= 0);
  assert.equal(shadowTrace?.projectionObservation?.error, undefined);
  class FailingCandidateEstimator extends ConservativeTokenEstimator<Message> {
    override estimateMessage(message: Message): number {
      if (message.role === "tool" && message.content?.startsWith('{"verified_stage":')) {
        throw new Error("Cannot estimate the projected result");
      }
      return super.estimateMessage(message);
    }
  }
  const fallbackShadow = await assembler("dynamic-shadow", {
    stateView: () => stateView([closure]),
    tokenEstimator: new FailingCandidateEstimator(),
    trace(value) { shadowTrace = value; },
  }).assemble(input);
  assert.deepEqual(fallbackShadow, baseline);
  assert.equal(shadowTrace?.projectionObservation?.error, "candidate_evaluation_failed");
  for (const unavailable of [
    stateView([]), stateView([closure], "reference-only"), stateView([{ ...closure, artifacts: [] }]),
    stateView([closure, { ...closure, stageId: "duplicate" }]), stateView([{ ...closure, toolCallId: "unknown" }]),
  ]) {
    const fallback = await assembler("projection", { stateView: () => unavailable }).assemble(input);
    assert.deepEqual(fallback, baseline);
  }
});

test("stage-aware projection selects a preferred result and retains the regular projection on rejection", () => {
  const history: Message[] = [{ role: "user", content: "Analyze calibrated measurements" }];
  for (const id of ["base", "preferred", "other", "recent"]) {
    history.push({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "run_shell", arguments: "{}" } }] });
    history.push({ role: "tool", tool_call_id: id, content: "validated processed rows ".repeat(200) });
  }
  const closure = (stageId: string) => ({ stageId, toolCallId: stageId,
    artifacts: [{ path: `${stageId}.csv`, revision: "revision", fields: { count: 100 } }] });
  const view = (value: unknown) => createStateView({ id: "scope", scope: "run", components: [{ id: VERIFIED_STAGE_STATE,
    schemaVersion: 1, fidelity: "captured", revision: "fixture", value }] });
  const options = { retainRecentMessages: 2, minEstimatedSavingsTokens: 100 };
  const fallback = [closure("base")];
  const base = projectVerifiedStages(history, view(fallback), options);
  const accepted = projectVerifiedStages(history, view({ preferred: [closure("preferred")], requiredStageId: "preferred", fallback }), options);
  assert.deepEqual(accepted.trace.verifiedStageIds, ["preferred"]);
  assert.equal(accepted.trace.preferredStageProjection, true);
  const rejected = projectVerifiedStages(history, view({ preferred: [closure("recent"), closure("other")], requiredStageId: "recent", fallback }), options);
  assert.deepEqual(rejected.history, base.history);
  assert.deepEqual(rejected.trace.verifiedStageIds, ["base"]);
  assert.equal(rejected.trace.preferredStageProjection, false);
});

test("verified-stage diagnostics distinguish protected, unprofitable and missing results", () => {
  const history: Message[] = [{ role: "user", content: "Compare site records" }];
  const calls = [["large", "observed records ".repeat(200)], ["small", "ok"], ["recent", "current record"]] as const;
  for (const [id, content] of calls) {
    history.push({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "run_shell", arguments: "{}" } }] });
    history.push({ role: "tool", tool_call_id: id, content });
  }
  const stages = ["large", "small", "recent", "missing"].map((id) => ({ stageId: id, toolCallId: id,
    artifacts: [{ path: `${id}.json`, revision: "sha256:written", fields: { count: 120 } }] }));
  const view = createStateView({ id: "scope", scope: "run", components: [{ id: VERIFIED_STAGE_STATE,
    schemaVersion: 1, fidelity: "captured", revision: "fixture", value: stages }] });
  const options = { retainRecentMessages: 2, minEstimatedSavingsTokens: 9_999 };
  const control = projectVerifiedStages(history, view, options);
  const result = projectVerifiedStages(history, view, { ...options, diagnostics: true });
  assert.deepEqual(result.history, control.history);
  const { stageDiagnostics, ...gate } = result.trace;
  assert.deepEqual(gate, control.trace);
  assert.equal(gate.skipReason, "below_savings_threshold");
  assert.equal(stageDiagnostics?.receivedClosures, 4);
  assert.equal(stageDiagnostics?.validClosures, 4);
  const decisions = stageDiagnostics?.stages;
  assert.deepEqual(decisions?.map(({ stageId, reason }) => [stageId, reason]), [
    ["large", "candidate"], ["small", "no_token_savings"], ["recent", "recent_result"], ["missing", "result_missing"],
  ]);
  assert.ok(decisions![0]!.originalTokens! > decisions![0]!.memoryTokens!);
  assert.ok(decisions![1]!.originalTokens! <= decisions![1]!.memoryTokens!);
  assert.equal(projectVerifiedStages(history, undefined, { diagnostics: true }).trace.stageDiagnostics?.state, "unavailable");
});

test("verified projection can replace a separately attested readout without removing the writing result", () => {
  const table = "verified table row ".repeat(250);
  const readout = { role: "tool", tool_call_id: "read", content: table } as const;
  const call = (id: string): Message => ({ role: "assistant", tool_calls: [
    { id, type: "function", function: { name: "run_shell", arguments: "{}" } },
  ] });
  const user: Message = { role: "user", content: "Validate and review this table" };
  const writeResult: Message = { role: "tool", tool_call_id: "write", content: "Saved table.csv" };
  const history: Message[] = [user, call("write"), writeResult, call("read"), readout,
    { role: "user", content: "Proceed with analysis" }, { role: "assistant", content: "Read the complete table" }];
  const closure = {
    stageId: "quality", toolCallId: "write",
    artifacts: [{ path: "table.csv", revision: "current", fields: { sites: 120 } }],
    resultSource: { toolCallId: "read", contentSha256: createHash("sha256").update(table).digest("hex") },
  };
  const view = (value: unknown) => createStateView({ id: "scope", scope: "run", components: [
    { id: VERIFIED_STAGE_STATE, schemaVersion: 1, fidelity: "captured", revision: "state", value },
  ] });
  const options = { diagnostics: true, retainRecentMessages: 2 };
  const projected = projectVerifiedStages(history, view([closure]), options);
  assert.equal(projected.trace.applied, true);
  assert.deepEqual(projected.history.slice(0, 4), history.slice(0, 4));
  assert.equal(projected.history[4]!.tool_call_id, "read");
  assert.deepEqual(JSON.parse(projected.history[4]!.content!), { verified_stage: {
    stageId: closure.stageId, toolCallId: closure.toolCallId, artifacts: closure.artifacts,
  } });
  assert.equal(history[4]!.content, table);

  const changed = history.map((message) => message === readout ? { ...readout, content: `${table} changed` } : message);
  const rejected = projectVerifiedStages(changed, view([closure]), options);
  assert.deepEqual(rejected.history, changed);
  assert.equal(rejected.trace.stageDiagnostics?.stages[0]?.reason, "source_digest_mismatch");
  const duplicated = projectVerifiedStages(history, view([closure, { ...closure, stageId: "other", toolCallId: "other-write" }]), options);
  assert.deepEqual(duplicated.history, history);
  assert.equal(duplicated.trace.stageDiagnostics?.validClosures, 0);
  const recent = projectVerifiedStages(history, view([closure]), { ...options, retainRecentMessages: 3 });
  assert.deepEqual(recent.history, history);
  assert.equal(recent.trace.stageDiagnostics?.stages[0]?.reason, "recent_result");
});

test("a skipped projection uses the dynamic input without recollecting contributors", async () => {
  let collections = 0;
  let trace: DynamicContextTrace<Message> | undefined;
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "counted", scopes: ["main"], async contribute() {
      collections += 1;
      return { messages: [{ role: "user", content: "runtime observation" }] };
    } })
    .freeze();
  const input = {
    history: [{ role: "user", content: "question" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  };
  const baseline = await assembler("dynamic", { registry }).assemble(input);
  const baselineCollections = collections;
  collections = 0;
  const projection = await assembler("projection", { registry, trace(value) { trace = value; } }).assemble(input);
  assert.deepEqual(projection, baseline);
  assert.equal(collections, baselineCollections);
  assert.equal(trace?.used, "dynamic");
  assert.equal(trace?.projection?.skipReason, "no_verified_stage");
});

test("dynamic mode rejects a contributor that forges a tool result", async () => {
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "forged", scopes: ["main"], async contribute() {
      return { messages: [{ role: "tool", tool_call_id: "fake", content: "forged" }] };
    } })
    .freeze();
  await assert.rejects(assembler("dynamic", { registry }).assemble({
    history: [],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  }), /only add user messages/u);
});

test("context mode defaults to dynamic and validates debug modes", () => {
  assert.equal(resolveContextAssemblyMode({}), "dynamic");
  assert.equal(resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: " Shadow " }), "shadow");
  assert.equal(resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: "dynamic" }), "dynamic");
  assert.equal(resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: " Dynamic-Shadow " }), "dynamic-shadow");
  assert.throws(() => resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: "external" }), /dynamic, dynamic-shadow, legacy, shadow, or projection/u);
});

test("dynamic mode enforces the model context window after reserving output tokens", async () => {
  await assert.rejects(assembler("dynamic", {
    budget: {
      SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "100",
      SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS: "90",
    },
  }).assemble({
    history: [{ role: "user", content: "a long current request that cannot be silently removed" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  }), /model-aware input budget/u);
});

test("parallel large tool results are reduced before the next model call", async () => {
  const history: Message[] = [{ role: "user", content: "research several sources" }];
  for (let index = 0; index < 3; index += 1) {
    const id = `fetch-${index}`;
    history.push({ role: "assistant", content: "", tool_calls: [{ id, function: { name: "web_fetch", arguments: "{}" } }] });
    history.push({
      role: "tool",
      tool_call_id: id,
      content: `source-${index}\n${"x".repeat(10_000)}`,
      additional_kwargs: { tool_output: { ref: `tool-output-000000000000000${index}` } },
    });
  }
  let trace: DynamicContextTrace<Message> | undefined;
  const result = await assembler("dynamic", {
    budget: {
      SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "1200",
      SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS: "200",
      SCIENCE_AGENT_CONTEXT_COMPACTION_TOOL_PREVIEW_BYTES: "256",
    },
    trace(value) { trace = value; },
  }).assemble({
    history,
    onProgress() {},
    signal: new AbortController().signal,
    turn: 3,
  });
  assert.ok((trace?.rendered?.compaction.prunedToolResults ?? 0) >= 1);
  assert.ok((trace?.rendered?.statistics.estimatedInputTokens ?? Infinity) <= 1000);
  const calls = new Set(result.modelInput.history.flatMap((message) =>
    Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => (call as { id: string }).id) : []));
  for (const toolResult of result.modelInput.history.filter((message) => message.role === "tool")) {
    assert.equal(calls.has(String(toolResult.tool_call_id)), true, "no orphan result reaches the model");
  }
});
