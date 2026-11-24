// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { ScopeProjectionOptions, ScopeProjectionTrace, StageProjectionDecision } from "./scope-projection.js";
import { canonicalState, type StateView } from "./state-view.js";
import { ConservativeTokenEstimator } from "./token-estimator.js";

export const VERIFIED_STAGE_STATE = "context.verified-stages";

/** Captured by the workflow owner after successful artifact validation. A closure
 * certifies that these facts and artifact references replace the result for downstream use. */
export interface VerifiedStageClosure {
  stageId: string;
  toolCallId: string;
  /** A state provider may attest a later tool result containing the verified artifact. */
  resultSource?: { toolCallId: string; contentSha256: string };
  artifacts: readonly { path: string; revision: string; fields: Readonly<Record<string, string | number | boolean | null>> }[];
}

function sourceCallId(closure: VerifiedStageClosure): string {
  return closure.resultSource?.toolCallId ?? closure.toolCallId;
}

export interface VerifiedStageAlternatives {
  preferred: readonly VerifiedStageClosure[];
  requiredStageId?: string;
  fallback: readonly VerifiedStageClosure[];
}

function readClosures(value: unknown, captured: boolean) {
  if (!captured) return { state: "unavailable" as const, received: 0, valid: [] };
  if (!Array.isArray(value)) return { state: "invalid" as const, received: 0, valid: [] };
  const nonEmpty = (item: unknown) => typeof item === "string" && item.trim().length > 0;
  const closures: VerifiedStageClosure[] = value.filter((closure): closure is VerifiedStageClosure =>
    !!closure && nonEmpty(closure.stageId) && nonEmpty(closure.toolCallId)
    && (closure.resultSource === undefined || (!!closure.resultSource
      && nonEmpty(closure.resultSource.toolCallId) && closure.resultSource.toolCallId !== closure.toolCallId
      && typeof closure.resultSource.contentSha256 === "string" && /^[a-f0-9]{64}$/.test(closure.resultSource.contentSha256)))
    && Array.isArray(closure.artifacts) && closure.artifacts.length > 0
    && closure.artifacts.every((artifact: VerifiedStageClosure["artifacts"][number]) =>
      !!artifact && nonEmpty(artifact.path) && nonEmpty(artifact.revision)
      && !!artifact.fields && typeof artifact.fields === "object" && !Array.isArray(artifact.fields)
      && Object.values(artifact.fields).every((field) => field === null || ["string", "number", "boolean"].includes(typeof field)))
    && closure.artifacts.some((artifact: VerifiedStageClosure["artifacts"][number]) => Object.keys(artifact.fields).length > 0));
  const valid = closures.filter((closure) => closures.filter((other) =>
    other.stageId === closure.stageId || [other.toolCallId, sourceCallId(other)].some(
      (callId) => callId === closure.toolCallId || callId === sourceCallId(closure))).length === 1);
  return { state: "captured" as const, received: value.length, valid };
}

/** Project only the validated tool result. User anchors, assistant decisions and
 * tool exchanges retain their original roles, ordering and call IDs. */
export function projectVerifiedStages<TMessage extends RuntimeMessage>(
  source: readonly TMessage[], view: StateView | undefined, options: ScopeProjectionOptions<TMessage>,
): { history: TMessage[]; trace: ScopeProjectionTrace } {
  const captured = view?.checkpoint.components.some((component) =>
    component.id === VERIFIED_STAGE_STATE && component.schemaVersion === 1 && component.fidelity === "captured") ?? false;
  const value = captured ? view?.read<unknown>(VERIFIED_STAGE_STATE) : undefined;
  if (value && typeof value === "object" && "preferred" in value && "fallback" in value
    && Array.isArray(value.preferred) && Array.isArray(value.fallback)) {
    const preferred = projectClosures(source, readClosures(value.preferred, true), options);
    const includesPreferred = "requiredStageId" in value && typeof value.requiredStageId === "string" && preferred.trace.verifiedStageIds?.includes(value.requiredStageId);
    if (preferred.trace.applied && includesPreferred) {
      return { ...preferred, trace: { ...preferred.trace, preferredStageProjection: true } };
    }
    const fallback = projectClosures(source, readClosures(value.fallback, true), options);
    return { ...fallback, trace: { ...fallback.trace, preferredStageProjection: false,
      preferredStageSkipReason: preferred.trace.skipReason ?? "no_verified_stage" } };
  }
  return projectClosures(source, readClosures(value, captured), options);
}

