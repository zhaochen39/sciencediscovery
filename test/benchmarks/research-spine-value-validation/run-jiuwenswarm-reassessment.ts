/** Compare two ScienceDiscovery revisions under the same real JiuwenSwarm adapter. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { VersionStore, type AgentStateRef } from "../../../packages/cas/src/index.ts";
import type { AgentShellExecution, ModelProfile, Project, Session, SessionRun, SessionUsageSummary, Subagent } from "../../../packages/schema/src/index.ts";
import { loadServerConfig } from "../../../services/api/src/bootstrap/config.ts";
import { loadRunnerConfig, startRunnerServer } from "../../../services/runner/src/server.ts";
import { ideaResearchModel } from "../../helpers/idea-research-model.ts";
import { citationCommands, citationPrompt, citationResume } from "./citation-workload.ts";
import { calibrationPrompt, inputsFor, readCalibrationArtifacts, validateCalibration } from "./calibration-workload.ts";

const [output, dataDir, fixture, modelMode, arm, original] = process.argv.slice(2);
assert.ok(output && dataDir && fixture && ["controlled", "real"].includes(modelMode ?? "") && ["original", "candidate"].includes(arm ?? ""));
assert.equal(process.env.SCIENCE_AGENT_EXECUTOR, "jiuwenswarm");
assert.ok(process.env.SCIENCE_AGENT_ADAPTER_URL);
assert.ok(arm !== "original" || original);
const adapterResponse = await fetch(`${process.env.SCIENCE_AGENT_ADAPTER_URL}/agent/info`);
assert.ok(adapterResponse.ok);
const adapter = await adapterResponse.json() as { executor?: string; jiuwenswarm?: { reachable?: boolean } };
assert.equal(adapter.executor, "jiuwenswarm");
assert.equal(adapter.jiuwenswarm?.reachable, true);
await mkdir(output, { recursive: true });
const env = { ...process.env, SCIENCE_AGENT_DATA_DIR: resolve(dataDir), SCIENCE_AGENT_HOST: "127.0.0.1",
  SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0", SCIENTIFIC_ENVS: "0",
  SCIENCE_AGENT_MEMORY_GRAPH_AUTO_INSTALL: "0", SCIENCE_AGENT_SCIENTIFIC_ENVS_ENABLED: "0", SCIENCE_AGENT_EVOLVE_URL: "", SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: "" };
const recoveryMode = process.env.SCIENCE_SPINE_SWARM_RECOVERY_MODE ?? "by-state";
assert.ok(recoveryMode === "by-state" || recoveryMode === "full");
if (arm === "candidate") process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = recoveryMode;
const { createApiServer, closeApiServer } = arm === "original"
  ? await import(pathToFileURL(resolve(original!, "services/api/src/http/index.ts")).href) as typeof import("../../../services/api/src/http/index.ts")
  : await import("../../../services/api/src/http/index.ts");
const runnerConfig = loadRunnerConfig(env);
const runner = await startRunnerServer(runnerConfig);
const port = (server: Server) => (server.address() as AddressInfo).port;
const graphProbe = process.env.SCIENCE_SPINE_SCOPE_GRAPH_PROBE === "1";
const graphUrl = process.env.SCIENCE_SPINE_SCOPE_GRAPH_URL ?? "";
if (graphProbe) assert.ok(graphUrl.startsWith("http://127.0.0.1:"));
const ideaProbe = process.env.SCIENCE_SPINE_IDEA_PROBE === "1";
const evolveProbe = process.env.SCIENCE_SPINE_EVOLVE_PROBE === "1";
const researchSidecarProbe = ideaProbe || evolveProbe;
const ideaToken = "scope-fixture-local";
let ideaSidecar: ReturnType<typeof spawn> | undefined;
if (researchSidecarProbe) {
  assert.ok(process.env.SCIENCE_SPINE_EVOLVE_PYTHON);
  ideaSidecar = spawn(process.env.SCIENCE_SPINE_EVOLVE_PYTHON, ["-m", "uvicorn", "sciencediscovery_evolve.server:app", "--host", "127.0.0.1", "--port", "0"], {
    env: { ...process.env, SCIENCE_AGENT_DATA_DIR: join(dataDir, "idea-engine"), SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: ideaToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sidecar = ideaSidecar;
  let startup = "";
  const ready = new Promise<string>((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.once("exit", code => reject(new Error(`Idea Tree sidecar exited (${code}): ${startup}`)));
    sidecar.stderr!.on("data", chunk => {
      startup += String(chunk);
      const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/u.exec(startup)?.[1];
      if (url) resolve(url);
    });
  });
  try {
    env.SCIENCE_AGENT_EVOLVE_URL = await Promise.race([ready, delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Idea Tree sidecar startup timed out"); })]);
    env.SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN = ideaToken;
  } catch (error) {
    sidecar.kill();
    await close(runner);
    throw error;
  }
}
const config = { ...loadServerConfig(env), host: "127.0.0.1", port: 0, runnerToken: runnerConfig.authToken,
  runnerUrl: `http://127.0.0.1:${port(runner)}`, memoryGraph: { url: graphProbe ? graphUrl : "", internalToken: "" }, disableBootstrapProject: true };
const timeoutMs = Number(process.env.SCIENCE_SPINE_SWARM_RUN_TIMEOUT_MS ?? 480_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const observed: { stage: string; tool: string | null; historySeen: boolean; projectionSeen?: boolean; oldEvidenceSeen?: boolean; messageBytes: number }[] = [];
const notes: Record<string, unknown> = { arm, fixture, modelMode, adapter, timeoutMs, observed };
let stage = "";
let turn = 0;
let api: Server | undefined;
let origin = "";
const controlled = modelMode === "controlled";
const spineEnabled = arm === "candidate" && process.env.SCIENCE_SPINE_SWARM_ADAPTED === "1";
notes.spineEnabled = spineEnabled;
if (spineEnabled) notes.recoveryMode = recoveryMode;
const isolationProbe = process.env.SCIENCE_SPINE_SWARM_ISOLATION_PROBE === "1";
const faultProbe = process.env.SCIENCE_SPINE_SWARM_FAULT_PROBE === "1";
if (faultProbe) {
  assert.ok(controlled && process.env.JIUWENSWARM_INSTANCE?.startsWith("sd-spine-fault-"));
  assert.equal(resolve(process.env.JIUWENSWARM_HOME!), resolve(process.env.CI_RUNTIME_DIR!, "with-jiuwenswarm", "home"));
}
const treeProbe = process.env.SCIENCE_SPINE_SCOPE_TREE_PROBE === "1";
const foldProbe = treeProbe && process.env.SCIENCE_SPINE_SCOPE_FOLD_PROBE === "1";
const foldEnabled = foldProbe && spineEnabled && process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPE_FOLD_CLOSED === "1";
const foldMarker = "ARCHIVED_ASSAY_OBSERVATION_019";
assert.ok(!foldProbe || treeProbe);
if (foldProbe) notes.foldEnabled = foldEnabled;
const observeProbe = process.env.SCIENCE_SPINE_SCOPE_OBSERVE_PROBE === "1";
const scopeProjectionWithObservation = process.env.SCIENCE_SPINE_SCOPE_COMBINED_PROBE === "1"
  && process.env.SCIENCE_SPINE_SCOPE_PROBE === "1";
const scopeDefaultProbe = observeProbe && process.env.SCIENCE_SPINE_SCOPE_DEFAULT_PROBE === "1";
const rollbackProbe = scopeDefaultProbe && process.env.SCIENCE_SPINE_SCOPE_ROLLBACK_PROBE === "1";
if ((scopeDefaultProbe || scopeProjectionWithObservation || isolationProbe) && spineEnabled) {
  process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPE_DEFAULT = "observe";
  process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPES = "1";
}
const nativeReceiptProbe = process.env.SCIENCE_SPINE_NATIVE_RECEIPT_PROBE === "1";
const calibrationProbe = process.env.SCIENCE_SPINE_CALIBRATION_PROBE === "1";
const traceRecovery = process.env.SCIENCE_SPINE_SCOPE_TRACE_RECOVERY === "1";
if ((treeProbe || observeProbe || nativeReceiptProbe || traceRecovery || researchSidecarProbe || calibrationProbe) && spineEnabled) process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPES = "1";
if (treeProbe && spineEnabled) process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPE_MANUAL = "1";
const scopeProbe = process.env.SCIENCE_SPINE_SCOPE_PROBE === "1";
const frozenFollowup = scopeProbe && !controlled && process.env.SCIENCE_SPINE_SWARM_FROZEN_FOLLOWUP === "1";
if (frozenFollowup) notes.frozenFollowup = true;
if (scopeProbe && spineEnabled) process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPE_PROJECTION = "1";
const scanNames = Array.from({ length: 5 }, (_, i) => `round-${i + 1}.tsv`);
const scanMarker = "ROUND_ONE_ARCHIVE_ROW";
const assayCommand = `python3 - <<'PY'
import csv,json
from pathlib import Path
with open('assay.tsv') as source:
    total = 2 * sum(int(row['count']) for row in csv.DictReader(source, delimiter='\t'))
Path('assay_result.json').write_text(json.dumps({'doubled_total': total})+'\\n')
print('ASSAY_BATCH_FROZEN', total)
PY`;
const expectedScopeAnswer = "FROZEN/155";
const receiptProbe = process.env.SCIENCE_SPINE_RECEIPT_PROBE === "1";
const sourceCommands = [String.raw`python3 - <<'PY'
import json
from pathlib import Path
records = json.loads(Path('doi_metadata.json').read_text(encoding='utf-8'))
lines = ['doi\ttitle\tyear', *(f"{r['doi'].lower()}\t{r['title']}\t{r['year']}" for r in records)]
Path('citation_sources.tsv').write_text('\n'.join(lines) + '\n', encoding='utf-8')
PY`, "cat citation_sources.tsv"];
const evaluatorSource = `import json, os, traceback
shards = os.environ["SCIENCE_AGENT_SHARDS"].split(",")
try:
    import candidate
    scores = [float(candidate.solve(int(shard))) for shard in shards]
    result = {"valid": True, "metrics": {"score": sum(scores) / len(scores)}, "error": ""}
except Exception:
    result = {"valid": False, "metrics": {"score": 0}, "error": traceback.format_exc()}
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as output:
    json.dump(result, output)
`;
const evolveArgs = {
  mode: "custom_script", algorithm: "puct", statement: "Improve the deterministic solve score",
  howScored: "Mean solve value on held-out cases", startingPointText: "def solve(case):\n    return 0.4\n", evaluatorSource,
  split: { gateShards: 8, rolloutShards: 4, testShards: 2, seed: 0, shardRows: 1 }, expansions: 4, workers: 1,
};
let evolveCandidateRequests = 0;
let faultWaitingForModel = false;
let releaseFaultModel: (() => void) | undefined;
const isolationFixtures = [
  { key: "amber", data: "2\t4\n3\t7\n", answer: 29 },
  { key: "cedar", data: "5\t6\n2\t9\n", answer: 48 },
  { key: "indigo", data: "7\t3\n4\t8\n", answer: 53 },
];
const isolationRequests = new Map<string, number>();
const faultCommit = "printf 'committed\\n' >> fault-ledger.txt";
const provider = (controlled || frozenFollowup) && !ideaProbe ? createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const historySeen = JSON.stringify(body.messages).includes("Perform the first stage of a literature citation audit");
    const id = `jiuwen-fixture-${observed.length + 1}`;
    const openAiTool = (name: string, args: Record<string, unknown>, index = 0) => ({ index, id: `${id}-${index}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    const command = (stage === "source" ? sourceCommands : stage === "continuation" ? citationCommands
      : stage === "scope-source" ? scanNames.map(name => `cat ${name}`) : [])[turn++];
    let toolCalls = command ? [openAiTool("run_shell", { command, cwd: "." })] : [];
    let content = ["question", "inline", "scope-rollback", "scope-short"].includes(stage) ? "14" : "Citation stage completed.";
    if (isolationProbe) {
      const wire = JSON.stringify(body.messages);
      const matches = isolationFixtures.filter(item => wire.includes(`ISOLATION_${item.key}`));
      assert.equal(matches.length, 1, "Model input must contain exactly one fixture marker");
      const item = matches[0]!;
      const requests = (isolationRequests.get(item.key) ?? 0) + 1;
      isolationRequests.set(item.key, requests);
      if (requests === 1) {
        toolCalls = [openAiTool("run_shell", { command: "awk '{s+=$1*$2} END {print s}' weights.tsv > result.txt && cat result.txt", cwd: "." })];
        // Hold each parallel request until its peer arrives. This proves overlap
        // at the provider and leaves serial execution to the run timeout.
        if (item.key !== "amber") {
          const peer = item.key === "cedar" ? "indigo" : "cedar";
          for (let i = 0; i < 200 && !isolationRequests.has(peer); i++) await delay(50);
          assert.ok(isolationRequests.has(peer), "Parallel turns did not overlap at the provider");
        }
      } else {
        assert.equal(requests, 2);
        assert.ok(body.messages.some((message: { role: string; content?: unknown }) => message.role === "tool" && JSON.stringify(message.content).includes(String(item.answer))));
      }
      content = `RESULT=${item.answer}`;
    }
    if (stage === "scope-source") content = "All five snapshots inspected.";
    if (stage === "fault-during-shell" || stage === "fault-after-commit") {
      if (turn === 1) toolCalls = [openAiTool("run_shell", {
        command: stage === "fault-during-shell" ? `sleep 20; ${faultCommit}` : faultCommit, cwd: ".",
      })];
      else if (stage === "fault-after-commit") {
        faultWaitingForModel = true;
        await new Promise<void>(done => { releaseFaultModel = done; });
      }
      content = "COMMITTED";
    }
    if (stage.startsWith("fault-") && stage.endsWith("-retry")) {
      const prompt = String(body.messages.findLast((message: { role: string }) => message.role === "user")?.content);
      if (prompt.includes("RETRY_WRITE_REQUIRED") && turn === 1) toolCalls = [openAiTool("run_shell", { command: faultCommit, cwd: "." })];
      content = "COMMITTED";
    }
    if (stage === "scope-followup") {
      const wire = JSON.stringify(body.messages);
      assert.ok(wire.includes("FROZEN") && wire.includes("Give the exact code prefix"), "Both user constraints must reach the model");
      content = expectedScopeAnswer;
    }
    if (stage === "inline") {
      assert.ok(!body.tools?.some((item: { function?: { name?: string } }) => /^(?:task|task_tool|subagent_)/u.test(item.function?.name ?? "")));
    }
    if (stage === "scope-native-receipt") {
      const names = new Set(body.tools?.map((item: { function?: { name?: string } }) => item.function?.name));
      const wire = JSON.stringify(body.messages);
      content = "ASSAY/36";
      if (names.has("subagent_spawn") && wire.includes("You must use JiuwenSwarm")) {
        const outputs = body.messages.filter((item: { role: string; content?: string }) => item.role === "tool" && typeof item.content === "string");
        const match = /["']subagent_id["']\s*:\s*["']([^"']+)["']/u.exec(outputs.map((item: { content: string }) => item.content).join("\n"));
        if (!match) toolCalls = [openAiTool("subagent_spawn", { subagent_type: "general-purpose", display_name: "Assay verification", role: "Assay verifier", task_description: "Calculate the sum of 3, 4, and 11, then double it. Return 36 only. Do not use tools." })];
        else if (!wire.includes("timed_out")) toolCalls = [openAiTool("subagent_wait", { subagent_ids: [match[1]], timeout_ms: 60_000 })];
      } else {
        content = "36";
      }
    }
    if (stage === "scope-observe") {
      assert.ok(!body.tools?.some((tool: { function: { name: string } }) => tool.function.name === "research_scope"));
      assert.ok(!JSON.stringify(body.messages).includes("Research Scope state"));
      if (turn === 1) toolCalls = [openAiTool("run_shell", { command: graphProbe ? assayCommand : "cat assay.tsv", cwd: "." })];
      else {
        assert.ok(JSON.stringify(body.messages).includes("ASSAY_BATCH_FROZEN"));
        if (graphProbe && turn === 2) toolCalls = [openAiTool("declare_artifact", { path: "assay_result.json" })];
      }
      content = "ASSAY/36";
    }
    if (stage === "scope-fold") {
      content = "ASSAY/110";
      const messages = body.messages as { role: string; content?: string }[];
      const tools = messages.filter(item => item.role === "tool" && typeof item.content === "string");
      const latestScope = tools.findLast(item => item.content?.includes('"activeId"'));
      const active = /"activeId"\s*:\s*"([a-f0-9]+|root)"/u.exec(latestScope?.content ?? "")?.[1] ?? "root";
      if (spineEnabled && turn === 1) toolCalls = [openAiTool("research_scope", { kind: "open", expectedActiveId: active, title: "Archive the assay observations" })];
      if (turn === (spineEnabled ? 2 : 1)) toolCalls = [openAiTool("run_shell", { command: "cat assay-archive.tsv", cwd: "." })];
      if (turn === (spineEnabled ? 3 : 2)) toolCalls = [openAiTool("declare_artifact", { path: "assay-archive.tsv" })];
      if (spineEnabled && turn === 4) {
        const version = /"version_id"\s*:\s*"([^"\s]+)"/u.exec(tools.at(-1)?.content ?? "")?.[1];
        assert.ok(version, "the closed Scope must refer to a version returned by the real API");
        toolCalls = [openAiTool("research_scope", { kind: "close", expectedActiveId: active,
          memory: { outcome: "completed", findings: ["55 observations"], obligations: ["Double the observation count"], artifactVersionIds: [version] } })];
      }
      const visible = JSON.stringify(messages);
      if (spineEnabled && turn === 5) notes.foldPayload = { folded: visible.includes('closedScope'), retainedStdout: visible.includes(foldMarker) };
      if (turn >= (spineEnabled ? 5 : 3) && turn <= (spineEnabled ? 6 : 4)) {
        toolCalls = [openAiTool("run_shell", { command: turn === (spineEnabled ? 5 : 3) ? "printf '%s\\n' count-verified" : "printf '%s\\n' ready-for-delivery", cwd: "." })];
      }
    }
    if (stage === "scope-tree") {
      content = "ASSAY/36";
      const wire = JSON.stringify(body.messages);
      if (spineEnabled) {
        const prior = body.messages.filter((message: { role: string; content?: string }) => message.role === "tool"
          && typeof message.content === "string" && message.content.includes('"activeId"'));
        const active = prior.length ? /"activeId"\s*:\s*"([a-f0-9]+|root)"/u.exec(prior.at(-1).content)?.[1] : "root";
        if (prior.length) assert.ok(wire.includes("Research Scope state"));
        const memory = { findings: [prior.length === 1 ? "Sum is 18" : "Doubled sum is 36"], obligations: [], artifactVersionIds: [], outcome: "completed" };
        if (prior.length === 0) toolCalls = [openAiTool("research_scope", { kind: "open", expectedActiveId: active, title: "Compute sample sum" })];
        if (prior.length === 1) toolCalls = [openAiTool("research_scope", { kind: "next", expectedActiveId: active, title: "Verify doubled total", memory })];
        if (prior.length === 2) toolCalls = [openAiTool("research_scope", { kind: "close", expectedActiveId: active, memory })];
      }
    }
    if (stage === "scope-evolve") {
      if (!body.tools?.length) {
        const score = (0.5 + ++evolveCandidateRequests / 100).toFixed(2);
        content = "```python\ndef solve(case):\n    return " + score + "\n```";
      } else if (turn === 1) toolCalls = [openAiTool("create_evolve_run", evolveArgs)];
      else content = "Background search submitted.";
    }
    if (stage === "receipt") {
      const prompt = String(body.messages.findLast((message: { role: string }) => message.role === "user")?.content ?? "");
      const child = /Check value for receipt group ([AB]) only/iu.exec(prompt)?.[1];
      if (child) {
        content = child.toUpperCase() === "A" ? '{"value":14}' : '{"value":"invalid"}';
      } else if (!body.messages.some((message: { role: string; tool_call_id?: string }) => message.role === "tool" && message.tool_call_id?.startsWith("jiuwen-fixture-"))) {
        const schema = { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "number" } } };
        toolCalls = ["A", "B"].map((group, index) => openAiTool("task", {
          description: `Verify group ${group}`, prompt: `Check value for receipt group ${group} only`, subagent_type: "general-purpose",
          brief: { version: 1, goal: `Verify group ${group}`, constraints: ["Only check one group"], collaborationRules: ["Work independently"], outputRequirements: ["Return JSON"], outputJsonSchema: schema },
        }, index));
      } else {
        content = "Group A returned 14 and Group B failed validation.";
      }
    }
    for (const tool of toolCalls) assert.ok(body.tools?.some((item: { function?: { name?: string } }) => item.function?.name === tool.function.name));
    const wire = JSON.stringify(body.messages);
    observed.push({ stage, tool: toolCalls[0]?.function.name ?? null, historySeen, messageBytes: Buffer.byteLength(wire),
      ...(stage === "scope-followup" ? { projectionSeen: wire.includes("<scope_node_memory "), oldEvidenceSeen: wire.includes(scanMarker) } : {}) });
    const delta = toolCalls.length ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content };
    const finish = toolCalls.length ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 250, completion_tokens: 50, total_tokens: 300 };
    response.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    if (!body.stream) return response.end(JSON.stringify({ id, object: "chat.completion", model: body.model, created: 1, choices: [{ index: 0, message: delta, finish_reason: finish }], usage }));
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }, { choices: [], usage }]) {
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, created: 1, ...chunk })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
}) : undefined;

async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(server === api ? config.port : 0, "127.0.0.1", done); });
}
function close(server: Server) {
  return new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
}
async function openApi() {
  api = createApiServer(config);
  await listen(api);
  origin = `http://127.0.0.1:${port(api)}`;
}
async function call<T>(path: string, data?: unknown, expected = data === undefined ? 200 : 201, method = data === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json", connection: "close" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(60_000) });
  const body = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${body}`);
  return JSON.parse(body) as T;
}
function digest(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }
const measurements: Record<string, unknown> = {};
notes.measurements = measurements;
async function measure(session: Session, name: string, content: string, options?: Record<string, unknown>) {
  stage = name;
  turn = 0;
  const start = performance.now();
  const root = `/api/sessions/${session.id}`;
  let run: SessionRun;
  const combinedEntry = scopeProjectionWithObservation && ["scope-source", "scope-followup", "scope-short"].includes(name);
  if (combinedEntry || (scopeDefaultProbe && ["scope-observe", "scope-rollback"].includes(name))) {
    const response = await fetch(`${origin}${root}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ content }), signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const started = events.find(event => event.type === "run.started");
    assert.ok(started?.runId && events.some(event => event.type === "run.completed"));
    run = await call<SessionRun>(`${root}/runs/${started.runId}`);
    assert.equal(run.researchScopes, spineEnabled && name !== "scope-rollback" ? "observe" : undefined);
    notes.normalMessageEntry = true;
  } else {
    run = await call<SessionRun>(`${root}/runs`, { content, ...options });
  }
  let current = run;
  while (["queued", "running"].includes(current.status) && performance.now() - start < timeoutMs) {
    await delay(200);
    current = await call<SessionRun>(`${root}/runs/${run.id}`);
  }
  const elapsedMs = Math.round(performance.now() - start);
  const usage = await call<SessionUsageSummary>(`${root}/usage`);
  const { executions } = await call<{ executions: AgentShellExecution[] }>(`${root}/agent-activity`);
  const invocations = usage.invocations.filter(item => item.runId === run.id);
  const byRun = usage.byRun.find(bucket => bucket.key === run.id);
  measurements[name] = { run: { id: run.id, status: current.status, error: current.error, assistantMessageId: current.assistantMessageId }, elapsedMs,
    usage: { byRun, invocations }, executions: executions.filter(execution => execution.turnId === run.id).map(({ id, state, turnId }) => ({ id, state, turnId })) };
  console.log(JSON.stringify({ stage: name, status: current.status, elapsedMs, tokens: byRun?.totalTokens }));
  assert.equal(current.status, "completed", current.error ?? "Expected natural completion");
  assert.ok(current.assistantMessageId);
  assert.ok(invocations.length > 0 && byRun?.reportedInvocationCount, "A completed Swarm run must include provider usage");
  return current;
}

let ideaModel: Awaited<ReturnType<typeof ideaResearchModel>> | undefined;
try {
  if (researchSidecarProbe) {
    const reservation = createServer();
    await listen(reservation);
    config.port = port(reservation);
    await close(reservation);
  }
  if (provider) await listen(provider);
  if (ideaProbe && controlled) {
    ideaModel = await ideaResearchModel();
    ideaModel.resume();
  }
  await openApi();
  const modelName = ideaModel?.model ?? (provider ? "swarm-spine-controlled" : process.env.E2E_LLM_MODEL);
  assert.ok(modelName);
  notes.model = modelName;
  const model = await call<ModelProfile>("/api/models", { name: "JiuwenSwarm Spine comparison", model: modelName,
    baseUrl: ideaModel?.baseUrl ?? (provider ? `http://127.0.0.1:${port(provider)}/v1` : process.env.E2E_LLM_BASE_URL),
    apiToken: ideaModel?.apiToken ?? (provider ? "fixture-only" : process.env.E2E_LLM_TOKEN), apiVariant: controlled ? "openai" : process.env.E2E_LLM_API_VARIANT ?? "openai" });
  await call("/api/settings", { modelId: model.id, enabledConnectorIds: [], semanticReviewEnabled: false }, 200, "PUT");
  const project = await call<Project>("/api/projects", { name: "JiuwenSwarm Spine comparison", settingsOverrides: { enabledSkillIds: [], skillSelectionMode: "selected" } });
  const newSession = (title: string) => call<Session>(`/api/projects/${project.id}/sessions`, { title, approvalMode: "always_allow" });
  if (isolationProbe) {
    async function verifyIsolation(item: typeof isolationFixtures[number]) {
      const session = await newSession(`Independent data task ${item.key}`);
      const root = `/api/sessions/${session.id}`;
      const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "weights.tsv"), item.data);
      const current = await measure(session, `isolation-${item.key}`,
        `ISOLATION_${item.key}: Use the shell to compute the sum of products of the two tab-separated columns in weights.tsv. Write the integer to result.txt. Finish your reply with a line of the form RESULT=<integer>. Do not edit weights.tsv.`);
      const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
      const answer = messages.find((message: { id: string }) => message.id === current.assistantMessageId)?.content as string | undefined;
      assert.equal(answer?.trim().split(/\r?\n/u).at(-1), `RESULT=${item.answer}`);
      assert.equal((await readFile(join(workspace, "result.txt"), "utf8")).trim(), String(item.answer));
      assert.equal(await readFile(join(workspace, "weights.tsv"), "utf8"), item.data);
      const { executions } = await call<{ executions: AgentShellExecution[] }>(`${root}/agent-activity`);
      assert.ok(executions.length && executions.every(execution => execution.turnId === current.id && execution.state === "completed"));
      assert.equal(current.researchScopes, spineEnabled ? "observe" : undefined);
      if (spineEnabled) {
        const scope = await call<{ executions: { tool: string; reference: string }[] }>(`${root}/research-scopes?runId=${current.id}`);
        assert.deepEqual(scope.executions.filter(item => item.tool === "run_shell").map(item => item.reference).sort(), executions.map(item => item.id).sort());
      }
      return { sessionId: session.id, runId: current.id, key: item.key, answer: item.answer, shells: executions.length };
    }
    const [single, ...parallel] = isolationFixtures;
    const sequential = await verifyIsolation(single!);
    const start = performance.now();
    const outcomes = await Promise.allSettled(parallel.map(verifyIsolation));
    notes.isolation = { sequential, parallel: outcomes, parallelElapsedMs: Math.round(performance.now() - start),
      providerRequests: Object.fromEntries(isolationRequests) };
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    notes.pass = true;
  } else if (faultProbe) {
    const proofs = [];
    notes.faults = proofs;
    const controlSwarm = promisify(execFile);
    const shellTerminal = (execution: AgentShellExecution) => ["completed", "failed", "cancelled", "timed_out"].includes(execution.state);
    async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const value = await read();
        if (accept(value)) return value;
        await delay(200);
      }
      throw new Error(`Timed out waiting for ${label}`);
    }
    for (const fault of ["fault-during-shell", "fault-after-commit"]) {
      stage = fault;
      turn = 0;
      faultWaitingForModel = false;
      const session = await newSession(fault);
      const root = `/api/sessions/${session.id}`;
      const file = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace", "fault-ledger.txt");
      const ledger = () => readFile(file, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
      const run = await call<SessionRun>(`${root}/runs`, { content: "Commit one line to the fixture ledger, then report completion." });
      const executions = async () => (await call<{ executions: AgentShellExecution[] }>(`${root}/agent-activity`)).executions.filter(item => item.turnId === run.id);
      const proof: Record<string, unknown> = { fault, runId: run.id, sessionId: session.id };
      proofs.push(proof);
      await until(executions, rows => rows.length === 1 && (fault === "fault-during-shell"
        ? rows[0]?.state === "running" : rows[0]?.state === "completed" && faultWaitingForModel), fault);
      const start = Date.now();
      try {
        await controlSwarm("bash", ["scripts/jiuwenswarm.sh", "stop"], { timeout: 30_000 });
      } finally {
        releaseFaultModel?.();
        releaseFaultModel = undefined;
      }
      const terminal = await until(() => call<SessionRun>(`${root}/runs/${run.id}`), value => !["queued", "running"].includes(value.status), "interrupted Run terminal status");
      proof.interruptedRunStatus = terminal.status;
      proof.interruptedRunError = terminal.error;
      proof.interruptedRunMs = Date.now() - start;
      assert.ok(["failed", "cancelled"].includes(terminal.status), "Interrupted Run must not claim success");
      const settled = await until(executions, rows => rows.length === 1 && rows.every(shellTerminal), "outstanding Shell terminal status");
      const before = await ledger();
      assert.ok(["", "committed\n"].includes(before));
      if (fault === "fault-after-commit") assert.equal(before, "committed\n");
      proof.interruptedShellStatus = settled[0]?.state;
      proof.completedWriteBeforeRetry = Boolean(before);
      try {
        const restarted = await controlSwarm("bash", ["scripts/jiuwenswarm.sh", "start"], { timeout: 220_000 });
        proof.restart = restarted.stderr.trim();
      } catch (error) {
        proof.restart = (error as { stderr?: string }).stderr?.trim();
        throw error;
      }
      await until(async () => {
        const response = await fetch(`${process.env.SCIENCE_AGENT_ADAPTER_URL}/agent/info`);
        return (await response.json() as { jiuwenswarm?: { reachable?: boolean } }).jiuwenswarm?.reachable;
      }, reachable => reachable === true, "adapter reconnect");
      const retry = await measure(session, `${fault}-retry`, before
        ? "The ledger was verified committed. Confirm COMMITTED without tools."
        : "RETRY_WRITE_REQUIRED. Commit one line and reply COMMITTED.");
      assert.equal(await ledger(), "committed\n");
      const rows = await call<{ executions: AgentShellExecution[] }>(`${root}/agent-activity`);
      assert.equal(rows.executions.filter(item => item.turnId === retry.id).length, before ? 0 : 1);
      const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
      assert.equal(messages.find((message: { id: string }) => message.id === retry.assistantMessageId)?.content?.trim(), "COMMITTED");
      proof.retryRunId = retry.id;
      proof.retryShells = before ? 0 : 1;
    }
    notes.pass = true;
  } else if (ideaProbe) {
    await call("/api/settings/idea-tree", { explorationIntensity: "quick", maxDepth: 2, maxNodes: 3 }, 200, "PUT");
    assert.equal((await call<{ state: string }>("/api/evolve/status")).state, "ready");
    const session = await newSession("Idea Tree scope handoff");
    const root = `/api/sessions/${session.id}`;
    const prompt = "Start one Idea Tree research using create_idea_research. Compare low-cost, recyclable Fe/Mn catalysts for near-neutral water, avoiding cobalt. Assess possible metal leaching and recovery uncertainties. Skip external retrieval. Use only these supplied materials and end this chat turn after handing off.";
    const started = performance.now();
    const run = await measure(session, "scope-idea", prompt, spineEnabled ? { researchScopes: "observe" } : undefined);
    const listPath = `${root}/idea-tree/research`;
    type View = import("../../../packages/schema/src/idea-tree.ts").IdeaResearchView;
    let view: View | undefined;
    while (performance.now() - started < timeoutMs) {
      const items = (await call<{ items: View[] }>(listPath)).items;
      assert.equal(items.length, 1);
      view = items[0]!;
      if (!["running", "pausing"].includes(view.research.status)) break;
      await delay(250);
    }
    assert.equal(view?.research.status, "completed", view?.research.reason ?? undefined);
    const candidates = view.graph.nodes.filter(node => node.kind === "candidate");
    assert.ok(candidates.length > 0);
    assert.ok(candidates.some(candidate => Number.isFinite(candidate.score)));
    if (controlled) assert.equal(candidates[0]!.score, 7);
    const proof = { sessionId: session.id, runId: run.id, researchId: view.research.id, researchElapsedMs: Math.round(performance.now() - started),
      candidates: candidates.map(({ id, score, status }) => ({ id, score, status })), researchTokens: view.research.tokens,
      researchRequests: ideaModel?.requests.length, researchStatus: view.research.status, linked: false, restartStable: false, foreignRejected: false };
    if (spineEnabled) {
      const path = `${root}/research-scopes?runId=${run.id}`;
      const tree = await call<{ executions: Array<{ tool: string; toolCallId: string; reference: string }> }>(path);
      const execution = tree.executions.find(item => item.tool === "create_idea_research");
      assert.equal(execution?.reference, view.research.id);
      const resultPath = `${path}&executionId=${encodeURIComponent(execution.toolCallId)}`;
      const summary = await call<{ id: string; status: string; candidates: Array<{ id: string; score: number; status: string }> }>(resultPath);
      assert.equal(summary.id, view.research.id);
      assert.equal(summary.status, "completed");
      assert.deepEqual(summary.candidates.map(({ id, score, status }) => ({ id, score, status })), proof.candidates);
      proof.linked = true;
      const foreign = await newSession("Other session");
      await call(resultPath.replace(root, `/api/sessions/${foreign.id}`), undefined, 404);
      proof.foreignRejected = true;
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      assert.deepEqual(await call(resultPath), summary);
      proof.restartStable = true;
    }
    notes.idea = proof;
    notes.pass = true;
  } else if (evolveProbe) {
    assert.equal((await call<{ state: string }>("/api/evolve/status")).state, "ready");
    const session = await newSession("Evolve scope handoff");
    const root = `/api/sessions/${session.id}`;
    const started = performance.now();
    const prompt = `Use create_evolve_run once with the following exact JSON arguments, then report the submission and end the turn. Do not poll the search.\n${JSON.stringify(evolveArgs)}`;
    const run = await measure(session, "scope-evolve", prompt, spineEnabled ? { researchScopes: "observe" } : undefined);
    type Search = import("../../../packages/schema/src/evolution.ts").EvolveRunSummary;
    let search: Search | undefined;
    while (performance.now() - started < timeoutMs) {
      const items = await call<Search[]>(`/api/evolve/runs?sessionId=${session.id}`);
      assert.equal(items.length, 1);
      search = items[0]!;
      if (["succeeded", "failed", "stopped", "cancelled", "interrupted"].includes(search.status)) break;
      await delay(250);
    }
    assert.equal(search?.status, "succeeded", JSON.stringify(search));
    const events = await call<Array<{ event: Record<string, unknown> }>>(`/api/evolve/runs/${search!.id}/events`);
    const scores = events.flatMap(({ event }) => event.type === "expanded" && event.valid === true && typeof event.score === "number" ? [event.score] : []);
    assert.ok(scores.length);
    const best = Math.max(...scores);
    if (controlled) {
      assert.equal(best, 0.54);
      assert.equal(evolveCandidateRequests, 4);
    }
    const proof = { sessionId: session.id, runId: run.id, searchId: search!.id, status: search!.status, best,
      searchTokens: search!.tokens, searchRequests: controlled ? evolveCandidateRequests : null, searchElapsedMs: Math.round(performance.now() - started),
      linked: false, restartStable: false, foreignRejected: false };
    if (spineEnabled) {
      const path = `${root}/research-scopes?runId=${run.id}`;
      const tree = await call<{ executions: Array<{ tool: string; toolCallId: string; reference: string }> }>(path);
      const execution = tree.executions.find(item => item.tool === "create_evolve_run");
      assert.equal(execution?.reference, search!.id);
      const resultPath = `${path}&executionId=${encodeURIComponent(execution.toolCallId)}`;
      const summary = await call<Search & { evaluations: Array<{ gateScore: number | null }> }>(resultPath);
      assert.equal(summary.status, "succeeded");
      assert.equal(summary.bestScore, best);
      assert.equal(summary.baselineScore, 0.4);
      assert.equal(summary.evaluations.length, events.filter(({ event }) => ["seeded", "expanded"].includes(String(event.type))).length);
      proof.linked = true;
      const foreign = await newSession("Other session");
      await call(resultPath.replace(root, `/api/sessions/${foreign.id}`), undefined, 404);
      proof.foreignRejected = true;
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      assert.deepEqual(await call(resultPath), summary);
      proof.restartStable = true;
    }
    notes.evolve = proof;
    notes.pass = true;
  } else if (nativeReceiptProbe) {
    const session = await newSession("Native Swarm delegation receipt");
    const root = `/api/sessions/${session.id}`;
    const prompt = "You must use JiuwenSwarm's subagent_spawn (subagent_type general-purpose, display_name Assay verification, role Assay verifier) to delegate one calculation. In the child instruction pass: Add 3, 4, and 11, then double the total. Reply with exactly the digits of the result. The child must compute directly without delegating. The following collection and formatting instructions apply only to the parent. Collect the child answer with subagent_wait and reply ASSAY/<number> only. Do not use platform task.";
    const run = await measure(session, "scope-native-receipt", prompt, spineEnabled ? { researchScopes: "observe" } : undefined);
    const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    const actual = messages.find((message: { id: string }) => message.id === run.assistantMessageId)?.content?.trim();
    assert.equal(actual, "ASSAY/36");
    assert.equal((await call<Subagent[]>(`${root}/subagents`)).length, 0);
    const trajectory = await call<{ entries: Array<{ kind: string; label: string; runId?: string }> }>(`${root}/trajectory`);
    assert.ok(trajectory.entries.some(entry => entry.kind === "tool" && entry.label === "subagent_spawn"));
    assert.ok(trajectory.entries.some(entry => entry.kind === "tool" && entry.label === "subagent_wait"));
    notes.tree = { actual, expected: "ASSAY/36", runId: run.id, sessionId: session.id };
    if (spineEnabled) {
      const path = `${root}/runs/${run.id}/spawn-receipt`;
      const result = await call<{ ref: { digest: string }; branches: Array<{ childId: string; status: string; executor?: string; resultRef?: { digest: string } }> }>(path, undefined, 200, "POST");
      assert.equal(result.branches.length, 1);
      assert.equal(result.branches[0]?.status, "completed");
      assert.equal(result.branches[0]?.executor, "jiuwenswarm");
      assert.ok(result.branches[0]?.resultRef?.digest);
      const stored = await new VersionStore(config.dataDir).readRecord<{ childId: string; result: unknown }>(result.branches[0].resultRef as AgentStateRef, "ResearchDelegationResult");
      assert.equal(stored.value.childId, result.branches[0].childId);
      assert.equal(String(stored.value.result).trim(), "36");
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      assert.deepEqual(await call(path, undefined, 200, "POST"), result);
      notes.tree = { ...notes.tree as object, restartStable: true, receipt: result };
    }
    notes.pass = true;
  } else if (observeProbe) {
    const session = await newSession("Read-only Scope trace of an assay check");
    const root = `/api/sessions/${session.id}`;
    const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
    await mkdir(workspace, { recursive: true });
    const frozen = "batch\tcount\nASSAY_BATCH_FROZEN\t3\nSECOND\t4\nTHIRD\t11\n";
    await writeFile(join(workspace, "assay.tsv"), frozen);
    const prompt = graphProbe ? `Run this exact analysis in the workspace with run_shell, then declare assay_result.json with declare_artifact. Use no other tools. Reply with ASSAY/<doubled sum> only.\n${assayCommand}`
      : "Read the workspace file assay.tsv using exactly one run_shell call with command cat assay.tsv. Sum the count field of the three assay batches and double the result. Reply with only ASSAY/<doubled sum> without Markdown.";
    const result = await measure(session, "scope-observe", prompt, spineEnabled ? { researchScopes: "observe" } : undefined);
    const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    const actual = messages.find((message: { id: string }) => message.id === result.assistantMessageId)?.content?.trim();
    const expected = `ASSAY/${2 * frozen.trimEnd().split("\n").slice(1).reduce((sum, row) => sum + Number(row.split("\t")[1]), 0)}`;
    assert.equal(actual, expected);
    assert.equal(await readFile(join(workspace, "assay.tsv"), "utf8"), frozen);
    const { executions } = await call<{ executions: AgentShellExecution[] }>(`${root}/agent-activity`);
    const reads = executions.filter(item => item.turnId === result.id);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.state, "completed");
    const logs = await call<{ chunks: { stream: string; text: string }[] }>(`${root}/agent-activity/executions/${encodeURIComponent(reads[0]!.id)}/logs`);
    assert.equal(logs.chunks.filter(item => item.stream === "stdout").map(item => item.text).join(""), graphProbe ? "ASSAY_BATCH_FROZEN 36\n" : frozen);
    if (graphProbe) assert.deepEqual(JSON.parse(await readFile(join(workspace, "assay_result.json"), "utf8")), { doubled_total: Number(expected.split("/")[1]) });
    notes.tree = { expected, actual, runId: result.id, sessionId: session.id, frozenSha256: digest(Buffer.from(frozen)) };
    if (spineEnabled) {
      const path = `${root}/research-scopes?runId=${encodeURIComponent(result.id)}`;
      const tree = await call<{ nodes: Array<{ id: string; status: string }>; executions: Array<{ nodeId: string; tool: string; status: string; reference: string }>; artifactLinks: Array<{ nodeId: string; versionId: string }> }>(path);
      assert.equal(tree.nodes.length, graphProbe ? 3 : 2);
      assert.equal(tree.executions.length, graphProbe ? 2 : 1);
      const shell = tree.executions.find(item => item.tool === "run_shell");
      assert.equal(shell?.status, "completed");
      assert.equal(shell?.reference, reads[0]!.id);
      assert.ok(tree.nodes.some(node => node.id === shell?.nodeId));
      if (graphProbe) {
        const declare = tree.executions.find(item => item.tool === "declare_artifact");
        assert.ok(declare && declare.status === "completed");
        assert.deepEqual(tree.artifactLinks, [{ nodeId: declare.nodeId, versionId: declare.reference }]);
        const reverse = `${root}/artifact-versions/${encodeURIComponent(declare.reference)}/provenance?includeScopes=1`;
        const provenance = await call<{ researchScopes: unknown[]; version: { artifactId: string; version: number } }>(reverse);
        assert.deepEqual(provenance.researchScopes, [{ nodeId: declare.nodeId, runId: result.id }]);
        const graphPath = `/api/memory/subgraph?session_id=${encodeURIComponent(session.id)}&scope_run_id=${encodeURIComponent(result.id)}`;
        const artifactNode = `${provenance.version.artifactId}#v${provenance.version.version}`;
        type Graph = { nodes: Array<{ id: string; label: string }>; edges: Array<{ source: string; target: string }> };
        let graph = await call<Graph>(graphPath);
        for (let attempt = 0; attempt < 20 && !graph.nodes.some(node => node.id === artifactNode); attempt++) {
          await delay(250);
          graph = await call<Graph>(graphPath);
        }
        assert.ok(graph.nodes.some(node => node.id === artifactNode && node.label === "Artifact"));
        assert.ok(graph.edges.some(edge => edge.source === `research-scope:${result.id}:${declare.nodeId}` && edge.target === artifactNode));
        notes.scopeGraph = { versionId: declare.reference, artifactNode, edgeValidated: true, reverseChecked: true };
      }
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      assert.deepEqual(await call(path), tree);
      if (graphProbe && process.env.SCIENCE_SPINE_SCOPE_BROWSER_PROBE === "1") {
        const { chromium, expect } = createRequire(resolve(".e2e/package.json"))("@playwright/test");
        const browser = await chromium.launch();
        const checked: string[] = [];
        try {
          for (const client of ["web", "desktop"]) {
            await closeApiServer(api!);
            api = undefined;
            config.staticDir = resolve(`apps/${client}/dist`);
            await openApi();
            const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
            await page.addInitScript(token => {
              localStorage.setItem("sciencediscovery-token", token);
              localStorage.setItem("sciencediscovery-desktop:guide", "1");
            }, config.authToken);
            if (client === "web") {
              await page.goto(`${origin}/projects/${project.id}/sessions/${session.id}/trajectory`);
            } else {
              await page.goto(origin);
              await page.locator(".side-session", { hasText: session.title }).first().click();
            }
            const scope = page.locator(".research-scope-explorer");
            await scope.locator("summary").first().click();
            const artifact = scope.locator(".research-scope-nodes details > summary").filter({ hasText: /^declare_artifact/u });
            await artifact.click({ timeout: 30_000 });
            const evidenceButton = scope.getByRole("button", { name: /View evidence version|查看证据版本/u });
            await evidenceButton.click();
            await expect(scope.locator("pre")).toContainText(tree.artifactLinks[0]!.versionId, { timeout: 15_000 });
            await page.screenshot({ path: join(output, `scope-${client}.png`) });
            checked.push(client);
            await page.close();
          }
        } finally {
          await browser.close();
        }
        notes.scopeBrowser = checked;
      }
      notes.tree = { ...notes.tree as object, observedToolCount: tree.executions.length, restartStable: true };
      if (rollbackProbe) {
        delete process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPE_DEFAULT;
        delete process.env.SCIENCE_AGENT_JIUWENSWARM_SCOPES;
        await closeApiServer(api!);
        api = undefined;
        await openApi();
        const rolledBack = await measure(session, "scope-rollback", "Give the arithmetic mean of 10, 14 and 18. Reply with only the integer.");
        const after = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
        assert.equal(after.find((message: { id: string }) => message.id === rolledBack.assistantMessageId)?.content?.trim(), "14");
        assert.deepEqual(await call(path), tree);
        notes.rollback = { completed: true, oldScopeRetained: true };
      }
    }
    notes.pass = true;
  } else if (calibrationProbe) {
    assert.ok(!controlled);
    const points = 24;
    const input = inputsFor(points);
    const session = await newSession("Frozen instrument calibration");
    const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "instrument.csv"), input);
    const source = await measure(session, "calibration-source", calibrationPrompt.slice(0, calibrationPrompt.indexOf("\n2. "))
      + " After writing both files, run a separate read-only command cat cleaned.csv and display every row. Do not truncate or summarize it. End this Run immediately after the display.",
    spineEnabled ? { researchScopes: "observe" } : undefined);
    const quality = await readCalibrationArtifacts(workspace, true);
    assert.deepEqual(validateCalibration(quality, points)[0], []);
    const table = quality.get("cleaned.csv")!;
    const apiRoot = `/api/sessions/${session.id}`;
    const { executions } = await call<{ executions: AgentShellExecution[] }>(`${apiRoot}/agent-activity`);
    const displays = await Promise.all(executions.filter(item => item.turnId === source.id && item.state === "completed").map(async item => {
      const logs = await call<{ chunks: { stream: string; text: string }[] }>(`${apiRoot}/agent-activity/executions/${encodeURIComponent(item.id)}/logs`);
      return logs.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join("") === table.toString("utf8");
    }));
    assert.equal(displays.filter(Boolean).length, 1, "expected one full calibration table display");
    if (spineEnabled) process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = session.id;
    const rest = calibrationPrompt.slice(calibrationPrompt.indexOf("\n2. "))
      .replace("Verify the artifact set and stop naturally once the tool reports BENCHMARK_VALIDATION_PASSED.", "Verify the artifact set and stop naturally with a short completion message.");
    const continued = await measure(session, "calibration-continuation", "Continue the instrument calibration. The full accepted cleaned.csv was already displayed. Do not display, regenerate or rewrite the quality inputs. Complete stages 2 through 4 using only run_shell and standard-library Python. " + rest,
      spineEnabled ? { researchResume: { sourceRunId: source.id, workflow: "calibration" }, researchScopes: "observe" } : undefined);
    const final = await readCalibrationArtifacts(workspace, true);
    assert.deepEqual(validateCalibration(final, points).flat(), []);
    for (const name of ["instrument.csv", "cleaned.csv", "qc.json"]) assert.deepEqual(final.get(name), quality.get(name));
    if (spineEnabled) assert.equal(continued.researchResume?.sourceRunId, source.id);
    notes.calibration = { points, verifiedOutputs: [...final.keys()].sort(), inputSha256: digest(Buffer.from(input)), formalRecovery: Boolean(continued.researchResume) };
    notes.pass = true;
  } else if (foldProbe) {
    const session = await newSession("Closed Scope with exact archived observations");
    const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
    await mkdir(workspace, { recursive: true });
    const archive = Buffer.from(Array.from({ length: 55 }, (_, index) => {
      const row = `ARCHIVED_ASSAY_OBSERVATION_${String(index + 1).padStart(3, "0")}`;
      return `${row}\t${digest(Buffer.from(row))}\n`;
    }).join(""));
    await writeFile(join(workspace, "assay-archive.tsv"), archive);
    const prompt = "Audit the archived assay observations. Make each tool call separately in this order. If research_scope is available, the first action must be research_scope open one child of root with title Archive the assay observations. Then use run_shell with exactly cat assay-archive.tsv (no other command in that call) to display the complete file. Declare the exact file with declare_artifact and record its returned version_id. If using a child Scope, close it with findings containing the observation count, obligations containing a reminder to double the count, and artifactVersionIds containing the exact version ID. After closing, make two separate run_shell calls, first printf '%s\\n' count-verified and then printf '%s\\n' ready-for-delivery. Include a single result code, ASSAY/ followed by the doubled observation count, in your final answer. A brief explanation is optional. Do not browse or use other tools.";
    const result = await measure(session, "scope-fold", prompt, spineEnabled ? { researchScopes: true, delegationMode: "inline" } : undefined);
    const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    const answer = messages.find((message: { id: string }) => message.id === result.assistantMessageId)?.content as string | undefined;
    const expected = `ASSAY/${archive.toString("utf8").trimEnd().split("\n").length * 2}`;
    const codes = [...new Set(answer?.match(/\bASSAY\/\d+\b/gu) ?? [])];
    assert.deepEqual(codes, [expected], "the delivered answer must contain one unambiguous result code");
    const actual = codes[0]!;
    assert.equal(digest(await readFile(join(workspace, "assay-archive.tsv"))), digest(archive));
    const activity = `/api/sessions/${session.id}/agent-activity`;
    const { executions } = await call<{ executions: AgentShellExecution[] }>(activity);
    const own = executions.filter(execution => execution.turnId === result.id);
    assert.equal(own.length, 3);
    const outputs = await Promise.all(own.map(async execution => {
      assert.equal(execution.state, "completed");
      const logs = await call<{ chunks: { stream: string; text: string }[] }>(`${activity}/executions/${encodeURIComponent(execution.id)}/logs`);
      return logs.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join("");
    }));
    assert.deepEqual(outputs.sort(), [archive.toString("utf8"), "count-verified\n", "ready-for-delivery\n"].sort());
    if (spineEnabled) {
      const tree = await call<{ nodes: { status: string; memory?: { findings: string[]; artifactVersionIds: string[] } }[]; artifactLinks: { versionId: string }[] }>(`/api/sessions/${session.id}/research-scopes?runId=${result.id}`);
      assert.ok(tree.nodes.some(node => node.status === "completed" && node.memory?.findings.some(finding => /\b55\b/u.test(finding))
        && node.memory.artifactVersionIds.some(id => tree.artifactLinks.some(link => link.versionId === id))));
      if (controlled) assert.deepEqual(notes.foldPayload, { folded: foldEnabled, retainedStdout: !foldEnabled });
    }
    notes.fold = { expected, actual, archiveSha256: digest(archive), runId: result.id };
    notes.pass = true;
  } else if (treeProbe) {
    const session = await newSession("Scope transitions on fixed assay counts");
    const root = `/api/sessions/${session.id}`;
    const assayCounts = [3, 4, 11];
    const expected = `ASSAY/${assayCounts.reduce((sum, count) => sum + count, 0) * 2}`;
    const result = await measure(session, "scope-tree", `Sum independent assay counts ${assayCounts.join(", ")}, then double the total. If research_scope is available, record the work in two sibling scopes: open the first scope at root, use next to store its sum and start the second, and close the second with its result. Use the active IDs returned by the tool. Then deliver just ${"ASSAY/<doubled sum>"} without Markdown. Without research_scope, perform both calculations and give the same answer.`, spineEnabled ? { researchScopes: true, delegationMode: "inline" } : undefined);
    const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    const actual = messages.find((message: { id: string }) => message.id === result.assistantMessageId)?.content?.trim();
    assert.equal(actual, expected);
    notes.tree = { expected, actual, runId: result.id, sessionId: session.id };
    if (spineEnabled) {
      const path = `${root}/research-scopes?runId=${encodeURIComponent(result.id)}`;
      type Tree = { activeId: string; sequence: number; nodes: Array<{ id: string; parentId: string | null; status: string; memory?: { findings: string[] } }> };
      const scope = await call<Tree>(path);
      assert.equal(scope.activeId, "root");
      assert.equal(scope.sequence, 3);
      const scopes = scope.nodes.filter(item => item.parentId === "root");
      assert.equal(scopes.length, 2);
      assert.ok(scopes.every(item => item.status === "completed"));
      assert.match(scopes[0]!.memory!.findings.join(" "), /\b18\b/u);
      assert.match(scopes[1]!.memory!.findings.join(" "), /\b36\b/u);
      const memoryPath = `${path}&nodeId=${scopes[1]!.id}`;
      const memory = await call<{ memory: { findings: string[] } }>(memoryPath);
      assert.deepEqual(memory.memory, scopes[1]!.memory);
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      assert.deepEqual(await call(path), scope);
      assert.deepEqual(await call(memoryPath), memory);
      await call(`${path}&nodeId=missing`, undefined, 409);
      notes.tree = { ...notes.tree as object, sequence: scope.sequence, childScopes: scopes.length, restartStable: true, unknownNodeRejected: true };
    }
    notes.pass = true;
  } else if (scopeProbe) {
    const session = await newSession("Scope projection on archived measurements");
    const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
    await mkdir(workspace, { recursive: true });
    for (const [index, name] of scanNames.entries()) {
      const label = index === 0 ? scanMarker : `ROUND_${index + 1}_ARCHIVE_ROW`;
      const rows = Array.from({ length: 31 }, (_, i) => `${label}_${i + 1}\t${i + 1}\t${digest(Buffer.from(`${name}/${i}`))}`);
      await writeFile(join(workspace, name), `record\tmeasurement\tcontent_hash\n${rows.join("\n")}\n`);
    }
    const source = await measure(session, "scope-source", `These five frozen assay snapshot TSVs are in the workspace. Read ${scanNames.join(", ")} in order, using one separate run_shell cat call per file, with no other tools. Give a short confirmation after the five reads, without reproducing the rows. The required code prefix for a future answer is FROZEN. The snapshots contain 31 data rows each.`);
    const { executions } = await call<{ executions: AgentShellExecution[] }>(`/api/sessions/${session.id}/agent-activity`);
    const reads = executions.filter(item => item.turnId === source.id && item.state === "completed");
    assert.equal(reads.length, scanNames.length);
    const logsRead = await Promise.all(reads.map(async execution => {
      const logs = await call<{ chunks: { stream: string; text: string }[] }>(`/api/sessions/${session.id}/agent-activity/executions/${encodeURIComponent(execution.id)}/logs`);
      return digest(Buffer.from(logs.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join("")));
    }));
    assert.deepEqual(logsRead.sort(), (await Promise.all(scanNames.map(async name => digest(await readFile(join(workspace, name)))))).sort());
    if (frozenFollowup) {
      const realModel = process.env.E2E_LLM_MODEL;
      assert.ok(realModel);
      const real = await call<ModelProfile>("/api/models", { name: "Frozen followup real model", model: realModel,
        baseUrl: process.env.E2E_LLM_BASE_URL, apiToken: process.env.E2E_LLM_TOKEN, apiVariant: process.env.E2E_LLM_API_VARIANT ?? "openai" });
      await call("/api/settings", { modelId: real.id, enabledConnectorIds: [], semanticReviewEnabled: false }, 200, "PUT");
      notes.model = realModel;
      notes.sourceModel = modelName;
      notes.sourceArchiveHashes = logsRead;
    }
    const followup = await measure(session, "scope-followup", "Give the exact code prefix established earlier, a slash, and the total number of data rows across the five snapshots. Reply with just the result. Do not reread the files or use tools.");
    const messages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    assert.equal(messages.find((message: { id: string }) => message.id === followup.assistantMessageId)?.content?.trim(), expectedScopeAnswer);
    if (controlled) {
      const payload = observed.find(item => item.stage === "scope-followup");
      assert.ok(payload);
      assert.equal(payload.projectionSeen, spineEnabled, "Projection must reach actual model payload");
      assert.equal(payload.oldEvidenceSeen, !spineEnabled, "Archived tool output must be removed only by projection");
    }
    if (scopeProjectionWithObservation) {
      const path = `/api/sessions/${session.id}/research-scopes?runId=${source.id}`;
      if (spineEnabled) {
        const scope = await call<{ executions: { tool: string; reference: string }[] }>(path);
        assert.deepEqual(scope.executions.filter(item => item.tool === "run_shell").map(item => item.reference).sort(), reads.map(item => item.id).sort());
        assert.deepEqual(await call(path), scope);
      }
      const shortSession = await newSession("Fresh short question with Scope observation configured");
      const short = await measure(shortSession, "scope-short", "Give the arithmetic mean of 10, 14 and 18. Reply with only the integer.");
      const answers = JSON.parse(await readFile(join(config.dataDir, "messages", `${shortSession.id}.json`), "utf8"));
      assert.equal(answers.find((message: { id: string }) => message.id === short.assistantMessageId)?.content?.trim(), "14");
      const measured = measurements["scope-short"] as { usage: { invocations: { turnsRecorded?: number }[] }; executions: unknown[] };
      assert.equal(measured.usage.invocations.reduce((count, row) => count + (row.turnsRecorded ?? 1), 0), 1);
      assert.equal(measured.executions.length, 0);
      notes.combinedEntry = { observation: spineEnabled, shortRunId: short.id };
    }
    notes.scope = { expectedScopeAnswer, filesRead: reads.length, followupRunId: followup.id, sessionId: session.id };
    notes.pass = true;
  } else if (receiptProbe) {
    const session = await newSession("Delegation receipt comparison");
    const prompt = controlled
      ? "Call task twice. Have each child verify a different group. Report failed validations accurately."
      : `Use the platform task tool twice, once per group. Do not calculate either result in the parent or use other tools. Use subagent_type general-purpose. Include brief.version 1, goal, constraints (only its own group), collaborationRules (work independently), outputRequirements (only a JSON object), and outputJsonSchema {"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"number"}}} in each call. Give group A only the calculation 3*4+2, and group B only 5*5-4. Require each to respond with bare JSON {"value": <number>} without Markdown or prose. Wait for both child results and report the two values by group.`;
    const run = await measure(session, "receipt", prompt);
    const root = `/api/sessions/${session.id}`;
    const readChildren = async () => {
      const children = (await call<Subagent[]>(`${root}/subagents`)).filter(child => child.parentTurnId === run.id);
      return children.map(({ id, status, error, structuredResult }) => ({ id, status, error, structuredResult }));
    };
    const summaryStarted = performance.now();
    const children = await readChildren();
    notes.childRecordsReadMs = Math.round(performance.now() - summaryStarted);
    notes.children = children;
    assert.deepEqual(children.map(child => child.status).sort(), controlled ? ["completed", "failed"] : ["completed", "completed"]);
    const values = children.filter(child => child.status === "completed").map(child => child.structuredResult);
    assert.deepEqual(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), controlled ? [{ value: 14 }] : [{ value: 14 }, { value: 21 }]);
    if (controlled) assert.match(children.find(child => child.status === "failed")?.error ?? "", /must be number/u);
    const assistantMessages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    const assistant = assistantMessages.find((message: { id: string }) => message.id === run.assistantMessageId);
    const answer = String(assistant?.content ?? "");
    notes.receiptParentAnswer = answer;
    assert.match(answer, /\b14\b/u);
    assert.match(answer, controlled ? /fail/iu : /\b21\b/u);
    const before = await call<SessionUsageSummary>(`${root}/usage`);
    const endpoint = `${root}/runs/${run.id}/spawn-receipt`;
    if (arm === "candidate") {
      const receiptStarted = performance.now();
      const receipt = await call<{ ref: AgentStateRef; branches: { childId: string; status: string; resultRef?: AgentStateRef; error?: string }[] }>(endpoint, {}, 200);
      notes.receiptCreatedMs = Math.round(performance.now() - receiptStarted);
      assert.equal(receipt.branches.length, children.length);
      for (const child of children) {
        const branch = receipt.branches.find(item => item.childId === child.id);
        assert.ok(branch);
        assert.equal(branch.status, child.status);
        if (child.status === "completed") assert.ok(branch.resultRef);
        else assert.equal(branch.error, child.error);
      }
      notes.receipt = receipt;
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      const repeatedStarted = performance.now();
      assert.deepEqual(await call(endpoint, {}, 200), receipt);
      notes.receiptReopenedMs = Math.round(performance.now() - repeatedStarted);
      const versions = new VersionStore(config.dataDir);
      const persisted = await versions.readRecord(receipt.ref, "ResearchSpawnReceipt");
      assert.deepEqual(persisted.value, { sessionId: session.id, parentRunId: run.id, branches: receipt.branches });
      for (const branch of receipt.branches) {
        if (!branch.resultRef) continue;
        const result = await versions.readRecord(branch.resultRef, "ResearchDelegationResult");
        assert.deepEqual(result.value, { childId: branch.childId, result: children.find(child => child.id === branch.childId)?.structuredResult });
      }
      notes.receiptCasVerified = true;
    } else {
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      const reopenedStarted = performance.now();
      const repeated = await readChildren();
      notes.childRecordsReopenedMs = Math.round(performance.now() - reopenedStarted);
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      assert.deepEqual(repeated.sort(byId), children.sort(byId));
    }
    const after = await call<SessionUsageSummary>(`${root}/usage`);
    assert.deepEqual(after.invocations, before.invocations);
    notes.receiptModelInvocationsAdded = 0;
    notes.pass = true;
  } else {
    const short = await newSession("Arithmetic control");
    const shortRun = await measure(short, "question", "Give the arithmetic mean of 10, 14, and 18. Reply with only the integer.");
    const shortMessages = JSON.parse(await readFile(join(config.dataDir, "messages", `${short.id}.json`), "utf8"));
    assert.equal(shortMessages.find((message: { id: string }) => message.id === shortRun.assistantMessageId)?.content?.trim(), "14");

    const session = await newSession("Frozen citation audit");
    const workspace = join(config.dataDir, "projects", project.id, "sessions", session.id, "workspace");
    const workspaceInput = join(fixture, "workspace");
    const paths = ["bibliography.json", "doi_metadata.json", "citation_sources.tsv"];
    await mkdir(workspace, { recursive: true });
    for (const name of paths.slice(0, 2)) await cp(join(workspaceInput, name), join(workspace, name));
    const [bibliography, metadata] = await Promise.all(paths.slice(0, 2).map(name => readFile(join(workspace, name))));
    const rows = JSON.parse(metadata!.toString("utf8")) as { doi: string; title: string; year: number }[];
    const expectedTable = `doi\ttitle\tyear\n${rows.map(row => `${row.doi.toLowerCase()}\t${row.title}\t${row.year}`).join("\n")}\n`;
    const source = await measure(session, "source", citationPrompt, spineEnabled && traceRecovery ? { researchScopes: "observe" } : undefined);
    assert.equal(await readFile(join(workspace, paths[2]!), "utf8"), expectedTable);
    if (arm === "candidate" && !spineEnabled && process.env.SCIENCE_SPINE_SWARM_LEGACY_GATES === "1") {
      process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = session.id;
      const root = `/api/sessions/${session.id}/runs`;
      const before = await call<SessionUsageSummary>(`/api/sessions/${session.id}/usage`);
      const beforeRuns = await call<SessionRun[]>(root);
      const resume = await call(root, { content: citationResume, researchResume: { sourceRunId: source.id, workflow: "citations" } }, 409);
      const inline = await call(root, { content: "Audit inline.", delegationMode: "inline" }, 409);
      const memory = await call(`${root}/${source.id}/node-memory?versionId=unavailable`, undefined, 409);
      const after = await call<SessionUsageSummary>(`/api/sessions/${session.id}/usage`);
      const afterRuns = await call<SessionRun[]>(root);
      assert.deepEqual(after.invocations, before.invocations);
      assert.deepEqual(afterRuns.map(run => run.id), beforeRuns.map(run => run.id));
      notes.gates = { resume, inline, memory, modelInvocationsAdded: 0, runsAdded: 0 };
    }
    const { executions: sourceActivity } = await call<{ executions: AgentShellExecution[] }>(`/api/sessions/${session.id}/agent-activity`);
    const displayEvidence = [];
    for (const execution of sourceActivity.filter(item => item.turnId === source.id && item.state === "completed")) {
      const logs = await call<{ chunks: { stream: string; text: string }[] }>(`/api/sessions/${session.id}/agent-activity/executions/${encodeURIComponent(execution.id)}/logs`);
      if (logs.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join("") === expectedTable) displayEvidence.push(execution.id);
    }
    notes.displayEvidence = displayEvidence;
    assert.equal(displayEvidence.length, 1, "The source Run must display the complete table exactly once");
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = session.id;
    if (spineEnabled) {
      await closeApiServer(api!);
      api = undefined;
      await openApi();
    }
    const continued = await measure(session, "continuation", citationResume, spineEnabled
      ? { researchResume: { sourceRunId: source.id, workflow: "citations" }, ...(traceRecovery ? { researchScopes: "observe" } : {}) } : undefined);
    if (spineEnabled) assert.equal(continued.researchResume?.sourceRunId, source.id);
    const continuedMessages = JSON.parse(await readFile(join(config.dataDir, "messages", `${session.id}.json`), "utf8"));
    assert.ok(continuedMessages.find((message: { id: string }) => message.id === continued.assistantMessageId)?.content);
    const protectedInputs = await Promise.all(paths.map(name => readFile(join(workspace, name))));
    assert.deepEqual(protectedInputs.map(digest), [bibliography!, metadata!, Buffer.from(expectedTable)].map(digest));
    const norm = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
    const lookup = new Map(rows.map(row => [row.doi.toLowerCase(), row]));
    const expectedAudit = (JSON.parse(bibliography!.toString("utf8")) as typeof rows).map(row => {
      const doi = row.doi.toLowerCase();
      const reference = lookup.get(doi);
      const title = reference ? norm(reference.title) === norm(row.title) : null;
      const year = reference ? reference.year === row.year : null;
      return { doi, title_match: title, year_match: year, status: !reference ? "unresolved" : title && year ? "match" : "mismatch" };
    });
    const expectedSummary = { total: expectedAudit.length, ...Object.fromEntries(["match", "mismatch", "unresolved"].map(kind => [kind, expectedAudit.filter(entry => entry.status === kind).length])) };
    const audit = JSON.parse(await readFile(join(workspace, "citation_audit.json"), "utf8"));
    const summary = JSON.parse(await readFile(join(workspace, "citation_summary.json"), "utf8"));
    assert.deepEqual(audit, expectedAudit);
    assert.deepEqual(summary, expectedSummary);
    if (spineEnabled) {
      const root = `/api/sessions/${session.id}`;
      const provenance = await call<{ currentRevision?: { artifactVersionIds: string[] } }>(`${root}/workspace/provenance?path=citation_audit.json`);
      const versionId = provenance.currentRevision?.artifactVersionIds.at(-1);
      assert.ok(versionId, "Recovered output must have a registered artifact version");
      if (traceRecovery) {
        const scopes = await call<{ artifactLinks: Array<{ versionId: string }>; executions: Array<{ tool: string }> }>(`${root}/research-scopes?runId=${continued.id}`);
        assert.ok(scopes.artifactLinks.some(link => link.versionId === versionId));
        assert.ok(scopes.executions.some(item => item.tool === "run_shell"));
        notes.recoveryScopes = scopes.artifactLinks;
      }
      await closeApiServer(api!);
      api = undefined;
      await openApi();
      const path = `${root}/runs/${continued.id}/node-memory?versionId=${encodeURIComponent(versionId)}`;
      const memory = await call<{ content: string; sha256: string; versionId: string }>(path);
      assert.equal(memory.versionId, versionId);
      assert.deepEqual(JSON.parse(memory.content), expectedAudit);
      assert.equal(memory.sha256, digest(await readFile(join(workspace, "citation_audit.json"))));
      await call(`${root}/runs/${source.id}/node-memory?versionId=${encodeURIComponent(versionId)}`, undefined, 409);
      const same = await call<SessionRun>(`${root}/runs`, { content: citationResume, researchResume: { sourceRunId: source.id, workflow: "citations" } });
      assert.equal(same.id, continued.id);
      if (process.env.SCIENCE_SPINE_SWARM_STALE_PROBE === "1") {
        const file = join(workspace, "citation_audit.json");
        const originalBytes = await readFile(file);
        try {
          await writeFile(file, "[]\n");
          await call(path, undefined, 409);
          notes.staleMemoryRejected = true;
        } finally {
          await writeFile(file, originalBytes);
        }
      }
      notes.nodeMemory = { versionId: memory.versionId, sha256: memory.sha256, wrongRunRejected: true };
      const inline = await newSession("Swarm Inline");
      const inlineRun = await measure(inline, "inline", "What is 3 * 4 + 2? Reply with 14 only.", { delegationMode: "inline" });
      assert.equal(inlineRun.delegationMode, "inline");
      const inlineMessages = JSON.parse(await readFile(join(config.dataDir, "messages", `${inline.id}.json`), "utf8"));
      assert.equal(inlineMessages.find((message: { id: string }) => message.id === inlineRun.assistantMessageId)?.content?.trim(), "14");
      assert.equal((await call<Subagent[]>(`/api/sessions/${inline.id}/subagents`)).length, 0);
      notes.inline = { runId: inlineRun.id, childRuns: 0 };
    }
    notes.audit = { shortAnswer: 14, protectedDigests: protectedInputs.map(digest), audit, summary };
    notes.pass = true;
  }
} catch (error) {
  notes.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(notes, null, 2));
  releaseFaultModel?.();
  if (api) await closeApiServer(api);
  if (provider) await close(provider);
  if (ideaModel) await ideaModel.stop();
  ideaSidecar?.kill();
  await close(runner);
}
