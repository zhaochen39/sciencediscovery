// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { projectScopeHistory } from "./scope-projection.js";

function toolCall(name: string) {
  return { id: `call-${name}`, type: "function", function: { name, arguments: "{}" } };
}

test("scope projection keeps a bounded model history and a structured node memory", () => {
  const history = [
    { role: "user", content: "Analyze cohort.csv and produce the report." },
    { role: "assistant", content: `I inspected cohort.csv and found 100 rows. ${"detail ".repeat(100)}` },
    { role: "assistant", content: "", tool_calls: [toolCall("run_shell")] },
    { role: "tool", tool_call_id: "call-run_shell", content: `cleaned.csv written ${"detail ".repeat(100)}` },
    { role: "assistant", content: `Next, run the baseline model and save model.json. ${"detail ".repeat(100)}` },
    { role: "assistant", content: "", tool_calls: [toolCall("run_shell")] },
    { role: "tool", tool_call_id: "call-run_shell", content: `model.json written ${"detail ".repeat(100)}` },
    { role: "assistant", content: `The model is ready for sensitivity analysis. ${"detail ".repeat(100)}` },
  ];
  const canonical = structuredClone(history);
  const result = projectScopeHistory(history, { retainRecentMessages: 3, maxObligations: 1 });
  assert.deepEqual(history, canonical);
  assert.equal(result.trace.applied, true);
  assert.equal(result.trace.sourceMessageCount, 8);
  assert.ok(result.trace.removedMessageCount > 0);
  assert.equal(result.history[0]?.role, "user");
  assert.match(String(result.history[0]?.content), /scope_node_memory/u);
  assert.deepEqual(result.memory.artifacts, ["cohort.csv", "cleaned.csv", "model.json"]);
  assert.deepEqual(result.memory.requiredArtifacts, ["cohort.csv"]);
  assert.deepEqual(result.memory.completedStages, []);
  assert.equal(result.memory.completionState, "in_progress");
  assert.equal(result.memory.obligations.length, 1);
});

test("scope projection skips low-value compression while preserving the canonical history", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    role: index === 0 ? "user" : "assistant",
    content: index === 0 ? "Analyze cohort.csv" : `stage ${index} wrote model_results.json ${"detail ".repeat(200)}`,
  }));
  const result = projectScopeHistory(history, {
    minSourceTokensForProjection: 10_000,
    minEstimatedSavingsTokens: 500,
    minEstimatedSavingsPercent: 10,
  });
  assert.deepEqual(result.history, history);
  assert.equal(result.trace.applied, false);
  assert.equal(result.trace.skipReason, "below_source_threshold");
  assert.ok(result.trace.candidateProjectedTokens < result.trace.sourceTokens);
  assert.ok(result.trace.estimatedSavingsTokens > 0);
});
test("scope projection leaves short histories unchanged", () => {
  const history = [{ role: "user", content: "short" }, { role: "assistant", content: "done" }];
  const result = projectScopeHistory(history);
  assert.deepEqual(result.history, history);
  assert.equal(result.trace.removedMessageCount, 0);
  assert.equal(result.trace.skipReason, "short_history");
});

const longHistory = Array.from({ length: 10 }, (_, index) => ({
  role: index === 0 ? "user" : "assistant",
  content: `Stage ${index}: ${"detail ".repeat(200)}`,
}));

for (const [options, reason] of [
  [{ minEstimatedSavingsTokens: 10_000 }, "below_savings_threshold"],
  [{ minEstimatedSavingsPercent: 99 }, "below_savings_percent"],
] as const) {
  test(`scope projection skips a candidate with ${reason}`, () => {
    const result = projectScopeHistory(longHistory, options);
    assert.deepEqual(result.history, longHistory);
    assert.equal(result.trace.applied, false);
    assert.equal(result.trace.skipReason, reason);
    assert.equal(result.trace.projectedTokens, result.trace.sourceTokens);
    assert.ok(result.trace.candidateProjectedTokens < result.trace.sourceTokens);
  });
}

test("scope projection rejects a candidate that grows history", () => {
  const history = longHistory.slice(0, 7).map(({ role }) => ({ role, content: "ok" }));
  const result = projectScopeHistory(history);
  assert.deepEqual(result.history, history);
  assert.equal(result.trace.applied, false);
  assert.ok(result.trace.estimatedSavingsTokens < 0);
});

test("scope projection falls back when structured state exceeds the memory budget", () => {
  const artifacts = Array.from({ length: 100 }, (_, index) => `artifact-${index}.json`).join(" ");
  const history = [{ role: "user", content: artifacts }, ...longHistory.slice(1)];
  const result = projectScopeHistory(history, { maxMemoryCharacters: 800, maxFacts: 0, maxObligations: 0 });
  assert.equal(result.trace.skipReason, "memory_budget");
  assert.deepEqual(result.history, history);
});