function projectClosures<TMessage extends RuntimeMessage>(source: readonly TMessage[], closures: ReturnType<typeof readClosures>,
  options: ScopeProjectionOptions<TMessage>): { history: TMessage[]; trace: ScopeProjectionTrace } {
  const estimator = options.estimator ?? new ConservativeTokenEstimator<TMessage>();
  const estimate = (messages: readonly TMessage[]) => messages.reduce((total, message) => total + estimator.estimateMessage(message), 0);
  const sourceTokens = estimate(source);
  const recent = Math.max(2, options.retainRecentMessages ?? 6);
  const candidate = [...source];
  const stageIds: string[] = [];
  let artifactCount = 0;
  let fieldCount = 0;
  let memoryCharacters = 0;
  let exceedsMemoryBudget = false;
  const decisions: StageProjectionDecision[] | undefined = options.diagnostics ? [] : undefined;
  for (const closure of closures.valid) {
    const { stageId, resultSource, ...memory } = closure;
    const toolCallId = sourceCallId(closure);
    const matches = source.filter((message) => message.role === "tool" && message.tool_call_id === toolCallId);
    if (matches.length !== 1) {
      decisions?.push({ stageId, reason: matches.length === 0 ? "result_missing" : "result_ambiguous" });
      continue;
    }
    const result = matches[0]!;
    const index = source.indexOf(result);
    if (index >= source.length - recent) {
      decisions?.push({ stageId, reason: "recent_result", originalTokens: estimate([result]) });
      continue;
    }
    if (typeof result.content !== "string") {
      decisions?.push({ stageId, reason: "unsupported_result" });
      continue;
    }
    if (resultSource && createHash("sha256").update(result.content).digest("hex") !== resultSource.contentSha256) {
      decisions?.push({ stageId, reason: "source_digest_mismatch" });
      continue;
    }
    const parent = source.slice(0, index).findLast((message) => message.role !== "tool");
    if (parent?.role !== "assistant" || !Array.isArray(parent.tool_calls)
      || !parent.tool_calls.some((call) => call?.id === toolCallId)) {
      decisions?.push({ stageId, reason: "unmatched_call" });
      continue;
    }
    const content = canonicalState({ verified_stage: { stageId, ...memory } });
    if (memoryCharacters + content.length > (options.maxMemoryCharacters ?? 6_000)) {
      exceedsMemoryBudget = true;
      decisions?.push({ stageId, reason: "memory_budget", originalTokens: estimate([result]) });
      break;
    }
    const replacement: TMessage = { ...result, content, additional_kwargs: { ...(typeof result.additional_kwargs === "object" && result.additional_kwargs !== null ? result.additional_kwargs : {}), scope_node_memory: true } };
    const originalTokens = estimate([result]);
    const memoryTokens = estimate([replacement]);
    if (memoryTokens >= originalTokens) {
      decisions?.push({ stageId, reason: "no_token_savings", originalTokens, memoryTokens });
      continue;
    }
    decisions?.push({ stageId, reason: "candidate", originalTokens, memoryTokens });
    candidate[index] = replacement;
    memoryCharacters += content.length;
    stageIds.push(stageId);
    artifactCount += closure.artifacts.length;
    fieldCount += closure.artifacts.reduce((sum, artifact) => sum + Object.keys(artifact.fields).length, 0);
  }
  const candidateProjectedTokens = estimate(candidate);
  const estimatedSavingsTokens = sourceTokens - candidateProjectedTokens;
  const estimatedSavingsPercent = sourceTokens ? 100 * estimatedSavingsTokens / sourceTokens : 0;
  const skipReason = exceedsMemoryBudget ? "memory_budget"
    : stageIds.length === 0 ? "no_verified_stage"
      : sourceTokens < (options.minSourceTokensForProjection ?? 0) ? "below_source_threshold"
        : estimatedSavingsTokens < (options.minEstimatedSavingsTokens ?? 0) ? "below_savings_threshold"
          : estimatedSavingsPercent < (options.minEstimatedSavingsPercent ?? 0) ? "below_savings_percent"
            : undefined;
  return {
    history: skipReason ? [...source] : candidate,
    trace: {
      nodeId: options.nodeId ?? "main", sourceMessageCount: source.length, projectedMessageCount: source.length,
      removedMessageCount: 0, sourceTokens, projectedTokens: skipReason ? sourceTokens : candidateProjectedTokens,
      candidateProjectedTokens, estimatedSavingsTokens, estimatedSavingsPercent, applied: skipReason === undefined,
      ...(skipReason ? { skipReason } : {}), verifiedStageIds: stageIds,
      completedToolCount: stageIds.length, artifactCount, factCount: fieldCount, obligationCount: 0,
      ...(decisions ? { stageDiagnostics: { state: closures.state, receivedClosures: closures.received,
        validClosures: closures.valid.length, stages: decisions } } : {}),
    },
  };
}
