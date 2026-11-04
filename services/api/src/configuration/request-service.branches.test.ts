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
 * Branch coverage for ConfigurationRequestService: scope membership, the
 * writability/version guards around every lifecycle transition, adapter plan
 * validation, and the terminal phases a verification or apply can produce.
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ConfigurationRequestService } from "./request-service.js";
import { ConfigurationRepository } from "./repository.js";
import { ConfigurationRegistry } from "./registry.js";
import type { ConfigurationAdapter, ConfigurationHost, ConfigurationSnapshot } from "./types.js";
import { object, string } from "./validation.js";

type HarnessOptions = {
  verify?: ConfigurationAdapter["verify"];
  credential?: boolean;
  choiceOptions?: ConfigurationHost["choiceOptions"];
  preview?: ConfigurationAdapter["preview"];
  scopes?: ConfigurationAdapter["scopes"];
};

function harness(options: HarnessOptions = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE domain_settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO domain_settings VALUES (1, '[]')");
  const repo = new ConfigurationRepository(db);
  let generation = 0; let version = 0; let writes = 0; let writable = true;
  const snapshot = (): ConfigurationSnapshot => ({ projectId: "project", stopGeneration: generation, writable, resourceVersions: { settings: String(version), parent: "v1", credential: "generation-1" }, data: {} });
  const adapter: ConfigurationAdapter = {
    id: "connector.enable", version: 1, schemaVersion: 1, scopes: options.scopes ?? ["session"], persistence: "local_transaction",
    normalize(input) { const value = object(input, ["connectorId"], "values"); return { connectorId: string(value.connectorId, "connectorId") }; },
    target(input) { return String(input.connectorId); },
    preview(input, context) { return {
      ready: true,
      fields: [
        { id: "connectorId", label: "Connector", required: true, kind: "text" as const, value: string(input.connectorId, "connectorId") },
        ...(options.credential ? [{ id: "apiKey", label: "API key", required: true, kind: "credential" as const, status: "missing" as const }] : []),
      ],
      changes: [{ field: "connectors", after: String(input.connectorId) }],
      impact: { resourceLocation: "Catalog", effectiveScope: "Session", message: "Keep other connectors" },
      verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false },
      activationMode: context.runId ? "same_run" : "next_run",
      data: { privateRef: "do-not-project" },
    }; },
    verify: options.verify,
    apply(context) {
      db.prepare("UPDATE domain_settings SET value = ? WHERE id = 1").run(JSON.stringify(["existing", context.input.connectorId]));
      writes++; version++; return { resourceRevision: String(version), summary: "Enabled" };
    },
    previewReversal() { return { connectorId: "previous" }; },
  };
  if (options.preview) adapter.preview = options.preview;
  let queue: Promise<unknown> = Promise.resolve();
  const host: ConfigurationHost = {
    snapshot,
    choiceOptions: options.choiceOptions,
    runInTransaction<T>(_sessionId: string, action: () => T): Promise<T> {
      const operation = queue.then(() => { const oldVersion = version; const oldWrites = writes; try { return repo.transaction(action); } catch (error) { version = oldVersion; writes = oldWrites; throw error; } });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
  const registry = new ConfigurationRegistry().register(adapter);
  const service = new ConfigurationRequestService({ repository: repo, registry, host });
  return { db, repo, service, registry, host, adapter, get writes() { return writes; }, stop() { generation++; }, changeVersion() { version++; }, archive() { writable = false; } };
}

const proposal = { capabilityId: "connector.enable" as const, values: { connectorId: "pubmed" }, runId: "run-1" };
const choiceOptions = () => [
  { id: "save", kind: "persisted_apply" as const, label: "Save for session", description: "Enable the installed connector for the session.", available: true },
  { id: "run-only", kind: "run_overlay" as const, label: "Use for this task", description: "Leave all saved settings unchanged.", available: true },
  { id: "use-web", kind: "alternative" as const, label: "Use Web search", description: "Use the available Web search source; results may differ from PubMed.", available: true, alternativeId: "web_search" },
  { id: "dismiss", kind: "dismiss" as const, label: "Do not configure", description: "Continue without changing settings.", available: true },
];

const planPreview = (patch: Record<string, unknown>): ConfigurationAdapter["preview"] => (() => ({
  ready: true,
  fields: [{ id: "connectorId", label: "Connector", required: true, kind: "text", value: "pubmed" }],
  changes: [{ field: "connectors", after: "pubmed" }],
  impact: { resourceLocation: "Catalog", effectiveScope: "Session", message: "Keep other connectors" },
  verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false },
  activationMode: "next_run",
  ...patch,
})) as unknown as ConfigurationAdapter["preview"];

