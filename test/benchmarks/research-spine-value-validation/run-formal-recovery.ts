import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, cp, readdir, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { loadServerConfig } from "../../../services/api/src/bootstrap/config.ts";
import { SessionStore } from "../../../services/api/src/store.ts";
import { loadRunnerConfig, startRunnerServer } from "../../../services/runner/src/server.ts";
import type { AgentShellExecution, ModelProfile, Project, Session, SessionRun } from "../../../packages/schema/src/index.ts";
import { citationPrompt, citationResume, citationCommands } from "./citation-workload.ts";
import { calibrationPrompt } from "./calibration-workload.ts";
import { solarPrompt } from "./solar-workload.ts";
import { createHash } from "node:crypto";
import { findDisplayReceipt } from "../../../services/api/src/native-agent/research-recovery.ts";
import { solarCommands } from "./solar-controlled-commands.ts";
import { readNodeMemory } from "./scope-experiments.ts";
import { writeSpawnReceipt } from "../../../services/api/src/subagents/spawn-receipt.ts";
import { CasStore } from "../../../packages/cas/src/index.ts";
import type { Subagent } from "../../../packages/schema/src/index.ts";

const [checkpointArg, outputArg, mode = "by-state", alternate] = process.argv.slice(2);
if (!checkpointArg || !outputArg || !["original", "full", "by-state"].includes(mode)) {
  throw new Error("Usage: run-formal-recovery.ts CHECKPOINT OUTPUT original|full|by-state [original checkout]");
}
const checkpoint = resolve(checkpointArg);
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(join(checkpoint, "checkpoint.json"), "utf8"));
assert.ok(["solar", "calibration-review", "citations"].includes(manifest.workload));
const workflow: string = manifest.workload === "calibration-review" ? "calibration" : manifest.workload;
const table = workflow === "solar" ? "site_qc.csv" : workflow === "calibration" ? "cleaned.csv" : "citation_sources.tsv";
const captureOnly = process.env.SCIENCE_SPINE_FORMAL_CAPTURE_ONLY === "1";
const fullHistory = captureOnly ? [] : JSON.parse(await readFile(join(checkpoint, "final-messages.json"), "utf8"));
const firstUser = fullHistory.findIndex((message: { role: string }) => message.role === "user");
assert.ok(captureOnly || firstUser >= 0 || (workflow === "citations" && fullHistory.length > 0));
const sourcePrompt = (workflow === "solar" ? solarPrompt : workflow === "calibration" ? calibrationPrompt : citationPrompt)
  .replace("Verify all artifacts and stop naturally after BENCHMARK_VALIDATION_PASSED.", "Verify all artifacts and stop with a short final response.")
  .replace("Verify the artifact set and stop naturally once the tool reports BENCHMARK_VALIDATION_PASSED.", "Verify all artifacts and stop with a short final response.");
