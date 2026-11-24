import { mkdir, readFile, writeFile, readdir, stat, cp, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ScopeProjectionTrace } from "../../../packages/context/src/scope-projection.ts";
import { VERIFIED_STAGE_STATE, type VerifiedStageClosure, type VerifiedStageAlternatives } from "../../../packages/context/src/verified-stage-projection.ts";
import { streamModelTurn } from "../../../packages/model/src/client.ts";
import type { NativeAgentRunResult } from "../../../services/api/src/native-agent/index.ts";

const alternateNativeRoot = process.env.SCIENCE_SPINE_NATIVE_ROOT;
const { createNativeAgent, setModelTurnStreamerForTest } = alternateNativeRoot
  ? await import(pathToFileURL(resolve(alternateNativeRoot, "services/api/src/native-agent/index.ts")).href) as typeof import("../../../services/api/src/native-agent/index.ts")
  : await import("../../../services/api/src/native-agent/index.ts");

import { calibrationArtifacts, calibrationContinuation, calibrationContract, calibrationPrompt, calibrationStages,
  captureCalibrationClosure, currentCalibrationClosures, readCalibrationArtifacts, validateCalibration, writeCalibrationInput,
  type CalibrationEvidence } from "./calibration-workload.ts";

import { captureSolarClosure, readSolarArtifacts, solarArtifacts, solarContinuation, solarContract, solarForkStage,
  attestSolarReadout, auditedReadoutCandidate, enrichSolarClosures, solarHandoffClosures, solarPrompt, solarReadoutCandidate, solarReportContinuation, solarStages, validateSolar, writeSolarInput } from "./solar-workload.ts";

import { findDisplayEvidence, planResearchRecovery, projectVerifiedResearchEvidence, type DisplayReceipt }
  from "../../../services/api/src/native-agent/research-recovery.ts";
import { chooseStageProjection, type WorkflowStage } from "./stage-policy.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../../");
const outputRoot = resolve(process.env.SCIENCE_SPINE_LOG_DIR ?? join(repositoryRoot, "test/benchmarks/research-spine-value-validation/logs"));
const repetitions = Number(process.env.SCIENCE_SPINE_REPETITIONS ?? 1);
const firstPair = Number(process.env.SCIENCE_SPINE_FIRST_PAIR ?? 1);
const modes = ["dynamic", "shadow", "projection", "dynamic-shadow", "projection-linked", "projection-handoff", "projection-adaptive", "adaptive-shadow"] as const;
const workload = process.env.SCIENCE_SPINE_CASE ?? "four-stage";
if (!["four-stage", "audit", "short", "calibration", "calibration-review", "solar"].includes(workload)) throw new Error("Unknown SCIENCE_SPINE_CASE");
const allArtifacts = [
  "phase1_quality.json",
  "cleaned_cohort.csv",
  "descriptive_stats.json",
  "model_results.json",
  "sensitivity.json",
  "final_report.md",
] as const;
const calibrationReview = workload === "calibration-review";
const calibration = workload === "calibration" || calibrationReview;
const calibrationPoints = calibrationReview ? 72 : 12;
const solarPolicy: WorkflowStage[] = [
  { id: "site-quality", kind: "quality", consumes: [] },
  { id: "technology-grouping", kind: "analysis", consumes: ["site_qc.csv"] },
  { id: "complete-site-sensitivity", kind: "analysis", consumes: ["site_qc.csv"] },
  { id: "solar-report", kind: "report", consumes: [] },
];
const calibrationPolicy: WorkflowStage[] = [
  { id: "instrument-qc", kind: "quality", consumes: [] },
  { id: "batch-fit", kind: "analysis", consumes: ["cleaned.csv"] },
  { id: "drift-check", kind: "analysis", consumes: ["fits.json"] },
  { id: "calibration-report", kind: "report", consumes: [] },
];
const solar = workload === "solar";
const requiredArtifacts = solar ? solarArtifacts : calibration ? calibrationArtifacts : workload === "short" ? allArtifacts.slice(0, 2) : allArtifacts;

type Mode = typeof modes[number];
const splitQc = solar && process.env.SCIENCE_SPINE_SPLIT_QC === "1";
const requireReview = calibrationReview || (solar && process.env.SCIENCE_SPINE_REQUIRE_REVIEW === "1");
const reviewFile = calibrationReview ? "cleaned.csv" : "site_qc.csv";
const selectedModes: Mode[] = (process.env.SCIENCE_SPINE_MODES?.split(",").map((value) => value.trim()).filter((value): value is Mode => (modes as readonly string[]).includes(value)) ?? ["dynamic", "shadow", "projection"]);

type RunSummary = {
  id: string;
  repetition: number;
  mode: Mode;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelTurns: number;
  toolCalls: number;
  toolCallNames: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageEvents: number;
  projectionAudit: Awaited<ReturnType<typeof auditProjection>>;
  requiredArtifacts: string[];
  completedStages: number;
  artifactCompleteness: number;
  artifactValidation: { passed: boolean; errors: string[] };
  finalReportChars: number;
  completionMode: "model_stop" | "acceptance_boundary" | "error";
  firstRequestUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; providerReported: boolean };
  error?: string;
  processId?: number;
  qualityWrites?: string[];
  stagePolicy?: Array<{ turn: number; nextStage?: string; reason: string }>;
};

async function auditProjection(runRoot: string) {
  const root = join(runRoot, "context-traces");
  const entries = await readdir(root, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const observations: Array<{ durationMs: number; error?: string }> = [];
  const rows: Array<{ turn: number; selectedPath: string; memoryInModelInput: boolean; projection: ScopeProjectionTrace }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const trace = JSON.parse(await readFile(join(root, entry), "utf8")) as {
      turn: number; selectedPath: string; projection?: ScopeProjectionTrace;
      projectionObservation?: { durationMs: number; error?: string };
      llmInput?: { history?: Array<{ additional_kwargs?: { scope_node_memory?: boolean } }> };
    };
    if (trace.projectionObservation) observations.push(trace.projectionObservation);
    if (trace.projection) rows.push({
      turn: trace.turn,
      selectedPath: trace.selectedPath,
      memoryInModelInput: trace.llmInput?.history?.some((message) => message.additional_kwargs?.scope_node_memory === true) ?? false,
      projection: trace.projection,
    });
  }
  const skipReasons: Record<string, number> = {};
  for (const { projection } of rows) {
    if (projection.skipReason) skipReasons[projection.skipReason] = (skipReasons[projection.skipReason] ?? 0) + 1;
  }
  return {
    traces: rows.length,
    admitted: rows.filter(({ projection }) => projection.applied).length,
    applied: rows.filter(({ selectedPath, memoryInModelInput, projection }) => selectedPath === "projection" && memoryInModelInput && projection.applied).length,
    skipReasons,
    observations,
    rows,
  };
}

function csv(): string {
  const rows = ["subject_id,treatment_group,age,biomarker_a,biomarker_b,sex,stage,smoking_status,outcome_30d,follow_up_days"];
  for (let i = 1; i <= 60; i += 1) {
    const treatment = i <= 30 ? "treated" : "control";
    const missing = i === 7 || i === 42 ? "" : String(1.2 + (i % 7) * 0.12 + (treatment === "treated" ? 0.35 : 0));
    const duplicate = i === 60 ? 59 : i;
    rows.push(`${duplicate},${treatment},${35 + (i % 30)},${missing},${2.1 + (i % 5) * 0.2},${i % 2 ? "F" : "M"},${i % 3 === 0 ? "III" : "II"},${i % 4 === 0 ? "yes" : "no"},${treatment === "treated" ? (i % 6 === 0 ? 0 : 1) : (i % 3 === 0 ? 1 : 0)},${20 + (i % 40)}`);
  }
  return `${rows.join("\n")}\n`;
}

const validateOnTool = process.env.SCIENCE_SPINE_VALIDATE_ON_TOOL === "1";
const runContract = solar ? solarContract : calibration ? calibrationContract : workload === "short" ? "Use one run_shell call to validate and clean the cohort, then stop naturally. The only required files are phase1_quality.json and cleaned_cohort.csv. If the tool reports BENCHMARK_VALIDATION_FAILED, repair the listed errors and then stop." : `
This benchmark has a fixed four-phase completion contract. The only callable tool for this benchmark is run_shell. Do not call declare_artifact, list_files, read_file, web_search, or any other tool, even if general workspace instructions mention them. Use exactly one run_shell call for each phase. Phase 1 must inspect the CSV and create its two required files in the same call, so do not make a preliminary inspection call. The required artifacts are phase1_quality.json, cleaned_cohort.csv, descriptive_stats.json, model_results.json, sensitivity.json, and final_report.md. The run is complete only when all six artifacts exist, the final report references the five supporting artifacts, and the acceptance validator can parse the artifacts. After the fourth phase verifies that condition, stop immediately and return a short completion message. Do not run an extra inspection, repair, exploratory analysis, or report rewrite after the completion condition is satisfied. If a phase command fails, repair only that phase and continue.${validateOnTool ? "\nWhen the workspace tool reports BENCHMARK_VALIDATION_FAILED, repair the named artifacts with run_shell. Keep the original task requirements and stop naturally after the validation passes." : ""}
`.trim();

