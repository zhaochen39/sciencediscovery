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

import { createHash } from "node:crypto";

export type DisplayReceipt = { toolCallId: string; contentSha256: string; artifactSha256: string };

type HistoryMessage = Record<string, unknown> & {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly { id: string; function?: { name: string } }[];
};

export function findDisplayEvidence(history: readonly HistoryMessage[], table: Buffer, expectedVersion: string): {
  receipt: DisplayReceipt;
  messages: [HistoryMessage, HistoryMessage];
} | undefined {
  const artifactSha256 = createHash("sha256").update(table).digest("hex");
  if (artifactSha256 !== expectedVersion) return;
  const fullTable = table.toString("utf8").replaceAll("\r\n", "\n").trimEnd();
  if (!fullTable) return;
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of history) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
      calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
    }
    if (message.role === "tool" && message.tool_call_id) {
      results.set(message.tool_call_id, (results.get(message.tool_call_id) ?? 0) + 1);
    }
  }
  const precedingShellCalls = new Map<string, NonNullable<HistoryMessage["tool_calls"]>[number]>();
  const marker = "\nstdout:\n";
  for (const message of history) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
      if (call.function?.name === "run_shell" && calls.get(call.id) === 1) precedingShellCalls.set(call.id, call);
    }
    const id = message.tool_call_id;
    const call = id && precedingShellCalls.get(id);
    if (message.role !== "tool" || message.name !== "run_shell" || !id || !call
      || results.get(id) !== 1 || typeof message.content !== "string") continue;
    const boundary = message.content.indexOf(marker);
    if (boundary < 0) continue;
    try {
      const header = JSON.parse(message.content.slice(0, boundary));
      // The local Runner uses a stable shell execution ID that is distinct
      // from the provider's tool-call ID. The canonical tool pair binds both.
      const executionId = header?.executionId;
      if (typeof executionId !== "string" || (executionId !== id && !/^shell:[a-f0-9]{64}$/u.test(executionId))
        || header.state !== "completed" || header.exitCode !== 0) continue;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const stdout = message.content.slice(boundary + marker.length).replaceAll("\r\n", "\n").split("\nstderr:\n", 1)[0];
    if (stdout && `\n${stdout}\n`.includes(`\n${fullTable}\n`)) {
      return {
        receipt: { toolCallId: id, contentSha256: createHash("sha256").update(message.content).digest("hex"), artifactSha256 },
        messages: [{ role: "assistant", content: null, tool_calls: [structuredClone(call)] }, structuredClone(message)],
      };
    }
  }
}

export function findDisplayReceipt(history: readonly HistoryMessage[], table: Buffer, expectedVersion: string): DisplayReceipt | undefined {
  return findDisplayEvidence(history, table, expectedVersion)?.receipt;
}

/** Remove an intact, uniquely matched evidence unit from the resumed context. */
export function retireDisplayEvidence<T extends HistoryMessage>(history: readonly T[], receipt: DisplayReceipt): readonly T[] {
  const callId = receipt.toolCallId;
  const calls = history.filter((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === callId));
  const results = history.filter((message) => message.role === "tool" && message.tool_call_id === callId);
  const [call] = calls;
  const [result] = results;
  if (calls.length !== 1 || results.length !== 1 || !call || !result || call.tool_calls?.length !== 1
    || call.tool_calls[0]?.function?.name !== "run_shell" || call.content !== null || result.name !== "run_shell"
    || typeof result.content !== "string" || createHash("sha256").update(result.content).digest("hex") !== receipt.contentSha256
    || history.indexOf(result) !== history.indexOf(call) + 1) return history;
  return history.filter((message) => message !== call && message !== result);
}


export type ResearchRecoveryRoute =
  | { mode: "full"; reason: "pending-display" | "unverified-display" }
  | { mode: "retire-display"; reason: "verified-display" };

/** Derive the model view from server-validated bytes and canonical history. */
export function planResearchRecovery(input: {
  history: readonly HistoryMessage[];
  table: Buffer;
  artifactSha256: string;
  displayObserved: boolean;
}): { route: ResearchRecoveryRoute; evidence?: NonNullable<ReturnType<typeof findDisplayEvidence>> } {
  const evidence = input.displayObserved
    ? findDisplayEvidence(input.history, input.table, input.artifactSha256) : undefined;
  if (evidence) return { route: { mode: "retire-display", reason: "verified-display" }, evidence };
  return { route: { mode: "full", reason: input.displayObserved ? "unverified-display" : "pending-display" } };
}

/** Recheck the consumer's acceptance on every turn. An invalidated downstream
 * artifact restores the evidence from canonical history without synthesizing a result. */
export function projectVerifiedResearchEvidence<T extends HistoryMessage>(options: {
  receipt: DisplayReceipt;
  acceptedInputRevision: () => Promise<string | undefined>;
  onTransition?: (state: "retired" | "restored", turn: number) => void | Promise<void>;
}): (history: readonly T[], turn: number) => Promise<readonly T[]> {
  let retired = false;
  return async (history, turn) => {
    const revision = await options.acceptedInputRevision();
    const result = revision === options.receipt.artifactSha256 ? retireDisplayEvidence(history, options.receipt) : history;
    const next = result !== history;
    if (retired !== next) await options.onTransition?.(next ? "retired" : "restored", turn);
    retired = next;
    return result;
  };
}