const remainingRequirements = sourcePrompt.slice(sourcePrompt.indexOf("\n2. ") + 1);
let followUp = `Continue the original analysis from its accepted quality stage. Preserve the quality files. If the complete current ${table} has not been displayed, display it exactly once in a standalone run_shell call before the next calculation. If it was displayed, proceed directly to the next calculation. Execute directly with run_shell and standard-library Python. Delegation and task tools are outside this workflow. Write each remaining stage separately and print only its short verification summary. Finish with one short answer once the files exist and are verified. Preserve accepted QC files. Follow these remaining artifact requirements.\n\n${remainingRequirements}`;
if (workflow === "citations") followUp = citationResume;
const scopeExperiment = process.env.SCIENCE_SPINE_DELEGATION_EVAL;
let scopeExpected: unknown;
if (scopeExperiment) {
  assert.ok(["separate", "inline", "partial"].includes(scopeExperiment) && mode === "original");
  if (workflow === "citations") {
    assert.notEqual(scopeExperiment, "partial");
    type Entry = { doi: string; title: string; year: number };
    const records = await readFile(join(checkpoint, "workspace", "doi_metadata.json"), "utf8");
    const claims = await readFile(join(checkpoint, "workspace", "bibliography.json"), "utf8");
    const input = JSON.parse(claims) as Entry[];
    const sources = new Map((JSON.parse(records) as Entry[]).map(row => [row.doi, row]));
    const normalize = (title: string) => title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
    scopeExpected = {
      a: { mismatched: input.filter(row => sources.has(row.doi) && normalize(sources.get(row.doi)!.title) !== normalize(row.title)).map(row => row.doi) },
      b: { mismatched: input.filter(row => sources.has(row.doi) && sources.get(row.doi)!.year !== row.year).map(row => row.doi),
        unresolved: input.filter(row => !sources.has(row.doi)).map(row => row.doi) },
    };
    const stage = `Audit two independent fields against frozen publication metadata.
Check A identifies DOI values with title mismatches among resolved DOI values, comparing titles after NFKC, trim, whitespace collapse, and lowercase. Its output is an object with only the key mismatched containing an array of DOI strings in bibliography order.
Check B identifies year mismatches among resolved DOI values and all unresolved DOI values. Its output is an object with only mismatched and unresolved, both arrays of DOI strings in bibliography order.
Use these inputs only. Metadata: ${records} Bibliography: ${claims}
Return only valid JSON, with keys a and b containing the two objects. Do not use any files, shell, or network.`;
    const method = scopeExperiment === "separate"
      ? " Use two general-purpose task calls, one for each check. Supply the relevant input records with each call and combine the child outputs."
      : " Compute both checks independently within this run, then combine them. Do not delegate.";
    followUp = stage + method;
  } else {
    assert.equal(workflow, "solar");
    const stage = "Compute two independent check values. Group A has observations 10, 14, 18. Group B has observations 8, 8, 14. Calculate each arithmetic mean and check whether each mean exceeds 12. Use these exact observations. Return a single JSON object with keys a and b, each with mean and exceeds. No Markdown or extra text.";
    followUp = scopeExperiment !== "inline"
      ? `${stage} Use exactly two task tool calls of type general-purpose. Delegate only group A in one and only group B in the other. Child output should use the same mean and exceeds fields. Combine the two child results. Do not run shell commands or modify files.`
      : `${stage} Perform both checks within this Run. Keep their calculations separate and combine their results. Do not use task tools, run shell commands or modify files.`;
    scopeExpected = { a: { mean: 14, exceeds: true }, b: scopeExperiment === "partial" ? { status: "failed" } : { mean: 10, exceeds: false } };
  }
}
const memoryExperiment = process.env.SCIENCE_SPINE_NODE_MEMORY_EVAL;
let memoryExpected: unknown;
let reviewInput: { path: string; bytes: Buffer } | undefined;
let memoryApiMs: number | undefined;
if (memoryExperiment) {
  assert.ok(mode === "original" && ["solar", "citations"].includes(workflow) && !scopeExperiment);
  assert.ok(memoryExperiment === "full" || memoryExperiment === "bounded");
  const inspected = process.env.SCIENCE_SPINE_NODE_MEMORY_RECEIPT;
  assert.ok(inspected);
  const proofText = await readFile(inspected, "utf8");
  const proof = JSON.parse(workflow === "citations" ? proofText : proofText.split("\n").find(line => line.startsWith("{"))!);
  const delivered = JSON.parse(await readFile(join(proof.arm, "result.json"), "utf8"));
  const root = proof.memoryStore ?? (await readFile(join(proof.arm, "data-dir.txt"), "utf8")).trim();
  const receiptStore = new SessionStore(root);
  await receiptStore.load();
  try {
    const memory = await readNodeMemory(receiptStore, proof.ref, delivered.sessionId, delivered.run.id);
    if (workflow === "citations") {
      const summary = memory.find(entry => entry.path === "citation_summary.json");
      assert.ok(summary?.artifactVersions.length, "Citation review requires a linked Artifact Version");
      let bytes = await new CasStore(root, "data").read(summary.sha256);
      const httpProof = process.env.SCIENCE_SPINE_NODE_MEMORY_HTTP_PROOF;
      if (httpProof && memoryExperiment === "bounded") {
        const { proofs } = JSON.parse(await readFile(httpProof, "utf8"));
        const item = proofs.find((value: { path: string }) => value.path === summary.path);
        assert.ok(item?.sha256 === summary.sha256 && item.versionId === summary.artifactVersions.at(-1)?.versionId);
        bytes = Buffer.from(item.content, "utf8");
        memoryApiMs = item.retrievalMs;
      }
      assert.equal(createHash("sha256").update(bytes).digest("hex"), summary.sha256);
      reviewInput = { path: summary.path, bytes };
      const counts = JSON.parse(bytes.toString("utf8")) as { total: number; match: number; mismatch: number; unresolved: number };
      memoryExpected = { requires_review: counts.mismatch + counts.unresolved, verified: counts.match, total: counts.total };
      const request = "From the accepted citation_summary.json, compute requires_review as mismatch plus unresolved, verified as match, and total as total. Return only a JSON object with those keys. Do not modify any files.";
      followUp = memoryExperiment === "full"
        ? `${request} Read citation_summary.json using run_shell.`
        : `${request} The verified artifact contents are attached below. Do not call tools.\n${bytes.toString("utf8")}`;
    } else {
      const cas = new CasStore(root);
      const groupsRef = memory.find(entry => entry.path === "groups.json");
      assert.ok(groupsRef);
      const groupBytes = await cas.read(groupsRef.sha256);
      assert.equal(createHash("sha256").update(groupBytes).digest("hex"), groupsRef.sha256);
      const groups = JSON.parse(groupBytes.toString("utf8")) as Record<string, { mean_index: number }>;
      const [name, group] = Object.entries(groups).sort((left, right) => right[1].mean_index - left[1].mean_index)[0]!;
      memoryExpected = { top_group: name, mean_index: group.mean_index };
      const raw = memoryExperiment === "full" ? await Promise.all(memory.filter(entry => entry.path !== "groups.json")
        .map(async entry => `${entry.path}: ${(await cas.read(entry.sha256)).toString("utf8")}`)) : [];
      const review = `From the verified groups.json choose the group with the highest mean_index. Return only a JSON object with keys top_group and mean_index, without rounding or Markdown. Do not call tools.\ngroups.json: ${groupBytes.toString("utf8")}\n${raw.join("\n")}`;
      followUp = review;
    }
  } finally { receiptStore.close(); }
}
const { createApiServer, closeApiServer } = alternate
  ? await import(pathToFileURL(resolve(alternate, "services/api/src/http/index.ts")).href) as typeof import("../../../services/api/src/http/index.ts")
  : await import("../../../services/api/src/http/index.ts");
const env: NodeJS.ProcessEnv = { ...process.env, SCIENCE_AGENT_DATA_DIR: resolve(process.env.SCIENCE_SPINE_FORMAL_DATA_DIR ?? join(output, "data")),
  SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
  SCIENCE_AGENT_SCIENTIFIC_ENVS_ENABLED: "0", SCIENCE_AGENT_MEMORY_GRAPH_AUTO_INSTALL: "0" };