test("CFG branch: scope membership and session writability are checked before any record is stored", async () => {
  const h = harness({ scopes: ["session", "project", "global"] });
  try {
    await assert.rejects(h.service.propose("session", { ...proposal, scope: { kind: "global", id: "x" } }), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.propose("session", { ...proposal, scope: { kind: "run" } as never }), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.propose("session", { ...proposal, scope: { kind: "session", id: "other" } }), { code: "CONFIGURATION_FORBIDDEN" });
    await assert.rejects(h.service.propose("session", { ...proposal, scope: { kind: "project", id: "other" } }), { code: "CONFIGURATION_FORBIDDEN" });
    const projected = await h.service.propose("session", { ...proposal, scope: { kind: "project", id: "project" } });
    assert.equal(projected.scope.kind, "project");
    h.archive();
    await assert.rejects(h.service.propose("session", proposal), { code: "SESSION_NOT_WRITABLE" });
  } finally { h.db.close(); }
});

test("CFG branch: an expired proposal reconciles to a terminal state and suppresses its outbox", async () => {
  const h = harness();
  try {
    const view = await h.service.propose("session", proposal);
    const record = h.service.getRecord("session", view.id);
    record.view.expiresAt = new Date(Date.now() - 60_000).toISOString();
    h.repo.save(record, record.view.stateVersion);
    h.repo.enqueueOutbox({ id: "expired-phase", requestId: view.id, revision: 1, sessionId: "session", kind: "activate", state: "pending", payload: {}, createdAt: "now", updatedAt: "now" });
    const changed = await h.service.reconcileLifecycle("session");
    assert.deepEqual(changed.map((item) => item.state), ["expired"]);
    assert.equal(h.repo.listOutbox()[0]?.state, "suppressed");
    await assert.rejects(h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "CONFIGURATION_EXPIRED" });
  } finally { h.db.close(); }
});

test("CFG branch: decide refuses unknown decisions and stale resources or adapters", async () => {
  const h = harness();
  try {
    const view = await h.service.propose("session", proposal);
    await assert.rejects(h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "maybe" as never }), { code: "INVALID_CONFIGURATION_INPUT" });
    const upgraded = new ConfigurationRegistry().register({ ...h.adapter, version: 2 });
    const restarted = new ConfigurationRequestService({ repository: h.repo, registry: upgraded, host: h.host });
    await assert.rejects(restarted.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "STALE_CONFIGURATION_PREVIEW" });
    h.changeVersion();
    await assert.rejects(h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "RESOURCE_VERSION_CONFLICT" });
  } finally { h.db.close(); }
});

test("CFG branch: preview rejects stale revisions and impossible option or credential combinations", async () => {
  const h = harness({ credential: true, choiceOptions });
  try {
    const view = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
    await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 2, values: proposal.values }), { code: "STALE_CONFIGURATION_PREVIEW" });
    await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: 7 as never }), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, credentialHandle: 7 as never }), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 1, values: { connectorId: "arxiv" }, credentialHandle: "handle" }), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "run-only", credentialHandle: "handle" }), { code: "CONFIGURATION_OPTION_UNAVAILABLE" });
  } finally { h.db.close(); }

  const v2 = harness();
  try {
    const view = await v2.service.propose("session", proposal);
    await assert.rejects(v2.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "save" }), { code: "INVALID_CONFIGURATION_INPUT" });
  } finally { v2.db.close(); }

  const runless = harness({ choiceOptions });
  try {
    const view = await runless.service.propose("session", { ...proposal, runId: undefined, protocolVersion: 3 });
    await assert.rejects(runless.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "run-only" }), { code: "CONFIGURATION_OPTION_UNAVAILABLE" });
  } finally { runless.db.close(); }

  const collision = harness();
  try {
    await collision.service.propose("session", proposal);
    const second = await collision.service.propose("session", { ...proposal, values: { connectorId: "arxiv" } });
    await assert.rejects(collision.service.preview("session", second.id, { expectedRevision: 1, values: proposal.values }), { code: "ACTIVE_CONFIGURATION_CONFLICT" });
  } finally { collision.db.close(); }
});

