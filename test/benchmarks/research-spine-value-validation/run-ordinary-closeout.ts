import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ChatMessage, ModelProfile, Project, Session, SessionRun } from "../../../packages/schema/src/index.ts";
import { loadServerConfig } from "../../../services/api/src/bootstrap/config.ts";
import { SessionStore } from "../../../services/api/src/store.ts";
import { loadRunnerConfig, startRunnerServer } from "../../../services/runner/src/server.ts";

const [output, dataDir, checkout] = process.argv.slice(2);
assert.ok(output && dataDir, "Provide an output file, fresh data directory and optional original checkout");
for (const key of ["SCIENCE_AGENT_RESEARCH_RECOVERY_MODE", "SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS", "SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS"]) {
  delete process.env[key];
}
process.env.SCIENCE_AGENT_EXECUTOR = "native";
process.env.SCIENCE_AGENT_CONTEXT_MODE = "dynamic";
const env = { ...process.env, SCIENCE_AGENT_DATA_DIR: resolve(dataDir), SCIENCE_AGENT_HOST: "127.0.0.1",
  SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0", SCIENTIFIC_ENVS: "0",
  SCIENCE_AGENT_MEMORY_GRAPH_AUTO_INSTALL: "0" };
const { createApiServer, closeApiServer } = checkout
  ? await import(pathToFileURL(resolve(checkout, "services/api/src/http/index.ts")).href) as typeof import("../../../services/api/src/http/index.ts")
  : await import("../../../services/api/src/http/index.ts");