process.env.SCIENCE_AGENT_EXECUTOR = "native";
process.env.SCIENCE_AGENT_CONTEXT_MODE = "dynamic";
process.env.SCIENCE_AGENT_CONTEXT_TRACE = "1";
const rc = loadRunnerConfig(env);
const runner = await startRunnerServer(rc);
const config = { ...loadServerConfig(env), host: "127.0.0.1", port: 0, runnerToken: rc.authToken,
  runnerUrl: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`, memoryGraph: { url: "", internalToken: "" }, disableBootstrapProject: true };
const controlled = process.env.SCIENCE_SPINE_FORMAL_CONTROLLED;
const fault = process.env.SCIENCE_SPINE_FORMAL_FAULT;
if (fault) assert.ok(controlled === "fixture" && mode === "by-state" && ["cancel-shell", "runner-unavailable", "crash-before-commit", "retry-after-restart"].includes(fault));
const cancelFault = fault === "cancel-shell" || fault === "runner-unavailable";
const shellBarrier = `touch .formal-shell-started
for i in $(seq 1 300); do
  if test -f .formal-shell-release; then touch .formal-shell-finished; exit 0; fi
  if test -f .formal-shell-probe; then touch .formal-shell-alive; fi
  sleep 0.2
done
exit 1`;
let providerBlocked = false;
let blockAfter = 0;
let provider: Server | undefined;
let modelRequests = 0;
let providerUrl: string | undefined;
const genuineSource = controlled === "source-run";
const queuedRollback = controlled === "queued-rollback";
const pendingPilot = controlled === "pilot-pending";
if (queuedRollback) assert.equal(mode, "by-state");
if (pendingPilot) assert.equal(mode, "original");
let rollbackToolNames: string[] | undefined;
const closeoutEvidence: Record<string, unknown> = {};
let runningSource = genuineSource;
let sourceRequests = 0;
if (controlled) {
  assert.ok(workflow === "solar" || workflow === "citations");
  const tableContents = await readFile(join(checkpoint, "workspace", table));
  const sourceDisplayed = findDisplayReceipt(fullHistory, tableContents, createHash("sha256").update(tableContents).digest("hex")) !== undefined;
  const asyncDisplay = controlled === "async-display";
  if (asyncDisplay || pendingPilot) assert.equal(sourceDisplayed, false, "A pending checkpoint is required");
  if (queuedRollback) assert.equal(sourceDisplayed, true, "An admitted checkpoint requires display evidence");
  const commands = workflow === "citations"
    ? [...(sourceDisplayed ? [] : [`cat ${table}`]), ...citationCommands]
    : solarCommands("split").slice(sourceDisplayed || controlled === "skip-display" ? 2 : 1);
  if (cancelFault) commands.unshift(shellBarrier);
  if (fault === "crash-before-commit") blockAfter = sourceDisplayed ? 1 : 2;
  if (controlled === "rewrite") commands.unshift(`touch ${table}`);
  if (controlled === "bad-delivery") commands[commands.length - 1] = `echo '{}' > citation_summary.json`;
  provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (queuedRollback && !rollbackToolNames) {
      rollbackToolNames = body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort();
    }
    let id: string;
    let choices: unknown[];
    if (scopeExperiment === "partial") {
      assert.equal(controlled, "fixture");
      const messages = body.messages as Array<{ role: string; content?: string; tool_call_id?: string }>;
      const isChild = messages.some(row => row.role === "system" && row.content?.includes("Applied subagent preset general-purpose"));
      const childB = messages.some(row => row.role === "user" && row.content?.includes("Group B check only"));
      const parentFinal = !isChild && messages.some(row => row.role === "tool" && row.tool_call_id?.startsWith("scope-child-"));
      id = `scope-partial-${modelRequests++}`;
      if (!isChild && !parentFinal) {
        const schema = { type: "object", additionalProperties: false, required: ["mean", "exceeds"], properties: { mean: { type: "number" }, exceeds: { type: "boolean" } } };
        choices = [{ index: 0, delta: { role: "assistant", tool_calls: ["A", "B"].map((group, index) => ({
          index, id: `scope-child-${group}`, type: "function", function: { name: "task", arguments: JSON.stringify({
            description: `Group ${group} check`, prompt: `Group ${group} check only`, subagent_type: "general-purpose",
            brief: { version: 1, goal: `Group ${group} check`, constraints: ["Use the supplied observations only"], collaborationRules: ["Work independently"], outputRequirements: ["Return JSON"], outputJsonSchema: schema },
          }) },
        })) }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "tool_calls" }];
      } else {
        const content = parentFinal ? '{"a":{"mean":14,"exceeds":true},"b":{"status":"failed"}}'
          : childB ? '{"mean":"invalid","exceeds":false}' : '{"mean":14,"exceeds":true}';
        choices = [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }];
      }
    } else {
      assert.ok(body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "run_shell"));
      const turn = runningSource ? sourceRequests++ : modelRequests++;
      if (blockAfter > 0 && !runningSource && turn === blockAfter) {
        providerBlocked = true;
        return; // Parent kills the API while it is waiting to finish the Run.
      }
      id = `formal-stub-${runningSource ? "source" : "resume"}-${turn}`;
      const command = (runningSource ? solarCommands("split").slice(0, 2) : commands)[asyncDisplay && turn > 0 ? turn - 2 : turn];
      let selectedTool = command ? { name: "run_shell", arguments: JSON.stringify({ command, cwd: "." }) } : undefined;
      if (asyncDisplay && turn === 0) {
        selectedTool = { name: "run_shell", arguments: JSON.stringify({ command, cwd: ".", background: true }) };
      } else if (asyncDisplay && (turn === 1 || turn === 2)) {
        const result = (body.messages as Array<{ role: string; content?: unknown }>).findLast(row => row.role === "tool");
        const executionId = String(result?.content).match(/"executionId":"(shell:[a-f0-9]{64})"/u)?.[1];
        assert.ok(executionId, "No managed execution ID in model-visible result");
        selectedTool = turn === 1
          ? { name: "execution_status", arguments: JSON.stringify({ execution_id: executionId, wait_ms: 30_000 }) }
          : { name: "execution_logs", arguments: JSON.stringify({ execution_id: executionId }) };
      }
      choices = selectedTool ? [
        { index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: selectedTool }] }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "tool_calls" },
      ] : [
        { index: 0, delta: { role: "assistant", content: "Verified results are ready." }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ];
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of choices) response.write(`data: ${JSON.stringify({ id, choices: [choice] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 250, completion_tokens: 50, total_tokens: 300 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done, reject) => { provider!.once("error", reject); provider!.listen(0, "127.0.0.1", done); });
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
}
let api: Server | undefined;
let child: ChildProcess | undefined;
let origin: string;
async function openApi() {
  if (fault || queuedRollback) {
    child = fork(fileURLToPath(new URL("./formal-api-child.ts", import.meta.url)));
    const listen = new Promise<number>((done, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => reject(new Error(`API child exited before listening: ${code ?? signal}`)));
      child!.once("message", (message: { port: number }) => done(message.port));
    });
    child.send(config);
    origin = `http://127.0.0.1:${await listen}`;
    return;
  }
  api = createApiServer(config);
  await new Promise<void>((done, reject) => { api!.once("error", reject); api!.listen(0, "127.0.0.1", done); });
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}
async function stopApi(kill = false) {
  if (child) {
    const exited = once(child, "exit");
    if (child.exitCode === null && child.signalCode === null) {
      if (kill) child.kill("SIGKILL");
      else child.send("close");
      const [code, signal] = await exited;
      if (kill) assert.equal(signal, "SIGKILL");
      else assert.equal(code, 0);
    }
    child = undefined;
  }
  if (api) { await closeApiServer(api); api = undefined; }
}
async function waitFor<T>(probe: () => Promise<T | undefined>, description: string, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await probe();
    if (result !== undefined) return result;
    await delay(200);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}
