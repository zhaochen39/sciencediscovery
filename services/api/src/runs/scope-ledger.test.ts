// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ScopeLedger } from "./scope-ledger.js";
import { scopeEvolveResult } from "./scope-research-result.js";
import { scopeMemorySubgraph } from "./scope-memory-graph.js";
import { writeSpawnReceipt } from "../subagents/spawn-receipt.js";

const memory = { findings: ["Independent total is 36"], obligations: [], artifactVersionIds: ["artifact-version"], outcome: "completed" as const };
const verify = (id: string) => id === "artifact-version";

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "science-scope-test-"));
  let db = new DatabaseSync(join(dir, "catalog.sqlite"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true }); });
  return { dir, ledger: () => new ScopeLedger(db, dir, "session", "run"), restart() { db.close(); db = new DatabaseSync(join(dir, "catalog.sqlite")); } };
}

test("replays nested and sibling scopes after reopening, returning the same receipt for a duplicate operation", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  const opening = { kind: "open", expectedActiveId: "root", title: "Audit" } as const;
  const a = await ledger.transition("op-1", opening, verify);
  const nested = await ledger.transition("op-2", { kind: "open", expectedActiveId: a.activeId, title: "Sources" }, verify);
  const b = await ledger.transition("op-3", { kind: "next", expectedActiveId: nested.activeId, title: "Claims", memory }, verify);
  await ledger.transition("op-4", { kind: "close", expectedActiveId: b.activeId, memory }, verify);
  await ledger.transition("op-5", { kind: "close", expectedActiveId: a.activeId, memory }, verify);
  const tree = ledger.view();
  assert.equal(tree.activeId, "root");
  assert.deepEqual(tree.nodes.map(node => node.parentId), [null, "root", a.activeId, a.activeId]);
  assert.equal(ledger.artifactScopes("artifact-version").length, 3);
  f.restart();
  const recovered = f.ledger();
  assert.deepEqual(recovered.view(), tree);
  assert.deepEqual((await recovered.readMemory(nested.activeId)).memory, memory);
  assert.deepEqual(await recovered.transition("op-1", opening, verify), a);
  assert.equal(recovered.state().sequence, 5);
  await assert.rejects(recovered.transition("op-1", { ...opening, title: "Different" }, verify), /already used/);
});

test("a stale or unverifiable close cannot attach evidence or transition a Scope", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  const { activeId } = await ledger.transition("open", { kind: "open", expectedActiveId: "root", title: "Audit" }, verify);
  await assert.rejects(ledger.transition("wrong-state", { kind: "close", expectedActiveId: "old", memory }, verify), /changed/);
  await assert.rejects(ledger.transition("wrong-owner", { kind: "close", expectedActiveId: activeId, memory }, () => false), /Artifact Versions/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ledger.transition("stopped", { kind: "close", expectedActiveId: activeId, memory }, verify, controller.signal), { name: "AbortError" });
  assert.equal(ledger.state().sequence, 1);
  assert.equal(ledger.state().activeId, activeId);
  assert.deepEqual(ledger.artifactScopes("artifact-version"), []);
});

test("only one overlapping close can advance the active scope", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  const { activeId } = await ledger.transition("open", { kind: "open", expectedActiveId: "root", title: "Audit" }, verify);
  const outcomes = await Promise.allSettled(["a", "b"].map(operation => ledger.transition(operation, { kind: "close", expectedActiveId: activeId, memory }, verify)));
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(ledger.state().sequence, 2);
  assert.equal(ledger.artifactScopes("artifact-version").length, 1);
});

test("close reuses an existing artifact link and exposes only committed child evidence", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  const { activeId } = await ledger.transition("open", { kind: "open", expectedActiveId: "root", title: "Audit" }, verify);
  ledger.beginExecution("shell", "run_shell");
  ledger.endExecution("shell", "completed", "execution-1");
  ledger.beginExecution("declare", "declare_artifact");
  ledger.endExecution("declare", "completed", "artifact-version", "artifact-version");
  const resolveArtifact = (id: string) => ({ id, hash: "hash", path: "data.tsv" });
  assert.equal(ledger.closedShellEvidence(resolveArtifact).size, 0);
  await ledger.transition("close", { kind: "close", expectedActiveId: activeId, memory }, verify);
  assert.equal(ledger.artifactScopes("artifact-version").length, 1);
  assert.equal(ledger.closedShellEvidence(resolveArtifact).get("shell")?.artifacts[0]?.id, "artifact-version");
  assert.equal(ledger.closedShellEvidence(() => undefined).size, 0);
});

