// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createResearchPackage, importResearchPackage, sha256 } from "@sciencediscovery/research-package";
import { createApiServer, closeApiServer } from "./http/index.js";
import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import type { ServerConfig } from "./bootstrap/config.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "research-package-http-"));
  const config: ServerConfig = {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" }, evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => { await closeApiServer(server); await rm(root, { force: true, recursive: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rawRequest = async (path: string, init: RequestInit = {}) => {
    return await fetch(`${origin}${path}`, { ...init, headers: { authorization: "Bearer test-token", ...(init.headers ?? {}) } });
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await rawRequest(path, init);
    assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
    return response;
  };
  const project = async () => await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "科研恢复验证" }) })).json() as { id: string; firstSession: { id: string } };
  return { rawRequest, request, project };
}

const date = "2026-10-20T10:00:00.000Z";
function evidencePackage(legacy = false) {
  const first = Buffer.from("value\n1\n");
  const latest = Buffer.from("value\n2\n");
  const notebook = Buffer.from('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}');
  const version = (id: string, index: number, object: Buffer) => ({
    id, artifactId: "artifact-source", sessionId: "source-one", projectId: "source-project", version: index,
    createdAt: date, content: { hash: sha256(object), size: object.length }, mediaType: "text/csv", sourcePath: "results/result.csv",
    inputArtifactVersionIds: index === 2 ? ["version-one"] : [], executionRunIds: [], turnId: "run-source", ...(legacy ? {} : { objectPath: sha256(object) }),
  });
  return createResearchPackage({ source: { projectId: "source-project", title: "科研项目", sessionIds: ["source-one", "source-two"] }, records: {
    sessions: [{ session: { id: "source-one", title: "原始研究", specialistId: "unavailable-specialist" },
      messages: [{ id: "prompt-one", role: "user", content: "第一轮科研问题", createdAt: date }, { id: "answer-one", role: "assistant", content: "第一轮结论", createdAt: date }, { id: "prompt-two", role: "user", content: "第二轮科研问题", createdAt: date }, { id: "answer-two", role: "assistant", content: "第二轮结论", createdAt: date }],
      runs: [{ id: "run-source", sessionId: "source-one", prompt: "第一轮科研问题", createdAt: date, status: "running", queueOrder: 1, annotationIds: [], references: [], settingsSnapshot: {}, userMessageId: "prompt-one", assistantMessageId: "answer-one" }],
      workspace: [{ path: "results/result.csv", objectPath: sha256(latest), size: latest.length, modifiedAt: date }, { path: "analysis.ipynb", objectPath: sha256(notebook), size: notebook.length, modifiedAt: date }],
      validations: { reviews: [{ id: "review-source", sessionId: "source-one", kind: "integrity", status: "passed", turnId: "run-source", createdAt: date, finishedAt: date, findings: [] }], artifactReviews: [{ id: "artifact-review-source", sessionId: "source-one", artifactId: "artifact-source", artifactVersionId: "version-two", artifactContentHash: sha256(latest), artifactLogicalName: "results/result.csv", checkpointId: "checkpoint-source", decision: "ACCEPT_AND_PROCEED", createdAt: date, finishedAt: date, findings: [], reviewerSpecialistVersion: "1", status: "completed" }] },
    }, { session: { id: "source-two", title: "分支会话", specialistId: "unavailable-specialist" }, messages: [{ id: "branch-prompt", role: "user", content: "分支研究", createdAt: date }], workspace: [] }],
    artifacts: [{ id: "artifact-source", projectId: "source-project", createdInSessionId: "source-one", createdInSessionTitle: "原始研究", sessionId: "source-one", name: "results/result.csv", logicalName: "results/result.csv", kind: "dataset", origin: "user_upload", currentVersion: 2, createdAt: date, updatedAt: date, versions: [version("version-one", 1, first), version("version-two", 2, latest)] }],
  }, objects: [first, latest, notebook].map((bytes) => ({ path: sha256(bytes), bytes })) }).bytes;
}