async function exists(path: string) {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function call<T>(path: string, data?: unknown, method = data === undefined ? "GET" : "POST", status = data === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(60_000) });
  const body = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${body}`);
  return JSON.parse(body) as T;
}
// The chat UI supports fenced JSON. Allow one complete JSON block and still
// reject mixed prose, partial objects, or an incorrect computed answer.
function parseReviewAnswer(content: string | undefined) {
  const text = content?.trim() ?? "null";
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]+?)\r?\n```$/iu.exec(text);
  return JSON.parse(fenced?.[1] ?? text);
}

async function runExperiment() {
try {
  await openApi();
  const model = await call<ModelProfile>("/api/models", { name: "Formal recovery experiment", model: controlled ? "formal-controlled" : process.env.E2E_LLM_MODEL,
    baseUrl: providerUrl ?? process.env.E2E_LLM_BASE_URL, apiToken: controlled ? "fixture-only" : process.env.E2E_LLM_TOKEN, apiVariant: controlled ? "openai" : process.env.E2E_LLM_API_VARIANT ?? "openai" });
  await call("/api/settings", { modelId: model.id, enabledConnectorIds: [], semanticReviewEnabled: false }, "PUT", 200);
  const project = await call<Project>("/api/projects", { name: "Formal recovery experiment", settingsOverrides: { enabledSkillIds: [], skillSelectionMode: "selected" } });
  const session = await call<Session>(`/api/projects/${project.id}/sessions`, { title: "Fixed recovery fixture", approvalMode: "always_allow" });
  await stopApi();
  // Restore identical source transcript and files into each arm through the
  // normal durable store. Model calls under measurement start at HTTP enqueue.
  const store = new SessionStore(config.dataDir);
  await store.load();
  const workspace = store.workspacePath(session.id);
  await mkdir(workspace, { recursive: true });
  let sourceId: string;
  let remoteSessionId: string | undefined;
  if (controlled === "release-gates") {
    assert.equal(workflow, "citations");
    assert.equal(mode, "by-state");
    const remoteHost = await store.registerRemoteHost({ alias: "release-probe", runnerName: "Release probe", connectionKind: "direct",
      endpoint: { host: "127.0.0.1", port: 1, protocol: "http" }, token: "unused-test-token",
      capabilities: { conda: false, containerRuntimes: [], cpuCores: 1, cuda: null, gpu: null, memoryBytes: 1024,
        modules: false, nodeVersion: null, platform: "Linux", probedAt: new Date().toISOString(), runnerCommandAvailable: true,
        scratchPaths: [], slurm: false } });
    await store.updateSession(session.id, { runnerIds: ["local"] });
    const remoteSession = await store.createSession(project.id, "Remote gate", {}, {}, { allowUnconfiguredModel: true });
    await store.updateSession(remoteSession.id, { runnerIds: [remoteHost.id] });
    remoteSessionId = remoteSession.id;
  }
  let auditCheckpoint = checkpoint;
  const runsEndpoint = `/api/sessions/${session.id}/runs`;
  if (genuineSource || captureOnly) {
    const sourceInputs = workflow === "citations" ? ["bibliography.json", "doi_metadata.json"] : ["sites.csv", "measurements.csv"];
    for (const file of sourceInputs) await cp(join(checkpoint, "workspace", file), join(workspace, file));
    store.close();
    await openApi();
    const source = await call<SessionRun>(runsEndpoint, { content: sourcePrompt });
    sourceId = source.id;
    let status = source.status;
    for (let attempt = 0; attempt < (captureOnly ? 900 : 100) && (status === "queued" || status === "running"); attempt++) {
      await delay(400);
      status = (await call<SessionRun>(`${runsEndpoint}/${sourceId}`)).status;
    }
    assert.equal(status, "completed", "Normal API Run must produce the quality checkpoint");
    const callsBeforeDisabledRequest = modelRequests + sourceRequests;
    await call(runsEndpoint, { content: followUp, researchResume: { sourceRunId: sourceId, workflow } }, "POST", 409);
    assert.equal(modelRequests + sourceRequests, callsBeforeDisabledRequest, "Disabled recovery must not call the model");
    await stopApi();
    await store.load();
    try {
      const messages = await store.readMessages(session.id);
      const actualHistory = messages.at(-1)?.modelContext;
      assert.ok(actualHistory?.length, "The API must persist canonical tool history");
      if (workflow === "citations") {
        const bytes = await readFile(join(workspace, table));
        assert.ok(findDisplayReceipt(actualHistory, bytes, createHash("sha256").update(bytes).digest("hex")), "Source must record a verified display");
      }
      auditCheckpoint = join(output, "source-checkpoint");
      await mkdir(auditCheckpoint);
      await cp(workspace, join(auditCheckpoint, "workspace"), { recursive: true });
      await writeFile(join(auditCheckpoint, "checkpoint.json"), JSON.stringify(manifest));
      await writeFile(join(auditCheckpoint, "final-messages.json"), JSON.stringify([{ role: "user", content: sourcePrompt }, ...actualHistory]));
    } finally { store.close(); }
    runningSource = false;
  } else {
    await cp(join(checkpoint, "workspace"), workspace, { recursive: true });
    if (reviewInput) await writeFile(join(workspace, reviewInput.path), reviewInput.bytes);
    const source = await store.createSessionRun({ sessionId: session.id, prompt: sourcePrompt,
      settingsSnapshot: { modelId: model.id } as SessionRun["settingsSnapshot"] });
    sourceId = source.id;
    const user = await store.appendMessage(session.id, "user", sourcePrompt);
    const sourceContext = memoryExperiment === "bounded" && workflow === "solar" ? [] : fullHistory.slice(firstUser + 1);
    const assistant = await store.appendMessage(session.id, "assistant", "Quality stage finished.", model, [], [], "message", sourceContext);
    await store.updateSessionRunStatus(session.id, sourceId, "completed", { userMessageId: user.id, assistantMessageId: assistant.id, finishedAt: new Date().toISOString() });
    store.close();
  }
  if (captureOnly) return;
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = mode === "original" ? "" : session.id;
  process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = process.env.SCIENCE_SPINE_FORMAL_PILOT === "1" && mode === "by-state" ? "pilot" : mode;
  if (process.env.SCIENCE_SPINE_FORMAL_PILOT === "1") process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = workflow;
  if (queuedRollback || pendingPilot) {
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = "pilot";
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = session.id;
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = workflow;
  }
  await openApi();
  if (pendingPilot) {
    await call(runsEndpoint, { content: followUp, researchResume: { sourceRunId: sourceId, workflow } }, "POST", 409);
    assert.equal(modelRequests, 0);
    assert.equal((await call<SessionRun[]>(runsEndpoint)).filter(run => run.researchResume).length, 0);
    closeoutEvidence.pendingPilotRejectedBeforeModel = true;
  }
  if (queuedRollback) await writeFile(join(config.dataDir, "hold-queued-run"), "1");
  const payload = { content: followUp, ...(scopeExperiment === "inline" ? { delegationMode: "inline" } : {}),
    ...(mode === "original" ? {} : { researchResume: { sourceRunId: sourceId, workflow } }) };
  if (controlled === "release-gates") {
    assert.ok(remoteSessionId);
    const rejected = { content: followUp, researchResume: { sourceRunId: sourceId, workflow } };
    await call(runsEndpoint, { ...rejected, researchResume: { sourceRunId: sourceId, workflow: "__proto__" } }, "POST", 400);
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = "pilot";
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS = workflow;
    try { await call(runsEndpoint, rejected, "POST", 409); }
    finally {
      process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE = "by-state";
      delete process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS;
    }
    process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS = `${session.id},${remoteSessionId}`;
    await call(`/api/sessions/${remoteSessionId}/runs`, rejected, "POST", 409);
    const adapterUrl = process.env.SCIENCE_AGENT_ADAPTER_URL;
    try {
      process.env.SCIENCE_AGENT_EXECUTOR = "jiuwenswarm";
      process.env.SCIENCE_AGENT_ADAPTER_URL = "http://127.0.0.1:1";
      await call(runsEndpoint, rejected, "POST", 409);
    } finally {
      process.env.SCIENCE_AGENT_EXECUTOR = "native";
      if (adapterUrl === undefined) delete process.env.SCIENCE_AGENT_ADAPTER_URL;
      else process.env.SCIENCE_AGENT_ADAPTER_URL = adapterUrl;
    }
    const originalTable = await readFile(join(workspace, table));
    try {
      await writeFile(join(workspace, table), Buffer.concat([originalTable, Buffer.from("stale table\n")]));
      await call(runsEndpoint, rejected, "POST", 409);
    } finally { await writeFile(join(workspace, table), originalTable); }
    assert.equal(modelRequests, 0);
    assert.equal((await call<SessionRun[]>(runsEndpoint)).filter(run => run.researchResume).length, 0);
    assert.equal((await call<SessionRun[]>(`/api/sessions/${remoteSessionId}/runs`)).length, 0);
    Object.assign(closeoutEvidence, { unregisteredContractDenied: true, remoteDenied: true, jiuwenSwarmDenied: true,
      changedEvidenceDenied: true, pilotContractDenied: true, modelCallsForRejection: modelRequests });
  }
  console.log("[formal-measurement-start]");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const run = mode === "original" ? await call<SessionRun>(runsEndpoint, payload) : await (async () => {
    const [initial, retry] = await Promise.all([call<SessionRun>(runsEndpoint, payload), call<SessionRun>(runsEndpoint, payload)]);
    assert.equal(initial.id, retry.id, "Duplicate resume created a Run");
    return initial;
  })();
  const runPath = `${runsEndpoint}/${run.id}`;
  const enqueueResponseAt = new Date().toISOString();
  if (queuedRollback) {
    const paused = join(config.dataDir, "observed-queued-run");
    await waitFor(async () => await exists(paused) ? true : undefined, "the durable queue barrier");
    assert.equal(await readFile(paused, "utf8"), run.id);
    assert.equal((await call<SessionRun>(runPath)).status, "queued");
    assert.equal(modelRequests, 0);
    const originalPid = child!.pid;
    await stopApi(true);
    await unlink(join(config.dataDir, "hold-queued-run"));
    delete process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE;
    await openApi();
    assert.notEqual(child?.pid, originalPid);
    await call(runsEndpoint, { ...payload, researchResume: { sourceRunId: "new-checkpoint-after-rollback", workflow } }, "POST", 409);
    Object.assign(closeoutEvidence, { queuedBeforeRestart: true, disabledNewSubmission: true,
      originalPid, restartedPid: child?.pid });
  }
  const faultEvidence: Record<string, unknown> = { ...(fault ? { originalApiPid: child?.pid } : {}) };
  if (cancelFault) {
    await waitFor(async () => await exists(join(workspace, ".formal-shell-started")) ? true : undefined, "Shell start marker");
    assert.equal((await call<SessionRun>(runPath)).status, "running");
    await call(`/api/sessions/${session.id}/files`, { path: "guarded-write.txt", content: "workspace handoff" }, "POST", 409);
    assert.equal(await exists(join(workspace, "guarded-write.txt")), false);
    faultEvidence.inFlightWriteDenied = true;
    const refused = join(config.dataDir, "refuse-shell-stop");
    if (fault === "runner-unavailable") await writeFile(refused, "1");
    faultEvidence.cancelRequestedAt = new Date().toISOString();
    await call(`${runPath}/cancel`, {}, "POST", 202);
    if (fault === "runner-unavailable") {
      await waitFor(async () => (await call<SessionRun>(runPath)).status === "cancelled" ? true : undefined, "Run stop with unavailable Runner");
      const fileEndpoint = `/api/sessions/${session.id}/files`;
      const attemptedWrite = { path: "guarded-write.txt", content: "workspace handoff" };
      await call(fileEndpoint, attemptedWrite, "POST", 409);
      assert.equal(await exists(join(workspace, attemptedWrite.path)), false);
      faultEvidence.unconfirmedWriteDenied = true;
      await stopApi(true);
      await openApi();
      await call(fileEndpoint, attemptedWrite, "POST", 409);
      assert.equal(await exists(join(workspace, attemptedWrite.path)), false);
      faultEvidence.unconfirmedWriteDeniedAfterRestart = true;
      await unlink(refused);
      await waitFor(async () => {
        const response = await fetch(`${origin}${fileEndpoint}`, {
          method: "POST", headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json" },
          body: JSON.stringify(attemptedWrite), signal: AbortSignal.timeout(15_000),
        });
        const body = await response.text();
        if (response.status === 201) return true;
        assert.equal(response.status, 409, body);
        assert.match(body, /RESEARCH_SHELL_STOP_UNCONFIRMED/);
        assert.equal(await exists(join(workspace, attemptedWrite.path)), false);
        return undefined;
      }, "workspace handoff after recovery of the abandoned observer lease", 45_000);
      assert.equal(await readFile(join(workspace, attemptedWrite.path), "utf8"), attemptedWrite.content);
    }
    const activityPath = `/api/sessions/${session.id}/agent-activity`;
    const stopped = await waitFor(async () => {
      const activity = await call<{ executions: AgentShellExecution[] }>(activityPath);
      const owned = activity.executions.filter(row => row.turnId === run.id && row.agentId === "main");
      assert.equal(owned.length, 1);
      assert.equal(owned[0]!.runnerId, "local");
      return owned[0]!.state === "cancelled" && owned[0]!.provenance === "committed" ? owned[0] : undefined;
    }, "Shell cancellation through Run cancellation alone");
    faultEvidence.executionId = stopped.id;
    faultEvidence.executionStateAfterRunCancel = stopped.state;
    faultEvidence.executionProvenanceAfterRunCancel = stopped.provenance;
    assert.equal(await exists(join(workspace, ".formal-shell-alive")), false);
    await writeFile(join(workspace, ".formal-shell-probe"), "probe after confirmed cancellation\n");
    await writeFile(join(workspace, ".formal-shell-release"), "released after cancellation\n");
    // The Shell checks this marker every 200 ms inside its PID namespace.
    await delay(1_200);
    assert.equal(await exists(join(workspace, ".formal-shell-finished")), false);
    assert.equal(await exists(join(workspace, ".formal-shell-alive")), false);
    faultEvidence.shellWriteAfterManagedCancel = false;
  }
  if (fault === "crash-before-commit") {
    await waitFor(async () => providerBlocked ? true : undefined, "next model request barrier");
    const firstArtifact = join(workspace, "groups.json");
    assert.equal((await call<SessionRun>(runPath)).status, "running");
    faultEvidence.beforeCrash = await readFile(firstArtifact, "utf8");
    faultEvidence.crashAt = new Date().toISOString();
    await stopApi(true);
    await openApi();
    assert.equal(await readFile(firstArtifact, "utf8"), faultEvidence.beforeCrash);
  }
  let finished: SessionRun;
  for (;;) {
    finished = await call<SessionRun>(runPath);
    if (["failed", "completed", "cancelled", "interrupted"].includes(finished.status)) break;
    if (performance.now() - started > Number(process.env.SCIENCE_SPINE_FORMAL_TIMEOUT_MS ?? 360_000)) throw new Error(`Run did not finish: ${finished.status}`);
    await delay(400);
  }
  const terminalObservedAt = new Date().toISOString();
  const expectedFaultStatus = cancelFault ? "cancelled" : fault === "crash-before-commit" ? "interrupted" : "completed";
  if (fault) {
    if (fault !== "crash-before-commit") { await stopApi(); await openApi(); }
    if (cancelFault) {
      const { executions } = await call<{ executions: AgentShellExecution[] }>(`/api/sessions/${session.id}/agent-activity`);
      assert.equal(executions.find(row => row.id === faultEvidence.executionId)?.state, "cancelled");
    }
    if (process.env.SCIENCE_SPINE_FORMAL_TRAJECTORY_AUDIT === "1") {
      const path = `/api/sessions/${session.id}/trajectory`;
      const trace = await call<{ entries: Array<{ id: string; runId?: string; eventType?: string; label: string; sequence: number }> }>(path);
      const recoveryEntries = trace.entries.filter(entry => entry.runId === run.id && entry.eventType === "research.recovery");
      assert.ok(recoveryEntries.length >= 2);
      assert.deepEqual(recoveryEntries.map(entry => entry.sequence), recoveryEntries.map(entry => entry.sequence).toSorted((a, b) => a - b));
      for (const entry of recoveryEntries) {
        const { value } = await call<{ value: { sourceRunId: string; action: string; checkpointDigest: string } }>(`${path}/detail?id=${encodeURIComponent(entry.id)}`);
        assert.equal(value.sourceRunId, sourceId);
        assert.equal(value.action, entry.label);
        assert.equal(value.checkpointDigest, run.researchResume?.ref.digest);
      }
      faultEvidence.trajectoryActions = recoveryEntries.map(entry => entry.label);
    }
    faultEvidence.restartedApiPid = child?.pid;
    assert.notEqual(faultEvidence.restartedApiPid, faultEvidence.originalApiPid);
    const requestsBefore = modelRequests;
    const retries = await Promise.all([call<SessionRun>(runsEndpoint, payload), call<SessionRun>(runsEndpoint, payload)]);
    assert.ok(retries.every(retry => retry.id === run.id && retry.status === expectedFaultStatus));
    await call(runsEndpoint, { ...payload, content: `${followUp} Changed.` }, "POST", 409);
    const recoveryRuns = await call<SessionRun[]>(runsEndpoint);
    assert.equal(recoveryRuns.filter(row => row.researchResume?.sourceRunId === sourceId).length, 1);
    assert.equal(modelRequests, requestsBefore);
    assert.equal(finished.status, expectedFaultStatus);
    if (fault === "retry-after-restart") {
      const persisted = (await call<SessionRun>(runPath));
      assert.ok(persisted.assistantMessageId);
      assert.equal(persisted.assistantMessageId, finished.assistantMessageId);
    } else {
      assert.ok(!finished.assistantMessageId, "An interrupted Run published an assistant answer");
      const files = await readdir(workspace);
      assert.ok(!files.includes("solar_report.md"));
      assert.equal(files.includes("groups.json"), fault === "crash-before-commit");
    }
    Object.assign(faultEvidence, { retriedRunIds: retries.map(retry => retry.id), requestsBeforeRetry: requestsBefore,
      totalRunsForCheckpoint: 1, expectedFaultStatus });
  }
  if (queuedRollback) {
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(finished.id, run.id);
    assert.deepEqual(rollbackToolNames, ["execution_logs", "execution_status", "read_tool_output", "run_shell", "update_plan"]);
    const trajectory = await call<{ entries: Array<{ runId?: string; eventType?: string; label: string }> }>(`/api/sessions/${session.id}/trajectory`);
    const actions = trajectory.entries.filter(row => row.runId === run.id && row.eventType === "research.recovery").map(row => row.label);
    assert.deepEqual(actions, ["full-history", "delivery-verified"]);
    Object.assign(closeoutEvidence, { actions, rollbackToolNames });
  }
  if (memoryExperiment) {
    const usage = await call(`/api/sessions/${session.id}/usage`);
    const durationMs = Math.round(performance.now() - started);
    await stopApi();
    const reopened = new SessionStore(config.dataDir);
    await reopened.load();
    try {
      const answer = (await reopened.readMessages(session.id)).find(message => message.id === finished.assistantMessageId);
      const shellExecutions = reopened.shellExecutions.list({ sessionId: session.id, agentId: "main" }).length;
      await writeFile(join(output, "memory-result.json"), JSON.stringify({ memoryExperiment, durationMs, usage, run: finished, answer: answer?.content, expected: memoryExpected, shellExecutions, memoryApiMs }, null, 2));
      assert.equal(finished.status, "completed");
      assert.deepEqual(parseReviewAnswer(answer?.content), memoryExpected);
      assert.equal(shellExecutions, reviewInput && memoryExperiment === "full" ? 1 : 0);
      assert.equal(reopened.listSubagents(session.id).length, 0);
    } finally { reopened.close(); }
  } else if (scopeExperiment) {
    const children = (await call<Subagent[]>(`/api/sessions/${session.id}/subagents`)).filter(child => child.parentTurnId === run.id);
    const usage = await call(`/api/sessions/${session.id}/usage`);
    const durationMs = Math.round(performance.now() - started);
    await stopApi();
    const reopened = new SessionStore(config.dataDir);
    await reopened.load();
    try {
      const answer = (await reopened.readMessages(session.id)).find(message => message.id === finished.assistantMessageId);
      const persistedChildren = reopened.listSubagents(session.id).filter(child => child.parentTurnId === run.id);
      assert.deepEqual(persistedChildren.map(child => child.id).sort(), children.map(child => child.id).sort());
      const receipt = await writeSpawnReceipt(reopened.dataDir, session.id, run.id, persistedChildren);
      assert.equal((await writeSpawnReceipt(reopened.dataDir, session.id, run.id, [...persistedChildren].reverse())).ref.digest, receipt.ref.digest);
      const replayedChild = persistedChildren[0];
      if (replayedChild) {
        const replayed = await writeSpawnReceipt(reopened.dataDir, session.id, run.id, [...persistedChildren, structuredClone(replayedChild)]);
        assert.equal(replayed.ref.digest, receipt.ref.digest);
        await assert.rejects(writeSpawnReceipt(reopened.dataDir, session.id, run.id,
          [...persistedChildren, { ...replayedChild, error: "conflicting result" }]), /conflicting child outcomes/);
      }
      const result = { scopeExperiment, durationMs, run: finished, usage, receipt, answer: answer?.content, expected: scopeExpected,
        childRuns: children.map(child => ({ id: child.id, status: child.status, createdAt: child.createdAt, finishedAt: child.finishedAt, usage: child.usage })) };
      await writeFile(join(output, "scope-result.json"), JSON.stringify(result, null, 2));
      assert.equal(finished.status, "completed");
      assert.deepEqual(parseReviewAnswer(answer?.content), scopeExpected);
      assert.equal(children.length, scopeExperiment === "inline" ? 0 : 2);
      if (scopeExperiment === "inline") {
        assert.equal((await reopened.getSessionRun(session.id, run.id))?.delegationMode, "inline");
        const frames = await readdir(join(config.dataDir, "context-traces"));
        const traceDir = frames.find(name => name.startsWith(`${session.id}_`));
        assert.ok(traceDir);
        const traces = (await readdir(join(config.dataDir, "context-traces", traceDir))).filter(name => /^turn-.*\.json$/u.test(name));
        assert.ok(traces.length > 0);
        for (const name of traces) {
          const trace = JSON.parse(await readFile(join(config.dataDir, "context-traces", traceDir, name), "utf8"));
          assert.ok(Array.isArray(trace.llmInput?.tools) && trace.llmInput.tools.length > 0);
          assert.ok(!trace.llmInput.tools.some((tool: { name: string }) => tool.name === "task"));
        }
      }
      if (scopeExperiment === "partial") {
        assert.equal(receipt.branches.filter(branch => branch.status === "completed" && branch.resultRef).length, 1);
        assert.equal(receipt.branches.filter(branch => branch.status === "failed" && branch.error?.includes("validation failed")).length, 1);
      } else {
        assert.equal(children.filter(child => child.status === "completed").length, children.length);
        assert.equal(receipt.branches.filter(branch => branch.resultRef).length, children.length);
      }
    } finally { reopened.close(); }
    if (!alternate) {
      await openApi();
      const route = `${runPath}/spawn-receipt`;
      const persisted = JSON.parse(await readFile(join(output, "scope-result.json"), "utf8"));
      const retrieved = await call(route, {}, "POST", 200);
      assert.deepEqual(retrieved, persisted.receipt);
      assert.deepEqual(await call(route, {}, "POST", 200), retrieved);
      persisted.receiptAfterRestart = retrieved;
      await writeFile(join(output, "scope-result.json"), JSON.stringify(persisted, null, 2));
    }
  } else {
    const usage = await call(`/api/sessions/${session.id}/usage`);
    const elapsedMs = Math.round(performance.now() - started);
    await writeFile(join(output, "result.json"), JSON.stringify({ mode, alternate, checkpoint: auditCheckpoint, workspace, sessionId: session.id, sourceRunId: sourceId,
      elapsedMs, timing: { startedAt, enqueueResponseAt, terminalObservedAt, usageReceivedAt: new Date().toISOString() },
      ...(fault ? { fault, faultEvidence } : {}), ...(queuedRollback || pendingPilot || controlled === "release-gates" ? { closeoutEvidence } : {}), run: finished, usage, ...(controlled ? { modelRequests, sourceRequests, controlled, disabledRequestRejected: genuineSource } : {}) }, null, 2));
    if (controlled === "bad-delivery") {
      assert.equal(finished.status, "failed");
      assert.match(finished.error ?? "", /independent verification/);
      assert.equal(finished.assistantMessageId, undefined);
    } else if (controlled === "rewrite") {
      assert.equal(finished.status, "failed");
      assert.match(finished.error ?? "", /accepted files were rewritten/);
    } else if (controlled === "skip-display") {
      assert.equal(finished.status, "failed");
      assert.match(finished.error ?? "", /quality table must be displayed before/);
    } else assert.equal(finished.status, fault ? expectedFaultStatus : "completed", finished.error);
  }
} catch (error) {
  console.error(error);
  if (queuedRollback && child) await stopApi(true);
  throw error;
} finally {
  await stopApi();
  if (controlled) console.log("[formal-cleanup] API stopped");
  if (provider) await new Promise<void>(done => { provider!.close(() => done()); provider!.closeAllConnections(); });
  await new Promise<void>(done => { runner.close(() => done()); runner.closeAllConnections(); });
  if (controlled) console.log("[formal-cleanup] Runner and provider listeners stopped");
}
}

await runExperiment();
