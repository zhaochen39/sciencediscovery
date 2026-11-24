// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { TokenEstimator } from "./token-estimator.js";

export interface ScopeProjectionOptions<TMessage extends RuntimeMessage = RuntimeMessage> {
  /** Collect detailed verified-stage decisions for private context traces. */
  diagnostics?: boolean;
  /** Maximum size of the structured node memory sent back to the model. */
  maxMemoryCharacters?: number;
  /** Number of recent wire messages retained after projection. */
  retainRecentMessages?: number;
  /** Stable node identity recorded in the projection. */
  nodeId?: string;
  /** Provider-neutral token estimator used for trace metrics. */
  estimator?: TokenEstimator<TMessage>;
  /** Minimum source tokens before projection is considered. */
  minSourceTokensForProjection?: number;
  /** Minimum estimated token savings before projection is applied. */
  minEstimatedSavingsTokens?: number;
  /** Minimum estimated percentage savings before projection is applied. */
  minEstimatedSavingsPercent?: number;
  /** Maximum low-priority facts retained in Node Memory. */
  maxFacts?: number;
  /** Maximum low-priority obligations retained in Node Memory. */
  maxObligations?: number;
}

export interface ScopeNodeMemory {
  nodeId: string;
  sourceMessageCount: number;
  retainedMessageCount: number;
  completedToolNames: string[];
  completedToolCalls: number;
  failedToolCalls: number;
  artifacts: string[];
  requiredArtifacts: string[];
  facts: string[];
  obligations: string[];
  completedStages: number[];
  completionState: "in_progress" | "ready";
}

export type StageProjectionDecision = {
  stageId: string;
  reason: "candidate" | "result_missing" | "result_ambiguous" | "recent_result" | "unsupported_result"
    | "source_digest_mismatch" | "unmatched_call" | "memory_budget" | "no_token_savings";
  originalTokens?: number;
  memoryTokens?: number;
};

export interface ScopeProjectionTrace {
  nodeId: string;
  sourceMessageCount: number;
  projectedMessageCount: number;
  removedMessageCount: number;
  sourceTokens: number;
  projectedTokens: number;
  completedToolCount: number;
  artifactCount: number;
  factCount: number;
  obligationCount: number;
  candidateProjectedTokens: number;
  estimatedSavingsTokens: number;
  estimatedSavingsPercent: number;
  applied: boolean;
  verifiedStageIds?: string[];
  preferredStageProjection?: boolean;
  preferredStageSkipReason?: ScopeProjectionTrace["skipReason"];
  stageDiagnostics?: {
    state: "unavailable" | "invalid" | "captured";
    receivedClosures: number;
    validClosures: number;
    stages: StageProjectionDecision[];
  };
  skipReason?: "no_verified_stage" | "short_history" | "below_source_threshold" | "below_savings_threshold" | "below_savings_percent" | "memory_budget";
}

export interface ScopeProjectionResult<TMessage extends RuntimeMessage = RuntimeMessage> {
  history: TMessage[];
  memory: ScopeNodeMemory;
  trace: ScopeProjectionTrace;
}

function visibleText(message: RuntimeMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
  }).join(" ");
}

function toolNames(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== "object") return [];
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function shorten(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function collectFacts(messages: readonly RuntimeMessage[], limit: number): string[] {
  const values = messages.flatMap((message) => {
    const text = visibleText(message);
    if (!text) return [];
    return text.split(/[\r\n]+/u)
      .map((line) => shorten(line, 220))
      .filter((line) => line.length >= 12);
  });
  return unique(values).slice(0, limit);
}

function collectObligations(messages: readonly RuntimeMessage[], limit: number): string[] {
  const markers = /(?:TODO|next|remaining|must|未完成|下一步|待处理|需要)/iu;
  const values = messages.flatMap((message) => visibleText(message).split(/[\r\n]+/u))
    .map((line) => shorten(line, 220))
    .filter((line) => markers.test(line));
  return limit === 0 ? [] : unique(values).slice(-limit);
}

function collectArtifacts(messages: readonly RuntimeMessage[]): string[] {
  const values = messages.flatMap((message) => visibleText(message).match(/(?:[\w./-]+\.(?:csv|json|md|tsv|txt|png|pdf))/giu) ?? []);
  return unique(values);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : fallback;
}

function percentage(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value!) : fallback;
}

