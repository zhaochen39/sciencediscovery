// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { MemoryGraphNode, MemorySubgraph, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type { ScopeLedger } from "./scope-ledger.js";

/** Join the authoritative Scope index with already visible ScienceMemory nodes.
 * Sidecar outages cannot change the Scope history or invent a citation edge. */
export function scopeMemorySubgraph(graph: MemorySubgraph, ledger: ScopeLedger, version: (id: string) => ScientificArtifactVersion | undefined): MemorySubgraph {
  const view = ledger.view();
  const scopeId = (nodeId: string) => `research-scope:${ledger.runId}:${nodeId}`;
  const scopeNodes: MemoryGraphNode[] = view.nodes.map(node => ({
    id: scopeId(node.id), label: "Task", sessionId: ledger.sessionId,
    extra: { task_type: "research_scope", objective: node.title, status: node.status, run_id: ledger.runId, scope_id: node.id },
  }));
  const edges = new Map<string, MemorySubgraph["edges"][number]>();
  const add = (source: string, target: string) => edges.set(JSON.stringify([source, target]), { source, target, type: "contains", extra: { basis: "research_scope" } });
  const visible = new Map(graph.nodes.map(node => [node.id, node]));
  const toolCalls = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.label !== "ToolCall") continue;
    for (const key of [node.id, node.extra?.task_id]) {
      if (typeof key !== "string") continue;
      const ids = toolCalls.get(key) ?? new Set<string>();
      ids.add(node.id);
      toolCalls.set(key, ids);
    }
  }
  for (const node of view.nodes) if (node.parentId) add(scopeId(node.parentId), scopeId(node.id));
  for (const link of view.artifactLinks) {
    const ref = version(link.versionId);
    if (!ref || ref.sessionId !== ledger.sessionId || ref.turnId !== ledger.runId) continue;
    const graphId = `${ref.artifactId}#v${ref.version}`;
    if (visible.get(graphId)?.label === "Artifact") add(scopeId(link.nodeId), graphId);
  }
  const labelByTool = { declare_claim: "Claim", declare_evidence: "Evidence", create_evolve_run: "SearchRun" } as const;
  for (const execution of view.executions) {
    if (execution.status !== "completed") continue;
    const label = labelByTool[execution.tool as keyof typeof labelByTool];
    if (label && execution.reference && visible.get(execution.reference)?.label === label) {
      add(scopeId(execution.nodeId), execution.reference);
    }
    for (const key of [execution.toolCallId, execution.reference]) {
      if (!key) continue;
      for (const id of toolCalls.get(key) ?? []) add(scopeId(execution.nodeId), id);
    }
  }
  return { ...graph, nodes: [...graph.nodes, ...scopeNodes], edges: [...graph.edges, ...edges.values()], total: graph.total + scopeNodes.length };
}
