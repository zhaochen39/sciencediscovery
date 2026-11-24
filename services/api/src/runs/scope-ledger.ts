// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { VersionStore } from "@sciencediscovery/cas";
import type { AgentTool } from "@sciencediscovery/tools";
import { Type } from "typebox";

export class ScopeConflict extends Error {}

type Memory = { findings: string[]; obligations: string[]; artifactVersionIds: string[]; outcome: "completed" | "failed" };
type MemoryRef = Awaited<ReturnType<VersionStore["putRecord"]>>;
type Transition =
  | { kind: "open"; nodeId: string; title: string }
  | { kind: "close"; nodeId: string; memory: Memory; ref: MemoryRef }
  | { kind: "next"; nodeId: string; title: string; closedId: string; memory: Memory; ref: MemoryRef };
type ScopeNode = {
  id: string; parentId: string | null; title: string; status: "active" | "waiting" | "completed" | "failed" | "running";
  memory?: Memory; memoryRef?: MemoryRef;
};
export type SwarmBranch = { childId: string; status: "completed" | "failed" | "cancelled"; result?: unknown; error?: string };
type ScopeExecution = { nodeId: string; toolCallId: string; tool: string; status: string; reference: string | null };
type ScopeRow = { seq: number; operation: string; fingerprint: string; transition: string };

const rootId = "root";
const maxNodes = 64;
const initialized = new WeakSet<DatabaseSync>();
const nonempty = (value: string, limit: number) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

export class ScopeLedger {
  private readonly versions: VersionStore;