test("CFG branch: the adapter preview is validated field by field", async () => {
  const rejected: Array<[Record<string, unknown>, RegExp]> = [
    [{ verificationPlan: { targets: ["not a url"], actions: [], maxRequests: 0, mayCharge: false } }, /Invalid verification target/],
    [{ verificationPlan: { targets: ["ftp://host/x"], actions: [], maxRequests: 0, mayCharge: false } }, /credentials or query data/],
    [{ verificationPlan: { targets: ["https://user:pass@host/x"], actions: [], maxRequests: 0, mayCharge: false } }, /credentials or query data/],
    [{ verificationPlan: { targets: ["https://host/x?q=1"], actions: [], maxRequests: 0, mayCharge: false } }, /credentials or query data/],
    [{ verificationPlan: { targets: ["https://host/x#frag"], actions: [], maxRequests: 0, mayCharge: false } }, /credentials or query data/],
    [{ verificationPlan: { targets: [], actions: Array.from({ length: 9 }, () => "ping"), maxRequests: 0, mayCharge: false } }, /Invalid verification plan/],
    [{ verificationPlan: { targets: [], actions: [], maxRequests: 11, mayCharge: false } }, /budget exceeds/],
    [{ verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: "yes" } }, /Invalid verification plan/],
    [{ ready: "yes" }, /budget exceeds/],
    [{ activationMode: "whenever" }, /Invalid activation mode/],
    [{ changes: Array.from({ length: 101 }, (_value, index) => ({ field: `f${index}`, after: "x" })) }, /Too many changes/],
  ];
  for (const [patch, pattern] of rejected) {
    const h = harness({ preview: planPreview(patch) });
    try { await assert.rejects(h.service.propose("session", proposal), pattern); } finally { h.db.close(); }
  }

  const noChange = harness({ preview: planPreview({ disposition: "no_change" }) });
  try { await assert.rejects(noChange.service.propose("session", proposal), { code: "CONFIGURATION_NO_CHANGE" }); } finally { noChange.db.close(); }

  const missing = harness({ preview: planPreview({ ready: false }) });
  try {
    const view = await missing.service.propose("session", proposal);
    assert.equal(view.state, "collecting_input");
    assert.equal(view.allowedActions.includes("apply"), false);
  } finally { missing.db.close(); }

  const restart = harness({ preview: planPreview({ activationMode: "requires_restart", verificationPlan: { targets: ["https://host/status"], actions: ["ping"], maxRequests: 3, mayCharge: true } }) });
  try {
    const view = await restart.service.propose("session", proposal);
    assert.equal(view.activation.mode, "requires_restart");
    assert.deepEqual(view.verificationPlan.targets, ["https://host/status"]);
    assert.equal(view.verificationPlan.mayCharge, true);
  } finally { restart.db.close(); }
});

