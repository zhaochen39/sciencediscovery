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
 * Branch coverage for the settings normalizers: every persisted/partial shape
 * either normalizes, drops the bad entry, or throws with a specific message.
 * Strict mode is the write path (a bad value is rejected); loose mode is the
 * catalog-load path (a bad value falls back to its default).
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import {
  DEFAULT_IDEA_TREE_SETTINGS,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  DEFAULT_SYSTEM_QUOTA_SETTINGS,
  DEFAULT_WEB_SETTINGS,
} from "@sciencediscovery/schema";

import {
  normalizeIdeaTreeSettings,
  normalizeMcpProxyPolicies,
  normalizeMemoryGraphSettings,
  normalizeNpuDeviceSelections,
  normalizeProxyDefaultPolicy,
  normalizeProxyPolicy,
  normalizeProxyUrl,
  normalizeQuotaSettings,
  normalizeRuntimeSettings,
  normalizeTimeoutSettings,
  normalizeWebSettings,
  resolveIdeaTreeSettings,
  resolveQuotaSettings,
  withoutSkillSelection,
} from "./settings.js";

const modelIds = new Set(["model-a", "model-b"]);
const skillIds = new Set(["skill-a"]);
const connectorIds = new Set(["web", "arxiv"]);

test("runtime settings loosen unknown and invalid values on load", () => {
  assert.deepEqual(normalizeRuntimeSettings(null, modelIds, skillIds, false), {});
  assert.deepEqual(normalizeRuntimeSettings("nope", modelIds, skillIds, false), {});
  assert.deepEqual(
    normalizeRuntimeSettings({ unknown: true, modelId: "missing", semanticReviewEnabled: "yes", skillSelectionMode: "some" }, modelIds, skillIds, false),
    {},
  );
  assert.deepEqual(
    normalizeRuntimeSettings({ enabledConnectorIds: ["web", "nope", 7, "web"], enabledSkillIds: "all" }, modelIds, skillIds, false),
    { enabledConnectorIds: ["web"] },
  );
  assert.deepEqual(
    normalizeRuntimeSettings({ thinkingMode: "sometimes", thinkingEffort: "extreme", reviewThinkingEffort: "low" }, modelIds, skillIds, false),
    { reviewThinkingEffort: "low" },
  );
});

test("runtime settings accept every declared field", () => {
  const normalized = normalizeRuntimeSettings({
    defaultApprovalMode: "always_allow",
    enabledConnectorIds: ["arxiv", "web"],
    enabledSkillIds: ["skill-a"],
    modelId: "model-a",
    reviewModelId: "model-b",
    semanticReviewEnabled: true,
    skillSelectionMode: "selected",
    thinkingMode: "enabled",
    thinkingEffort: "high",
    reviewThinkingEffort: "max",
  }, modelIds, skillIds, true, connectorIds);
  assert.deepEqual(normalized, {
    defaultApprovalMode: "always_allow",
    enabledConnectorIds: ["arxiv", "web"],
    enabledSkillIds: ["skill-a"],
    modelId: "model-a",
    reviewModelId: "model-b",
    semanticReviewEnabled: true,
    skillSelectionMode: "selected",
    thinkingMode: "enabled",
    thinkingEffort: "high",
    reviewThinkingEffort: "max",
  });
});

test("runtime settings reject each malformed field in strict mode", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ unknown: 1 }, /Unknown runtime setting/],
    [{ defaultApprovalMode: "never" }, /defaultApprovalMode/],
    [{ enabledConnectorIds: "web" }, /enabledConnectorIds must be an array/],
    [{ enabledConnectorIds: ["nope"] }, /enabledConnectorIds contains an unknown value/],
    [{ enabledSkillIds: ["nope"] }, /enabledSkillIds contains an unknown value/],
    [{ enabledSkillLibraries: "lib" }, /enabledSkillLibraries must be an array/],
    [{ modelId: "missing" }, /modelId must reference/],
    [{ reviewModelId: 12 }, /reviewModelId must reference/],
    [{ semanticReviewEnabled: "yes" }, /semanticReviewEnabled must be a boolean/],
    [{ skillSelectionMode: "some" }, /skillSelectionMode must be all or selected/],
    [{ thinkingMode: "sometimes" }, /thinkingMode must be auto/],
    [{ thinkingEffort: "extreme" }, /thinkingEffort must be low/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => normalizeRuntimeSettings(value, modelIds, skillIds, true, connectorIds), pattern);
  }
  assert.throws(() => normalizeRuntimeSettings([], modelIds, skillIds, true), /must be an object/);
});

