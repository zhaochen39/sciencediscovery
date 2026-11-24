// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { summariseRun } from "../evolution/proposal.js";

/** Project recorded evaluations without changing engine rankings or mixing gate and held-out scores. */
export function scopeEvolveResult(run: Parameters<typeof summariseRun>[0], events: Parameters<typeof summariseRun>[1]) {
  const candidates = new Map<number, {
    nodeIndex: number; parentIndex: number | null; status: "seed" | "evaluated" | "invalid";
    gateScore: number | null; changeSummary?: string; codeHash?: string;
  }>();
  for (const { event } of events) {
    if (event.type !== "seeded" && event.type !== "expanded") continue;
    if (typeof event.nodeIndex !== "number" || !Number.isSafeInteger(event.nodeIndex) || event.nodeIndex < 0) continue;
    const seed = event.type === "seeded";
    const score = seed ? event.baselineScore : event.score;
    candidates.set(event.nodeIndex, {
      nodeIndex: event.nodeIndex,
      parentIndex: typeof event.parentIndex === "number" ? event.parentIndex : null,
      status: seed ? "seed" : event.valid === true ? "evaluated" : "invalid",
      gateScore: (seed || event.valid === true) && typeof score === "number" && Number.isFinite(score) ? score : null,
      ...(typeof event.changeSummary === "string" ? { changeSummary: event.changeSummary } : {}),
      ...(typeof event.codeHash === "string" ? { codeHash: event.codeHash } : {}),
    });
  }
  return { ...summariseRun(run, events), evaluations: [...candidates.values()].sort((a, b) => a.nodeIndex - b.nodeIndex) };
}