test("CFG branch: propose enforces protocol versions, capability registration, and the resource baseline", async () => {
  const h = harness();
  try {
    await assert.rejects(h.service.propose("session", { ...proposal, protocolVersion: 2 } as never), { code: "INVALID_CONFIGURATION_INPUT" });
    await assert.rejects(h.service.propose("session", { capabilityId: "skill.select", values: {} } as never), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
    await assert.rejects(h.service.propose("session", { ...proposal, capabilityId: "not.registered" as never }), { code: "CONFIGURATION_CAPABILITY_UNAVAILABLE" });
    await assert.rejects(h.service.propose("session", proposal, undefined, { settings: "9" }), { code: "RESOURCE_VERSION_CONFLICT" });
    const view = await h.service.propose("session", proposal);
    await assert.rejects(h.service.propose("session", { ...proposal, protocolVersion: 3 }), { code: "CONFIGURATION_PROTOCOL_CONFLICT" });
    const replay = await h.service.propose("session", proposal, "same-key");
    assert.equal(replay.id, view.id);
  } finally { h.db.close(); }
});

test("CFG branch: verification-time guard failures land in cancelled, expired, and stale states", async () => {
  const modes = ["archive", "expire", "version"] as const;
  const expected = { archive: ["cancelled", "SESSION_NOT_WRITABLE"], expire: ["expired", "CONFIGURATION_EXPIRED"], version: ["stale", "RESOURCE_VERSION_CONFLICT"] } as const;
  for (const mode of modes) {
    const h = harness({ verify: async () => {
      if (mode === "archive") h.archive();
      if (mode === "version") h.changeVersion();
      if (mode === "expire") {
        const record = h.service.getRecord("session", h.service.list("session")[0]!.id);
        record.view.expiresAt = new Date(Date.now() - 60_000).toISOString();
        h.repo.save(record, record.view.stateVersion);
      }
      return { ok: true };
    } });
    try {
      const view = await h.service.propose("session", proposal);
      const result = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
      assert.equal(result.state, expected[mode][0]);
      assert.equal(result.error?.code, expected[mode][1]);
      assert.equal(result.activation.state, mode === "version" ? "not_requested" : "suppressed");
    } finally { h.db.close(); }
  }
});

test("CFG branch: verification results and apply strategies drive the terminal phase", async () => {
  const failing = harness({ verify: async () => ({ ok: false, code: "BAD_CONNECTION", message: "Refused", field: "connectorId", retryable: true }) });
  try {
    const view = await failing.service.propose("session", proposal);
    const result = await failing.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(result.state, "needs_fix");
    assert.deepEqual(result.error, { code: "BAD_CONNECTION", message: "Refused", field: "connectorId", retryable: true });
  } finally { failing.db.close(); }

  const external = harness();
  const externalRegistry = new ConfigurationRegistry().register({ ...external.adapter, persistence: "external_control", apply: undefined });
  const externalService = new ConfigurationRequestService({ repository: external.repo, registry: externalRegistry, host: external.host });
  try {
    const view = await externalService.propose("session", proposal);
    const result = await externalService.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(result.state, "applying");
    assert.equal(external.repo.listOutbox()[0]?.kind, "external_submit");
    assert.equal(external.writes, 0);
  } finally { external.db.close(); }

  const noApply = harness();
  delete (noApply.adapter as { apply?: unknown }).apply;
  try {
    const view = await noApply.service.propose("session", proposal);
    const result = await noApply.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(result.state, "failed");
    assert.equal(result.error?.code, "CONFIGURATION_APPLY_FAILED");
    assert.equal(result.error?.retryable, true);
  } finally { noApply.db.close(); }
});

test("CFG branch: allowed actions and projections follow the terminal state", async () => {
  const h = harness();
  try {
    const view = await h.service.propose("session", proposal);
    const applied = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.deepEqual(applied.allowedActions, ["reversal", "continue"]);
    const record = h.service.getRecord("session", view.id);
    record.view.resumption.state = "completed";
    h.repo.save(record, record.view.stateVersion);
    assert.deepEqual(h.service.get("session", view.id).allowedActions, ["reversal"]);
    record.view.state = "validating";
    h.repo.save(record, record.view.stateVersion);
    assert.deepEqual(h.service.get("session", view.id).allowedActions, ["query"]);
  } finally { h.db.close(); }

  const noReversal = harness();
  delete (noReversal.adapter as { previewReversal?: unknown }).previewReversal;
  try {
    const view = await noReversal.service.propose("session", proposal);
    const applied = await noReversal.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.deepEqual(applied.allowedActions, ["continue"]);
  } finally { noReversal.db.close(); }

  const v3 = harness({ choiceOptions });
  try {
    const view = await v3.service.propose("session", { ...proposal, protocolVersion: 3 });
    const chosen = await v3.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "dismiss" });
    const dismissed = await v3.service.decide("session", view.id, { revision: 2, previewDigest: chosen.previewDigest!, selectedOptionId: "dismiss", decision: "dismiss" });
    assert.equal(dismissed.protocolVersion, 3);
    assert.equal(dismissed.selectedOptionId, "dismiss");
    assert.equal(dismissed.choiceReceipt?.kind, "dismiss");
    assert.deepEqual(dismissed.allowedActions, []);
    const record = v3.service.getRecord("session", view.id);
    record.view.error = { code: "CONFIGURATION_APPLY_FAILED", message: "m", field: "connectorId", retryable: true };
    record.view.activation.effectiveRevision = 2;
    record.view.resumption.runId = "run-1";
    record.view.decisionSource = "user";
    v3.repo.save(record, record.view.stateVersion);
    const projected = v3.service.get("session", view.id);
    assert.equal(projected.error?.field, "connectorId");
    assert.equal(projected.activation.effectiveRevision, 2);
    assert.equal(projected.resumption.runId, "run-1");
    assert.equal(projected.decisionSource, "user");
  } finally { v3.db.close(); }
});

test("CFG branch: terminal decisions replay instead of writing twice", async () => {
  const h = harness();
  try {
    const view = await h.service.propose("session", proposal);
    const input = { revision: 1, previewDigest: view.previewDigest!, decision: "apply" as const };
    assert.equal((await h.service.decide("session", view.id, input)).state, "applied");
    assert.equal((await h.service.decide("session", view.id, input)).state, "applied");
    assert.equal(h.writes, 1);
    const record = h.service.getRecord("session", view.id);
    record.view.state = "validating";
    h.repo.save(record, record.view.stateVersion);
    assert.equal((await h.service.decide("session", view.id, input)).state, "validating");
  } finally { h.db.close(); }

  const dismissed = harness();
  try {
    const view = await dismissed.service.propose("session", proposal);
    const input = { revision: 1, previewDigest: view.previewDigest!, decision: "dismiss" as const };
    assert.equal((await dismissed.service.decide("session", view.id, input)).state, "dismissed");
    assert.equal((await dismissed.service.decide("session", view.id, input)).state, "dismissed");
    assert.equal(dismissed.writes, 0);
  } finally { dismissed.db.close(); }
});

test("CFG branch: reversal requires an applied receipt and honours the connector baseline", async () => {
  const h = harness();
  try {
    const view = await h.service.propose("session", proposal);
    await assert.rejects(h.service.reversal("session", view.id), { code: "CONFIGURATION_REVERSAL_UNAVAILABLE" });
    const applied = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(applied.state, "applied");
    h.changeVersion();
    await assert.rejects(h.service.reversal("session", view.id), { code: "RESOURCE_VERSION_CONFLICT" });
  } finally { h.db.close(); }
});
