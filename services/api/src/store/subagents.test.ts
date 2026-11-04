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
 * Persisted subagent records are untrusted JSON written by earlier builds and
 * by the runtime. Every optional field is either migrated, filtered, or left
 * out; a `running` record from a dead process becomes a recoverable failure.
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import { SUBAGENT_RESTART_LOAD_PLACEHOLDER_ERROR } from "../subagent-continuation.js";
import { normalizePersistedSubagent, normalizeSubagentInputPaths } from "./subagents.js";

const brief = {
  collaborationRules: ["ask before delegating"],
  constraints: ["no network"],
  goal: "Summarize the fixture",
  outputRequirements: ["Return a JSON object"],
};

test("a non-record persisted value is discarded", () => {
  assert.equal(normalizePersistedSubagent(undefined), undefined);
  assert.equal(normalizePersistedSubagent(null), undefined);
  assert.equal(normalizePersistedSubagent("subagent"), undefined);
  assert.equal(normalizePersistedSubagent([]), undefined);
});

test("a legacy brief is migrated into a prompt and defaults", () => {
  const migrated = normalizePersistedSubagent({
    id: "legacy-1",
    sessionId: "session",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    brief: { title: "Inspect the dataset", role: "analyst", intendedSteps: ["open", 2], outputSchema: "{}" },
  });
  assert.ok(migrated);
  assert.equal(migrated.id, "legacy-1");
  assert.equal(migrated.input.description, "Inspect the dataset");
  assert.equal(migrated.input.prompt, "Role: analyst\n\nTask: Inspect the dataset\n\nIntended steps:\n1. open\n2. 2\n\nRequired output schema:\n{}");
  assert.equal(migrated.input.subagentType, "general-purpose");
  assert.equal(migrated.maxTurns > 0, true);
  assert.equal(migrated.timeoutSeconds > 0, true);
  assert.equal(migrated.turnCount, 0);
  assert.equal(migrated.parentTurnId, "migrated");
  assert.equal(migrated.status, "completed");
  assert.equal(migrated.error, undefined);
  assert.equal(migrated.finishedAt, undefined);
});

test("a record without a usable title falls back to the migrated description", () => {
  const migrated = normalizePersistedSubagent({ brief: {} });
  assert.ok(migrated);
  assert.equal(migrated.input.description, "Migrated subagent");
  assert.equal(migrated.input.prompt, "Migrated subagent");
  assert.match(migrated.id, /^[0-9a-f-]{36}$/);
  assert.equal(migrated.sessionId, "");
});

