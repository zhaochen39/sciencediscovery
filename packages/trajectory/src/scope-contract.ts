// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export interface ScopeRun { runId: string; status: string; createdAt: string }
interface ScopeNode {
  id: string; parentId: string | null; title: string; status: string;
  memory?: { findings: string[]; obligations: string[]; artifactVersionIds: string[] };
}
export interface ScopeTree extends ScopeRun {
  nodes: ScopeNode[];
  artifactLinks: Array<{ nodeId: string; versionId: string }>;
  executions: Array<{ nodeId: string; toolCallId: string; tool: string; status: string; reference: string | null }>;
}
export interface ScopePort {
  runs(sessionId: string, signal: AbortSignal): Promise<ScopeRun[]>;
  tree(sessionId: string, runId: string, signal: AbortSignal): Promise<ScopeTree>;
  execution(sessionId: string, runId: string, executionId: string, signal: AbortSignal): Promise<unknown>;
  artifact(sessionId: string, versionId: string, signal: AbortSignal): Promise<unknown>;
}