function collectStages(messages: readonly RuntimeMessage[]): number[] {
  const values = messages.flatMap((message) => {
    const text = visibleText(message);
    return [...text.matchAll(/\b(?:phase|stage|阶段)\s*[-#:]?\s*(\d+)\b/giu)].map((match) => Number(match[1]));
  });
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function completedToolCallCount(messages: readonly RuntimeMessage[]): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const text = visibleText(message);
    if ( /"state"\s*:\s*"completed"/iu.test(text)) completed += 1;
    if ( /"state"\s*:\s*"failed"/iu.test(text)) failed += 1;
  }
  return { completed, failed };
}

function requiredArtifacts(messages: readonly RuntimeMessage[]): string[] {
  return collectArtifacts(messages.filter((message) => message.role === "user"));
}

function completionState(artifacts: readonly string[], toolCalls: { completed: number; failed: number }): "in_progress" | "ready" {
  const hasFinalReport = artifacts.some((artifact) => /(?:^|[/\\])final_report\.md$/iu.test(artifact));
  return hasFinalReport && toolCalls.completed > 0 && toolCalls.failed === 0 ? "ready" : "in_progress";
}

function estimateMessages<TMessage extends RuntimeMessage>(
  messages: readonly TMessage[],
  estimator: TokenEstimator<TMessage> | undefined,
): number {
  if (estimator) return messages.reduce((total, message) => total + estimator.estimateMessage(message), 0);
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 2));
}

function memoryMessage<TMessage extends RuntimeMessage>(memory: ScopeNodeMemory): TMessage {
  const content = [
    `<scope_node_memory node_id="${memory.nodeId}">`,
    `source_message_count=${memory.sourceMessageCount}`,
    `completed_tools=${memory.completedToolNames.join(", ") || "none"}`,
    `completed_tool_calls=${memory.completedToolCalls}`,
    `failed_tool_calls=${memory.failedToolCalls}`,
    `artifacts=${memory.artifacts.join(", ") || "none"}`,
    `required_artifacts=${memory.requiredArtifacts.join(", ") || "none"}`,
    `completed_stages=${memory.completedStages.join(", ") || "none"}`,
    `completion_state=${memory.completionState}`,
    "facts:",
    ...(memory.facts.length ? memory.facts.map((fact) => `- ${fact}`) : ["- none"]),
    "obligations:",
    ...(memory.obligations.length ? memory.obligations.map((item) => `- ${item}`) : ["- none"]),
    "</scope_node_memory>",
  ].join("\n");
  return {
    role: "user",
    content,
    additional_kwargs: {
      context_contributor_message: true,
      hide_from_ui: true,
      scope_node_memory: true,
      scope_node_id: memory.nodeId,
    },
  } as unknown as TMessage;
}

/**
 * Deterministic first-version Scope Projection.
 *
 * The canonical transcript remains owned by the runtime. This function only
 * builds the model-visible history and a compact Node Memory for the current
 * scope. It intentionally uses bounded extraction rather than an extra model
 * call so the first value experiment can attribute changes to context layout.
 */