test("a running record from a dead process becomes a recoverable failure", () => {
  const recovered = normalizePersistedSubagent({ status: "running", sessionId: "session" });
  assert.ok(recovered);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.interruptedByRestart, true);
  assert.equal(recovered.error, SUBAGENT_RESTART_LOAD_PLACEHOLDER_ERROR);
  assert.match(recovered.finishedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("an earlier restart placeholder keeps the interrupted flag without a new timestamp", () => {
  const recovered = normalizePersistedSubagent({ status: "failed", error: SUBAGENT_RESTART_LOAD_PLACEHOLDER_ERROR, finishedAt: "2026-01-02T00:00:00.000Z" });
  assert.ok(recovered);
  assert.equal(recovered.interruptedByRestart, true);
  assert.equal(recovered.finishedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(normalizePersistedSubagent({ status: "failed", interruptedByRestart: true }).interruptedByRestart, true);
  assert.equal(normalizePersistedSubagent({ status: "failed", error: "provider failed" })?.interruptedByRestart, undefined);
});

test("an unknown or missing status closes as failed", () => {
  assert.equal(normalizePersistedSubagent({ status: "queued" })?.status, "failed");
  assert.equal(normalizePersistedSubagent({})?.status, "failed");
  assert.equal(normalizePersistedSubagent({ status: "cancelled" })?.status, "cancelled");
  assert.equal(normalizePersistedSubagent({ status: "timed_out" })?.status, "timed_out");
});

test("a persisted brief is normalized with its version and a malformed one is dropped", () => {
  const stored = normalizePersistedSubagent({ input: { description: "d", prompt: "p", brief: { ...brief, version: 2 } } });
  assert.deepEqual(stored?.input.brief, { ...brief, version: 2 });
  const unversioned = normalizePersistedSubagent({ input: { description: "d", prompt: "p", brief: { ...brief, version: 1.5 } } });
  assert.deepEqual(unversioned?.input.brief, brief);
  const malformed = normalizePersistedSubagent({ input: { description: "d", prompt: "p", brief: { goal: "" } } });
  assert.equal(malformed?.input.brief, undefined);
});

test("input paths, tools, and the specialist id are filtered from stored JSON", () => {
  const stored = normalizePersistedSubagent({
    input: { description: "d", prompt: "p", inputPaths: ["a", 2, "b"], tools: ["read", 3], specialistId: "specialist" },
  });
  assert.deepEqual(stored?.input.inputPaths, ["a", "b"]);
  assert.deepEqual(stored?.input.tools, ["read"]);
  assert.equal(stored?.input.specialistId, "specialist");
  assert.equal(stored?.specialistId, "specialist");
  assert.deepEqual(normalizePersistedSubagent({ input: { description: "d", prompt: "p", tools: null } })?.input.tools, null);
  assert.equal(normalizePersistedSubagent({ input: { description: "d", prompt: "p", tools: "all" } })?.input.tools, undefined);
  assert.equal(normalizePersistedSubagent({ input: { description: "d", prompt: "p", subagentType: "explore" } })?.input.subagentType, "explore");
  assert.equal(normalizePersistedSubagent({ specialistId: 7 })?.specialistId, undefined);
});

test("a handoff is kept only when its paths and workspace are strings", () => {
  const stored = normalizePersistedSubagent({
    handoff: {
      inputPaths: ["a.md", 1],
      manifestPath: "manifest.json",
      privateWorkspacePath: "/workspace",
      workspaceId: "workspace-1",
      skippedInputPaths: [
        { path: "b.md", reason: "too large", size: 10 },
        { path: 1, reason: "bad" },
        { path: "c.md", reason: "bad", size: "10" },
      ],
    },
  });
  assert.deepEqual(stored?.handoff, {
    inputPaths: ["a.md"],
    manifestPath: "manifest.json",
    privateWorkspacePath: "/workspace",
    workspaceId: "workspace-1",
    skippedInputPaths: [{ path: "b.md", reason: "too large", size: 10 }, { path: "c.md", reason: "bad" }],
  });
  assert.equal(normalizePersistedSubagent({ handoff: { inputPaths: [], manifestPath: "m" } })?.handoff, undefined);
  assert.equal(normalizePersistedSubagent({ handoff: "manifest" })?.handoff, undefined);
});

test("steps fall back to the transcript and an empty record has none", () => {
  const steps = [{ role: "user", text: "hi" }];
  assert.deepEqual((normalizePersistedSubagent({ steps }) as { steps: unknown }).steps, steps);
  assert.deepEqual((normalizePersistedSubagent({ transcript: steps }) as { steps: unknown }).steps, steps);
  assert.deepEqual((normalizePersistedSubagent({}) as { steps: unknown }).steps, []);
});

test("model, usage, and result validation survive only in their exact shape", () => {
  const model = { id: "m", model: "model-a", name: "Model A" };
  assert.deepEqual(normalizePersistedSubagent({ model })?.model, model);
  assert.equal(normalizePersistedSubagent({ model: { id: "m" } })?.model, undefined);
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
  assert.deepEqual(normalizePersistedSubagent({ usage })?.usage, usage);
  assert.equal(normalizePersistedSubagent({ usage: { inputTokens: 1 } })?.usage, undefined);
  const validation = { status: "passed", errors: ["fine", 1], schema: { type: "object" }, validatedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(normalizePersistedSubagent({ resultValidation: validation })?.resultValidation, {
    errors: ["fine"], schema: { type: "object" }, status: "passed", validatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(normalizePersistedSubagent({ resultValidation: { status: "unknown", errors: [] } })?.resultValidation, undefined);
  assert.equal(typeof normalizePersistedSubagent({ resultValidation: { status: "skipped", errors: [] } })?.resultValidation?.validatedAt, "string");
});

test("a context reference is kept only with a valid agent-state digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(normalizePersistedSubagent({ contextRef: { pool: "agent-state", digest, size: 4, mediaType: "application/json" } })?.contextRef, { pool: "agent-state", digest, size: 4, mediaType: "application/json" });
  assert.equal(normalizePersistedSubagent({ contextRef: { pool: "other", digest, size: 4, mediaType: "application/json" } })?.contextRef, undefined);
  assert.equal(normalizePersistedSubagent({ contextRef: { pool: "agent-state", digest: "sha256:abc", size: 4, mediaType: "application/json" } })?.contextRef, undefined);
});

test("runtime options, diagnostics, and pending input are validated by runtime", () => {
  assert.deepEqual(normalizePersistedSubagent({ runtimeOptions: { kind: "codex", extra: true } })?.runtimeOptions, { kind: "codex", extra: true });
  assert.equal(normalizePersistedSubagent({ runtimeOptions: { kind: "other" } })?.runtimeOptions, undefined);
  assert.deepEqual(normalizePersistedSubagent({ runtimeDiagnostics: { stderr: "boom" } })?.runtimeDiagnostics, { stderr: "boom" });
  assert.equal(normalizePersistedSubagent({ runtimeDiagnostics: "boom" })?.runtimeDiagnostics, undefined);
  assert.deepEqual(normalizePersistedSubagent({ runtimeInput: { id: "input-1", runtime: "acp", state: "configured", secret: "drop" } })?.runtimeInput, { id: "input-1", runtime: "acp", state: "configured" });
  assert.equal(normalizePersistedSubagent({ runtimeInput: { id: "input-1", runtime: "acp", state: "applied" } })?.runtimeInput, undefined);
  assert.equal(normalizePersistedSubagent({ runtimeInput: { id: "input-1", runtime: "other", state: "pending" } })?.runtimeInput, undefined);
});

test("numeric limits fall back unless they are positive", () => {
  const stored = normalizePersistedSubagent({ maxTurns: 0, timeoutSeconds: -1, turnCount: -1 });
  assert.equal(stored?.maxTurns > 0, true);
  assert.equal(stored?.timeoutSeconds > 0, true);
  assert.equal(stored?.turnCount, 0);
  assert.equal(normalizePersistedSubagent({ maxTurns: 5, timeoutSeconds: 60, turnCount: 2 })?.maxTurns, 5);
  assert.equal(normalizePersistedSubagent({ maxTurns: 5, timeoutSeconds: 60, turnCount: 2 })?.timeoutSeconds, 60);
  assert.equal(normalizePersistedSubagent({ maxTurns: 5, timeoutSeconds: 60, turnCount: 2 })?.turnCount, 2);
});

test("optional scalar fields pass through only as strings", () => {
  assert.equal(normalizePersistedSubagent({ specialistConfigHash: "hash" })?.specialistConfigHash, "hash");
  assert.equal(normalizePersistedSubagent({ runtimeSessionId: "runtime" })?.runtimeSessionId, "runtime");
  assert.equal(normalizePersistedSubagent({ rawStructuredResult: "{}" })?.rawStructuredResult, "{}");
  assert.equal(normalizePersistedSubagent({ parentTurnId: "turn" })?.parentTurnId, "turn");
  assert.equal(normalizePersistedSubagent({ createdAt: "2026-01-01T00:00:00.000Z" })?.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(normalizePersistedSubagent({ finishedAt: "2026-01-01T00:00:00.000Z" })?.finishedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(normalizePersistedSubagent({ structuredResult: { ok: true } })?.structuredResult, { ok: true });
});

test("input paths are trimmed, deduplicated, and bounded", () => {
  assert.equal(normalizeSubagentInputPaths(undefined), undefined);
  assert.equal(normalizeSubagentInputPaths(null), undefined);
  assert.equal(normalizeSubagentInputPaths([]), undefined);
  assert.deepEqual(normalizeSubagentInputPaths([" a.md ", "./b.md", "a.md"]), ["a.md", "b.md"]);
  assert.throws(() => normalizeSubagentInputPaths("a.md"), /must be an array/);
  assert.throws(() => normalizeSubagentInputPaths([1]), /must contain strings/);
  assert.throws(() => normalizeSubagentInputPaths(["./"]), /non-empty/);
  assert.throws(() => normalizeSubagentInputPaths(["a\0b"]), /non-empty/);
  assert.throws(() => normalizeSubagentInputPaths(["a\nb"]), /non-empty/);
  assert.throws(() => normalizeSubagentInputPaths(["a".repeat(2_001)]), /non-empty/);
  assert.throws(() => normalizeSubagentInputPaths(Array.from({ length: 51 }, (_value, index) => `f${index}`)), /at most 50/);
  assert.equal(normalizeSubagentInputPaths(Array.from({ length: 50 }, (_value, index) => `f${index}`))?.length, 50);
});