  constructor(private readonly db: DatabaseSync, dataDir: string, readonly sessionId: string, readonly runId: string) {
    this.versions = new VersionStore(dataDir);
    if (initialized.has(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS research_scope_events_v1 (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      operation TEXT NOT NULL, fingerprint TEXT NOT NULL, transition TEXT NOT NULL,
      PRIMARY KEY (session_id, run_id, seq), UNIQUE (session_id, run_id, operation)
    );
    CREATE TABLE IF NOT EXISTS research_scope_artifacts_v1 (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL, version_id TEXT NOT NULL,
      PRIMARY KEY (session_id, version_id, run_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS research_scope_artifacts_run_v1 ON research_scope_artifacts_v1(session_id, run_id);
    CREATE TABLE IF NOT EXISTS research_scope_executions_v1 (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      node_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, reference TEXT,
      PRIMARY KEY (session_id, run_id, tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS research_scope_swarm_branches_v1 (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, spawn_call_id TEXT NOT NULL,
      child_id TEXT NOT NULL, outcome TEXT,
      PRIMARY KEY (session_id, run_id, spawn_call_id), UNIQUE (session_id, run_id, child_id)
    );`);
    initialized.add(db);
  }

  private rows(): ScopeRow[] {
    return this.db.prepare(`SELECT seq, operation, fingerprint, transition FROM research_scope_events_v1
      WHERE session_id = ? AND run_id = ? ORDER BY seq`).all(this.sessionId, this.runId) as ScopeRow[];
  }

  private replay(rows: ScopeRow[]) {
    const root: ScopeNode = { id: rootId, parentId: null, title: "Research Run", status: "active" };
    const nodes = new Map([[rootId, root]]);
    let active = root;
    for (const [index, row] of rows.entries()) {
      if (row.seq !== index + 1) throw new ScopeConflict("Scope event sequence has a gap");
      const event = JSON.parse(row.transition) as Transition;
      if (event.kind === "close" || event.kind === "next") {
        const closedId = event.kind === "close" ? event.nodeId : event.closedId;
        const parent = active.parentId && nodes.get(active.parentId);
        if (active.id !== closedId || !parent || !["completed", "failed"].includes(event.memory.outcome)) {
          throw new ScopeConflict("Scope event does not close the active child");
        }
        active.status = event.memory.outcome;
        active.memory = event.memory;
        active.memoryRef = event.ref;
        active = parent;
        active.status = "active";
      }
      if (event.kind === "open" || event.kind === "next") {
        if (nodes.has(event.nodeId) || nodes.size >= maxNodes || !nonempty(event.title, 160)) {
          throw new ScopeConflict("Scope event cannot open this node");
        }
        active.status = "waiting";
        const node: ScopeNode = { id: event.nodeId, parentId: active.id, title: event.title, status: "active" };
        active = node;
        nodes.set(node.id, node);
      } else if (event.kind !== "close") {
        throw new ScopeConflict("Unknown Scope transition");
      }
    }
    return { activeId: active.id, nodes: [...nodes.values()], sequence: rows.length };
  }

  state() { return this.replay(this.rows()); }

  view() {
    const state = this.state();
    const executions = this.executions();
    // Observed steps use a separate namespace and project their lifecycle from
    // the durable tool records. They never change the active manual Scope.
    const implicitNodes = executions.filter(execution => execution.nodeId.startsWith("observed:")).map((execution): ScopeNode => ({
      id: execution.nodeId, parentId: rootId, title: execution.tool,
      status: execution.status === "running" ? "running" : execution.status === "failed" ? "failed" : "completed",
    }));
    return { ...state, nodes: [...state.nodes, ...implicitNodes], executions, artifactLinks: this.artifactLinks() };
  }

  executions(): ScopeExecution[] {
    return this.db.prepare(`SELECT node_id AS nodeId, tool_call_id AS toolCallId, tool, status, reference
      FROM research_scope_executions_v1 WHERE session_id = ? AND run_id = ? ORDER BY tool_call_id`)
      .all(this.sessionId, this.runId) as ScopeExecution[];
  }

  beginExecution(toolCallId: string, tool: string, observe = false) {
    const activeId = observe ? `observed:${toolCallId}` : this.state().activeId;
    this.db.prepare(`INSERT OR IGNORE INTO research_scope_executions_v1 VALUES (?, ?, ?, ?, ?, 'running', NULL)`)
      .run(this.sessionId, this.runId, toolCallId, activeId, tool);
  }

  endExecution(toolCallId: string, status: "running" | "failed" | "completed", reference: string | null, artifactVersionId?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.db.prepare(`UPDATE research_scope_executions_v1 SET status = ?, reference = ?
        WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'running' RETURNING node_id`)
        .get(status, reference, this.sessionId, this.runId, toolCallId) as { node_id: string } | undefined;
      if (execution && artifactVersionId && status === "completed") {
        this.db.prepare("INSERT OR IGNORE INTO research_scope_artifacts_v1 VALUES (?, ?, ?, ?)")
          .run(this.sessionId, this.runId, execution.node_id, artifactVersionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordSwarmDelegation(toolCallId: string, tool: string, output: string, requestedIds: unknown) {
    const spawn = this.db.prepare(`INSERT OR IGNORE INTO research_scope_swarm_branches_v1 VALUES (?, ?, ?, ?, NULL)`);
    let body: Record<string, unknown> | undefined;
    try {
      if (output.length <= 256 * 1024) body = JSON.parse(output);
    } catch { /* The adapter provided a diagnostic instead of a verified protocol record. */ }
    if (tool === "subagent_spawn") {
      const childId = typeof body?.subagent_id === "string" && nonempty(body.subagent_id, 256) ? body.subagent_id : `unresolved:${toolCallId}`;
      spawn.run(this.sessionId, this.runId, toolCallId, childId);
      return childId;
    }
    if (tool !== "subagent_wait" || body?.timed_out !== false || !Array.isArray(requestedIds)) return null;
    const statuses = body.statuses as Record<string, unknown> | undefined;
    const results = body.results as Record<string, unknown> | undefined;
    const update = this.db.prepare(`UPDATE research_scope_swarm_branches_v1 SET outcome = ?
      WHERE session_id = ? AND run_id = ? AND child_id = ? AND outcome IS NULL`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of requestedIds) {
        if (typeof id !== "string" || !statuses || !Object.hasOwn(statuses, id)) continue;
        const observed = statuses[id];
        const status = observed === "completed" ? "completed" : observed === "errored" ? "failed" : observed === "closed" ? "cancelled" : undefined;
        if (!status) continue;
        if (status === "completed" && (!results || !Object.hasOwn(results, id))) continue;
        const outcome: SwarmBranch = status === "completed" ? { childId: id, status, result: results![id] }
          : { childId: id, status, error: `JiuwenSwarm reported ${observed}` };
        update.run(JSON.stringify(outcome), this.sessionId, this.runId, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return null;
  }

  swarmBranches(): SwarmBranch[] {
    const rows = this.db.prepare(`SELECT outcome FROM research_scope_swarm_branches_v1 WHERE session_id = ? AND run_id = ? ORDER BY child_id`)
      .all(this.sessionId, this.runId) as { outcome: string | null }[];
    if (rows.some(row => row.outcome === null)) throw new ScopeConflict("Spawn Receipt requires terminal JiuwenSwarm wait results for children spawned by this Run");
    return rows.map(row => JSON.parse(row.outcome!) as SwarmBranch);
  }

  linkArtifact(versionId: string, executionId: string) {
    const execution = this.executions().find(item => item.reference === executionId && item.status === "completed");
    this.db.prepare("INSERT OR IGNORE INTO research_scope_artifacts_v1 VALUES (?, ?, ?, ?)")
      .run(this.sessionId, this.runId, execution?.nodeId ?? rootId, versionId);
  }

  artifactLinks(): { nodeId: string; versionId: string }[] {
    return this.db.prepare(`SELECT node_id AS nodeId, version_id AS versionId FROM research_scope_artifacts_v1
      WHERE session_id = ? AND run_id = ? ORDER BY node_id, version_id`).all(this.sessionId, this.runId) as { nodeId: string; versionId: string }[];
  }

  context(): { sequence: number; text: string } | undefined {
    const state = this.state();
    if (!state.sequence) return undefined;
    const active = state.nodes.find(node => node.id === state.activeId)!;
    const lineage = [active.id];
    for (let id = active.parentId; id; id = state.nodes.find(node => node.id === id)?.parentId ?? null) lineage.unshift(id);
    const recent = state.nodes.filter(node => node.parentId === active.parentId && node.memory).slice(-2);
    return { sequence: state.sequence, text: `Research Scope state. ${JSON.stringify({
      activeId: active.id, lineage, recent: recent.map(node => ({ id: node.id, status: node.status })),
    })}` };
  }

  closedShellEvidence(verifyVersion: (id: string) => { id: string; hash: string; path: string } | undefined) {
    const state = this.state();
    const links = this.artifactLinks();
    const byToolCall = new Map<string, { nodeId: string; executionId: string; findings: string[]; obligations: string[];
      artifacts: { id: string; hash: string; path: string }[] }>();
    const completed = new Map(state.nodes.filter(node => node.status === "completed" && node.memory?.findings.length)
      .map(node => [node.id, node.memory!]));
    for (const execution of this.executions()) {
      const memory = completed.get(execution.nodeId);
      if (!memory || execution.tool !== "run_shell" || execution.status !== "completed" || !execution.reference) continue;
      const artifacts = memory.artifactVersionIds.map(id => links.some(link => link.nodeId === execution.nodeId && link.versionId === id)
        ? verifyVersion(id) : undefined);
      if (!artifacts.length || !artifacts.every(artifact => artifact !== undefined)) continue;
      byToolCall.set(execution.toolCallId, { nodeId: execution.nodeId, executionId: execution.reference,
        findings: memory.findings, obligations: memory.obligations, artifacts });
    }
    return byToolCall;
  }

  async readMemory(nodeId: string) {
    const node = this.state().nodes.find(item => item.id === nodeId);
    if (!node?.memoryRef) throw new ScopeConflict("Scope has no committed memory");
    const { value } = await this.versions.readRecord<{ sessionId: string; runId: string; nodeId: string; memory: Memory }>(node.memoryRef, "ResearchScopeMemory");
    if (value.sessionId !== this.sessionId || value.runId !== this.runId || value.nodeId !== nodeId
      || !isDeepStrictEqual(value.memory, node.memory)) throw new ScopeConflict("Scope Memory reference does not match this node");
    return value;
  }

  artifactScopes(versionId: string) {
    return this.db.prepare(`SELECT run_id AS runId, node_id AS nodeId FROM research_scope_artifacts_v1
      WHERE session_id = ? AND version_id = ? ORDER BY run_id, node_id`).all(this.sessionId, versionId);
  }

  async transition(operation: string, input: { kind: "open" | "close" | "next"; expectedActiveId: string; title?: string; memory?: Memory },
    verifyVersion: (id: string) => boolean, signal?: AbortSignal) {
    if (!nonempty(operation, 256) || !nonempty(input.expectedActiveId, 64)) throw new ScopeConflict("Invalid Scope operation identity");
    if (input.kind !== "close" && !nonempty(input.title ?? "", 160)) throw new ScopeConflict("Invalid Scope title");
    const rawMemory = input.memory;
    const memory = rawMemory && {
      findings: rawMemory.findings, obligations: rawMemory.obligations,
      artifactVersionIds: rawMemory.artifactVersionIds, outcome: rawMemory.outcome,
    };
    if (input.kind !== "open" && (!memory || !["completed", "failed"].includes(memory.outcome)
      || ![memory.findings, memory.obligations, memory.artifactVersionIds].every(items =>
        Array.isArray(items) && items.length <= 8 && items.every(item => nonempty(item, 512))))) {
      throw new ScopeConflict("Invalid or oversized Scope memory");
    }
    const fingerprint = JSON.stringify({ kind: input.kind, expectedActiveId: input.expectedActiveId, title: input.title, memory });
    const existing = (rows: ScopeRow[]) => {
      const row = rows.find(item => item.operation === operation);
      if (!row) return undefined;
      if (row.fingerprint !== fingerprint) throw new ScopeConflict("Scope operation ID was already used with different arguments");
      return this.replay(rows.slice(0, row.seq));
    };
    const rows = this.rows();
    const duplicate = existing(rows);
    if (duplicate) return duplicate;
    const current = this.replay(rows);
    if (current.activeId !== input.expectedActiveId) throw new ScopeConflict("Active Scope changed. Inspect it and retry with a new operation ID");
    const nodeId = createHash("sha256").update(operation).digest("hex").slice(0, 24);
    let event: Transition;
    if (input.kind === "open") {
      event = { kind: "open", nodeId, title: input.title!.trim() };
    } else {
      if (current.activeId === rootId || !memory!.artifactVersionIds.every(verifyVersion)) {
        throw new ScopeConflict("Closing a Scope requires an active child and Artifact Versions from this Run");
      }
      const ref = await this.versions.putRecord("ResearchScopeMemory", {
        sessionId: this.sessionId, runId: this.runId, nodeId: current.activeId, memory,
      });
      event = input.kind === "close"
        ? { kind: "close", nodeId: current.activeId, memory: memory!, ref }
        : { kind: "next", nodeId, title: input.title!.trim(), closedId: current.activeId, memory: memory!, ref };
    }
    signal?.throwIfAborted();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.rows();
      const replayedDuplicate = existing(latest);
      if (replayedDuplicate) {
        this.db.exec("COMMIT");
        return replayedDuplicate;
      }
      if (latest.length !== rows.length) throw new ScopeConflict("Scope changed during this operation");
      if (event.kind !== "open" && !event.memory.artifactVersionIds.every(verifyVersion)) throw new ScopeConflict("Scope artifact reference changed");
      const row = { seq: latest.length + 1, operation, fingerprint, transition: JSON.stringify(event) };
      const result = this.replay([...latest, row]);
      this.db.prepare(`INSERT INTO research_scope_events_v1 VALUES (?, ?, ?, ?, ?, ?)`)
        .run(this.sessionId, this.runId, row.seq, operation, fingerprint, row.transition);
      if (event.kind !== "open") {
        for (const versionId of new Set(event.memory.artifactVersionIds)) {
          this.db.prepare(`INSERT INTO research_scope_artifacts_v1 VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, version_id, run_id, node_id) DO NOTHING`)
            .run(this.sessionId, this.runId, current.activeId, versionId);
        }
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const strings = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 8 });
const memorySchema = Type.Object({
  findings: Type.Optional(strings), obligations: Type.Optional(strings), artifactVersionIds: Type.Optional(strings),
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
}, { additionalProperties: false });

export function scopeTool(ledger: ScopeLedger, verifyVersion: (id: string) => boolean): AgentTool {
  const parameters = Type.Object({
    kind: Type.Union([Type.Literal("inspect"), Type.Literal("open"), Type.Literal("close"), Type.Literal("next")]),
    expectedActiveId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    memory: Type.Optional(memorySchema),
  }, { additionalProperties: false });
  const definition: AgentTool<typeof parameters> = {
    name: "research_scope", label: "Research Scope", parameters, requiredArguments: ["kind"],
    description: "Inspect the active research Scope, open a child, close it with notes and same-Run artifact version IDs, or atomically close it and open a sibling. The initial active ID is root. For close and next, give memory.outcome and optionally findings, obligations, or artifactVersionIds. Return to root before delivering the final answer. Scope notes do not certify scientific findings.",
    async execute(id, args, signal) {
      try {
        const memory = args.memory && {
          findings: args.memory.findings ?? [], obligations: args.memory.obligations ?? [],
          artifactVersionIds: args.memory.artifactVersionIds ?? [], outcome: args.memory.outcome,
        };
        const state = args.kind === "inspect" ? ledger.state() : await ledger.transition(id, {
          kind: args.kind, title: args.title, expectedActiveId: args.expectedActiveId ?? "", memory,
        }, verifyVersion, signal);
        const active = state.nodes.find(node => node.id === state.activeId)!;
        const relevant = new Set([active.id, active.parentId]);
        return { content: [{ type: "text", text: JSON.stringify({
          researchScopeResult: 1, sequence: state.sequence, activeId: active.id, nodes: state.nodes.filter(node => relevant.has(node.id)
            || (node.parentId === active.parentId && node.memory)).slice(-6),
        }) }] };
      } catch (error) {
        if (!(error instanceof ScopeConflict)) throw error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  };
  return definition;
}
