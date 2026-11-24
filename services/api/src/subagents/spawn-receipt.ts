// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { isDeepStrictEqual } from "node:util";
import { VersionStore } from "@sciencediscovery/cas";
import type { SwarmBranch } from "../runs/scope-ledger.js";
import type { Subagent } from "@sciencediscovery/schema";

export class SpawnReceiptConflict extends Error {}

/** Accumulate terminal outcomes by child identity, independent of finish order. */
export async function writeSpawnReceipt(dataDir: string, sessionId: string, parentRunId: string, children: readonly Subagent[], swarm: readonly SwarmBranch[] = []) {
  const selected = new Map<string, Subagent>();
  for (const child of children) {
    if (child.sessionId !== sessionId || child.parentTurnId !== parentRunId || child.status === "running" || !child.finishedAt || child.interruptedByRestart) {
      throw new SpawnReceiptConflict("Spawn Receipt requires committed terminal children of the same Run");
    }
    const previous = selected.get(child.id);
    if (previous && !isDeepStrictEqual(previous, child)) throw new SpawnReceiptConflict("Spawn Receipt contains conflicting child outcomes");
    selected.set(child.id, child);
  }
  const versions = new VersionStore(dataDir);
  const branches: Array<{ childId: string; status: Subagent["status"]; resultRef?: Awaited<ReturnType<VersionStore["putRecord"]>>; error?: string; executor?: "jiuwenswarm" }> = [];
  for (const child of [...selected.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    let result: unknown;
    if (child.status === "completed") {
      result = child.structuredResult;
      if (result === undefined) result = child.steps.findLast(step => step.kind === "assistant")?.content;
    }
    const resultRef = result === undefined ? undefined : await versions.putRecord("ResearchDelegationResult", { childId: child.id, result });
    branches.push({ childId: child.id, status: child.status, ...(resultRef ? { resultRef } : {}),
      ...(child.error ? { error: child.error } : {}) });
  }
  for (const child of swarm) {
    if (selected.has(child.childId)) throw new SpawnReceiptConflict("Spawn Receipt contains conflicting child identities");
    const resultRef = child.result === undefined ? undefined : await versions.putRecord("ResearchDelegationResult", { childId: child.childId, result: child.result });
    branches.push({ childId: child.childId, status: child.status, ...(resultRef ? { resultRef } : {}), ...(child.error ? { error: child.error } : {}), executor: "jiuwenswarm" });
  }
  branches.sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
  const ref = await versions.putRecord("ResearchSpawnReceipt", { sessionId, parentRunId, branches });
  for (const branch of branches) {
    if (branch.resultRef) await versions.readRecord(branch.resultRef, "ResearchDelegationResult");
  }
  return { ref, branches };
}
