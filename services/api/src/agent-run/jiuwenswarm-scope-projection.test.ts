// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import { createSwarmHistoryProjection } from "./jiuwenswarm-scope-projection.js";

function swarmUser(content: string): AgentHistoryMessage {
  return { role: "user", content: `你收到一条消息：\n${JSON.stringify({ source: "tui", type: "user input", content })}` };
}

const reminder: AgentHistoryMessage = { role: "user", content: "<system-reminder>Current run metadata</system-reminder>" };
const continuation = swarmUser("Continue the accepted run.\nDo not rewrite inputs.");
const splitTool: AgentHistoryMessage = { role: "assistant", content: null,
  tool_calls: [{ id: "call-1", type: "function", function: { name: "run_shell", arguments: "{}" } }] };

test("Swarm recovery adds sealed history while keeping the live envelope, reminder and current tool result", async () => {
  const sealed: AgentHistoryMessage[] = [{ role: "user", content: "Sealed source" }];
  const tool: AgentHistoryMessage = { role: "tool", content: "current-result", tool_call_id: "call-1" };
  const project = createSwarmHistoryProjection({ prompt: "Continue the accepted run.\nDo not rewrite inputs.", sessionId: "s",
    projectScopes: false, recoveryHistory: sealed })!;
  const input = [reminder, swarmUser("Previous transient prompt"), continuation, splitTool, tool];
  assert.deepEqual(await project(input), [reminder, ...sealed, continuation, splitTool, tool]);
  await assert.rejects(project(input.filter(message => message !== continuation)), /lost the continuation prompt boundary/u);
});

test("Swarm projection retains the current run and prior instructions with tool pairs intact", async () => {
  const project = createSwarmHistoryProjection({ prompt: "Continue the accepted run.\nDo not rewrite inputs.", sessionId: "s", projectScopes: true })!;
  const archived: AgentHistoryMessage[] = Array.from({ length: 6 }, (_, i) => [
    { ...splitTool, tool_calls: [{ id: `archived-${i}`, type: "function", function: { name: "run_shell", arguments: "{}" } }] },
    { role: "tool" as const, content: `raw-archive-${i} ${"x".repeat(3_500)}`, tool_call_id: `archived-${i}` },
  ]).flat();
  const originalTask = swarmUser("Preserve all evidence files.");
  const input = [reminder, originalTask, ...archived, continuation];
  const output = await project(input);
  assert.ok(output.length < input.length);
  assert.ok(output.includes(originalTask));
  assert.equal(output.at(-1), continuation);
  assert.ok(!output.some(message => typeof message.content === "string" && message.content.startsWith("raw-archive-0")));
  for (const [index, message] of output.entries()) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      assert.equal(output[index + 1]?.tool_call_id, (message.tool_calls[0] as { id: string }).id);
    }
  }
  for (const unchanged of [[reminder, continuation], [reminder, ...archived, splitTool, continuation], [reminder, ...archived]]) {
    assert.equal(await project(unchanged), unchanged);
  }
});


test("closed Scope folds only verified exact stdout and restores it when proof is removed", async () => {
  const stdout = "accepted assay rows\n".repeat(500);
  const header = { executionId: "execution-1", state: "completed", exitCode: 0, createdFiles: [], modifiedFiles: [],
    recovery: { schemaVersion: 1, capability: "unknown", reason: "NOT_REPORTED" } };
  const content = JSON.stringify(header) + "\nstdout:\n" + stdout + "\nstderr:\n";
  const shell: AgentHistoryMessage = { role: "tool", tool_call_id: "call-1", content };
  const close = { role: "assistant" as const, content: "Closed child" };
  const evidence = { nodeId: "child", executionId: "execution-1", findings: ["55 samples"], obligations: ["Report confidence"],
    artifacts: [{ id: "artifact-1", hash: createHash("sha256").update(stdout).digest("hex"), path: "assay.tsv" }] };
  const proofs = new Map<string, typeof evidence>();
  const project = createSwarmHistoryProjection({ prompt: "Continue the accepted run.\nDo not rewrite inputs.", sessionId: "s",
    projectScopes: false, scopeContext: () => ({ sequence: 2, text: "scope" }), closedShellEvidence: () => proofs })!;
  const input = [reminder, continuation, splitTool, shell, close];
  assert.equal((await project(input)).find(message => message.role === "tool")?.content, content);
  proofs.set("call-1", evidence);
  const output = await project(input);
  const result = output.find(message => message.role === "tool")!;
  assert.match(String(result.content), /Report confidence/u);
  assert.match(String(result.content), /artifact-1/u);
  assert.ok(String(result.content).length < content.length / 2);
  assert.ok(output.some(message => message.role === continuation.role && message.content === continuation.content));
  assert.equal(result.tool_call_id, "call-1");
  assert.equal(shell.content, content);
  const repr = (value: string) => `{'result': '${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}'}`;
  const wrapped = repr(content);
  const wireInput = [...input.slice(0, 3), { ...shell, content: wrapped }, close];
  const foldedWire = String((await project(wireInput)).find(message => message.role === "tool")?.content);
  assert.match(foldedWire, /^\{'result': "/u);
  assert.match(foldedWire, /artifact-1/u);
  assert.doesNotMatch(foldedWire, /accepted assay rows/u);
  const mismatched = content.replace("accepted", "unexpected");
  const failed = content.replace('"exitCode":0', '"exitCode":1');
  const writes = content.replace('"createdFiles":[]', '"createdFiles":["x.txt"]');
  for (const unsafe of [mismatched, failed, writes, repr(mismatched), wrapped.replace("accepted", "\\qaccepted"),
    repr(content + "Runner warning"), repr(content.replace('"execution-1"', '"wrong-execution"'))]) {
    assert.equal((await project([reminder, continuation, splitTool, { ...shell, content: unsafe }, close]))
      .find(message => message.role === "tool")?.content, unsafe);
  }
  proofs.clear();
  assert.equal((await project(input)).find(message => message.role === "tool")?.content, content);
});
