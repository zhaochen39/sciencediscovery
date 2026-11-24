import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryGraphClient } from "../../../packages/memory/src/memory-graph.ts";
import { ProvenanceRecorder } from "../../../packages/provenance/src/recorder.ts";
import { SessionStore } from "../../../services/api/src/store.ts";
import { readNodeMemory, verifyNodeMemory } from "./scope-experiments.ts";

const [arm, graphUrl, output] = process.argv.slice(2);
assert.ok(arm && graphUrl && output, "Provide the accepted citation arm, isolated graph sidecar URL and output path");
const audit = spawnSync("python3", ["test/benchmarks/research-spine-value-validation/report-formal-recovery.py", arm, "--single", "--require-pass"], { encoding: "utf8" });
assert.equal(audit.status, 0, audit.stderr || audit.stdout);
const result = JSON.parse(await readFile(join(arm, "result.json"), "utf8"));
const sourceRoot = (await readFile(join(arm, "data-dir.txt"), "utf8")).trim();
const root = await mkdtemp(join(tmpdir(), "citation-memory-"));
await cp(sourceRoot, root, { recursive: true });
const store = new SessionStore(root);
await store.load();
try {
  const client = new MemoryGraphClient({ url: graphUrl });
  const session = store.getSession(result.sessionId)!;
  const recorder = new ProvenanceRecorder(root, store);
  const runs = await store.listExecutionRuns(session.id);
  const expected = [];
  for (const path of ["citation_audit.json", "citation_summary.json"]) {
    const execution = runs.find(run => run.turnId === result.run.id && run.exitCode === 0 && run.createdFiles?.includes(path));
    if (!execution) throw new Error(`Verified file has no successful source execution: ${path}`);
    const { version } = await recorder.registerWorkspaceArtifact({ sessionId: session.id, path, workspaceRoot: store.workspacePath(session.id),
      origin: "llm_declared", turnId: result.run.id, executionRunIds: [execution.id], inputArtifactVersionIds: expected.map(entry => entry.version.id) });
    await client.observeExecution({ executionId: execution.id, sessionId: session.id, turnId: result.run.id, tool: execution.tool,
      language: execution.language, codeHash: execution.code.hash, exitCode: execution.exitCode, status: execution.status,
      startedAt: execution.startedAt, finishedAt: execution.finishedAt, toolType: "execution", producedArtifacts: [{
        artifactId: version.artifactId, path, version: version.version, logicalName: path, mediaType: version.mediaType,
        projectId: session.projectId, turnId: result.run.id, contentHash: version.content.hash,
        inputArtifactVersions: expected.map(entry => ({ artifactId: entry.version.artifactId, version: entry.version.version })),
      }] });
    expected.push({ path, version });
  }
  const memory = await verifyNodeMemory(store, session.id, result.run.id, expected.map(entry => entry.path));
  const graph = await client.getSubgraph(session.id);
  assert.ok(!graph.reason && !graph.truncated, `Graph is incomplete: ${graph.reason ?? "truncated"}`);
  const linked = expected.map(({ path, version }) => {
    const node = graph.nodes.find(node => node.label === "Artifact" && node.extra?.artifact_id === version.artifactId
      && node.extra?.version === version.version && node.extra?.content_hash === version.content.hash);
    assert.ok(node, `No exact Artifact version in ScienceMemory for ${path}`);
    assert.ok(graph.edges.some(edge => edge.type === "produces" && edge.target === node.id), `No producing execution in ScienceMemory for ${path}`);
    assert.ok(memory.entries.find(entry => entry.path === path)?.artifactVersions.some(link => link.versionId === version.id));
    return { path, id: node.id, versionId: version.id, sha256: version.content.hash };
  });
  assert.ok(graph.edges.some(edge => edge.type === "input" && edge.source === linked[0]!.id), "Missing audit-to-summary dependency");
  await assert.rejects(readNodeMemory(store, memory.ref, session.id, "other-run"), /owner mismatch/);
  // Simulate a replacement revision through the durable store, leaving the source bytes intact.
  const summary = memory.entries.find(entry => entry.path === "citation_summary.json")!;
  await store.recordWorkspaceFileRevision(session.id, { path: summary.path, size: summary.bytes, contentHash: summary.sha256,
    mode: "write", origin: "system", modifiedAt: new Date().toISOString(), runId: "revision-probe" });
  await assert.rejects(readNodeMemory(store, memory.ref, session.id, result.run.id), /revision expired/);
  // Re-link the validated bytes to the original version for the benchmark readback.
  const versionId = linked.find(entry => entry.path === summary.path)!.versionId;
  await store.recordWorkspaceFileRevision(session.id, { path: summary.path, size: summary.bytes, contentHash: summary.sha256,
    mode: "link", origin: "system", modifiedAt: new Date().toISOString(), runId: result.run.id, artifactVersionId: versionId });
  const usable = await verifyNodeMemory(store, session.id, result.run.id, expected.map(entry => entry.path));
  await writeFile(output, JSON.stringify({ arm, memoryStore: root, ...usable, linked, edgeCount: graph.edges.length, staleRevisionRejected: true }, null, 2));
} finally { store.close(); }