const fullPrompt = `
Run a controlled local benchmark with cohort.csv. Use only run_shell, standard-library Python, and the current workspace. The workspace contains only cohort.csv. Do not use list_files, read_file, web search, network, subagents, package discovery, or any installed third-party package.
Complete the work in four short phases and use one run_shell call per phase. Each phase must create its required files in that same call. Do not spend a turn investigating correlations among subject_id, age, or follow_up_days, and do not create exploratory scripts. The only analysis target is the treated versus control outcome_30d comparison.
1. Read cohort.csv and create phase1_quality.json and cleaned_cohort.csv. Use subject_id as the duplicate key. The known duplicate subject_id is 59, so keep its first occurrence and remove one row. Keep the raw facts in phase1_quality.json using these keys where possible: raw_rows, raw_columns, duplicate_subject_ids, duplicate_subject_count, missing_biomarker_a_count_raw. Impute the two missing biomarker_a values with the cohort median so cleaned_cohort.csv has no missing biomarker_a values. Preserve exactly the original 10 columns in cleaned_cohort.csv and do not add helper or provenance columns.
2. Read the cleaned data and create descriptive_stats.json. Record treated and control counts and outcome_30d event rates.
3. Create model_results.json with the treatment outcome direction and descriptive uncertainty. Use these stable top-level fields where possible: direction, contingency, event_rate, absolute_risk_difference, risk_ratio, odds_ratio. Use only a standard-library two-proportion normal-approximation 95% confidence interval for the treated-minus-control risk difference, with 1.96 as the critical value. Do not implement a t distribution, call external packages, or add exploratory model variants.
4. Create sensitivity.json and final_report.md before doing any verification. Sensitivity entries should reuse the same risk-difference field names from model_results.json, and the report must reference all five supporting files. The final report must reference all five earlier files, state the exact raw facts 60 rows, 10 columns, 1 duplicate subject, and 2 missing biomarker_a values, and state the treatment effect direction with uncertainty. After the two files are written, use the same call to verify their existence and stop immediately. In the next response, report completion with no additional tool call. Do not inspect any file, package, or environment after this verification.
The expected raw quality facts are 60 rows, 10 columns, one duplicate subject, and two missing biomarker_a values. After all six files exist, verify that the final report and all five supporting files are present, then stop. Keep shell output short and do not create exploratory scripts after the required files are complete.
`.trim();

const taskPrompt = solar ? (splitQc ? solarPrompt.replace("Print the complete site_qc.csv once as the per-site review table.", "Display the complete site_qc.csv in a separate read-only tool call once as the per-site review table.") : solarPrompt) : calibration ? (calibrationReview ? calibrationPrompt.replace("print a short quality summary.",
  process.env.SCIENCE_SPINE_RECOVERY_BY_STATE === "1"
    ? "print a short quality summary. Before fitting, run the standalone shell command `cat cleaned.csv` once to display the complete raw CSV. The review requires the original CSV lines without line numbers or formatting."
    : "print a short quality summary. Before fitting, display the complete cleaned.csv table once for independent review.") : calibrationPrompt) : workload === "short" ? `Use only run_shell and standard-library Python. ${fullPrompt.split("\n").find((line) => line.startsWith("1. Read cohort.csv"))} Stop after the tool confirms validation.` : workload === "audit" ? `${fullPrompt}
For phase 1 the tool wrapper appends a trusted per-row cleaning audit to the response. Use accepted phase 1 artifact fields and summaries for later phases. The audit is generated from the submitted CSV and original inputs.` : fullPrompt;

function now(): string { return new Date().toISOString(); }

function csvRows(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  return {
    header: lines[0]?.split(",") ?? [],
    rows: lines.slice(1).map((line) => line.split(",")),
  };
}