test("enabled skill libraries drop malformed entries but keep distinct valid ones", () => {
  const normalized = normalizeRuntimeSettings({
    enabledSkillLibraries: [
      "not-an-object",
      { libraryId: "  " },
      { libraryId: "lib", versionId: "  " },
      { libraryId: "lib", priority: "high" },
      { libraryId: "lib", priority: 2.5 },
      { libraryId: "lib", limit: "ten" },
      { libraryId: "lib", limit: 0 },
      { libraryId: "lib", limit: 500 },
      { libraryId: "lib", limit: 5, priority: 3 },
      { libraryId: "lib", limit: 5, priority: 3 },
      { libraryId: "lib", versionId: "v1", limit: 100 },
    ],
  }, modelIds, skillIds, false);
  assert.deepEqual(normalized.enabledSkillLibraries, [
    { libraryId: "lib", limit: 5, priority: 3 },
    { libraryId: "lib", versionId: "v1", limit: 100 },
  ]);

  assert.throws(
    () => normalizeRuntimeSettings({ enabledSkillLibraries: [{ libraryId: "lib", limit: 0 }] }, modelIds, skillIds, true),
    /limit must be between 1 and 100/,
  );
});

test("withoutSkillSelection strips only the skill selection fields", () => {
  assert.deepEqual(
    withoutSkillSelection({ enabledSkillIds: ["skill-a"], thinkingMode: "auto" }),
    { thinkingMode: "auto" },
  );
});

test("timeout settings validate shape, ranges, and the gateway ordering", () => {
  const valid = {
    gatewayIdleTimeoutMs: 1000,
    gatewayTurnTimeoutMs: 2000,
    kernelIdleTimeoutMs: 3000,
    permissionWaitTimeoutMs: 4000,
    runnerExecTimeoutMs: 5000,
  };
  assert.deepEqual(normalizeTimeoutSettings(valid), valid);
  assert.deepEqual(normalizeTimeoutSettings({ ...valid, gatewayTurnTimeoutMs: 1000 }), { ...valid, gatewayTurnTimeoutMs: 1000 });
  assert.deepEqual(normalizeTimeoutSettings({ ...valid, gatewayIdleTimeoutMs: 0, gatewayTurnTimeoutMs: 0 }), { ...valid, gatewayIdleTimeoutMs: 0, gatewayTurnTimeoutMs: 0 });

  assert.throws(() => normalizeTimeoutSettings(null), /must be an object/);
  assert.throws(() => normalizeTimeoutSettings({ ...valid, extra: 1 }), /Unknown timeout setting/);
  assert.throws(() => normalizeTimeoutSettings({ ...valid, kernelIdleTimeoutMs: -1 }), /non-negative integer/);
  assert.throws(() => normalizeTimeoutSettings({ ...valid, runnerExecTimeoutMs: 1.5 }), /non-negative integer/);
  assert.throws(() => normalizeTimeoutSettings({ ...valid, gatewayTurnTimeoutMs: 999 }), /greater than or equal/);
  assert.throws(() => normalizeTimeoutSettings({ ...valid, gatewayIdleTimeoutMs: undefined as never }), /non-negative integer/);
});

test("quota settings validate the subagent cap and byte quotas", () => {
  const valid = {
    runnerMaxOutputBytes: 10,
    runnerMaxWorkspaceBytes: 20,
    uploadMaxFileBytes: 30,
    uploadMaxRequestBytes: 40,
  };
  assert.deepEqual(normalizeQuotaSettings(valid), valid);
  assert.deepEqual(normalizeQuotaSettings({ ...valid, maxConcurrentSubagents: 10 }), { ...valid, maxConcurrentSubagents: 10 });
  assert.deepEqual(normalizeQuotaSettings({ ...valid, maxConcurrentSubagents: undefined }), valid);

  assert.throws(() => normalizeQuotaSettings([]), /must be an object/);
  assert.throws(() => normalizeQuotaSettings({ ...valid, extra: 1 }), /Unknown quota setting/);
  assert.throws(() => normalizeQuotaSettings({ ...valid, maxConcurrentSubagents: 0 }), /1 to 10/);
  assert.throws(() => normalizeQuotaSettings({ ...valid, maxConcurrentSubagents: 11 }), /1 to 10/);
  assert.throws(() => normalizeQuotaSettings({ ...valid, uploadMaxFileBytes: -1 }), /non-negative integer/);
});

