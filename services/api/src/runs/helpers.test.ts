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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ChatMessage, SubagentStep } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";

import {
  appendToolProgress,
  buildCompletedToolTrace,
  buildSubagentToolStep,
  cloneRunEventDetails,
  createDeltaCoalescingSink,
  emptyMatch,
  emptyTrace,
  firstUserAuthoredMessage,
  isTerminalRunStatus,
  skillAuthoringCommandPrompt,
  splitArtifactVersionSuffix,
  stopSessionSubagent,
  subagentStreamId,
  toolOutputStreamId,
} from "./index.js";

function toolEnd(overrides: Record<string, unknown> = {}) {
  return { isError: false, result: {}, toolCallId: "call-1", toolName: "search_workspace", type: "tool_execution_end", ...overrides };
}

test("RUN cloneRunEventDetails deep-clones plain data", () => {
  const source = { nested: { value: 1 }, list: [1, 2] };
  const cloned = cloneRunEventDetails(source) as typeof source;
  assert.deepEqual(cloned, source);
  cloned.nested.value = 2;
  assert.equal(source.nested.value, 1);
  assert.equal(cloneRunEventDetails(undefined), undefined);
});

test("RUN cloneRunEventDetails falls back to JSON when structuredClone rejects the value", () => {
  const cloned = cloneRunEventDetails({ fn: () => 1, keep: "text" });
  assert.deepEqual(cloned, { keep: "text" }, "functions are dropped by the JSON round trip");
});

test("RUN cloneRunEventDetails returns undefined when neither strategy can copy the value", () => {
  const circular: Record<string, unknown> = { fn: () => 1 };
  circular.self = circular;
  assert.equal(cloneRunEventDetails(circular), undefined);
});

test("RUN buildCompletedToolTrace records bounded evidence and a completed status", () => {
  const trace = buildCompletedToolTrace(toolEnd({ result: { details: { count: 2 } } }), "line one");
  assert.equal(trace.id, "call-1");
  assert.equal(trace.name, "search_workspace");
  assert.equal(trace.status, "completed");
  assert.deepEqual(trace.details, { count: 2 });
  assert.equal(trace.outputChars, 8);
  assert.equal(trace.outputStream, "tool-call-1");
  assert.equal(trace.preview, "line one");
  assert.equal(trace.paperCount, undefined);
});

test("RUN buildCompletedToolTrace omits output fields when the tool produced no text", () => {
  const trace = buildCompletedToolTrace(toolEnd({ isError: true }));
  assert.equal(trace.status, "failed");
  assert.equal("outputChars" in trace, false);
  assert.equal("outputStream" in trace, false);
  assert.equal("details" in trace, false);
});

test("RUN buildCompletedToolTrace keeps multi-line output to a head and tail preview", () => {
  const trace = buildCompletedToolTrace(toolEnd(), ["a", "b", "c", "d", "e", "f"].join("\n"));
  assert.equal(trace.preview, "a\nb\n…\ne\nf");
});

test("RUN buildCompletedToolTrace shortens over-long preview lines", () => {
  const long = "x".repeat(200);
  const trace = buildCompletedToolTrace(toolEnd(), long);
  assert.equal(trace.preview!.length, 158);
  assert.ok(trace.preview!.includes("…"));
});

test("RUN buildCompletedToolTrace counts records only for search results from a paper source", () => {
  const payload = JSON.stringify({ records: [{}, {}, {}], sourceId: "pubmed", toolId: "search" });
  assert.equal(buildCompletedToolTrace(toolEnd(), payload).paperCount, 3);
  assert.equal(buildCompletedToolTrace(toolEnd(), JSON.stringify({ records: [{}], sourceId: "pubmed", toolId: "fetch" })).paperCount, undefined);
  assert.equal(buildCompletedToolTrace(toolEnd(), JSON.stringify({ records: [{}], sourceId: "other", toolId: "search" })).paperCount, undefined);
  assert.equal(buildCompletedToolTrace(toolEnd(), JSON.stringify({ records: "nope", sourceId: "arxiv", toolId: "search" })).paperCount, undefined);
  assert.equal(buildCompletedToolTrace(toolEnd(), "{not json").paperCount, undefined);
});