test("complete package restores conversations, files, versions and reviews across projects without leaking into sibling sessions", async (context) => {
  const { rawRequest, request, project } = await fixture(context);
  const source = await project();
  const targetId = source.firstSession.id;
  assert.deepEqual(await (await request(`/api/sessions/${targetId}/research-package-import-eligibility`)).json(), { canImport: true });
  const receipt = await (await request(`/api/projects/${source.id}/research-package/import?sessionId=${targetId}`, { method: "POST", body: Buffer.from(evidencePackage()) })).json() as { importedSessionIds: string[]; artifactCount: number; omissions: string[] };
  assert.equal(receipt.artifactCount, 1);
  assert.equal(receipt.importedSessionIds.length, 2);
  assert.deepEqual(receipt.omissions, []);
  const detail = await (await request(`/api/sessions/${targetId}`)).json() as { title: string; messages: { content: string }[] };
  assert.equal(detail.title, "原始研究");
  assert.deepEqual(detail.messages.map((item) => item.content), ["第一轮科研问题", "第一轮结论", "第二轮科研问题", "第二轮结论"]);
  assert.equal(await (await request(`/api/sessions/${targetId}/file?path=results%2Fresult.csv`)).text(), "value\n2\n");
  const runs = await (await request(`/api/sessions/${targetId}/runs`)).json() as { id: string; status: string; createdAt: string }[];
  assert.equal(runs[0]?.status, "cancelled"); assert.equal(runs[0]?.createdAt, date);
  const artifacts = await (await request(`/api/sessions/${targetId}/artifacts`)).json() as { id: string }[];
  const versions = await (await request(`/api/sessions/${targetId}/artifacts/${artifacts[0]!.id}/versions`)).json() as { id: string; inputArtifactVersionIds: string[] }[];
  assert.equal(versions.length, 2);
  assert.ok(versions.some((item) => item.inputArtifactVersionIds.length === 1));
  // The imported second session and a subsequently created empty session stay isolated.
  const sibling = receipt.importedSessionIds[1]!;
  assert.deepEqual(await (await request(`/api/sessions/${sibling}/artifacts`)).json(), []);
  assert.deepEqual(await (await request(`/api/sessions/${sibling}/files`)).json(), []);
  const empty = await (await request(`/api/projects/${source.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新建空会话" }) })).json() as { id: string };
  assert.deepEqual(await (await request(`/api/sessions/${empty.id}/artifacts`)).json(), []);
  assert.deepEqual(await (await request(`/api/sessions/${empty.id}/files`)).json(), []);
  const sameName = await (await request(`/api/projects/${source.id}/research-package/import?sessionId=${empty.id}`, { method: "POST", body: Buffer.from(evidencePackage()) })).json() as { artifactCount: number };
  assert.equal(sameName.artifactCount, 1);
  const renamedEmpty = await (await request(`/api/sessions/${empty.id}`)).json() as { title: string };
  assert.equal(renamedEmpty.title, "原始研究");
  const separateArtifacts = await (await request(`/api/sessions/${empty.id}/artifacts`)).json() as { id: string }[];
  assert.equal(separateArtifacts.length, 1);
  assert.notEqual(separateArtifacts[0]!.id, artifacts[0]!.id);
  // Export the live data, then import it into an entirely new project.
  const exported = Buffer.from(await (await request(`/api/projects/${source.id}/research-package?sessionId=${targetId}&level=complete`)).arrayBuffer());
  const exportedRecords = importResearchPackage(exported).records as { sessions: { validations: { artifactReviews: { artifactVersionId: string }[] } }[] };
  assert.ok(versions.some((item) => item.id === exportedRecords.sessions[0]?.validations.artifactReviews[0]?.artifactVersionId));
  const other = await project();
  const roundtrip = await (await request(`/api/projects/${other.id}/research-package/import?sessionId=${other.firstSession.id}`, { method: "POST", body: exported })).json() as { artifactCount: number };
  assert.equal(roundtrip.artifactCount, 1);
  const restored = await (await request(`/api/sessions/${other.firstSession.id}`)).json() as { messages: unknown[] };
  assert.equal(restored.messages.length, 4);
  assert.equal(await (await request(`/api/sessions/${other.firstSession.id}/file?path=results%2Fresult.csv`)).text(), "value\n2\n");
  const files = await (await request(`/api/sessions/${other.firstSession.id}/files`)).json() as { path: string }[];
  assert.ok(files.some((item) => item.path === "analysis.ipynb"));
  assert.deepEqual(await (await request(`/api/sessions/${targetId}/research-package-import-eligibility`)).json(), { canImport: false });
  const rejected = await rawRequest(`/api/projects/${source.id}/research-package/import?sessionId=${targetId}`, { method: "POST", body: Buffer.from(evidencePackage()) });
  assert.equal(rejected.status, 409);
  const custom = importResearchPackage(Buffer.from(await (await request(`/api/projects/${source.id}/research-package?sessionId=${targetId}&level=complete&customFiles=1&filePath=analysis.ipynb`)).arrayBuffer()));
  const customRecords = custom.records as { sessions: { workspace: { path: string }[] }[] };
  assert.deepEqual(customRecords.sessions[0]?.workspace.map((item) => item.path), ["analysis.ipynb"]);
  const preview = await (await request(`/api/projects/${source.id}/research-package/preview?sessionId=${targetId}&level=complete`)).json() as { estimatedBytes: number; files: unknown[] };
  assert.ok(preview.estimatedBytes > 0); assert.equal(preview.files.length, 2);
  const markdown = await (await request(`/api/sessions/${targetId}/conversation-export?format=markdown&scope=custom&messageId=prompt-two`)).text();
  assert.ok(markdown.includes("第二轮结论")); assert.ok(!markdown.includes("第一轮结论"));
});

test("legacy v1 packages restore CAS-backed artifact content without explicit objectPath", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const result = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(evidencePackage(true)) })).json() as { artifactCount: number; omissions: string[] };
  assert.equal(result.artifactCount, 1); assert.deepEqual(result.omissions, []);
});

test("invalid workspace destinations are rejected before a target session is changed", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const malicious = createResearchPackage({ source: { projectId: "bad", title: "Invalid paths" }, records: {
    sessions: [{ session: { id: "source" }, messages: [{ id: "bad-message", role: "user", content: "must not import", createdAt: date }], workspace: [{ path: "../../outside.txt", objectPath: sha256(Buffer.from("bad")), size: 3 }] }],
  }, objects: [{ path: sha256(Buffer.from("bad")), bytes: Buffer.from("bad") }] }).bytes;
  await assert.rejects(request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(malicious),
  }), /400/);
  const detail = await (await request(`/api/sessions/${target.firstSession.id}`)).json() as { messages: unknown[] };
  assert.deepEqual(detail.messages, []);
});
