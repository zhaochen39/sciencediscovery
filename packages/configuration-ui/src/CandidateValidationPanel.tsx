// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CandidateExperiment, CandidateExperimentRequest, CandidatePreparationResult, CandidateValidation, CandidateValidationMetric, SessionArtifactOutput } from "@sciencediscovery/schema";

const roles = ["baseline", "candidate"] as const;
const active = (job: CandidateExperiment) => job.status === "running" || job.status === "unconfirmed";
export type CandidateExperimentAction = (input: Record<string, unknown>) => Promise<CandidateExperiment | CandidateExperiment[] | CandidatePreparationResult | null>;

export function CandidateValidationPanel({ researchId, candidateId, results, evidenceIds, maySubmit, disabled, loadOutputs,
  experiment, onAttached, onSelectEvidence, openVersion, locale }: {
  researchId: string;
  candidateId: string;
  results: CandidateValidation[];
  evidenceIds?: string[];
  onSelectEvidence?: (validationId: string) => void;
  maySubmit: boolean;
  disabled: boolean;
  loadOutputs: () => Promise<SessionArtifactOutput[]>;
  experiment: CandidateExperimentAction;
  onAttached: () => void;
  openVersion: (versionId: string) => Promise<Blob>;
  locale: "zh" | "en";
}) {
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const [outputs, setOutputs] = useState<SessionArtifactOutput[]>();
  const [error, setError] = useState<string>();
  const [jobs, setJobs] = useState<CandidateExperiment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [preparation, setPreparation] = useState<CandidatePreparationResult>();
  const renderedResults = useRef(results);
  renderedResults.current = results;
  const [draft, setDraft] = useState<Omit<CandidateExperimentRequest, "researchId" | "candidateId">>({
    metric: "mae", inputVersionId: "", referenceVersionId: "", baselineScriptVersionId: "", candidateScriptVersionId: "",
  });
  useEffect(() => {
    if (!open || !maySubmit) return;
    let active = true;
    setOutputs(undefined);
    setError(undefined);
    void loadOutputs().then(
      (rows) => { if (active) setOutputs(rows); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, [loadOutputs, maySubmit, open]);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const updated = await experiment({ operation: "list", researchId }) as CandidateExperiment[];
        const entries = updated.filter(job => job.candidateId === candidateId);
        if (closed) return;
        const missing = entries.some(job => job.status === "ready" && job.validationId
          && !renderedResults.current.some(result => result.id === job.validationId));
        if (missing) onAttached();
        setJobs(entries);
      } catch (reason) {
        if (!closed) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!closed && maySubmit) timer = setTimeout(() => void load(), 3000);
      }
    }
    void load();
    return () => { closed = true; if (timer) clearTimeout(timer); };
  }, [researchId, candidateId, experiment, onAttached, maySubmit]);

  useEffect(() => {
    if (!open || !maySubmit) return;
    let closed = false;
    void experiment({ operation: "preparations", researchId, candidateId }).then(value => {
      if (closed || !value || !("runId" in value)) return;
      setPreparation(value);
      if (value.versionId) setDraft(current => current.candidateScriptVersionId ? current : ({
        ...current, inputVersionId: value.inputVersionId,
        baselineScriptVersionId: value.sourceVersionId, candidateScriptVersionId: value.versionId!, preparationRunId: value.runId,
      }));
    }).catch(reason => { if (!closed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { closed = true; };
  }, [open, maySubmit, experiment, researchId, candidateId]);

  useEffect(() => {
    if (preparation?.status !== "running") return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(runId: string) {
      try {
        const result = await experiment({ operation: "prepared", runId }) as CandidatePreparationResult;
        if (closed) return;
        if (result.status === "running") {
          timer = setTimeout(() => void poll(runId), 2500);
          return;
        }
        if (result.versionId) {
          const rows = await loadOutputs();
          if (closed) return;
          setOutputs(rows);
          setDraft(current => ({ ...current, inputVersionId: result.inputVersionId,
            baselineScriptVersionId: result.sourceVersionId, candidateScriptVersionId: result.versionId!, preparationRunId: runId }));
        }
        setPreparation(result);
      } catch (reason) {
        if (closed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        timer = setTimeout(() => void poll(runId), 5000);
      }
    }
    timer = setTimeout(() => void poll(preparation.runId), 2500);
    return () => { closed = true; clearTimeout(timer); };
  }, [preparation, experiment, loadOutputs]);

  const fields = [
    ["inputVersionId", zh ? "开发集输入" : "Development inputs", false],
    ["referenceVersionId", zh ? "开发集参考值" : "Development reference", false],
    ["baselineScriptVersionId", zh ? "基线脚本" : "Baseline script", true],
    ["candidateScriptVersionId", zh ? "候选脚本" : "Candidate script", true],
  ] as const;
  const status = zh ? { running: "运行中", unconfirmed: "等待确认", failed: "验证失败", cancelled: "已取消", ready: "已验证" }
    : { running: "Running", unconfirmed: "Waiting for confirmation", failed: "Validation failed", cancelled: "Cancelled", ready: "Validated" };
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 7 });
  const metricName = (metric: CandidateValidationMetric) => metric === "nrmse" ? (zh ? "全局 nRMSE" : "Global nRMSE") : metric === "mae" ? "MAE" : "Accuracy";
  const busy = disabled || submitting || preparation?.status === "running" || jobs.some(active);
  async function prepare() {
    setError(undefined);
    setSubmitting(true);
    try {
      const run = await experiment({ operation: "prepare", researchId, candidateId,
        sourceVersionId: draft.baselineScriptVersionId, inputVersionId: draft.inputVersionId }) as CandidatePreparationResult;
      setPreparation(run);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSubmitting(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const job = await experiment({ ...draft, operation: "start", researchId, candidateId }) as CandidateExperiment;
      setJobs(current => [job, ...current.filter(old => old.id !== job.id)]);
      setOpen(false);
      if (job.status === "ready") onAttached();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSubmitting(false); }
  }
  async function download(versionId: string) {
    try {
      const url = URL.createObjectURL(await openVersion(versionId));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${versionId}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function updateJob(operation: "cancel" | "retry", id: string) {
    setError(undefined);
    try {
      const job = await experiment({ operation, id }) as CandidateExperiment;
      setJobs(current => [job, ...current.filter(old => old.id !== job.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  const visibleResults = new Map(results.map(result => [result.id, result]));
  for (const job of jobs) {
    if (job.status === "ready" && job.result && !visibleResults.has(job.result.id)) visibleResults.set(job.result.id, job.result);
  }
  return <section aria-label={zh ? "实测验证" : "Measured validation"}>
    {[...visibleResults.values()].map((result) => <details key={result.id}>
      <summary>{metricName(result.metric)} · {zh ? "改善量" : "Improvement"} {number.format(result.improvement)}</summary>
      <p>{zh ? "基线" : "Baseline"} {number.format(result.baseline)} · {zh ? "候选" : "Candidate"} {number.format(result.candidate)} · n={result.sampleCount}</p>
      <div className="idea-research-actions">
        <button className="secondary-button" type="button" onClick={() => void download(result.referenceVersionId)}>{zh ? "参考值" : "Reference"}</button>
        <button className="secondary-button" type="button" onClick={() => void download(result.baselineVersionId)}>{zh ? "基线预测" : "Baseline predictions"}</button>
        <button className="secondary-button" type="button" onClick={() => void download(result.candidateVersionId)}>{zh ? "候选预测" : "Candidate predictions"}</button>
      </div>
      <dl>
        <div><dt>{zh ? "基线运行" : "Baseline run"}</dt><dd><code style={{ overflowWrap: "anywhere" }}>{result.baselineExecutionId}</code></dd></div>
        <div><dt>{zh ? "候选运行" : "Candidate run"}</dt><dd><code style={{ overflowWrap: "anywhere" }}>{result.candidateExecutionId}</code></dd></div>
      </dl>
    </details>)}
    {evidenceIds?.length ? <details><summary>{zh ? "构思引用的验证" : "Validation cited by this proposal"}</summary>
      <ul>{evidenceIds.map(id => <li key={id}>{onSelectEvidence
        ? <button className="secondary-button" type="button" onClick={() => onSelectEvidence(id)} style={{ overflowWrap: "anywhere" }}>{id}</button>
        : <code style={{ overflowWrap: "anywhere" }}>{id}</code>}</li>)}</ul>
    </details> : null}
    {jobs.filter(job => job.status !== "ready").map(job => <div key={job.id}>
      <p role="status">{status[job.status]} · {job.executionIds.candidate ? (zh ? "候选" : "Candidate") : (zh ? "基线" : "Baseline")}</p>
      {job.error && <p role="alert">{job.error}</p>}
      {active(job) && <button className="secondary-button" type="button" disabled={job.stopRequested} onClick={() => void updateJob("cancel", job.id)}>{zh ? "停止实验" : "Stop experiment"}</button>}
      {maySubmit && (job.status === "failed" || job.status === "cancelled") && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void updateJob("retry", job.id)}>{zh ? "重新验证" : "Retry validation"}</button>}
      <ul>{roles.flatMap(role => job.executionIds[role] ? [<li key={role}><code style={{ overflowWrap: "anywhere" }}>{job.executionIds[role]}</code></li>] : [])}</ul>
    </div>)}
    {maySubmit && (open ? <form onSubmit={(event) => void submit(event)}>
      <p>{zh ? "确认后，本地 Runner 会在无网络的独立工作区依次运行两份 Python 脚本。脚本读取 input.json，并将 [{id, value}] JSON 写到标准输出。参考值仅用于评分。" : "After confirmation, the local Runner executes both Python scripts in separate workspaces without network access. Each script reads input.json and prints a JSON array of {id, value}. The reference is reserved for scoring."}</p>
      <fieldset disabled={busy}>
        <label>{zh ? "指标" : "Metric"} <select value={draft.metric} onChange={(event) => setDraft({ ...draft, metric: event.target.value as CandidateValidationMetric })}>
          <option value="mae">MAE</option><option value="accuracy">Accuracy</option><option value="nrmse">{metricName("nrmse")}</option>
        </select></label>
        {fields.map(([field, label, script]) => <label key={field} style={{ display: "block" }}>{label}
          <select required value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value,
            preparationRunId: field === "inputVersionId" || field === "candidateScriptVersionId" ? undefined : draft.preparationRunId })} style={{ display: "block", maxWidth: "100%" }}>
            <option value="">{zh ? "选择产物版本" : "Select a version"}</option>
            {outputs?.filter(({ version }) => script === (version.sourcePath?.toLowerCase().endsWith(".py") === true || version.mediaType === "text/x-python"))
              .map(({ artifact, version }) => <option key={version.id} value={version.id}>{artifact.name} · v{version.version}</option>)}
          </select>
        </label>)}
        <label>{zh ? "随机种子" : "Random seed"} <input type="number" min={0} max={4294967295} step={1}
          value={draft.seed ?? 0} onChange={event => setDraft({ ...draft, seed: event.target.value === "" ? undefined : event.target.valueAsNumber })} /></label>
      </fieldset>
      <button className="secondary-button" type="button" disabled={busy || !draft.baselineScriptVersionId || !draft.inputVersionId}
        onClick={() => void prepare()}>{zh ? "用 JiuwenSwarm 准备候选脚本" : "Prepare candidate script with JiuwenSwarm"}</button>
      {preparation?.status === "running" && <p role="status">{zh ? "正在准备候选脚本。请在会话中处理运行授权。" : "Preparing candidate script. Review execution requests in the conversation."}</p>}
      {preparation?.status === "failed" && <p role="alert">{zh ? "候选脚本未发布。请查看该 Agent 运行。" : "The candidate script was not published. Review the Agent run."}</p>}
      {!outputs && !error && <p role="status">{zh ? "正在加载产物" : "Loading artifacts"}</p>}
      {outputs?.length === 0 && <p role="status">{zh ? "当前会话中没有可用产物。" : "This session has no eligible artifacts."}</p>}
      <button className="primary-button" type="submit" disabled={busy || !outputs?.length || fields.some(([field]) => !draft[field]) || new Set(fields.map(([field]) => draft[field])).size !== 4}>
        {submitting ? (zh ? "正在提交" : "Submitting") : (zh ? "确认运行并评分" : "Confirm, run and score")}
      </button>
      <button className="secondary-button" type="button" disabled={submitting} onClick={() => setOpen(false)}>{zh ? "取消" : "Cancel"}</button>
    </form> : <button className="secondary-button" type="button" disabled={busy} onClick={() => setOpen(true)}>{zh ? "验证此候选" : "Validate candidate"}</button>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