function numericField(record: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

async function validateArtifacts(workspaceRoot: string, qualityOnly = workload === "short"): Promise<{ passed: boolean; errors: string[] }> {
  if (solar) {
    const errors = (await validateSolar(workspaceRoot)).errors.flat();
    return { passed: errors.length === 0, errors };
  }
  if (calibration) {
    const errors = validateCalibration(await readCalibrationArtifacts(workspaceRoot, calibrationReview), calibrationPoints).flat();
    return { passed: errors.length === 0, errors };
  }
  const errors: string[] = [];
  const readJson = async (name: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const value = JSON.parse(await readFile(join(workspaceRoot, name), "utf8")) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      errors.push(`${name} is not a JSON object`);
    } catch (error) {
      errors.push(`${name} cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  };
  const quality = await readJson("phase1_quality.json");
  const stats = qualityOnly ? undefined : await readJson("descriptive_stats.json");
  const model = qualityOnly ? undefined : await readJson("model_results.json");
  const sensitivity = qualityOnly ? undefined : await readJson("sensitivity.json");
  let cleaned: { header: string[]; rows: string[][] } = { header: [], rows: [] };
  try {
    cleaned = csvRows(await readFile(join(workspaceRoot, "cleaned_cohort.csv"), "utf8"));
  } catch (error) {
    errors.push(`cleaned_cohort.csv cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finalReport = "";
  if (!qualityOnly) try {
    finalReport = await readFile(join(workspaceRoot, "final_report.md"), "utf8");
  } catch (error) {
    errors.push(`final_report.md cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rawQuality = quality?.raw_quality_facts && typeof quality.raw_quality_facts === "object"
    ? quality.raw_quality_facts as Record<string, unknown>
    : quality?.raw_facts && typeof quality.raw_facts === "object"
      ? quality.raw_facts as Record<string, unknown>
      : quality ?? {};
  const rawRowCount = numericField(rawQuality, ["raw_row_count", "raw_rows", "rawRows", "row_count", "n_rows_raw", "n_rows"]);
  const rawColumnCount = numericField(rawQuality, ["raw_column_count", "raw_columns", "n_columns", "columns", "column_count"]);
  if (rawRowCount !== 60) errors.push(`raw row count does not match 60 (observed ${String(rawRowCount)})`);
  if (rawColumnCount !== 10) errors.push(`raw column count does not match 10 (observed ${String(rawColumnCount)})`);
  const duplicateIds = Array.isArray(rawQuality.duplicate_subject_ids)
    ? rawQuality.duplicate_subject_ids.length
    : rawQuality.duplicate_subject_ids && typeof rawQuality.duplicate_subject_ids === "object"
      ? Object.keys(rawQuality.duplicate_subject_ids as Record<string, unknown>).length
      : typeof rawQuality.duplicate_subject_ids === "string" && rawQuality.duplicate_subject_ids.trim()
        ? 1
        : typeof rawQuality.duplicate_subject_ids === "number" && Number.isFinite(rawQuality.duplicate_subject_ids)
          ? rawQuality.duplicate_subject_ids
          : undefined;
  const duplicateCount = numericField(rawQuality, ["duplicate_subject_count", "n_duplicate_subjects", "duplicateSubjectCount", "raw_duplicate_subject_count"]);
  if (duplicateCount !== 1 && duplicateIds !== 1 && numericField(rawQuality, ["n_duplicate_rows_removed", "duplicate_rows_removed"]) !== 1) errors.push("duplicate subject count does not match 1");
  const missingCounts = rawQuality.missing_counts && typeof rawQuality.missing_counts === "object"
    ? rawQuality.missing_counts as Record<string, unknown>
    : rawQuality.missing_by_column && typeof rawQuality.missing_by_column === "object"
      ? rawQuality.missing_by_column as Record<string, unknown>
      : undefined;
  const missing = numericField(rawQuality, ["missing_biomarker_a_count", "missing_biomarker_a_count_before", "missing_biomarker_a_count_raw", "missing_biomarker_a_raw", "raw_missing_biomarker_a", "missing_biomarker_a", "missingBiomarkerACount", "n_missing_biomarker_a", "biomarker_a_missing_values"])
    ?? numericField(missingCounts ?? {}, ["biomarker_a"]);
  if (missing !== 2) errors.push(`missing biomarker_a count does not match 2 (observed ${String(missing)})`);
  if (cleaned.header.length !== 10) errors.push(`cleaned cohort has ${cleaned.header.length} columns instead of 10`);
  if (cleaned.rows.length !== 59) errors.push("cleaned cohort must have 59 rows");
  if (qualityOnly) {
    const raw = csvRows(await readFile(join(workspaceRoot, "cohort.csv"), "utf8"));
    const biomarker = raw.header.indexOf("biomarker_a");
    const numericColumns = new Set([biomarker, raw.header.indexOf("biomarker_b")]);
    const firstById = new Map<string, string[]>();
    for (const row of raw.rows) if (!firstById.has(row[0]!)) firstById.set(row[0]!, row);
    const median = (rows: readonly string[][]) => {
      const values = rows.filter((row) => row[biomarker]).map((row) => Number(row[biomarker])).sort((a, b) => a - b);
      return (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2;
    };
    // Task wording permits either original-cohort or deduplicated-cohort median.
    const medians = [median(raw.rows), median([...firstById.values()])];
    const numericMatch = (value: string, expected: number) => value.trim() !== ""
      && Number.isFinite(Number(value)) && Math.abs(Number(value) - expected) <= 1e-9;
    if (JSON.stringify(raw.header) !== JSON.stringify(cleaned.header) || cleaned.rows.some((row) => {
      const original = firstById.get(row[0]!);
      return !original || row.length !== original.length || row.some((value, column) => {
        if (column === biomarker && !original[column]) return !medians.some((expected) => numericMatch(value, expected));
        return numericColumns.has(column) ? !numericMatch(value, Number(original[column])) : value !== original[column];
      });
    })) errors.push("cleaned cohort differs from the first-occurrence rows with median imputation");
    return { passed: errors.length === 0, errors };
  }
  const subjectIndex = cleaned.header.indexOf("subject_id");
  const biomarkerIndex = cleaned.header.indexOf("biomarker_a");
  if (subjectIndex >= 0 && new Set(cleaned.rows.map((row) => row[subjectIndex])).size !== cleaned.rows.length) errors.push("cleaned cohort contains duplicate subject ids");
  if (biomarkerIndex >= 0 && cleaned.rows.some((row) => !row[biomarkerIndex]?.trim())) errors.push("cleaned cohort still has missing biomarker_a values");

  const treatmentIndex = cleaned.header.indexOf("treatment_group");
  const outcomeIndex = cleaned.header.indexOf("outcome_30d");
  if (treatmentIndex >= 0 && outcomeIndex >= 0) {
    const treated = cleaned.rows.filter((row) => row[treatmentIndex] === "treated");
    const control = cleaned.rows.filter((row) => row[treatmentIndex] === "control");
    const treatedRate = treated.length ? treated.reduce((total, row) => total + Number(row[outcomeIndex] ?? 0), 0) / treated.length : 0;
    const controlRate = control.length ? control.reduce((total, row) => total + Number(row[outcomeIndex] ?? 0), 0) / control.length : 0;
    const directionText = JSON.stringify({ stats, model, sensitivity, finalReport }).toLowerCase();
    if (treatedRate > controlRate && !/(treated[^\n]{0,100}(higher|harm)|positive|higher 30-day event|direction["']?\s*:\s*["']?higher)/u.test(directionText)) {
      errors.push("analysis outputs do not preserve the observed treated-higher outcome direction");
    }
  }
  for (const name of requiredArtifacts.slice(0, -1)) {
    if (!finalReport.includes(name)) errors.push(`final report does not reference ${name}`);
  }
  if (!/(?:\b60\b\**\s+(?:raw\s+)?rows?\b|\braw\s+rows?\s*[:=]\s*\**60\b)/iu.test(finalReport)) {
    errors.push("final report does not state 60 raw rows");
  }
  if (!/(?:10\s+columns?|columns?\s*[:=]\s*\**10|10\s*[x×]\s*10)/iu.test(finalReport)) errors.push("final report does not state 10 raw columns");
  const plainReport = finalReport.replace(/[`*]/gu, "");
  if (!/(?:\b(?:1|one|single)\s+duplicat(?:e|ed)\b|\bduplicat(?:e|ed)\s+(?:subjects?(?:_ids?)?|rows?)(?:\s+count)?\s*[:=]\s*(?:1|one)\b)/iu.test(plainReport)) {
    errors.push("final report does not state one duplicate subject");
  }
  if (!/(?:2|two)\s+missing[^\n]{0,80}biomarker_a|biomarker_a[^\n]{0,80}(?:(?:2|two)\s+missing|(?:2|two)\s+values)|missing[^\n]{0,80}biomarker_a[^\n]{0,80}(?:2|two)/iu.test(finalReport)) errors.push("final report does not state two missing biomarker_a values");
  if (!/uncertain|interval|confidence|\b95\s*%\s*CI\b/iu.test(finalReport)) errors.push("final report does not state uncertainty");
  return { passed: errors.length === 0, errors };
}

function runProcess(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function executionResult(input: { mode: "shell" | "python"; executionId: string; cwd: string; result: { exitCode: number; stdout: string; stderr: string } }) {
  const finishedAt = now();
  return {
    cgroupMode: "none",
    createdFiles: [],
    environmentRevisionId: input.mode === "shell" ? "local-wsl-shell-v1" : "local-wsl-python-v1",
    environmentVariables: {},
    executionId: input.executionId,
    exitCode: input.result.exitCode,
    finishedAt,
    kernelId: `local-${input.executionId}`,
    kernelMode: "ephemeral",
    language: input.mode,
    modifiedFiles: [],
    networkPolicy: "none",
    runnerVersion: "research-spine-value-validation",
    sandbox: "none",
    startedAt: finishedAt,
    stderr: input.result.stderr,
    stdout: input.result.stdout,
    workingDirectory: input.cwd,
  };
}

async function makeWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  if (solar) await writeSolarInput(root);
  else if (calibration) await writeCalibrationInput(root, calibrationPoints);
  else await writeFile(join(root, "cohort.csv"), csv(), "utf8");
}

async function filesPresent(workspaceRoot: string): Promise<{ present: string[]; finalReportChars: number; artifactValidation: { passed: boolean; errors: string[] } }> {
  const present: string[] = [];
  let finalReportChars = 0;
  for (const name of requiredArtifacts) {
    try {
      const file = await stat(join(workspaceRoot, name));
      if (file.isFile() && file.size > 0) present.push(name);
      if (name === "final_report.md" || name === "calibration_report.md" || name === "solar_report.md") finalReportChars = file.size;
    } catch { /* missing artifact is part of the acceptance result */ }
  }
  return { present, finalReportChars, artifactValidation: await validateArtifacts(workspaceRoot) };
}

type FrozenPrefix = { workspace: string; history: NativeAgentRunResult["finalMessages"]; closures: VerifiedStageClosure[];
  boundary?: "solar-quality" | "calibration-quality"; calibrationHandoff?: CalibrationRecoveryHandoff; compactRecovery?: SolarRecoveryState; recoveryStep?: SolarRecoveryStep;
  recoveryHandoff?: SolarRecoveryHandoff; displayHistory?: FrozenPrefix["history"]; retireDisplay?: DisplayReceipt };
const checkpointCapture = process.argv[2] === "--checkpoint-capture";
const stateResume = process.argv[2] === "--checkpoint-resume-by-state";
const receiptResume = process.argv[2] === "--checkpoint-resume-receipt";
const retireResume = process.argv[2] === "--checkpoint-resume-retire-display";
const evidenceResume = retireResume || process.argv[2] === "--checkpoint-resume-evidence";
const stateExperiment = process.env.SCIENCE_SPINE_RECOVERY_BY_STATE === "1" || stateResume;
const auditRetirement = stateExperiment || process.env.SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY === "1";
const handoffResume = evidenceResume || receiptResume || process.argv[2] === "--checkpoint-resume-handoff";
const stepResume = handoffResume || process.argv[2] === "--checkpoint-resume-next-step";
const compactResume = stepResume || process.argv[2] === "--checkpoint-resume-compact";
const nextStepExperiment = process.env.SCIENCE_SPINE_RECOVERY_NEXT_STEP === "1";
const captureReview = process.env.SCIENCE_SPINE_CAPTURE_REVIEW;
if (captureReview && !["pending", "displayed"].includes(captureReview)) throw new Error("Invalid checkpoint review state");
const checkpointResume = stateResume || compactResume || process.argv[2] === "--checkpoint-resume";
const recoveryAudit = checkpointCapture || checkpointResume || process.env.SCIENCE_SPINE_RECOVERY_AUDIT === "1";
// Keep the real transport. Record the provider usage omitted by the task ledger for summary requests.
if (process.env.SCIENCE_SPINE_RECOVERY_USAGE_AUDIT === "1") {
  setModelTurnStreamerForTest(async (...args) => {
    const turn = await streamModelTurn(...args);
    if (args[3].length === 0) console.log(`[recovery-summary-usage] ${JSON.stringify(turn.usage ?? null)}`);
    return turn;
  });
}
const solarQualityFiles = ["daily_clean.csv", "site_qc.csv"] as const;
const checkpointQualityFiles = calibrationReview ? calibrationStages[0] : solarQualityFiles;
const checkpointPhase = calibrationReview ? "calibration-quality" : "solar-quality";
const checkpointQualityStage = calibrationReview ? "instrument-qc" : "site-quality";
const retirementStage = calibrationReview ? "batch-fit" : solarForkStage;
const solarQualityContinuation = "Continue the original task from the validated quality checkpoint. Preserve daily_clean.csv and site_qc.csv. If the complete current site_qc.csv table has not yet been displayed, display it with a standalone run_shell call before grouping. Then complete grouping, sensitivity and the report under the original requirements. Stop naturally after acceptance.";
const calibrationQualityContinuation = "Continue the original task from the validated quality checkpoint. Preserve cleaned.csv and qc.json. If the complete raw CSV has not yet been displayed at this revision, start with a standalone run_shell call using exactly cat cleaned.csv. Do not add line numbers or reformatted output. Then fit the batches, check drift, and deliver the report. Stop naturally after acceptance.";
type CalibrationRecoveryHandoff = {
  acceptedStage: "instrument-qc";
  acceptedFiles: { path: string; sha256: string }[];
  review: "already displayed";
  nextAction: { input: "cleaned.csv"; output: "fits.json"; groupBy: "batch"; method: "ordinary least squares" };
};

function calibrationHandoffPrompt(handoff: CalibrationRecoveryHandoff): string {
  return `Continue the original task from the validated quality checkpoint.
The runtime verified the accepted files in the current run_shell workspace and validated their contents. The complete cleaned.csv review is already satisfied for this exact revision, as shown by the preceding tool result. Carry that completed state forward even after starting the fit. Preserve the accepted files.
Start with a run_shell call that reads cleaned.csv, fits each batch, and writes fits.json. Read the accepted files inside the calculation or reporting call that needs them. Workspace listing, separate existence checks, and repeating the full-table display are unnecessary because the runtime already verified them.
Verified workspace handoff:
${JSON.stringify(handoff, null, 2)}
Apply the original requirements to the remaining fit, drift and report stages. Stop naturally after acceptance.

Original task:
${taskPrompt}`;
}

type SolarRecoveryState = {
  acceptedStage: "site-quality";
  artifactSha256: Record<string, string>;
  review: "already displayed" | "still required";
  pendingStages: string[];
};

type SolarRecoveryStep = {
  firstPending: "display-quality-table" | "technology-grouping";
  qualityFacts: Awaited<ReturnType<typeof validateSolar>>["facts"][number];
  downstreamFields: Awaited<ReturnType<typeof validateSolar>>["handoff"][number];
};

type SolarRecoveryHandoff = {
  acceptedStage: SolarRecoveryState["acceptedStage"];
  review: SolarRecoveryState["review"];
  acceptedFiles: { path: string; sha256: string; columns?: string[] }[];
  firstPending: SolarRecoveryStep["firstPending"];
  nextAction: { input: string; command: string } | {
    input: string; output: string; groupBy: string; value: string; weighting: "equal per site";
    groups: string[]; outputFields: string[];
  };
  pendingStages: string[];
  displayReceipt?: DisplayReceipt;
};

function buildRecoveryHandoff(state: SolarRecoveryState, snapshot: Awaited<ReturnType<typeof readSolarArtifacts>>): SolarRecoveryHandoff {
  const acceptedFiles = solarQualityFiles.map((path) => {
    const bytes = snapshot.get(path);
    const sha256 = state.artifactSha256[path]!;
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error(`Accepted file missing or no longer at its checkpoint revision: ${path}`);
    }
    const columns = path === "site_qc.csv" ? bytes.toString("utf8").split(/\r?\n/u, 1)[0]!.split(",") : undefined;
    return { path, sha256, ...(columns ? { columns } : {}) };
  });
  const pendingReview = state.review === "still required";
  return {
    acceptedStage: state.acceptedStage, review: state.review, acceptedFiles,
    firstPending: pendingReview ? "display-quality-table" : "technology-grouping",
    nextAction: pendingReview ? { input: "site_qc.csv", command: "cat site_qc.csv" } : {
      input: "site_qc.csv", output: "groups.json", groupBy: "technology", value: "mean_index",
      weighting: "equal per site", groups: ["mono", "poly", "thin_film"], outputFields: ["sites", "mean_index"],
    },
    pendingStages: state.pendingStages,
  };
}

function handoffPrompt(handoff: SolarRecoveryHandoff): string {
  const firstAction = handoff.firstPending === "display-quality-table"
    ? "Start with a standalone run_shell call: cat site_qc.csv. Review the full output before grouping."
    : "Start with a run_shell call that reads site_qc.csv and computes and writes groups.json, printing the three group summaries. The current revision already satisfied the full table review."
      + (handoff.displayReceipt ? " The displayReceipt records the successful full-table display in the prior trajectory and binds it to the current file revision. Treat that step as completed." : "");
  return `Continue the original task from the validated quality checkpoint.
The verified paths below are relative to the current run_shell working directory. The runtime checked presence, versions and QC computation before opening this session. Use the provided schema directly in the next action. Read any needed rows in that action and preserve the accepted files.
${firstAction}
Verified workspace handoff:
${JSON.stringify(handoff, null, 2)}
Apply all original requirements for unfinished work and stop naturally after acceptance.

Original task:
${taskPrompt}`;
}

const reviewOrderContract = "Before writing groups.json, ensure the complete current site_qc.csv table has already been emitted in an earlier successful tool call, here or in the validated checkpoint history. When still pending, emit it as a separate read-only call.";

function nextStepPrompt(state: SolarRecoveryState, step: SolarRecoveryStep): string {
  const firstAction = step.firstPending === "display-quality-table"
    ? "Your next tool call should display the full site_qc.csv table (cat site_qc.csv). Then run the grouping calculation."
    : "Your next tool call should compute and write groups.json from site_qc.csv. The table was already displayed at this revision.";
  return `Continue the original task from the validated quality checkpoint.
${firstAction}
The runtime already verified the workspace, file versions and QC computations. Start with the specified pending action. Read rows within the grouping computation and print its requested summaries. Preserve the accepted QC artifacts.
Verified recovery state:
${JSON.stringify({ ...state, ...step }, null, 2)}
Apply all original requirements for unfinished work and stop naturally after acceptance.

Original task:
${taskPrompt}`;
}

function containsReviewTable(output: string, table: string): boolean {
  const expected = table.replaceAll("\r\n", "\n").trimEnd();
  return expected.length > 0 && output.replaceAll("\r\n", "\n").includes(expected);
}

function hasReviewEvidence(history: FrozenPrefix["history"], table: string): boolean {
  return history.some((message) => message.role === "tool" && typeof message.content === "string"
    && message.content.includes(`"exitCode":0`) && containsReviewTable(message.content.split("\nstdout:\n")[1] ?? "", table));
}

function solarRecoveryPrompt(state: SolarRecoveryState): string {
  return `Continue the original task from the validated quality checkpoint.
The following verified recovery state takes precedence over the instructions for work already completed:
${JSON.stringify(state, null, 2)}
Keep the accepted files byte-for-byte. Do not repeat QC calculations or writes.
If review is still required, display the complete current site_qc.csv with a read-only tool call before grouping. If already displayed, that obligation is complete.
Apply the original requirements for all remaining stages and stop naturally after acceptance.

Original task:
${taskPrompt}`;
}

async function hashesForCheckpoint(root: string): Promise<Record<string, string>> {
  const entries = await readdir(join(root, "workspace"), { recursive: true, withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() && !entry.isDirectory())) throw new Error("Checkpoint workspace contains unsupported file types");
  const files = ["final-messages.json", "verified-stages.json", ...entries.filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(root.length + 1))].sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash("sha256")
    .update(await readFile(join(root, file))).digest("hex")])));
}

