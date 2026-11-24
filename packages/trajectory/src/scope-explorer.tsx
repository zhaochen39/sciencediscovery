// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useState } from "react";

import type { ScopePort, ScopeRun, ScopeTree } from "./scope-contract.js";
export type { ScopePort } from "./scope-contract.js";

export function createScopePort(request: <T>(path: string, signal: AbortSignal) => Promise<T>): ScopePort {
  const root = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
  return {
    runs: (id, signal) => request(`${root(id)}/research-scopes`, signal),
    tree: (id, runId, signal) => request(`${root(id)}/research-scopes?runId=${encodeURIComponent(runId)}`, signal),
    execution: (id, runId, executionId, signal) => request(`${root(id)}/research-scopes?runId=${encodeURIComponent(runId)}&executionId=${encodeURIComponent(executionId)}`, signal),
    artifact: (id, versionId, signal) => request(`${root(id)}/artifact-versions/${encodeURIComponent(versionId)}/provenance?includeScopes=1`, signal),
  };
}

export function ScopeExplorer({ sessionId, port, locale, onExecution }: {
  sessionId: string; port: ScopePort; locale: string;
  onExecution?: (tool: string, reference: string) => void;
}) {
  const zh = locale.startsWith("zh");
  const label = (cn: string, en: string) => zh ? cn : en;
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<{ sessionId: string; runs: ScopeRun[] }>();
  const [runId, setRunId] = useState("");
  const [tree, setTree] = useState<ScopeTree>();
  const [versionId, setVersionId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [evidence, setEvidence] = useState<{ id: string; value: unknown }>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const runs = catalog?.sessionId === sessionId ? catalog.runs : undefined;
  const selectedRunId = runs?.find(run => run.runId === runId)?.runId ?? runs?.[0]?.runId;
  const current = tree?.runId === selectedRunId ? tree : undefined;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    void port.runs(sessionId, controller.signal).then(items => {
      if (!controller.signal.aborted) setCatalog({ sessionId, runs: items });
    }).catch(() => { if (!controller.signal.aborted) setError("runs"); });
    return () => controller.abort();
  }, [open, port, revision, sessionId]);
  useEffect(() => {
    if (!open || !selectedRunId) return;
    const controller = new AbortController();
    void port.tree(sessionId, selectedRunId, controller.signal).then(item => {
      if (!controller.signal.aborted) setTree(item);
    }).catch(() => { if (!controller.signal.aborted) setError("tree"); });
    return () => controller.abort();
  }, [open, port, revision, selectedRunId, sessionId]);
  useEffect(() => {
    if (!open || !(versionId || executionId) || !selectedRunId) return;
    const controller = new AbortController();
    const request = versionId ? port.artifact(sessionId, versionId, controller.signal)
      : port.execution(sessionId, selectedRunId, executionId, controller.signal);
    void request.then(value => {
      if (!controller.signal.aborted) setEvidence({ id: versionId || executionId, value });
    }).catch(() => { if (!controller.signal.aborted) setError("artifact"); });
    return () => controller.abort();
  }, [executionId, open, port, revision, selectedRunId, sessionId, versionId]);

  const stateLabels: Record<string, string> = {
    active: label("执行中", "Active"), waiting: label("等待子节点", "Waiting for child"),
    running: label("执行中", "Running"), queued: label("排队中", "Queued"),
    blocked: label("等待确认", "Blocked"), completed: label("已完成", "Completed"), failed: label("失败", "Failed"),
    cancelled: label("已取消", "Cancelled"), interrupted: label("已中断", "Interrupted"),
  };
  const researchTools = ["create_evolve_run", "create_idea_research"];
  const terminal = current && ["completed", "failed", "cancelled", "interrupted"].includes(current.status);
  function renderNodes(parentId: string | null) {
    const nodes = current?.nodes.filter(node => node.parentId === parentId) ?? [];
    if (!nodes.length) return null;
    return <ul className="research-scope-nodes">{nodes.map(node => {
      const nodeStatus = node.parentId === null ? current!.status : terminal && ["active", "waiting"].includes(node.status) ? current!.status : node.status;
      return <li key={node.id}>
        <details open={node.parentId === null || ["active", "failed", "interrupted"].includes(nodeStatus) ? true : undefined}>
          <summary><strong>{node.parentId === null ? label("研究任务", "Research run") : node.title}</strong><span>{stateLabels[nodeStatus] ?? nodeStatus}</span></summary>
          {node.memory && <div className="research-scope-memory">
            {node.memory.findings.length > 0 && <><h4>{label("节点记录", "Node notes")}</h4><ul>{node.memory.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul></>}
            {node.memory.obligations.length > 0 && <><h4>{label("待办", "Open obligations")}</h4><ul>{node.memory.obligations.map((obligation, index) => <li key={index}>{obligation}</li>)}</ul></>}
          </div>}
          {current!.artifactLinks.filter(link => link.nodeId === node.id).map(({ versionId: id }) => <button key={id} type="button"
            onClick={() => { setVersionId(id); setExecutionId(""); setEvidence(undefined); }}>{label("查看证据版本", "View evidence version")} <code>{id}</code></button>)}
          {current!.executions.filter(execution => execution.nodeId === node.id).map(item => <p key={item.toolCallId} className="research-scope-execution">
            <code>{item.tool}</code> · {researchTools.includes(item.tool) && item.status === "completed" ? label("已提交", "Submitted") : stateLabels[item.status] ?? item.status} {item.reference && (onExecution && researchTools.includes(item.tool)
              ? <button type="button" onClick={() => onExecution(item.tool, item.reference!)}>{item.tool === "create_idea_research" ? label("打开研究", "Open research") : label("打开搜索", "Open search")}</button>
              : researchTools.includes(item.tool)
                ? <button type="button" onClick={() => { setVersionId(""); setExecutionId(item.toolCallId); setEvidence(undefined); }}>{label("查看研究结果", "View research result")}</button>
                : <code>{item.reference}</code>)}
          </p>)}
          {renderNodes(node.id)}
        </details>
      </li>;
    })}</ul>;
  }
  return <details className="research-scope-explorer" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label("科研 Scope", "Research scopes")}</summary>
    {open && <section aria-label={label("科研执行树", "Research execution tree")}>
      <div className="research-scope-toolbar">
        {!!runs?.length && <label>{label("运行", "Run")} <select value={selectedRunId} onChange={event => { setRunId(event.target.value); setVersionId(""); setExecutionId(""); setEvidence(undefined); }}>
          {runs.map(run => <option key={run.runId} value={run.runId}>{new Date(run.createdAt).toLocaleString(locale)} · {stateLabels[run.status] ?? run.status}</option>)}
        </select></label>}
        <button type="button" onClick={() => setRevision(value => value + 1)}>{label("刷新", "Refresh")}</button>
      </div>
      {!error && (!runs || (selectedRunId && !current)) && <p role="status">{label("正在读取…", "Loading…")}</p>}
      {runs?.length === 0 && <p>{label("该会话尚无 Scope 运行。", "This session has no scoped runs yet.")}</p>}
      {error && <p role="alert">{label("读取失败，请刷新后重试。", "Could not load. Refresh to retry.")}</p>}
      {renderNodes(null)}
      {(versionId || executionId) && <div className="research-scope-evidence"><strong>{versionId ? label("证据溯源", "Evidence provenance") : label("研究结果", "Research result")}</strong>
        <button type="button" onClick={() => { setVersionId(""); setExecutionId(""); }}>{label("关闭", "Close")}</button>
        {evidence?.id === (versionId || executionId) && <pre>{JSON.stringify(evidence.value, null, 2)}</pre>}
      </div>}
    </section>}
  </details>;
}