test("resolveQuotaSettings fills gaps from the fallback and rejects bad shapes", () => {
  const fallback = { ...DEFAULT_SYSTEM_QUOTA_SETTINGS, maxConcurrentSubagents: 3 };
  assert.deepEqual(resolveQuotaSettings(undefined, fallback), fallback);
  assert.deepEqual(resolveQuotaSettings(null, fallback), fallback);
  assert.deepEqual(resolveQuotaSettings({ uploadMaxFileBytes: 99 }, fallback), { ...fallback, uploadMaxFileBytes: 99 });
  assert.deepEqual(resolveQuotaSettings({ maxConcurrentSubagents: 7 }, fallback), { ...fallback, maxConcurrentSubagents: 7 });
  assert.throws(() => resolveQuotaSettings(7, fallback), /must be an object/);
});

test("memory-graph settings fall back, translate, and reject malformed known fields", () => {
  assert.deepEqual(normalizeMemoryGraphSettings(undefined), DEFAULT_MEMORY_GRAPH_SETTINGS);
  assert.deepEqual(normalizeMemoryGraphSettings(null), DEFAULT_MEMORY_GRAPH_SETTINGS);
  assert.deepEqual(
    normalizeMemoryGraphSettings({ enabled: false, backend: "neo4j", neo4jHttp: " http://db:7474 ", neo4jUser: "  " }),
    { enabled: false, backend: "neo4j", neo4jHttp: "http://db:7474", neo4jUser: DEFAULT_MEMORY_GRAPH_SETTINGS.neo4jUser },
  );
  assert.deepEqual(
    normalizeMemoryGraphSettings({ backend: "local", neo4jBolt: "bolt://stale" }),
    { ...DEFAULT_MEMORY_GRAPH_SETTINGS, backend: "local" },
  );
  assert.throws(() => normalizeMemoryGraphSettings([]), /must be an object/);
  assert.throws(() => normalizeMemoryGraphSettings({ backend: "bolt" }), /local.*neo4j/);
  assert.throws(() => normalizeMemoryGraphSettings({ neo4jHttp: "x".repeat(8_193) }), /too long/);
  assert.throws(() => normalizeMemoryGraphSettings({ neo4jUser: "u".repeat(513) }), /too long/);
});

test("web settings reject each malformed field", () => {
  const base = {
    fetchCacheTtlSeconds: 86_400,
    fetchProvider: "jina",
    proxyPolicy: "inherit",
    searchCacheTtlSeconds: 3_600,
  };
  assert.deepEqual(normalizeWebSettings(base), { ...DEFAULT_WEB_SETTINGS, ...base });
  assert.throws(() => normalizeWebSettings("x"), /must be an object/);
  assert.throws(() => normalizeWebSettings({ ...base, unknown: 1 }), /Unknown web setting/);
  assert.throws(() => normalizeWebSettings({ ...base, deepseekEnabled: "yes" }), /deepseekEnabled must be a boolean/);
  assert.throws(() => normalizeWebSettings({ ...base, fetchProvider: "bing" }), /Unsupported web fetch provider/);
  assert.throws(() => normalizeWebSettings({ ...base, paidSearchProviders: "tavily" }), /paidSearchProviders must list/);
  assert.throws(() => normalizeWebSettings({ ...base, paidSearchProviders: ["nope"] }), /paidSearchProviders must list/);
  assert.throws(() => normalizeWebSettings({ ...base, freeSearchEngines: 1 }), /freeSearchEngines must be an object/);
  assert.throws(() => normalizeWebSettings({ ...base, freeSearchEngines: { bing: true, unknown: true } }), /Unknown free search engine/);
  assert.throws(() => normalizeWebSettings({ ...base, freeSearchEngines: { bing: "yes" } }), /bing must be a boolean/);
  assert.throws(() => normalizeWebSettings({ ...base, searchCacheTtlSeconds: -1 }), /searchCacheTtlSeconds/);
  assert.throws(() => normalizeWebSettings({ ...base, fetchCacheTtlSeconds: 30 * 24 * 60 * 60 + 1 }), /fetchCacheTtlSeconds/);
});

