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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { CreateSpecialistRequest } from "@sciencediscovery/schema";

import { SessionStore, isAutoApplicableConnector } from "./store.js";

function storeRoot(): string {
  return resolve(process.cwd(), ".tmp", `store-branches-${randomUUID()}`);
}

async function loadedStore(context: { after(fn: () => Promise<void>): void }): Promise<SessionStore> {
  const root = storeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  return store;
}

test("STORE an unloaded store refuses every storage-backed accessor", async (context) => {
  const root = storeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  assert.throws(() => store.plugins, /Plugin control is not initialized/);
  assert.throws(() => store.notifications, /Notification storage is not initialized/);
  assert.throws(() => store.shellExecutions, /Shell Execution storage is not initialized/);
  assert.throws(() => store.transfers, /Transfer storage is not initialized/);
  assert.throws(() => store.getConfigurationDatabase(), /Catalog database is not initialized/);
  assert.throws(() => store.getWebSettings(), /Catalog database is not initialized/);
  assert.equal(store.getWebProviderApiKey("tavily" as never), undefined);
  assert.equal(store.getModelApiToken(undefined), undefined);
  assert.equal(store.getProviderApiToken(undefined), undefined);
  assert.equal(store.getProxyServerUrl("missing"), undefined);
  assert.deepEqual(store.listDueConnectorConfigurationRequests("2026-01-01T00:00:00.000Z"), []);
});

test("STORE only the explicitly reviewed PubMed connector applies without a decision", () => {
  assert.equal(isAutoApplicableConnector("pubmed"), true);
  assert.equal(isAutoApplicableConnector("uniprot"), false);
  assert.equal(isAutoApplicableConnector(""), false);
});

test("STORE proxy server creation validates the kind, the name and where a URL may appear", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.createProxyServer({ kind: "bogus" as never, name: "Bad" }), /kind must be custom_url, environment, or system/);
  await assert.rejects(store.createProxyServer({ kind: "system", name: "   " }), /Proxy server name is required/);
  await assert.rejects(store.createProxyServer({ kind: "custom_url", name: "No URL" }), /requires a proxy URL/);
  await assert.rejects(store.createProxyServer({ kind: "system", name: "Sys", url: "http://127.0.0.1:8080" }), /Only custom_url proxy servers accept a proxy URL/);

  const custom = await store.createProxyServer({ kind: "custom_url", name: "Local", url: "http://127.0.0.1:8080" });
  assert.equal(custom.hasUrl, true);
  assert.equal(custom.url, "http://127.0.0.1:8080/");

  const system = await store.createProxyServer({ kind: "system", name: "System" });
  assert.equal(system.hasUrl, false);
  assert.equal(system.url, undefined);
});

test("STORE proxy server updates keep the same URL rules and clear a URL when the kind changes", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.updateProxyServer("missing", { name: "Renamed" }), /Proxy server not found/);

  const custom = await store.createProxyServer({ kind: "custom_url", name: "Custom", url: "http://127.0.0.1:9000" });
  const downgraded = await store.updateProxyServer(custom.id, { kind: "system" });
  assert.equal(downgraded.kind, "system");
  assert.equal(downgraded.hasUrl, false);
  assert.equal(store.getProxyServerUrl(custom.id), undefined);

  const system = await store.createProxyServer({ kind: "system", name: "Plain" });
  await assert.rejects(store.updateProxyServer(system.id, { kind: "custom_url" }), /Changing to custom_url requires a proxy URL/);
  await assert.rejects(store.updateProxyServer(system.id, { url: "http://127.0.0.1:1234" }), /Only custom_url proxy servers accept a proxy URL/);
});

test("STORE a proxy server in use cannot be deleted, an unused one can", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.deleteProxyServer("missing"), /Proxy server not found/);

  const referenced = await store.createProxyServer({ kind: "system", name: "Referenced" });
  await store.updateProxySettings({ defaultPolicy: `proxy:${referenced.id}` });
  await assert.rejects(store.deleteProxyServer(referenced.id), /referenced by the global default proxy/);

  const spare = await store.createProxyServer({ kind: "system", name: "Spare" });
  await store.deleteProxyServer(spare.id);
  assert.equal(store.getProxySettings().servers.some((server) => server.id === spare.id), false);
});

test("STORE the proxy default policy must name an installed server", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.updateProxySettings({ defaultPolicy: "proxy:missing" }), /references an unknown proxy server/);
});

test("STORE reviewer settings reject a non-boolean flag and an unknown feedback policy", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.updateReviewerSpecialistSettings({ enabled: "yes" }), /enabled must be a boolean/);
  await assert.rejects(store.updateReviewerSpecialistSettings({ enabled: true, feedbackPolicy: "shout" }), /feedback policy must be/);
  const updated = await store.updateReviewerSpecialistSettings({ enabled: false, feedbackPolicy: "explain" });
  assert.deepEqual(updated, { enabled: false, feedbackPolicy: "explain" });
});

test("STORE specialists reject duplicate names, oversized instructions and unknown references", async (context) => {
  const store = await loadedStore(context);
  const base: CreateSpecialistRequest = { description: "Reviews methods", instructions: "Check the method section", name: "Method Reviewer" };
  await store.createSpecialist(base);
  await assert.rejects(store.createSpecialist(base), /Specialist name already exists/);
  await assert.rejects(store.createSpecialist({ ...base, name: "Long", instructions: "x".repeat(20_001) }), /1-20000 characters/);
  await assert.rejects(store.createSpecialist({ ...base, name: "Skills", enabledSkillIds: ["no-such-skill"] }), /skills are unavailable: no-such-skill/);
  await assert.rejects(store.createSpecialist({ ...base, name: "Connectors", connectorIds: ["no-such-connector"] }), /connectors are unavailable: no-such-connector/);
  await assert.rejects(store.deleteSpecialist("missing"), /Specialist not found/);
  assert.equal(store.getSpecialist(undefined), undefined);
  assert.equal(store.getSpecialist("missing"), undefined);
});

test("STORE project and session lookups fail closed on unknown ids", async (context) => {
  const store = await loadedStore(context);
  assert.throws(() => store.getProjectSettings("missing"), /Project not found/);
  assert.throws(() => store.getSessionSettings("missing"), /Session not found/);
  assert.throws(() => store.resolveRuntimeSettings("missing"), /Session not found/);
  assert.throws(() => store.getSessionReviewerSpecialistSettings("missing"), /Session not found/);
  assert.throws(() => store.listSubagents("missing"), /Session not found/);
});

test("STORE custom connector cleanup refuses ids the store did not mint", async (context) => {
  const store = await loadedStore(context);
  await assert.rejects(store.removeCustomConnectorReferences("custom-123"), /Not a custom MCP connector/);
});
