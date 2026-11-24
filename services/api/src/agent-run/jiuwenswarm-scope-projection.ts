// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { historyUnits, projectScopeHistory } from "@sciencediscovery/context";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import type { NativeAgentOptions } from "../native-agent/index.js";
import type { ModelGatewayLifecycle } from "./jiuwenswarm-model-gateway.js";

type ProjectHistory = NonNullable<ModelGatewayLifecycle["projectHistory"]>;

/** Swarm wraps TUI input in a localized JSON envelope before model dispatch. */
function matchesPrompt(content: unknown, prompt: string): boolean {
  if (content === prompt) return true;
  if (typeof content !== "string") return false;
  const envelope = /^[^\n{]{1,40}[:：]\s*(\{[\s\S]*\})\s*$/u.exec(content);
  if (!envelope) return false;
  try {
    const parsed = JSON.parse(envelope[1]!) as { source?: unknown; type?: unknown; content?: unknown };
    return parsed.source === "tui" && parsed.type === "user input" && parsed.content === prompt;
  } catch {
    return false;
  }
}

type ClosedShellEvidence = NonNullable<NonNullable<NativeAgentOptions["researchScope"]>["closedShellEvidence"]>;

/** Swarm 0.2.6 serializes an MCP text result as a one-field Python repr. */
function unwrapSwarmResult(content: string) {
  const wrapped = /^\{'result': (['"])(.*)\1\}$/u.exec(content);
  if (!wrapped) return { text: content, wrap: (text: string) => text };
  const quote = wrapped[1]!;
  const escapes = new Map([["n", "\n"], ["r", "\r"], ["t", "\t"], ["\\", "\\"], [quote, quote]]);
  let valid = true;
  const text = wrapped[2]!.replace(/\\(.)|([\\'"])/gu, (match, escaped?: string, unescaped?: string) => {
    if (unescaped && unescaped !== quote && unescaped !== "\\") return match;
    const value = escaped && escapes.get(escaped);
    if (value === undefined || value === "") valid = false;
    return value ?? match;
  });
  if (!valid) return undefined;
  return { text, wrap: (replacement: string) => `{'result': ${JSON.stringify(replacement)}}` };
}

function foldClosedShellResult(content: string, evidence: ReturnType<ClosedShellEvidence> extends ReadonlyMap<string, infer T> ? T : never) {
  const result = unwrapSwarmResult(content);
  if (!result) return content;
  const headerEnd = result.text.indexOf("\nstdout:\n");
  if (headerEnd < 0 || content.length < 4_096) return content;
  try {
    const header = JSON.parse(result.text.slice(0, headerEnd)) as Record<string, unknown>;
    if (header.executionId !== evidence.executionId || header.state !== "completed" || header.exitCode !== 0
      || Object.keys(header).some(key => !["executionId", "state", "exitCode", "createdFiles", "modifiedFiles", "recovery"].includes(key))
      || [header.createdFiles, header.modifiedFiles].some(files => !Array.isArray(files) || files.length)) return content;
    // Preserve Runner recovery metadata verbatim in the replacement.
    const output = result.text.slice(headerEnd + "\nstdout:\n".length);
    const stderrMarker = "\nstderr:\n";
    const stderrStart = output.indexOf(stderrMarker);
    if (stderrStart < 0 || stderrStart + stderrMarker.length !== output.length) return content;
    const stdout = output.slice(0, stderrStart);
    const hash = createHash("sha256").update(stdout).digest("hex");
    const artifact = evidence.artifacts.find(item => item.hash === hash);
    if (!artifact) return content;
    const folded = result.wrap(JSON.stringify({ ...header, closedScope: evidence.nodeId, artifact,
      findings: evidence.findings, obligations: evidence.obligations,
      evidence: "Exact stdout is preserved in this Artifact Version and in the execution logs." }));
    return folded.length <= content.length / 2 ? folded : content;
  } catch {
    return content;
  }
}

export function createSwarmHistoryProjection(options: {
  prompt: string;
  sessionId: string;
  runId?: string;
  recoveryHistory?: readonly AgentHistoryMessage[];
  projectRecoveryHistory?: NativeAgentOptions["projectContextHistory"];
  projectScopes: boolean;
  scopeContext?: () => { sequence: number; text: string } | undefined;
  closedShellEvidence?: ClosedShellEvidence;
}): ProjectHistory | undefined {
  if (!options.recoveryHistory && !options.projectScopes && !options.scopeContext) return undefined;
  let turn = 0;
  return async (history) => {
    const current = turn++;
    const boundary = history.findLastIndex(message => message.role === "user" && matchesPrompt(message.content, options.prompt));
    if (options.recoveryHistory) {
      if (boundary < 0) throw new Error("Swarm research recovery lost the continuation prompt boundary");
      // Swarm injects current runtime reminders before the conversation history.
      const reminders = history.slice(0, boundary).filter(message => message.role === "user"
        && typeof message.content === "string" && message.content.startsWith("<system-reminder>"));
      const restored = [...reminders, ...options.recoveryHistory, ...history.slice(boundary)];
      const next = await options.projectRecoveryHistory?.(restored, current) ?? restored;
      console.info(`[swarm-spine] ${JSON.stringify({ event: "research.recovery.input", sessionId: options.sessionId,
        runId: options.runId, turn: current, originalMessages: history.length, modelMessages: next.length })}`);
      return [...next] as typeof history;
    }
    if (options.scopeContext) {
      const context = options.scopeContext();
      if (!context || boundary < 0) return history;
      const units = historyUnits(history.slice(boundary));
      const closed = options.closedShellEvidence?.();
      let foldedShellResults = 0;
      const projected = units.flatMap(unit => {
        if (!unit.closed || unit === units.at(-1)) return unit.messages;
        const declarations = unit.messages[0]?.tool_calls;
        if (!Array.isArray(declarations)) return unit.messages;
        const scopeCalls = new Set(declarations.flatMap((call: { id?: string; function?: { name?: string } }) =>
          call.function?.name === "research_scope" && call.id ? [call.id] : []));
        return unit.messages.map(message => {
          if (message.role !== "tool" || typeof message.content !== "string") return message;
          const callId = String(message.tool_call_id);
          if (declarations.length === 1 && declarations[0]?.function?.name === "run_shell" && declarations[0]?.id === callId) {
            const evidence = closed?.get(callId);
            if (!evidence) return message;
            const content = foldClosedShellResult(message.content, evidence);
            if (content === message.content) return message;
            foldedShellResults++;
            return { ...message, content };
          }
          if (!scopeCalls.has(callId)) return message;
          try {
            const result = JSON.parse(message.content) as { researchScopeResult?: number; sequence?: number; activeId?: string };
            if (result.researchScopeResult !== 1 || !Number.isSafeInteger(result.sequence) || result.sequence! >= context.sequence) return message;
            const content = JSON.stringify({ researchScopeResult: 1, sequence: result.sequence, activeId: result.activeId,
              historical: "The durable log retained this snapshot. Inspect the active Scope for current state." });
            return content.length < message.content.length ? { ...message, content } : message;
          } catch { return message; }
        });
      });
      if (foldedShellResults) console.info(`[swarm-spine] ${JSON.stringify({ event: "scope.closed_evidence.folded",
        sessionId: options.sessionId, runId: options.runId, turn: current, foldedShellResults })}`);
      return [{ role: "user", content: context.text }, ...history.slice(0, boundary), ...projected];
    }
    if (boundary <= 0) return history;
    const prefix = history.slice(0, boundary);
    const tail = history.slice(boundary);
    const units = historyUnits(prefix);
    if (units.some(unit => !unit.closed)) return history;
    const minSource = Number(process.env.SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS ?? 1_500);
    const minSavings = Number(process.env.SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS ?? 1_500);
    const minPercent = Number(process.env.SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT ?? 10);
    const result = projectScopeHistory(prefix, {
      minSourceTokensForProjection: minSource, minEstimatedSavingsTokens: minSavings,
      minEstimatedSavingsPercent: minPercent,
    });
    if (!result.trace.applied) return history;
    const retainedCount = result.history.length - 1;
    const priorUserRequests = prefix.slice(0, prefix.length - retainedCount).filter(message => message.role === "user");
    // All user requests survive verbatim, including requests older than the retained tool history.
    const candidate = [result.history[0]!, ...priorUserRequests, ...result.history.slice(1), ...tail];
    const sourceSize = JSON.stringify(history).length;
    const saved = sourceSize - JSON.stringify(candidate).length;
    if (saved <= 0 || saved < minSavings * 2 || saved / sourceSize * 100 < minPercent) return history;
    console.info(`[swarm-spine] ${JSON.stringify({ event: "scope.projection.applied", sessionId: options.sessionId,
      runId: options.runId, turn: current, originalMessages: history.length, modelMessages: candidate.length, savedCharacters: saved })}`);
    return candidate;
  };
}