test("web settings canonicalize paid providers and default absent tiers", () => {
  const base = {
    fetchCacheTtlSeconds: 1,
    fetchProvider: "exa",
    searchCacheTtlSeconds: 2,
  };
  const normalized = normalizeWebSettings({ ...base, paidSearchProviders: ["tavily", "exa"], freeSearchEngines: { bing: true } });
  assert.deepEqual(normalized.paidSearchProviders, ["tavily", "exa"]);
  assert.equal(normalized.freeSearchEngines.bing, true);
  assert.equal(normalized.freeSearchEngines.duckduckgo, DEFAULT_WEB_SETTINGS.freeSearchEngines.duckduckgo);
  assert.equal(normalized.proxyPolicy, "inherit");
  assert.equal(normalized.deepseekEnabled, false);
});

test("proxy URLs accept http, https, and socks5 and reject everything else", () => {
  assert.equal(normalizeProxyUrl(" http://127.0.0.1:7890 "), "http://127.0.0.1:7890/");
  assert.equal(normalizeProxyUrl("socks5://proxy.local:1080"), "socks5://proxy.local:1080");
  assert.throws(() => normalizeProxyUrl("   "), /cannot be empty/);
  assert.throws(() => normalizeProxyUrl(`http://${"a".repeat(8_200)}`), /too long/);
  assert.throws(() => normalizeProxyUrl("not a url"), /invalid/);
  assert.throws(() => normalizeProxyUrl("ftp://proxy.local"), /http, https, or socks5/);
  assert.throws(() => normalizeProxyUrl("http://proxy.local#frag"), /fragment/);
});

test("proxy policies accept the closed vocabulary and reject malformed ids", () => {
  assert.equal(normalizeProxyPolicy("inherit", "p"), "inherit");
  assert.equal(normalizeProxyPolicy("none", "p"), "none");
  assert.equal(normalizeProxyPolicy("proxy:corp", "p"), "proxy:corp");
  assert.throws(() => normalizeProxyPolicy(1, "p"), /must be a string/);
  assert.throws(() => normalizeProxyPolicy("proxy:", "p"), /inherit, none/);
  assert.throws(() => normalizeProxyPolicy(`proxy:${"x".repeat(201)}`, "p"), /inherit, none/);
  assert.throws(() => normalizeProxyPolicy("corp", "p"), /inherit, none/);

  assert.equal(normalizeProxyDefaultPolicy("none"), "none");
  assert.throws(() => normalizeProxyDefaultPolicy("inherit"), /must be none or proxy/);

  assert.deepEqual(normalizeMcpProxyPolicies({ corp: "proxy:corp", plain: "inherit", direct: "none" }), {
    corp: "proxy:corp",
    direct: "none",
  });
  assert.throws(() => normalizeMcpProxyPolicies([]), /must be an object/);
  assert.throws(() => normalizeMcpProxyPolicies({ "  ": "none" }), /1-200 characters/);
  assert.throws(() => normalizeMcpProxyPolicies({ bad: "wat" }), /policies.bad/);
});

test("NPU device selections drop malformed entries and sort the rest", () => {
  assert.deepEqual(normalizeNpuDeviceSelections(null), {});
  assert.deepEqual(normalizeNpuDeviceSelections([]), {});
  assert.deepEqual(normalizeNpuDeviceSelections("nope"), {});
  assert.deepEqual(
    normalizeNpuDeviceSelections({ a: [3, 1, 3, -1, 1024, 1.5, "2"], " ": [0], b: "0", c: [] }),
    { a: [1, 3] },
  );
});

test("idea tree updates reject retired fields and out-of-range numbers", () => {
  const current = { ...DEFAULT_IDEA_TREE_SETTINGS };
  assert.throws(() => normalizeIdeaTreeSettings({ maxRounds: 3 }, current), /configured by the selected template/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxDepth: 0 }, current), /maxDepth must be between/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxDepth: 21 }, current), /maxDepth must be between/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxDepth: 1.5 }, current), /maxDepth must be an integer/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxNodes: 1 }, current), /maxNodes must be between/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxTokensPerCall: 255 }, current), /maxTokensPerCall must be between/);
  assert.throws(() => normalizeIdeaTreeSettings({ maxTokens: 0 }, current), /maxTokens must be between/);
});