const runnerConfig = loadRunnerConfig(env);
const runner = await startRunnerServer(runnerConfig);
const config = { ...loadServerConfig(env), host: "127.0.0.1", port: 0, runnerToken: runnerConfig.authToken,
  runnerUrl: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`, memoryGraph: { url: "", internalToken: "" }, disableBootstrapProject: true };

const requestLog: { sample: number; withToolResult: boolean; historySeen: boolean; compaction: boolean }[] = [];
const responseText = "The arithmetic mean is 14.";
const provider = createServer(async (request, response) => {
  const parts = [];
  for await (const chunk of request) parts.push(chunk);
  const body = JSON.parse(Buffer.concat(parts).toString()) as { messages: { role: string; content?: string }[] };
  const user = body.messages.findLast(item => item.role === "user")?.content ?? "";
  const compaction = body.messages.some(item => item.role === "system" && item.content?.includes("You compact conversation history"));
  const match = /Closeout sample (\d+)/u.exec(user);
  const toolResult = body.messages.slice(body.messages.findLastIndex(item => item.role === "user") + 1)
    .find(item => item.role === "tool" && item.content?.includes("validated mean 14"));
  const sample = Number(match?.[1]);
  requestLog.push({ sample, compaction, withToolResult: Boolean(toolResult), historySeen: body.messages.some(item => item.content?.includes("EARLIER-OBSERVATION-")) });
  const callId = `closeout-${requestLog.length}`;
  const delta = !compaction && !toolResult && user.includes("via shell")
    ? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "run_shell",
      arguments: JSON.stringify({ command: `printf 'validated mean 14\\n' > result-${sample}.txt; cat result-${sample}.txt`, cwd: "." }) } }] }
    : { role: "assistant", content: compaction ? "EARLIER-OBSERVATION-0 and subsequent measurements and decisions were recorded." : responseText };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: 250, completion_tokens: 50, total_tokens: 300 } }]) {
    response.write(`data: ${JSON.stringify({ id: callId, ...chunk })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
const listen = async (server: Server) => {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
let api: Server | undefined;
let origin: string;
async function openApi() { api = createApiServer(config); origin = await listen(api); }
async function stopApi() { if (api) { await closeApiServer(api); api = undefined; } }
async function call<T>(path: string, data?: unknown, method = data === undefined ? "GET" : "POST", status = data === undefined ? 200 : 201): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${body}`);
  return JSON.parse(body) as T;
}

try {
  const baseUrl = await listen(provider) + "/v1";
  await openApi();
  const model = await call<ModelProfile>("/api/models", { name: "Ordinary regression", model: "closeout-fixture", baseUrl, apiToken: "fixture", apiVariant: "openai" });
  await call("/api/settings", { modelId: model.id, enabledConnectorIds: [], semanticReviewEnabled: false }, "PUT", 200);
  const project = await call<Project>("/api/projects", { name: "Ordinary regression", settingsOverrides: { enabledSkillIds: [], skillSelectionMode: "selected" } });
  const newSession = (title: string) => call<Session>(`/api/projects/${project.id}/sessions`, { title, approvalMode: "always_allow" });
  const simple = await newSession("Fresh session");
  const long = await newSession("Long session");
  await stopApi();
  const store = new SessionStore(config.dataDir);
  await store.load();
  const settings = store.resolveRuntimeSettings(long.id).effective;
  const history = Array.from({ length: 96 }, (_, index) => ({ id: `message-${index}`, sessionId: long.id,
    role: index % 2 ? "assistant" : "user", content: `EARLIER-OBSERVATION-${index} ${"measurement and decision recorded. ".repeat(20)}`,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString() })) as ChatMessage[];
  await store.restoreMessages(long.id, history);
  const historicalRuns = Array.from({ length: 800 }, (_, index) => ({ id: `ordinary-history-${index}`, sessionId: long.id,
    prompt: `Archived ordinary run ${index}`, references: [], queueOrder: index, settingsSnapshot: settings, status: "completed",
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString() }));
  const runDir = join(dataDir, "session-runs");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, `${long.id}.json`), JSON.stringify(historicalRuns));
  store.close();
  await openApi();
  const samples = [];
  const usageChecks = [];
  for (const [kind, session, count] of [["simple", simple, 4], ["long", long, 6]] as const) {
    const runEndpoint = `/api/sessions/${session.id}/runs`;
    const workspace = store.workspacePath(session.id);
    let sessionCalls = 0;
    let taskCalls = 0;
    for (let index = 0; index < count; index++) {
      const sample = samples.length;
      const initialCalls = requestLog.length;
      const writeStart = performance.now();
      await call(`/api/sessions/${session.id}/files`, { path: `observations-${sample}.txt`, content: "10,14,18\n" });
      const writeMs = performance.now() - writeStart;
      assert.equal(await readFile(join(workspace, `observations-${sample}.txt`), "utf8"), "10,14,18\n");
      const started = performance.now();
      const submitted = await call<SessionRun>(runEndpoint, { content: `Closeout sample ${sample}. Give the mean of 10, 14, and 18${kind === "long" ? " via shell" : ""}.` });
      const enqueueMs = performance.now() - started;
      let run = submitted;
      while (["queued", "running"].includes(run.status) && performance.now() - started < 120_000) {
        await delay(100);
        run = await call<SessionRun>(`${runEndpoint}/${submitted.id}`);
      }
      const deliveryMs = performance.now() - started;
      const runMs = Date.parse(run.finishedAt ?? "") - Date.parse(run.startedAt ?? "");
      assert.equal(run.status, "completed", run.error);
      assert.ok(run.assistantMessageId && Number.isFinite(runMs));
      assert.equal(run.researchResume, undefined);
      const ledger = JSON.parse(await readFile(join(dataDir, "messages", `${session.id}.json`), "utf8")) as ChatMessage[];
      assert.equal(ledger.find(message => message.id === run.assistantMessageId)?.content, responseText);
      const observed = requestLog.slice(initialCalls);
      const business = observed.filter(request => !request.compaction);
      assert.equal(business.length, kind === "long" ? 2 : 1);
      assert.ok(business.every(request => request.sample === sample));
      sessionCalls += observed.length;
      taskCalls += business.length;
      if (kind === "long") {
        assert.ok(business[0]!.historySeen && business[1]!.withToolResult);
        assert.equal(await readFile(join(workspace, `result-${sample}.txt`), "utf8"), "validated mean 14\n");
      }
      samples.push({ kind, sample, status: run.status, writeMs, enqueueMs, runMs, deliveryMs, requests: observed.length, compactions: observed.length - business.length, toolCalls: kind === "long" ? 1 : 0 });
    }
    const usage = await call<{ totals: { inputTokens: number; outputTokens: number; totalTokens: number; invocationCount: number } }>(`/api/sessions/${session.id}/usage`);
    assert.equal(usage.totals.invocationCount, count);
    assert.equal(usage.totals.inputTokens, taskCalls * 250);
    assert.equal(usage.totals.outputTokens, taskCalls * 50);
    assert.equal(usage.totals.totalTokens, taskCalls * 300);
    usageChecks.push({ kind, wireCalls: sessionCalls, taskCalls, compactionCalls: sessionCalls - taskCalls, totals: usage.totals });
  }
  await writeFile(output, JSON.stringify({ variant: checkout ? "original" : "disabled", historicalRuns: historicalRuns.length, historicalMessages: history.length, samples, usageChecks }, null, 2));
} finally {
  await stopApi();
  await close(provider);
  await close(runner);
}