test("RUN appendToolProgress keeps short text verbatim and bounds long text", () => {
  assert.equal(appendToolProgress("abc", "def"), "abcdef");
  const bounded = appendToolProgress("a".repeat(10_000), "b".repeat(10_000));
  assert.ok(bounded.length < 20_000);
  assert.ok(bounded.startsWith("a".repeat(8_192)));
  assert.ok(bounded.endsWith("b".repeat(8_189)));
  assert.ok(bounded.includes("\n…\n"));
});

test("RUN buildSubagentToolStep falls back to a status sentence when the tool produced no text", () => {
  const failed = buildSubagentToolStep(toolEnd({ isError: true }));
  assert.equal(failed.content, "Tool failed");
  assert.equal(failed.status, "failed");
  assert.equal(buildSubagentToolStep(toolEnd()).content, "Tool completed");
});

test("RUN buildSubagentToolStep carries the running step's progress, input and args", () => {
  const running = {
    args: { query: "protein" },
    content: "Searching",
    createdAt: "2026-01-01T00:00:00.000Z",
    input: "Searching for protein",
    progress: "half way",
  } as unknown as SubagentStep;
  const step = buildSubagentToolStep(toolEnd({ result: { content: [{ text: "done" }], details: { hits: 4 } } }), running);
  assert.equal(step.content, "done");
  assert.equal(step.progress, "half way");
  assert.equal(step.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(step.input, "Searching for protein");
  assert.deepEqual(step.args, { query: "protein" });
  assert.deepEqual(step.details, { hits: 4 });
  assert.equal(step.toolCallId, "call-1");
});

test("RUN buildSubagentToolStep falls back to the running step content as input", () => {
  const running = { content: "Thinking" } as unknown as SubagentStep;
  const step = buildSubagentToolStep(toolEnd(), running);
  assert.equal(step.input, "Thinking");
  assert.equal("progress" in step, false);
  assert.equal("args" in step, false);
});

test("RUN emptyMatch and emptyTrace describe why a memory graph answer is unavailable", () => {
  assert.deepEqual(emptyMatch("memory_graph_disabled"), { hits: [], reason: "memory_graph_disabled", total: 0, truncated: false });
  assert.deepEqual(emptyTrace("memory_graph_unreachable"), {
    broken: true, chain: [], reason: "memory_graph_unreachable", startNode: null, truncated: false,
  });
});

test("RUN firstUserAuthoredMessage skips runtime notices and keeps the earliest user goal", () => {
  const notice = { content: "wake", kind: "runtime_notice", role: "user" } as unknown as ChatMessage;
  const goal = { content: "find papers", role: "user" } as unknown as ChatMessage;
  const reply = { content: "ok", role: "assistant" } as unknown as ChatMessage;
  assert.equal(firstUserAuthoredMessage([notice, goal], reply), goal);
  assert.equal(firstUserAuthoredMessage([], notice), undefined);
  assert.equal(firstUserAuthoredMessage([reply], goal)?.content, "find papers");
});

test("RUN splitArtifactVersionSuffix separates a collapsed #vN suffix", () => {
  assert.deepEqual(splitArtifactVersionSuffix("abc#v3"), { id: "abc", version: 3 });
  assert.deepEqual(splitArtifactVersionSuffix("abc#V12"), { id: "abc", version: 12 });
  assert.deepEqual(splitArtifactVersionSuffix("abc"), { id: "abc", version: undefined });
  assert.deepEqual(splitArtifactVersionSuffix("#v5"), { id: "", version: 5 });
});

test("RUN skillAuthoringCommandPrompt expands the two authoring commands", () => {
  const bare = skillAuthoringCommandPrompt("  /skill-creator  ");
  assert.ok(bare?.includes("No workflow description was supplied"));
  const withRequest = skillAuthoringCommandPrompt("/skill-creator summarise reviews");
  assert.ok(withRequest?.includes("Workflow description from the user:\nsummarise reviews"));
  const distill = skillAuthoringCommandPrompt("/distill-session");
  assert.ok(distill?.includes("turn this Session into a reusable Skill"));
  assert.ok(!distill!.includes("Additional direction"));
  const directed = skillAuthoringCommandPrompt("/distill-session keep the eval loop");
  assert.ok(directed?.includes("Additional direction from the user:\nkeep the eval loop"));
  assert.equal(skillAuthoringCommandPrompt("please create a skill"), undefined);
  assert.equal(skillAuthoringCommandPrompt("/skill-creator-x"), undefined);
});

test("RUN isTerminalRunStatus separates finished runs from live ones", () => {
  for (const status of ["cancelled", "completed", "failed", "interrupted"] as const) assert.equal(isTerminalRunStatus(status), true);
  for (const status of ["queued", "running", "blocked"] as const) assert.equal(isTerminalRunStatus(status), false);
});

test("RUN stream ids namespace tool and subagent output", () => {
  assert.equal(toolOutputStreamId("call-9"), "tool-call-9");
  assert.equal(subagentStreamId("sub-9"), "subagent-sub-9");
});

test("RUN stopSessionSubagent only stops a subagent that belongs to the session", () => {
  const stopped: Array<{ agentId: string; sessionId: string }> = [];
  const store = {
    listSubagents: () => [{ id: "known" }],
    notifications: { stopAgent: (input: { agentId: string; sessionId: string }) => stopped.push(input) },
  } as unknown as SessionStore;
  assert.equal(stopSessionSubagent(store, "s1", "unknown"), false);
  assert.deepEqual(stopped, []);
  assert.equal(stopSessionSubagent(store, "s1", "known"), true);
  assert.deepEqual(stopped, [{ agentId: "subagent:known", sessionId: "s1" }]);
});

function sinkEvents() {
  const published: Array<Record<string, unknown>> = [];
  const sink = createDeltaCoalescingSink((event) => {
    published.push(event as unknown as Record<string, unknown>);
  }, 60_000);
  return { published, sink };
}

test("RUN delta sink merges consecutive deltas of one response into a single event", async () => {
  const { published, sink } = sinkEvents();
  await sink.emit({ delta: "he", responseId: "r1", type: "assistant.delta" } as never);
  await sink.emit({ delta: "llo", responseId: "r1", type: "assistant.delta" } as never);
  assert.deepEqual(published, [], "nothing is published before the window closes");
  await sink.flush();
  assert.deepEqual(published, [{ delta: "hello", responseId: "r1", type: "assistant.delta" }]);
  await sink.flush();
  assert.equal(published.length, 1, "a second flush has nothing left to publish");
});

test("RUN delta sink flushes on a response change, a kind change and a non-delta event", async () => {
  const { published, sink } = sinkEvents();
  await sink.emit({ delta: "a", responseId: "r1", type: "assistant.delta" } as never);
  await sink.emit({ delta: "b", responseId: "r2", type: "assistant.delta" } as never);
  assert.equal(published.length, 1);
  await sink.emit({ delta: "c", responseId: "r2", turn: 2, type: "assistant.thinking.delta" } as never);
  assert.equal(published.length, 2);
  await sink.emit({ type: "run.status", status: "running" } as never);
  assert.equal(published.length, 4);
  assert.deepEqual(published.at(-1), { status: "running", type: "run.status" });
});

test("RUN delta sink records the turn of thinking deltas and the end of their evidence window", async () => {
  const { published, sink } = sinkEvents();
  await sink.emit({
    delta: "plan", evidence: { agentRunId: "a1", contextRef: { digest: "d1" }, recordedAt: "t0" }, responseId: "r1", turn: 4,
    type: "assistant.thinking.delta",
  } as never);
  await sink.emit({
    delta: " more", evidence: { agentRunId: "a1", contextRef: { digest: "d1" }, recordedAt: "t1" }, responseId: "r1", turn: 4,
    type: "assistant.thinking.delta",
  } as never);
  await sink.flush();
  assert.deepEqual(published, [{
    delta: "plan more",
    evidence: { agentRunId: "a1", contextRef: { digest: "d1" }, endedAt: "t1", recordedAt: "t0" },
    responseId: "r1",
    turn: 4,
    type: "assistant.thinking.delta",
  }]);
});

test("RUN delta sink publishes early once the buffered text reaches the character cap", async () => {
  const published: Array<Record<string, unknown>> = [];
  const sink = createDeltaCoalescingSink((event) => {
    published.push(event as unknown as Record<string, unknown>);
  }, 60_000, 4);
  await sink.emit({ delta: "ab", responseId: "r1", type: "assistant.delta" } as never);
  assert.equal(published.length, 0);
  await sink.emit({ delta: "cde", responseId: "r1", type: "assistant.delta" } as never);
  assert.deepEqual(published, [{ delta: "abcde", responseId: "r1", type: "assistant.delta" }]);
});