test("idea tree updates keep omitted fields, clear transient limits, and trim prompts", () => {
  const current = { ...DEFAULT_IDEA_TREE_SETTINGS, maxTokens: 4000, designSystemPrompt: "old" };
  assert.deepEqual(normalizeIdeaTreeSettings({}, current), current);
  assert.equal(normalizeIdeaTreeSettings({ maxTokens: null }, current).maxTokens, null);
  const updated = normalizeIdeaTreeSettings({
    templateId: "water-treatment-materials/v1",
    explorationIntensity: "deep",
    maxDepth: 7,
    maxNodes: 9,
    scoreDirection: "minimize",
    designSystemPrompt: "  new design  ",
    aggregatorSystemPrompt: "   ",
    propagateInsightSystemPrompt: "insight",
    roleThinkingEfforts: { ideate: "low", design: null, assess: "max" },
  }, current);
  assert.equal(updated.templateId, "water-treatment-materials/v1");
  assert.equal(updated.explorationIntensity, "deep");
  assert.equal(updated.maxDepth, 7);
  assert.equal(updated.maxNodes, 9);
  assert.equal(updated.scoreDirection, "minimize");
  assert.equal(updated.designSystemPrompt, "new design");
  assert.equal(updated.aggregatorSystemPrompt, undefined);
  assert.equal(updated.propagateInsightSystemPrompt, "insight");
  assert.deepEqual(updated.roleThinkingEfforts, { ideate: "low", assess: "max" });
  assert.equal(normalizeIdeaTreeSettings({ scoreDirection: "sideways" }, current).scoreDirection, current.scoreDirection);
});

test("idea tree role efforts reject unknown stages and levels on write", () => {
  const current = { ...DEFAULT_IDEA_TREE_SETTINGS };
  assert.throws(() => normalizeIdeaTreeSettings({ roleThinkingEfforts: [] }, current), /must be an object/);
  assert.throws(() => normalizeIdeaTreeSettings({ roleThinkingEfforts: { unknown: "low" } }, current), /unknown stage/);
  assert.throws(() => normalizeIdeaTreeSettings({ roleThinkingEfforts: { ideate: "extreme" } }, current), /must be low/);
  assert.equal(normalizeIdeaTreeSettings({ roleThinkingEfforts: {} }, current).roleThinkingEfforts, undefined);
});

test("resolveIdeaTreeSettings fills defaults and drops stale values", () => {
  assert.deepEqual(resolveIdeaTreeSettings(undefined), DEFAULT_IDEA_TREE_SETTINGS);
  assert.deepEqual(resolveIdeaTreeSettings(null), DEFAULT_IDEA_TREE_SETTINGS);
  assert.throws(() => resolveIdeaTreeSettings(7), /must be an object/);
  const resolved = resolveIdeaTreeSettings({
    templateId: "water-treatment-materials/v1",
    explorationIntensity: "quick",
    maxTokens: 100,
    maxTokensPerCall: 512,
    maxDepth: 3,
    maxNodes: 20,
    scoreDirection: "minimize",
    designSystemPrompt: "  design ",
    aggregatorSystemPrompt: "   ",
    roleThinkingEfforts: { ideate: "low", design: "extreme", unknown: "max" },
  });
  assert.equal(resolved.templateId, "water-treatment-materials/v1");
  assert.equal(resolved.explorationIntensity, "quick");
  assert.equal(resolved.maxTokens, 100);
  assert.equal(resolved.maxTokensPerCall, 512);
  assert.equal(resolved.maxDepth, 3);
  assert.equal(resolved.maxNodes, 20);
  assert.equal(resolved.scoreDirection, "minimize");
  assert.equal(resolved.designSystemPrompt, "design");
  assert.equal(resolved.aggregatorSystemPrompt, undefined);
  assert.deepEqual(resolved.roleThinkingEfforts, { ideate: "low" });
  assert.deepEqual(
    resolveIdeaTreeSettings({ templateId: "other", explorationIntensity: "extreme", scoreDirection: "up" }),
    DEFAULT_IDEA_TREE_SETTINGS,
  );
});