export function projectScopeHistory<TMessage extends RuntimeMessage>(
  history: readonly TMessage[],
  options: ScopeProjectionOptions<TMessage> = {},
): ScopeProjectionResult<TMessage> {
  const nodeId = options.nodeId ?? "main";
  const retainRecentMessages = Math.max(2, Math.trunc(options.retainRecentMessages ?? 6));
  const maxMemoryCharacters = Math.max(800, Math.trunc(options.maxMemoryCharacters ?? 6_000));
  const minSourceTokensForProjection = nonNegativeInteger(options.minSourceTokensForProjection, 0);
  const minEstimatedSavingsTokens = nonNegativeInteger(options.minEstimatedSavingsTokens, 0);
  const minEstimatedSavingsPercent = percentage(options.minEstimatedSavingsPercent, 0);
  const maxFacts = nonNegativeInteger(options.maxFacts, 8);
  const maxObligations = nonNegativeInteger(options.maxObligations, 5);
  const source = history.map((message) => structuredClone(message));
  const sourceTokens = estimateMessages(source, options.estimator);
  const mentionedArtifacts = collectArtifacts(source);
  const required = requiredArtifacts(source);
  const toolCalls = completedToolCallCount(source);
  const stages = collectStages(source);

  const buildMemory = (retainedMessageCount: number, facts: string[], obligations: string[]): ScopeNodeMemory => ({
    nodeId,
    sourceMessageCount: source.length,
    retainedMessageCount,
    completedToolNames: unique(source.flatMap(toolNames)),
    completedToolCalls: toolCalls.completed,
    failedToolCalls: toolCalls.failed,
    artifacts: mentionedArtifacts,
    requiredArtifacts: required,
    facts,
    obligations,
    completedStages: stages,
    completionState: completionState(mentionedArtifacts, toolCalls),
  });

  const baseTrace = (memory: ScopeNodeMemory, projectedTokens: number, candidateProjectedTokens: number, applied: boolean, skipReason?: ScopeProjectionTrace["skipReason"]): ScopeProjectionTrace => {
    const estimatedSavingsTokens = sourceTokens - candidateProjectedTokens;
    const estimatedSavingsPercent = sourceTokens > 0 ? (estimatedSavingsTokens / sourceTokens) * 100 : 0;
    return {
      nodeId,
      sourceMessageCount: source.length,
      projectedMessageCount: applied ? memory.retainedMessageCount + 1 : source.length,
      removedMessageCount: applied ? source.length - (memory.retainedMessageCount + 1) : 0,
      sourceTokens,
      projectedTokens,
      completedToolCount: memory.completedToolNames.length,
      artifactCount: memory.artifacts.length,
      factCount: memory.facts.length,
      obligationCount: memory.obligations.length,
      candidateProjectedTokens,
      estimatedSavingsTokens,
      estimatedSavingsPercent,
      applied,
      ...(skipReason ? { skipReason } : {}),
    };
  };

  if (source.length <= retainRecentMessages) {
    const memory = buildMemory(source.length, collectFacts(source, maxFacts), collectObligations(source, maxObligations));
    return {
      history: source,
      memory,
      trace: baseTrace(memory, sourceTokens, sourceTokens, false, "short_history"),
    };
  }

  const cutoff = Math.max(1, source.length - retainRecentMessages);
  const prefix = source.slice(0, cutoff);
  let recentStart = cutoff;
  const firstRecent = source[recentStart];
  if (firstRecent?.role === "tool") {
    while (recentStart > 0 && source[recentStart - 1]?.role !== "assistant") recentStart -= 1;
    if (source[recentStart - 1]?.role === "assistant") recentStart -= 1;
  }
  const recent = source.slice(recentStart);
  const memory = buildMemory(recent.length, collectFacts(prefix, maxFacts), collectObligations(source, maxObligations));
  let projectedMemory = memoryMessage<TMessage>(memory);
  if (String(projectedMemory.content).length > maxMemoryCharacters) {
    memory.facts = memory.facts.slice(0, Math.min(memory.facts.length, 4));
    memory.obligations = memory.obligations.slice(0, Math.min(memory.obligations.length, 3));
    projectedMemory = memoryMessage<TMessage>(memory);
  }
  if (String(projectedMemory.content).length > maxMemoryCharacters) {
    return {
      history: source,
      memory,
      trace: baseTrace(memory, sourceTokens, estimateMessages([projectedMemory, ...recent], options.estimator), false, "memory_budget"),
    };
  }
  const projected = [projectedMemory, ...recent];
  const candidateProjectedTokens = estimateMessages(projected, options.estimator);
  const estimatedSavingsTokens = sourceTokens - candidateProjectedTokens;
  const estimatedSavingsPercent = sourceTokens > 0 ? (estimatedSavingsTokens / sourceTokens) * 100 : 0;
  const skipReason = sourceTokens < minSourceTokensForProjection
    ? "below_source_threshold"
    : estimatedSavingsTokens <= 0 || estimatedSavingsTokens < minEstimatedSavingsTokens
      ? "below_savings_threshold"
      : estimatedSavingsPercent < minEstimatedSavingsPercent
        ? "below_savings_percent"
        : undefined;

  if (skipReason) {
    memory.retainedMessageCount = source.length;
    return {
      history: source,
      memory,
      trace: baseTrace(memory, sourceTokens, candidateProjectedTokens, false, skipReason),
    };
  }

  return {
    history: projected,
    memory,
    trace: baseTrace(memory, candidateProjectedTokens, candidateProjectedTokens, true),
  };
}