test("a scoped artifact joins only the matching ScienceMemory version and retains the reverse index", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  ledger.beginExecution("declare", "declare_artifact", true);
  ledger.endExecution("declare", "completed", "artifact-version", "artifact-version");
  const graph = scopeMemorySubgraph({ nodes: [{ id: "report#v1", label: "Artifact" }, { id: "report#v2", label: "Artifact" }], edges: [], total: 2, truncated: false }, ledger,
    id => id === "artifact-version" ? { id, artifactId: "report", createdAt: "", version: 1, content: { hash: "", size: 0 }, executionRunIds: [], inputArtifactVersionIds: [], mediaType: "application/json", projectId: "project", sessionId: "session", turnId: "run" } : undefined);
  const scope = "research-scope:run:observed:declare";
  assert.ok(graph.edges.some(edge => edge.source === scope && edge.target === "report#v1"));
  assert.ok(!graph.edges.some(edge => edge.source === scope && edge.target === "report#v2"));
  assert.deepEqual(ledger.artifactScopes("artifact-version").map(row => ({ ...row })), [{ runId: "run", nodeId: "observed:declare" }]);
});

test("native wait receipts use owned terminal children, ignore timeouts, and remain stable after reopening", async t => {
  const f = await fixture(t);
  const ledger = f.ledger();
  ledger.recordSwarmDelegation("spawn-b", "subagent_spawn", JSON.stringify({ subagent_id: "b" }), undefined);
  ledger.recordSwarmDelegation("spawn-a", "subagent_spawn", JSON.stringify({ subagent_id: "a" }), undefined);
  ledger.recordSwarmDelegation("timeout", "subagent_wait", JSON.stringify({ timed_out: true, statuses: { b: "completed" }, results: { b: 36 } }), ["b"]);
  assert.throws(() => ledger.swarmBranches(), /terminal/);
  ledger.recordSwarmDelegation("wait", "subagent_wait", JSON.stringify({ timed_out: false,
    statuses: { a: "errored", b: "completed", foreign: "completed" }, results: { b: "36", foreign: "99" } }), ["b", "a", "foreign"]);
  const receipt = await writeSpawnReceipt(f.dir, "session", "run", [], ledger.swarmBranches());
  assert.deepEqual(receipt.branches.map(item => [item.childId, item.status]), [["a", "failed"], ["b", "completed"]]);
  assert.ok(receipt.branches[1]?.resultRef);
  f.restart();
  assert.deepEqual(await writeSpawnReceipt(f.dir, "session", "run", [], f.ledger().swarmBranches()), receipt);
});

test("a Scope search summary preserves lineage, invalid evaluations and held-out results", () => {
  const result = scopeEvolveResult({ id: "search", status: "succeeded", candidates: 3 }, [
    { event: { type: "seeded", nodeIndex: 0, baselineScore: 0.4 } },
    { event: { type: "expanded", nodeIndex: 1, parentIndex: 0, valid: true, score: 0.6, codeHash: "winner" } },
    { event: { type: "expanded", nodeIndex: 2, parentIndex: 1, valid: false, score: 0.99 } },
    { event: { type: "search_finished", bestNodeIndex: 1, bestTestScore: 0.55 } },
  ]);
  assert.equal(result.bestScore, 0.6);
  assert.equal(result.bestTestScore, 0.55);
  assert.equal(result.bestCodeHash, "winner");
  assert.deepEqual(result.evaluations.map(({ nodeIndex, parentIndex, status, gateScore }) => [nodeIndex, parentIndex, status, gateScore]), [
    [0, null, "seed", 0.4], [1, 0, "evaluated", 0.6], [2, 1, "invalid", null],
  ]);
});