async function runOne(repetition: number, mode: Mode, fork?: "capture" | FrozenPrefix): Promise<RunSummary> {
  const id = `${String(repetition).padStart(2, "0")}-${mode}-${randomUUID().slice(0, 8)}`;
  const runRoot = resolve(outputRoot, id);
  const workspaceRoot = join(runRoot, "workspace");
  const dataDir = join(runRoot, "data");
  await mkdir(runRoot, { recursive: true });
  if (fork && fork !== "capture") {
    await cp(fork.workspace, workspaceRoot, { recursive: true });
    const handoff = fork.recoveryHandoff ?? fork.calibrationHandoff;
    if (handoff) {
      for (const { path, sha256 } of handoff.acceptedFiles) {
        const copied = await readFile(join(workspaceRoot, path));
        if (createHash("sha256").update(copied).digest("hex") !== sha256) {
          throw new Error(`Recovery workspace copy differs from the verified revision: ${path}`);
        }
      }
    }
  } else await makeWorkspace(workspaceRoot);
  const startedAt = now();
  const events: unknown[] = [];
  const qualityWrites: string[] = [];
  let modelTurns = 0;
  let toolCalls = 0;
  const toolCallNames: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let usageEvents = 0;
  let firstRequestUsage: RunSummary["firstRequestUsage"];
  process.env.SCIENCE_AGENT_CONTEXT_TRACE = "1";
  process.env.SCIENCE_AGENT_CONTEXT_TRACE_DIR = join(runRoot, "context-traces");
  process.env.SCIENCE_AGENT_SCOPE_MEMORY_CHARS = process.env.SCIENCE_AGENT_SCOPE_MEMORY_CHARS ?? "6000";
  process.env.SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES = process.env.SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES ?? "6";
  const config = {
    baseUrl: process.env.E2E_LLM_BASE_URL ?? "",
    apiToken: process.env.E2E_LLM_TOKEN,
    apiProtocol: "openai-chat-completions",
    apiVariant: process.env.E2E_LLM_API_VARIANT ?? "openai",
    dataDir,
    model: process.env.E2E_LLM_MODEL ?? "",
    contextWindow: Number(process.env.SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS ?? 32_000),
    ...(process.env.SCIENCE_SPINE_THINKING_MODE === "disabled" || process.env.SCIENCE_SPINE_THINKING_MODE === "enabled"
      ? { thinkingMode: process.env.SCIENCE_SPINE_THINKING_MODE }
      : {}),
  } as any;
  if (!config.baseUrl || !config.model) throw new Error("E2E_LLM_BASE_URL and E2E_LLM_MODEL are required");

  const adaptive = mode === "projection-adaptive" || mode === "adaptive-shadow";
  const attestReadout = adaptive || (solar && (mode === "projection-linked" || mode === "projection-handoff" || fork === "capture"));
  const stagePolicy: NonNullable<RunSummary["stagePolicy"]> = [];
  let observedPolicy: Omit<(typeof stagePolicy)[number], "turn"> | undefined;
  const pendingReviewTables = new Map<string, string>();
  let observedSolarReview: string | undefined;
  if (requireReview && fork && fork !== "capture") {
    const table = await readFile(join(workspaceRoot, reviewFile), "utf8");
    if (fork.compactRecovery ? fork.compactRecovery.review === "already displayed" : hasReviewEvidence(fork.history, table)) {
      observedSolarReview = table;
    }
  }
  const pendingReadouts = new Map<string, { origin: string; stdout: string }>();
  const ambiguousReadouts = new Set<string>();
  let stageEvidence = fork && fork !== "capture" ? fork.closures as CalibrationEvidence[] : [];
  let closure = fork && fork !== "capture" ? fork.closures[0] : undefined;
  const fingerprints = async () => Promise.all(allArtifacts.slice(0, 2).map(async (path) => ({
    path, bytes: await readFile(join(workspaceRoot, path)),
  }))).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const revisions = (files: NonNullable<Awaited<ReturnType<typeof fingerprints>>>) =>
    files.map(({ path, bytes }) => ({ path, revision: createHash("sha256").update(bytes).digest("hex") }));
  const withoutReadout = (closures: CalibrationEvidence[]) => closures.map(({ resultSource: _source, ...closure }) => closure);
  const currentClosures = async () => {
    if (solar) {
      const closures = currentCalibrationClosures(await readSolarArtifacts(workspaceRoot), stageEvidence);
      if (mode === "projection-handoff") return solarHandoffClosures(workspaceRoot, closures);
      return attestReadout && !adaptive ? closures : withoutReadout(closures);
    }
    if (calibration) return withoutReadout(currentCalibrationClosures(await readCalibrationArtifacts(workspaceRoot, calibrationReview), stageEvidence));
    const files = closure && await fingerprints();
    if (!files || revisions(files).some(({ revision }, index) => revision !== closure?.artifacts[index]?.revision)) return [];
    return [closure!];
  };
  const adaptiveClosures = async (): Promise<VerifiedStageAlternatives> => {
    const snapshot = solar ? await readSolarArtifacts(workspaceRoot) : await readCalibrationArtifacts(workspaceRoot, calibrationReview);
    const closures = currentCalibrationClosures(snapshot, stageEvidence);
    const audit = solar ? await validateSolar(workspaceRoot) : undefined;
    const errors = audit?.errors ?? validateCalibration(snapshot, calibrationPoints);
    const { nextStage, reason, source } = chooseStageProjection(solar ? solarPolicy : calibrationPolicy, errors, closures);
    observedPolicy = { nextStage, reason };
    const fallback = withoutReadout(closures);
    if (!source) return { preferred: [], fallback };
    const candidate = audit ? enrichSolarClosures([source], audit)[0]! : {
      ...source,
      artifacts: source.artifacts.map((artifact) => artifact.path === "cleaned.csv" ? {
        ...artifact, fields: { ...artifact.fields, next_required: "Fit each batch independently using the validated cleaned.csv." },
      } : artifact),
    };
    return { preferred: [...fallback.filter((closure) => closure.stageId !== candidate.stageId), candidate],
      requiredStageId: candidate.stageId, fallback };
  };
  const qualityTimestamps = () => Promise.all(checkpointQualityFiles.map((name) => stat(join(workspaceRoot, name), { bigint: true })
    .then((file) => file.mtimeNs).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
  const runWorkspaceShell = async (code: string, cwd: string, signal: AbortSignal | undefined, toolCallId: string | undefined) => {
    if (solar) {
      const before = await readSolarArtifacts(workspaceRoot);
      const qualityBefore = recoveryAudit ? await qualityTimestamps() : undefined;
      const result = await runProcess("bash", ["--noprofile", "--norc", "-c", code], cwd, signal);
      if (qualityBefore && toolCallId && (await qualityTimestamps()).some((time, index) => time !== qualityBefore[index])) {
        qualityWrites.push(toolCallId);
      }
      if ((nextStepExperiment || stateExperiment) && toolCallId) {
        const after = await readSolarArtifacts(workspaceRoot);
        const changedArtifacts = solarArtifacts.filter(name => {
          const prior = before.get(name);
          const current = after.get(name);
          return current ? !prior?.equals(current) : prior !== undefined;
        });
        events.push({ at: now(), type: "recovery_tool_artifacts", toolCallId, changedArtifacts, exitCode: result.exitCode });
      }
      if (toolCallId && result.exitCode === 0) {
        const after = await readSolarArtifacts(workspaceRoot);
        const table = after.get("site_qc.csv")?.toString("utf8");
        if (requireReview && table && containsReviewTable(result.stdout, table)) pendingReviewTables.set(toolCallId, table);
        const evidence = await captureSolarClosure(workspaceRoot, before, after, toolCallId);
        if (evidence) stageEvidence = [...stageEvidence.filter((item) => item.stageId !== evidence.stageId), evidence];
        if (auditRetirement && after.get("groups.json") && !before.get("groups.json")?.equals(after.get("groups.json")!)) {
          const grouping = evidence?.stageId === solarForkStage ? evidence
            : evidence ? undefined : await captureSolarClosure(workspaceRoot, before, after, toolCallId, solarForkStage);
          if (grouping && evidence !== grouping) {
            stageEvidence = [...stageEvidence.filter(({ stageId }) => stageId !== solarForkStage), grouping];
          }
          events.push({ at: now(), type: "recovery_grouping_validation", toolCallId,
            accepted: Boolean(grouping), ...(grouping ? { closure: grouping } : {}) });
        }
        if (attestReadout && !evidence) {
          const origin = solarReadoutCandidate(before, after, result.stdout, result.stderr, stageEvidence);
          if (origin) pendingReadouts.set(toolCallId, { origin, stdout: result.stdout });
        }
      }
      return validateShellResult(result);
    }
    if (calibration) {
      const before = await readCalibrationArtifacts(workspaceRoot, calibrationReview);
      const qualityBefore = recoveryAudit ? await qualityTimestamps() : undefined;
      const result = await runProcess("bash", ["--noprofile", "--norc", "-c", code], cwd, signal);
      if (qualityBefore && toolCallId && (await qualityTimestamps()).some((time, index) => time !== qualityBefore[index])) {
        qualityWrites.push(toolCallId);
      }
      const after = await readCalibrationArtifacts(workspaceRoot, calibrationReview);
      if (stateExperiment && toolCallId) {
        const changedArtifacts = calibrationArtifacts.filter((name) => {
          const prior = before.get(name);
          const current = after.get(name);
          return current ? !prior?.equals(current) : prior !== undefined;
        });
        events.push({ at: now(), type: "recovery_tool_artifacts", toolCallId, changedArtifacts, exitCode: result.exitCode });
      }
      if (toolCallId && result.exitCode === 0) {
        const table = after.get(reviewFile)?.toString("utf8");
        if (requireReview && table && containsReviewTable(result.stdout, table)) pendingReviewTables.set(toolCallId, table);
        const evidence = captureCalibrationClosure(before, after, toolCallId, calibrationPoints);
        if (evidence) stageEvidence = [...stageEvidence.filter((item) => item.stageId !== evidence.stageId), evidence];
        const fit = after.get("fits.json");
        if (auditRetirement && fit && !before.get("fits.json")?.equals(fit)) {
          const accepted = evidence?.stageId === retirementStage;
          events.push({ at: now(), type: "recovery_grouping_validation", toolCallId,
            accepted, ...(accepted ? { closure: evidence } : {}) });
        }
        if (attestReadout && !evidence) {
          const origin = auditedReadoutCandidate(before, after, result.stdout, result.stderr, stageEvidence, "instrument-qc", reviewFile);
          if (origin) pendingReadouts.set(toolCallId, { origin, stdout: result.stdout });
        }
      }
      return validateShellResult(result);
    }
    const before = await fingerprints();
    const result = await runProcess("bash", ["--noprofile", "--norc", "-c", code], cwd, signal);
    const files = await fingerprints();
    if (toolCallId && result.exitCode === 0 && files && (!before || JSON.stringify(revisions(before)) !== JSON.stringify(revisions(files)))
      && (await validateArtifacts(workspaceRoot, true)).passed) {
      const quality = JSON.parse(files[0]!.bytes.toString("utf8"));
      const fields: Record<string, string | number | boolean | null> = {};
      function flatten(value: unknown, path: string) {
        if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
          if (path) fields[path] = value;
        } else if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) flatten(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
        }
      }
      flatten(quality, "");
      closure = { stageId: "cohort-cleaning", toolCallId, artifacts: revisions(files).map((entry, index) => ({
        ...entry, fields: index === 0 ? fields : { data_rows: 59, columns: 10 },
      })) };
      if (workload === "audit") {
        const raw = csvRows(await readFile(join(workspaceRoot, "cohort.csv"), "utf8"));
        const cleaned = csvRows(files[1]!.bytes.toString("utf8"));
        const cleanedById = new Map(cleaned.rows.map((row) => [row[0], row]));
        const seen = new Set<string>();
        const audit = raw.rows.map((row, index) => {
          const id = row[0]!;
          const removed = seen.has(id);
          seen.add(id);
          return { sourceRow: index + 1, subject_id: id, treatment_group: row[1], outcome_30d: row[8],
            decision: removed ? "drop_duplicate" : row[3] ? "retain_original" : "impute_median",
            biomarker_a_before: row[3] || null, biomarker_a_after: removed ? null : cleanedById.get(id)?.[3] };
        });
        result.stdout += `\nBENCHMARK_CLEANING_AUDIT\n${audit.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      }
    }
    return validateShellResult(result);
  };
  const validateShellResult = async (result: Awaited<ReturnType<typeof runProcess>>) => {
    if (!validateOnTool || result.exitCode !== 0) return result;
    const files = await filesPresent(workspaceRoot);
    if (files.present.length !== requiredArtifacts.length) return result;
    const table = requireReview && files.artifactValidation.passed
      ? await readFile(join(workspaceRoot, reviewFile), "utf8") : undefined;
    const needsReview = table !== undefined && observedSolarReview !== table && !containsReviewTable(result.stdout, table);
    const feedback = files.artifactValidation.passed
      ? needsReview
        ? `BENCHMARK_VALIDATION_FAILED: the files pass. For the required full ${solar ? "per-site review" : "cleaned-row review"}, run cat ${reviewFile} by itself in the workspace.`
        : "BENCHMARK_VALIDATION_PASSED: all required artifacts passed the content checks. Finish now."
      : `BENCHMARK_VALIDATION_FAILED: ${files.artifactValidation.errors.join(" | ")}. Repair these artifacts and verify again.`;
    return { ...result, stdout: `${result.stdout}\n${feedback}\n` };
  };
  const executeShell = async (code: string, _kernelMode: unknown, signal?: AbortSignal, toolCallId?: string, _machine?: string, environment?: { cwd?: string }) => {
    const requestedCwd = environment?.cwd ?? ".";
    const cwd = requestedCwd === "work" ? workspaceRoot : resolve(workspaceRoot, requestedCwd);
    const result = await runWorkspaceShell(code, cwd, signal, toolCallId);
    return executionResult({ mode: "shell", executionId: toolCallId ?? randomUUID(), cwd, result });
  };
  const executePython = async (code: string, signal?: AbortSignal, toolCallId?: string) => {
    const result = await runProcess("python3", ["-c", code], workspaceRoot, signal);
    return executionResult({ mode: "python", executionId: toolCallId ?? randomUUID(), cwd: workspaceRoot, result });
  };
  const managedExecutions = new Map<string, any>();
  const startManagedShell = async (code: string, input: { cwd?: string }, signal?: AbortSignal, toolCallId?: string, runnerId?: string) => {
    const id = toolCallId ?? randomUUID();
    const requestedCwd = input.cwd ?? ".";
    const cwd = requestedCwd === "work" ? workspaceRoot : resolve(workspaceRoot, requestedCwd);
    const result = await runWorkspaceShell(code, cwd, signal, toolCallId);
    const execution = {
      agentId: `research-spine-${id}`,
      accepted: true,
      finalization: "committed",
      finishedAt: now(),
      id,
      provenance: "committed",
      queuedAt: now(),
      result: executionResult({ mode: "shell", executionId: id, cwd, result }),
      runnerId: runnerId ?? "local",
      sessionId: `research-spine-${id}`,
      startedAt: now(),
      state: result.exitCode === 0 ? "completed" : "failed",
      turnId: id,
      workspaceId: workspaceRoot,
    };
    managedExecutions.set(id, execution);
    return execution;
  };
  const shellExecutions = {
    start: startManagedShell,
    async wait(id: string) { return managedExecutions.get(id); },
    list() { return [...managedExecutions.values()]; },
    async get(id: string) { return managedExecutions.get(id); },
    async cancel(id: string) { return managedExecutions.get(id); },
    async logs(id: string) {
      const execution = managedExecutions.get(id);
      const stdout = execution?.result?.stdout ?? "";
      const stderr = execution?.result?.stderr ?? "";
      return { chunks: [...(stdout ? [{ cursor: 0, stream: "stdout", text: stdout }] : []), ...(stderr ? [{ cursor: 1, stream: "stderr", text: stderr }] : [])], nextCursor: 2, truncated: false, retentionTruncated: false };
    },
  };
  const splitContract = "Write the two stage 1 files in one tool call that produces empty stdout. In a separate run_shell call, use exactly cat site_qc.csv to display the full table with no extra output. Perform the grouping only after that call.";
  const reviewContract = calibrationReview
    ? "Before writing fits.json, ensure the complete current cleaned.csv table has been emitted in an earlier successful tool call here or in the validated checkpoint history. If the display is pending, make the next tool call exactly cat cleaned.csv. Emit raw CSV without line numbers or formatting."
    : reviewOrderContract;
  const commonContract = nextStepExperiment || stateExperiment ? `${runContract} ${reviewContract}` : runContract;
  const captureTableContract = captureReview === "pending" ? `For this capture only, defer the original user task's table display and review until continuation. Write and validate both QC files without displaying any contents of ${reviewFile}. A short count summary is enough.`
    : captureReview === "displayed" ? `Display the full ${reviewFile} table in the quality-writing call or a separate successful read-only call. The harness will wait for validated QC files and the complete table display.`
      : "";
  const retireReceipt = fork && fork !== "capture" ? fork.retireDisplay : undefined;
  let lastAccepted: CalibrationEvidence | undefined;
  const projectContextHistory = retireReceipt && projectVerifiedResearchEvidence<FrozenPrefix["history"][number]>({
    receipt: retireReceipt,
    acceptedInputRevision: async () => {
      if (!stageEvidence.some(({ stageId }) => stageId === retirementStage)) return;
      const snapshot = solar ? await readSolarArtifacts(workspaceRoot) : await readCalibrationArtifacts(workspaceRoot, true);
      lastAccepted = currentCalibrationClosures(snapshot, stageEvidence).find(({ stageId }) => stageId === retirementStage);
      return lastAccepted?.inputRevisions?.[reviewFile];
    },
    onTransition: (state, turn) => { events.push({ at: now(), type: `recovery_display_${state}`, turn, receipt: retireReceipt, grouping: lastAccepted }); },
  });
  const agent = createNativeAgent({
    config,
    contextAssemblyMode: process.env.SCIENCE_SPINE_RECOVERY_DYNAMIC_CONTEXT === "1" ? "dynamic" : mode === "adaptive-shadow" ? "dynamic-shadow" : mode === "projection-linked" || mode === "projection-handoff" || mode === "projection-adaptive" ? "projection" : mode,
    contextScope: "main",
    enabledConnectorIds: [],
    ...(fork && fork !== "capture" ? { gatewayHistory: fork.displayHistory ?? (fork.compactRecovery ? undefined : fork.history) } : {}),
    ...(projectContextHistory ? { projectContextHistory } : {}),
    stateProviders: [{ id: VERIFIED_STAGE_STATE, async capture() {
      const value = adaptive ? await adaptiveClosures() : await currentClosures();
      return { id: VERIFIED_STAGE_STATE, schemaVersion: 1, fidelity: "captured", value,
        revision: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
    } }],
    executePython,
    executeShell,
    shellExecutions,
    localRunnerAllowed: true,
    approvalMode: "always_allow",
    toolPolicy: { allowed: ["run_shell"] },
    maxModelTurns: Math.max(1, Number(process.env.SCIENCE_SPINE_MAX_MODEL_TURNS ?? 18)),
    runIdleTimeoutMs: 300_000,
    runContract: checkpointCapture ? `${commonContract} For this invocation, execute stage 1 only. Write ${checkpointQualityFiles.join(" and ")}. The harness will pause at independent quality validation. Leave steps 2 through 4 for the continuation. ${captureTableContract}`.trimEnd()
      : solar && fork === "capture"
      ? `${runContract} ${splitQc ? splitContract : ""} This request prepares a checkpoint. Run only stages 1 and 2. Write only daily_clean.csv, site_qc.csv and groups.json, with grouping in its own tool call. The harness will suspend after the grouping artifact passes validation. Stages 3 and 4 run in the subsequent continuation.`
      : splitQc ? `${commonContract} ${splitContract}` : commonContract,
    sessionId: `research-spine-${id}`,
    ...(fork === "capture" ? { suspendAfterTurn: async () => {
      if (solar) {
        const snapshot = await readSolarArtifacts(workspaceRoot);
        const verified = currentCalibrationClosures(snapshot, stageEvidence);
        if (checkpointCapture) {
          return !["groups.json", "sensitivity.json", "solar_report.md"].some((name) => snapshot.has(name))
            && verified.some((stage) => stage.stageId === "site-quality")
            && (captureReview !== "displayed" || observedSolarReview === snapshot.get("site_qc.csv")?.toString("utf8"));
        }
        return !snapshot.has("sensitivity.json") && !snapshot.has("solar_report.md")
          && verified.some((stage) => stage.stageId === solarForkStage)
          && (!splitQc || verified.some((stage) => stage.stageId === "site-quality" && stage.resultSource));
      }
      if (calibration && checkpointCapture) {
        const snapshot = await readCalibrationArtifacts(workspaceRoot, true);
        return !calibrationStages.slice(1).flat().some((name) => snapshot.has(name))
          && currentCalibrationClosures(snapshot, stageEvidence).some((stage) => stage.stageId === checkpointQualityStage)
          && (captureReview !== "displayed" || observedSolarReview === snapshot.get(reviewFile)?.toString("utf8"));
      }
      if (calibration) return (await currentClosures()).some((stage) => stage.stageId === "batch-fit");
      const [ready, stats] = await Promise.all([currentClosures(), readFile(join(workspaceRoot, "descriptive_stats.json"), "utf8").catch(() => "")]);
      return ready.length === 1 && stats.length > 0;
    } } : process.env.SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS === "0" ? {} : {
      suspendAfterTurn: async () => {
        const files = await filesPresent(workspaceRoot);
        return files.present.length === requiredArtifacts.length && files.artifactValidation.passed;
      },
    }),
    workspaceRoot,
  } as any);
  const unsubscribe = agent.subscribe((event: any) => {
    events.push({ at: now(), ...event });
    if (event.type === "turn_start") modelTurns += 1;
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      if (typeof event.toolName === "string") toolCallNames.push(event.toolName);
    }
    if (event.type === "tool_execution_end") {
      const pending = pendingReadouts.get(event.toolCallId);
      pendingReadouts.delete(event.toolCallId);
      const parts = event.result?.content;
      const reviewTable = pendingReviewTables.get(event.toolCallId);
      pendingReviewTables.delete(event.toolCallId);
      if (reviewTable && !event.isError && Array.isArray(parts)
        && parts.some((part) => typeof part?.text === "string" && containsReviewTable(part.text, reviewTable))) {
        observedSolarReview = reviewTable;
      }
      if (pending && !event.isError && event.toolName === "run_shell" && parts?.length === 1 && typeof parts[0].text === "string"
        && !ambiguousReadouts.has(pending.origin)) {
        stageEvidence = stageEvidence.map((stage) => {
          if (stage.toolCallId !== pending.origin) return stage;
          const source = attestSolarReadout(stage, event.toolCallId, parts[0].text, pending.stdout);
          if (!source) return stage;
          if (stage.resultSource) {
            ambiguousReadouts.add(pending.origin);
            const { resultSource: _source, ...original } = stage;
            return original;
          }
          return { ...stage, resultSource: source };
        });
      }
    }
    if (event.type === "model_usage" && event.usage) {
      if (observedPolicy) stagePolicy.push({ turn: modelTurns - 1, ...observedPolicy });
      usageEvents += 1;
      firstRequestUsage ??= {
        inputTokens: Number(event.usage.inputTokens ?? 0), outputTokens: Number(event.usage.outputTokens ?? 0),
        totalTokens: Number(event.usage.totalTokens ?? 0), providerReported: event.usageReported === true,
      };
      inputTokens += Number(event.usage.inputTokens ?? 0);
      outputTokens += Number(event.usage.outputTokens ?? 0);
      totalTokens += Number(event.usage.totalTokens ?? 0);
    }
  });
  let status: RunSummary["status"] = "completed";
  let error: string | undefined;
  let completionMode: RunSummary["completionMode"] = "model_stop";
  try {
    const reportOnly = solar && fork && fork !== "capture" && !(await validateSolar(workspaceRoot)).errors[2]!.length;
    const result = await agent.execute(fork && fork !== "capture"
      ? fork.calibrationHandoff ? calibrationHandoffPrompt(fork.calibrationHandoff) : fork.recoveryHandoff ? handoffPrompt(fork.recoveryHandoff)
        : fork.compactRecovery ? (fork.recoveryStep ? nextStepPrompt(fork.compactRecovery, fork.recoveryStep) : solarRecoveryPrompt(fork.compactRecovery)) : solar ? (fork.boundary === "solar-quality" ? solarQualityContinuation : reportOnly ? solarReportContinuation : solarContinuation) : calibration ? (fork.boundary === "calibration-quality" ? calibrationQualityContinuation : calibrationContinuation) : "Continue the original request from the frozen workspace. Phase 1 and phase 2 files are already present. Finish phase 3 and phase 4 only, run the same verification, and stop naturally."
      : taskPrompt);
    completionMode = result.suspended ? "acceptance_boundary" : "model_stop";
    await writeFile(join(runRoot, "final-messages.json"), JSON.stringify(result.finalMessages, null, 2), "utf8");
  } catch (caught) {
    status = "failed";
    completionMode = "error";
    error = (caught instanceof Error ? caught.stack ?? caught.message : String(caught))
      .replace(/(api[_ -]?key\s*:\s*)[^.\s"}]+/giu, "$1[redacted]");
  } finally {
    unsubscribe();
  }
  await writeFile(join(runRoot, "verified-stages.json"), JSON.stringify(adaptive ? stageEvidence : await currentClosures(), null, 2), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const files = await filesPresent(workspaceRoot);
  if (requireReview && files.artifactValidation.passed
    && observedSolarReview !== await readFile(join(workspaceRoot, reviewFile), "utf8")) {
    files.artifactValidation = { passed: false, errors: [`No successful tool output contains the complete current ${reviewFile} table`] };
  }
  const finishedAt = now();
  const summary: RunSummary = {
    id,
    repetition,
    mode,
    status,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    modelTurns,
    toolCalls,
    toolCallNames,
    inputTokens,
    outputTokens,
    totalTokens,
    usageEvents,
    ...(firstRequestUsage ? { firstRequestUsage } : {}),
    ...(adaptive ? { stagePolicy } : {}),
    ...(recoveryAudit ? { processId: process.pid, qualityWrites } : {}),
    projectionAudit: await auditProjection(runRoot),
    requiredArtifacts: files.present,
    completedStages: (solar ? solarStages : calibration ? calibrationStages : workload === "short" ? [requiredArtifacts] : [allArtifacts.slice(0, 2), [allArtifacts[2]], [allArtifacts[3]], allArtifacts.slice(4)])
      .filter((phase) => phase.every((name) => files.present.includes(name))).length,
    artifactCompleteness: files.present.length / requiredArtifacts.length,
    artifactValidation: files.artifactValidation,
    finalReportChars: files.finalReportChars,
    completionMode,
    ...(error ? { error } : {}),
  };
  await writeFile(join(runRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

async function checkpointRun(): Promise<void> {
  if ((!solar && !(calibrationReview && stateExperiment && !compactResume)) || !requireReview || selectedModes.join(",") !== "projection") {
    throw new Error("Checkpoint recovery requires supported review workload options and a single Projection mode");
  }
  if (checkpointCapture) {
    const seed = await runOne(0, "projection", "capture");
    if (seed.completionMode !== "acceptance_boundary") throw new Error(`No quality checkpoint in ${seed.id}`);
    const root = join(outputRoot, seed.id);
    if (captureReview) {
      const history = JSON.parse(await readFile(join(root, "final-messages.json"), "utf8")) as FrozenPrefix["history"];
      const table = await readFile(join(root, "workspace", reviewFile), "utf8");
      if (hasReviewEvidence(history, table) !== (captureReview === "displayed")) {
        throw new Error(`Checkpoint did not match the requested ${captureReview} review state in ${seed.id}`);
      }
    }
    const manifest = { version: 1, workload, phase: checkpointPhase, capturedBy: process.pid,
      hashes: await hashesForCheckpoint(root) };
    await writeFile(join(root, "checkpoint.tmp"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    await rename(join(root, "checkpoint.tmp"), join(root, "checkpoint.json"));
    await writeFile(join(outputRoot, "checkpoint-index.json"), JSON.stringify({ id: seed.id }), { flag: "wx" });
    return;
  }
  const root = resolve(process.argv[3] ?? "");
  const manifest = JSON.parse(await readFile(join(root, "checkpoint.json"), "utf8"));
  if (manifest.version !== 1 || manifest.workload !== workload || manifest.phase !== checkpointPhase
    || JSON.stringify(await hashesForCheckpoint(root)) !== JSON.stringify(manifest.hashes)) {
    throw new Error("Checkpoint file or history integrity verification failed");
  }
  const workspace = join(root, "workspace");
  const snapshot = solar ? await readSolarArtifacts(workspace) : await readCalibrationArtifacts(workspace, true);
  const accepted = JSON.parse(await readFile(join(root, "verified-stages.json"), "utf8")) as CalibrationEvidence[];
  const history = JSON.parse(await readFile(join(root, "final-messages.json"), "utf8")) as FrozenPrefix["history"];
  const closures = currentCalibrationClosures(snapshot, accepted);
  const solarAudit = solar ? await validateSolar(workspace) : undefined;
  const qualityErrors = solarAudit ? solarAudit.errors[0]! : validateCalibration(snapshot, calibrationPoints)[0]!;
  if (qualityErrors.length || !closures.some((closure) => closure.stageId === checkpointQualityStage)
    || requiredArtifacts.some((name) => !(checkpointQualityFiles as readonly string[]).includes(name) && snapshot.has(name))) {
    throw new Error("Checkpoint stage no longer passes quality acceptance");
  }
  const table = snapshot.get(reviewFile)!;
  const reviewed = hasReviewEvidence(history, table.toString("utf8"));
  const plan = stateResume ? planResearchRecovery({ history, table, artifactSha256: manifest.hashes[`workspace/${reviewFile}`], displayObserved: reviewed }) : undefined;
  const displayEvidence = plan?.evidence ?? (!stateResume && (receiptResume || evidenceResume)
    ? findDisplayEvidence(history, table, manifest.hashes[`workspace/${reviewFile}`]) : undefined);
  if (evidenceResume && reviewed !== Boolean(displayEvidence)) {
    throw new Error("Verified display evidence disagrees with the checkpoint review state");
  }
  const route = plan?.route;
  const useStateEvidence = route?.mode === "retire-display";
  const compactRecovery: SolarRecoveryState | undefined = compactResume || (solar && useStateEvidence) ? {
    acceptedStage: "site-quality",
    artifactSha256: Object.fromEntries(solarQualityFiles.map((name) => [name, manifest.hashes[`workspace/${name}`]])),
    review: (receiptResume ? Boolean(displayEvidence) : reviewed) ? "already displayed" : "still required",
    pendingStages: ["technology-grouping", "complete-site-sensitivity", "solar-report"],
  } : undefined;
  const recoveryStep: SolarRecoveryStep | undefined = stepResume && !handoffResume && compactRecovery ? {
    firstPending: compactRecovery.review === "already displayed" ? "technology-grouping" : "display-quality-table",
    qualityFacts: solarAudit!.facts[0]!,
    downstreamFields: solarAudit!.handoff[0]!,
  } : undefined;
  const recoveryHandoff = (handoffResume || useStateEvidence) && compactRecovery ? buildRecoveryHandoff(compactRecovery, snapshot) : undefined;
  if (recoveryHandoff && receiptResume && displayEvidence) recoveryHandoff.displayReceipt = displayEvidence.receipt;
  const calibrationHandoff: CalibrationRecoveryHandoff | undefined = calibrationReview && useStateEvidence ? {
    acceptedStage: "instrument-qc",
    acceptedFiles: checkpointQualityFiles.map((path) => ({ path, sha256: manifest.hashes[`workspace/${path}`] })),
    review: "already displayed",
    nextAction: { input: "cleaned.csv", output: "fits.json", groupBy: "batch", method: "ordinary least squares" },
  } : undefined;
  const result = await runOne(1, "projection", { workspace, history, closures, boundary: checkpointPhase, compactRecovery,
    calibrationHandoff,
    recoveryStep, recoveryHandoff, displayHistory: evidenceResume || useStateEvidence ? displayEvidence?.messages : undefined,
    retireDisplay: retireResume || useStateEvidence ? displayEvidence?.receipt : undefined });
  await writeFile(join(outputRoot, "recovery-result.json"), JSON.stringify({ capturedBy: manifest.capturedBy,
    resumedBy: process.pid, checkpoint: root, model: process.env.E2E_LLM_MODEL,
    nativeRoot: alternateNativeRoot ?? repositoryRoot, contextAssemblyMode: process.env.SCIENCE_SPINE_RECOVERY_DYNAMIC_CONTEXT === "1" ? "dynamic" : "projection",
    historyMode: route ? route.mode : retireResume ? "retire-display" : evidenceResume ? "evidence" : receiptResume ? "receipt" : handoffResume ? "handoff" : stepResume ? "next-step" : compactResume ? "compact" : "full",
    route, compactRecovery, recoveryStep, recoveryHandoff, calibrationHandoff, evidenceReceipt: evidenceResume || useStateEvidence ? displayEvidence?.receipt : undefined,
    result }, null, 2), { flag: "wx" });
  if (!result.artifactValidation.passed || result.completionMode !== "model_stop") process.exitCode = 1;
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(firstPair) || firstPair < 1 || selectedModes.length === 0 || new Set(selectedModes).size !== selectedModes.length) {
    throw new Error("Expected a positive integer repetition count and distinct benchmark modes");
  }
  const summaries: RunSummary[] = [];
  if (selectedModes.includes("projection-handoff") && !solar) throw new Error("Handoff is a solar workflow experiment");
  if (selectedModes.some((mode) => mode === "adaptive-shadow" || mode === "projection-adaptive") && !solar && !calibrationReview) {
    throw new Error("Stage-aware projection requires the solar or calibration-review workflow");
  }
  const triple = selectedModes.length === 3 && selectedModes.includes("projection-linked");
  const orders = triple ? [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]] : undefined;
  const runOrder = (repetition: number) => orders ? orders[(repetition - 1) % orders.length]!.map((index) => selectedModes[index]!)
    : repetition % 2 === 0 ? [...selectedModes].reverse() : selectedModes;
  if (process.env.SCIENCE_SPINE_FORK === "1") {
    const handoffFork = solar && selectedModes.join(",") === "projection,projection-linked,projection-handoff";
    if (!handoffFork && ((!solar && !calibration && workload !== "audit") || repetitions !== 1
      || !["dynamic,projection", "dynamic,projection,projection-linked"].includes(selectedModes.join(",")))) {
      throw new Error("Frozen-prefix experiment requires one supported long-task pair with dynamic,projection modes");
    }
    const sourceSeed = process.env.SCIENCE_SPINE_FORK_SEED_DIR;
    const replay = handoffFork && sourceSeed ? await readFile(join(sourceSeed, "natural-replay.json"), "utf8")
      .then((data) => JSON.parse(data) as { id: string; sourceRun: string })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }) : undefined;
    const seed = replay ?? (sourceSeed ? JSON.parse(await readFile(join(sourceSeed, "summary.json"), "utf8")) as RunSummary
      : await runOne(0, "dynamic", "capture"));
    if ("status" in seed && (seed.status !== "completed" || seed.completionMode !== "acceptance_boundary")) {
      throw new Error(`Unable to freeze stage boundary: ${seed.id}`);
    }
    const root = join(outputRoot, seed.id);
    if (sourceSeed) await cp(sourceSeed, root, { recursive: true, errorOnExist: true, force: false });
    const frozen = await Promise.all([
      readFile(join(root, "final-messages.json"), "utf8"), readFile(join(root, "verified-stages.json"), "utf8"),
    ]);
    const prefix: FrozenPrefix = { workspace: join(root, "workspace"), history: JSON.parse(frozen[0]), closures: JSON.parse(frozen[1]) };
    await writeFile(join(outputRoot, "fork-prefix.json"), JSON.stringify({ seedId: seed.id, ...(replay ? { naturalReplay: replay } : {}),
      historySha256: createHash("sha256").update(frozen[0]).digest("hex"), closures: prefix.closures,
      workspaceSha256: Object.fromEntries(await Promise.all((await readdir(prefix.workspace, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath, entry.name).slice(prefix.workspace.length + 1)).sort().map(async (name) =>
        [name, createHash("sha256").update(await readFile(join(prefix.workspace, name))).digest("hex")]))),
    }, null, 2));
    for (let repetition = firstPair; repetition < firstPair + repetitions; repetition += 1) {
      for (const mode of handoffFork ? runOrder(repetition) : selectedModes) summaries.push(await runOne(repetition, mode, prefix));
    }
  } else for (let repetition = firstPair; repetition < firstPair + repetitions; repetition += 1) {
    for (const mode of runOrder(repetition)) summaries.push(await runOne(repetition, mode));
  }
  const output = resolve(outputRoot, "results.json");
  const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.startsWith("SCIENCE_AGENT_SCOPE_") || [
      "SCIENCE_SPINE_CASE", "SCIENCE_SPINE_FORK", "SCIENCE_SPINE_SPLIT_QC", "SCIENCE_SPINE_REQUIRE_REVIEW", "SCIENCE_SPINE_THINKING_MODE", "SCIENCE_SPINE_MAX_MODEL_TURNS", "SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS", "SCIENCE_SPINE_VALIDATE_ON_TOOL",
      "SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS", "SCIENCE_AGENT_LLM_MAX_TOKENS", "SCIENCE_AGENT_LLM_MAX_RETRIES", "SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES",
      "SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES", "SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS",
    ].includes(key)));
  await writeFile(output, JSON.stringify({ generatedAt: now(), model: process.env.E2E_LLM_MODEL, settings, repositoryRoot, firstPair, repetitions, modes: selectedModes, summaries }, null, 2), "utf8");
  console.log(JSON.stringify({ output, repetitions, summaries }, null, 2));
  if (summaries.some((summary) => summary.status !== "completed" || !summary.artifactValidation.passed
    || summary.artifactCompleteness !== 1 || summary.usageEvents < summary.modelTurns || summary.totalTokens <= 0
    || (process.env.SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS === "0" && summary.completionMode !== "model_stop"))) process.exitCode = 1;
}

async function revalidate(resultFile: string, outputName = "results-revalidated.json"): Promise<void> {
  const results = JSON.parse(await readFile(resultFile, "utf8")) as { summaries: RunSummary[] };
  const directory = dirname(resultFile);
  const output = resolve(directory, outputName);
  const summaries = await Promise.all(results.summaries.map(async (run) => {
    const files = await filesPresent(join(directory, run.id, "workspace"));
    return {
      ...run,
      originalArtifactValidation: run.artifactValidation,
      artifactValidation: files.artifactValidation,
      artifactCompleteness: files.present.length / requiredArtifacts.length,
    };
  }));
  await writeFile(output, JSON.stringify({ ...results, revalidatedAt: now(), summaries }, null, 2), { flag: "wx" });
  if (summaries.some((run) => !run.artifactValidation.passed || run.artifactCompleteness !== 1)) process.exitCode = 1;
}

if (process.argv[2] === "--revalidate" && process.argv[3]) await revalidate(resolve(process.argv[3]), process.argv[4]);
else if (checkpointCapture || checkpointResume) await checkpointRun();
else await main();
