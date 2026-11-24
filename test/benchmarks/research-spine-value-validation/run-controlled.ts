import { solarCommands, solarReadoutScenarios, type SolarReadoutScenario } from "./solar-controlled-commands.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { AddressInfo } from "node:net";

const repositoryRoot = resolve(import.meta.dirname, "../../../");
const outputRoot = resolve(process.env.SCIENCE_SPINE_LOG_DIR ?? join(repositoryRoot, "test/benchmarks/research-spine-value-validation/logs/controlled-e2e"));
const requiredArtifacts = [
  "phase1_quality.json",
  "cleaned_cohort.csv",
  "descriptive_stats.json",
  "model_results.json",
  "sensitivity.json",
  "final_report.md",
];

const recoveryScenario = process.env.SCIENCE_SPINE_CONTROLLED_RECOVERY;
if (recoveryScenario && !["pending", "displayed"].includes(recoveryScenario)) throw new Error("Unknown controlled recovery scenario");
const stateRecovery = Boolean(recoveryScenario && process.env.SCIENCE_SPINE_RECOVERY_BY_STATE === "1");
const calibrationRecovery = stateRecovery && process.env.SCIENCE_SPINE_CASE === "calibration-review";
const solarScenario = recoveryScenario ? "split" : process.env.SCIENCE_SPINE_CONTROLLED_SOLAR as SolarReadoutScenario | undefined;
if (solarScenario && !solarReadoutScenarios.includes(solarScenario)) throw new Error("Unknown controlled solar scenario");
const verifyHandoff = process.env.SCIENCE_SPINE_CONTROLLED_HANDOFF === "1";
const expectHandoffProjection = process.env.SCIENCE_SPINE_CONTROLLED_HANDOFF_GATE !== "blocked";
const verifyAdaptive = process.env.SCIENCE_SPINE_CONTROLLED_ADAPTIVE === "1";
const solarModes = verifyAdaptive ? "projection,adaptive-shadow,projection-adaptive" : verifyHandoff ? "dynamic,projection,projection-linked,projection-handoff" : "dynamic,projection,projection-linked";
const repairSolarReview = solarScenario === "incomplete" && process.env.SCIENCE_SPINE_REQUIRE_REVIEW === "1";
const injectStageFault = process.env.SCIENCE_SPINE_CONTROLLED_STAGE_FAULT === "1";
const injectReportFault = process.env.SCIENCE_SPINE_CONTROLLED_REPORT_FAULT === "1";

function python(body: string): string {
  return `python3 - <<'PY'
import csv
import json
import statistics
from pathlib import Path

def read_csv(name):
    with Path(name).open(newline='') as handle:
        return list(csv.DictReader(handle))

def write_json(name, value):
    Path(name).write_text(json.dumps(value, indent=2) + '\\n')

def counts(rows):
    return {group: [len(items), sum(int(row['outcome_30d']) for row in items)]
            for group in ('treated', 'control')
            for items in [[row for row in rows if row['treatment_group'] == group]]}

def risk_difference(table):
    nt, et = table['treated']
    nc, ec = table['control']
    return et / nt - ec / nc

${body}
PY`;
}

const reportCommand = python(`
quality = json.loads(Path('phase1_quality.json').read_text())
model = json.loads(Path('model_results.json').read_text())
Path('final_report.md').write_text(f'''# Controlled cohort report

The raw cohort has {quality['raw_rows']} rows, {quality['raw_columns']} columns,
{quality['duplicate_subject_count']} duplicate subject and
{quality['missing_biomarker_a_count_raw']} missing biomarker_a values.
The treated group has a higher event rate, with risk difference
{model['absolute_risk_difference']:.3f} and descriptive 95% confidence interval
{model['absolute_risk_difference_ci95']}.

Artifacts: phase1_quality.json, cleaned_cohort.csv, descriptive_stats.json,
model_results.json, sensitivity.json.
''')`);

const commands = solarScenario ? [...solarCommands(solarScenario), ...(repairSolarReview ? ["cat site_qc.csv"] : [])] : [
  python(`
rows = read_csv('cohort.csv')
first = {}
for row in rows:
    first.setdefault(row['subject_id'], dict(row))
cleaned = list(first.values())
median = statistics.median(float(row['biomarker_a']) for row in cleaned if row['biomarker_a'])
for row in cleaned:
    if not row['biomarker_a']:
        row['biomarker_a'] = str(median)
write_json('phase1_quality.json', {
    'raw_rows': len(rows), 'raw_columns': len(rows[0]),
    'duplicate_subject_count': len(rows) - len(cleaned),
    'missing_biomarker_a_count_raw': sum(not row['biomarker_a'] for row in rows),
})
with Path('cleaned_cohort.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(cleaned)`),
  python(`
table = counts(read_csv('cleaned_cohort.csv'))
write_json('descriptive_stats.json', {'counts': table,
    'rates': {group: events / n for group, (n, events) in table.items()}})`),
  python(`
table = json.loads(Path('descriptive_stats.json').read_text())['counts']
nt, et = table['treated']
nc, ec = table['control']
pt, pc = et / nt, ec / nc
rd = risk_difference(table)
margin = 1.96 * (pt * (1 - pt) / nt + pc * (1 - pc) / nc) ** .5
write_json('model_results.json', {'direction': 'treated higher',
    'absolute_risk_difference': rd, 'absolute_risk_difference_ci95': [rd - margin, rd + margin]})`),
  python(`
raw = read_csv('cohort.csv')
write_json('sensitivity.json', {'all_raw_rows': {'absolute_risk_difference': risk_difference(counts(raw))},
    'complete_case': {'absolute_risk_difference': risk_difference(counts([row for row in raw if row['biomarker_a']]))}})`)
    + "\n" + (injectReportFault ? reportCommand.replace("{quality['raw_rows']} rows", "None rows") : reportCommand),
];

type ChatRequest = { messages?: Array<Record<string, unknown>>; tools?: unknown[] };

function usage(messages: Array<Record<string, unknown>>, completionTokens: number) {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
  return { prompt_tokens: inputTokens, completion_tokens: completionTokens, total_tokens: inputTokens + completionTokens };
}

function sendSse(response: ServerResponse, frames: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

type StubRequestRecord = {
  request: number;
  historyMessages: number;
  historyRoles: string[];
  historyCharacters: number;
  toolCount: number;
  lastRole: string | undefined;
  lastContentCharacters: number;
  sawStageFailure: boolean;
  sawReviewFeedback: boolean;
  sawHandoff: boolean;
};

type ControlledRunSummary = {
  mode: string;
  status: string;
  completionMode: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelTurns: number;
  artifactCompleteness: number;
  artifactValidation: { passed: boolean };
  projectionAudit: { traces: number; admitted: number; applied: number; observations: Array<{ error?: string }>;
    rows: Array<{ turn: number; projection: { preferredStageProjection?: boolean } }> };
  stagePolicy?: Array<{ turn: number; reason: string }>;
};

function averageTokens(summaries: ControlledRunSummary[], mode: string, metric: "inputTokens" | "totalTokens"): number {
  const runs = summaries.filter((summary) => summary.mode === mode);
  return runs.length ? runs.reduce((total, run) => total + run[metric], 0) / runs.length : 0;
}

const solarRecoveryCommands = recoveryScenario === "displayed"
  ? [`${solarCommands("split")[0]}\npython3 -c 'from pathlib import Path; p=Path("site_qc.csv"); p.write_bytes(p.read_bytes().replace(bytes([10]), bytes([13,10]))); print(p.read_text(), end="")'`, ...solarCommands("split").slice(2)]
  : solarCommands("split");

const calibrationClean = python(`
raw = read_csv('instrument.csv')
seen = set()
clean = []
for row in raw:
    key = (row['batch'], row['sample_id'])
    if row['status'] == 'ok' and key not in seen:
        seen.add(key)
        clean.append(row)
with Path('cleaned.csv').open('w', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=list(raw[0]), lineterminator=chr(10))
    writer.writeheader()
    writer.writerows(clean)
write_json('qc.json', {'raw_rows': len(raw), 'clean_rows': len(clean), 'excluded_status_rows': 1, 'duplicate_rows': 1})`);
const calibrationCommands = [
  ...(recoveryScenario === "displayed" ? [`${calibrationClean}\ncat cleaned.csv`] : [calibrationClean, "cat cleaned.csv"]),
  python(`
rows = read_csv('cleaned.csv')
fits = {}
for batch in dict.fromkeys(row['batch'] for row in rows):
    points = [(float(row['setpoint']), float(row['reading'])) for row in rows if row['batch'] == batch]
    xs, ys = zip(*points)
    slope, intercept = statistics.linear_regression(xs, ys)
    fits[batch] = dict(n=len(xs), slope=slope, intercept=intercept)
write_json('fits.json', fits)`),
  python(`
fits = json.loads(Path('fits.json').read_text())
deltas = {batch: fit['slope'] - fits['reference']['slope'] for batch, fit in fits.items() if batch != 'reference'}
write_json('drift.json', dict(baseline_batch='reference', threshold=0.05, slope_deltas=deltas,
                              flagged_batches=[batch for batch, value in deltas.items() if abs(value) > 0.05]))`),
  python(`
qc = json.loads(Path('qc.json').read_text())
fits = json.loads(Path('fits.json').read_text())
drift = json.loads(Path('drift.json').read_text())
Path('calibration_report.md').write_text(f"""# Calibration drift

Production B exceeds the drift threshold. References: qc.json, cleaned.csv, fits.json, drift.json.

clean_rows: {qc['clean_rows']}
reference_slope: {fits['reference']['slope']}
drift_threshold: {drift['threshold']}
flagged_batches: {','.join(drift['flagged_batches'])}
""")`),
];
const recoveryCommands = calibrationRecovery ? calibrationCommands : solarRecoveryCommands;

function startModelStub(): Promise<{ server: Server; url: string; requestCount: () => number; records: () => StubRequestRecord[] }> {
  let requests = 0;
  let currentRunToolCalls = 0;
  let failedGrouping = false;
  const records: StubRequestRecord[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      requests += 1;
      const body = JSON.parse(raw) as ChatRequest;
      const messages = body.messages ?? [];
      const last = messages.at(-1) ?? {};
      const sawStageFailure = last.role === "tool" && String(last.content).includes("CONTROLLED_CLEANING_FAILED");
      records.push({
        request: requests,
        historyMessages: messages.length,
        historyRoles: messages.map((message) => typeof message.role === "string" ? message.role : "unknown"),
        historyCharacters: JSON.stringify(messages).length,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        lastRole: typeof last.role === "string" ? last.role : undefined,
        sawStageFailure,
        sawHandoff: messages.some((message) => message.role === "tool" && typeof message.content === "string"
          && message.content.includes('"complete_site_rule":"valid_days == expected_days == 4"')
          && message.content.includes('"mono_incomplete_sites":6') && message.content.includes('"next_required":')),
        sawReviewFeedback: last.role === "tool" && String(last.content).includes("For the required full per-site review"),
        lastContentCharacters: typeof last.content === "string" ? last.content.length : 0,
      });
      const isCompactionRequest = !Array.isArray(body.tools) || body.tools.length === 0;
      if (isCompactionRequest) {
        sendSse(response, [
          { choices: [{ delta: { content: "Compacted controlled history." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: usage(messages, 12) },
        ]);
        return;
      }
      const startsNewRun = last.role === "user"
        && typeof last.content === "string"
        && last.content.includes(calibrationRecovery ? "Analyze calibration drift from instrument.csv"
          : solarScenario ? "Review multi-site solar array monitoring" : "Run a controlled local benchmark");
      if (recoveryScenario && last.role === "user" && String(last.content).startsWith("Continue the original task from the validated quality checkpoint.")) {
        const compact = String(last.content).includes("Original task:");
        const expectsReview = recoveryScenario === "pending";
        const evidence = messages.filter((message) => message.role === "assistant" || message.role === "tool");
        const mayRetainPair = !expectsReview && (process.env.SCIENCE_SPINE_RECOVERY_EVIDENCE === "1"
          || process.env.SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY === "1" || stateRecovery);
        if (compact && ((!calibrationRecovery && !String(last.content).includes(`"review": "${expectsReview ? "still required" : "already displayed"}"`))
          || (evidence.length !== 0 && (!mayRetainPair || evidence.length !== 2
            || evidence[0]?.role !== "assistant" || evidence[1]?.role !== "tool")))) {
          response.writeHead(400).end("Invalid compact checkpoint input");
          return;
        }
        if (String(last.content).includes("Verified recovery state:")
          && !String(last.content).includes(`"firstPending": "${expectsReview ? "display-quality-table" : "technology-grouping"}"`)) {
          response.writeHead(400).end("Invalid first pending action");
          return;
        }
        currentRunToolCalls = 1;
        failedGrouping = false;
      } else if (startsNewRun) currentRunToolCalls = 0;
      const invalidGrouping = process.env.SCIENCE_SPINE_CONTROLLED_GROUPING_FAULT === "1"
        && recoveryScenario === "displayed" && currentRunToolCalls === 1 && !failedGrouping;
      if (invalidGrouping) failedGrouping = true;
      const activeCommands = recoveryScenario ? recoveryCommands : commands;
      const repairsReport = injectReportFault && currentRunToolCalls === 4
        && last.role === "tool" && JSON.stringify(last.content).includes("BENCHMARK_VALIDATION_FAILED");
      if (last.role === "tool" && currentRunToolCalls >= activeCommands.length && !repairsReport) {
        sendSse(response, [
          { choices: [{ delta: { content: solarScenario ? "Completed the controlled solar analysis." : "Completed the controlled six-artifact analysis." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: usage(messages, 12) },
        ]);
        return;
      }
      const failedStageCommand = injectStageFault && startsNewRun;
      if (!failedStageCommand && !invalidGrouping) currentRunToolCalls += 1;
      const callId = `controlled-call-${requests}`;
      const stage = failedStageCommand ? 1 : currentRunToolCalls;
      const observation = [
        "Phase 1 observation: cohort quality checks found 60 raw rows, 10 columns, one duplicate subject and two missing biomarker_a values. The cleaned cohort is ready for the next phase. ",
        "Phase 2 observation: descriptive statistics were computed from the cleaned cohort. The treated outcome rate is higher than the control outcome rate, with the comparison retained for the model result. ",
        "Phase 3 observation: the treatment effect direction remains positive in the descriptive model result. The result is a descriptive benchmark and carries uncertainty because this is a small synthetic cohort. ",
        "Phase 4 observation: sensitivity checks preserve the positive direction. The final report references phase1_quality.json, cleaned_cohort.csv, descriptive_stats.json, model_results.json and sensitivity.json. ",
      ][Math.min(stage - 1, 3)]!.repeat(24);
      sendSse(response, [
        { choices: [{ delta: { content: solarScenario ? "Executing the controlled solar analysis." : `Executing the controlled cohort analysis. ${observation}` } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: invalidGrouping ? `printf '%s\n' '{}' > ${calibrationRecovery ? 'fits.json' : 'groups.json'}` : failedStageCommand ? "printf 'CONTROLLED_CLEANING_FAILED: cohort output not committed\\n' >&2; exit 1" : repairsReport ? reportCommand : activeCommands[stage - 1], cwd: "." }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: usage(messages, 36) },
      ]);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
       resolvePromise({ server, url: `http://127.0.0.1:${port}`, requestCount: () => requests, records: () => records });
    });
  });
}

async function run(): Promise<void> {
  await mkdir(recoveryScenario ? resolve(outputRoot, "..") : outputRoot, { recursive: true });
  const stub = await startModelStub();
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolvePromise) => {
    const bench = "test/benchmarks/research-spine-value-validation";
    const [command, ...args] = recoveryScenario ? ["bash", `${bench}/${stateRecovery ? "run-state-recovery-wsl.sh" : "run-compact-recovery-wsl.sh"}`]
      : [process.platform === "win32" ? "pnpm.cmd" : "pnpm", "exec", "tsx", `${bench}/run-live.ts`];
    const child = spawn(command!, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        E2E_LLM_BASE_URL: stub.url,
        E2E_LLM_MODEL: "controlled-stub",
        E2E_LLM_TOKEN: "controlled-stub-token",
        SCIENCE_SPINE_CASE: calibrationRecovery ? "calibration-review" : solarScenario ? "solar" : process.env.SCIENCE_SPINE_CASE ?? "audit",
        SCIENCE_SPINE_MODES: solarScenario ? solarModes : process.env.SCIENCE_SPINE_MODES ?? "dynamic,shadow,projection",
        SCIENCE_SPINE_REPETITIONS: process.env.SCIENCE_SPINE_REPETITIONS ?? "1",
        SCIENCE_SPINE_MAX_MODEL_TURNS: process.env.SCIENCE_SPINE_MAX_MODEL_TURNS ?? "8",
        SCIENCE_AGENT_LLM_MAX_TOKENS: "4096",
        SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "32768",
        SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES: process.env.SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES ?? "2",
        SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES: process.env.SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES ?? "16384",
        SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES: process.env.SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES ?? "600",
        SCIENCE_SPINE_LOG_DIR: outputRoot,
        SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS: "0",
        ...(injectReportFault || solarScenario ? { SCIENCE_SPINE_VALIDATE_ON_TOOL: "1" } : {}),
        ...(recoveryScenario ? { SCIENCE_SPINE_RECOVERY_CONTROLLED: "1", SCIENCE_SPINE_CAPTURE_REVIEW: recoveryScenario, E2E_LLM_API_VARIANT: "openai" } : {}),
      },
      ...(process.platform === "win32" ? { shell: true } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolvePromise({ exitCode: 1, stdout, stderr: `${stderr}${String(error)}` }));
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });
  await new Promise<void>((resolvePromise) => stub.server.close(() => resolvePromise()));
  if (recoveryScenario) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    await writeFile(join(outputRoot, "stub-requests.json"), JSON.stringify(stub.records(), null, 2), { flag: "wx" });
    if (result.exitCode !== 0) throw new Error(`Controlled recovery failed. See ${outputRoot}`);
    return;
  }
  const resultsPath = join(outputRoot, "results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && result.exitCode !== 0) {
      process.stderr.write(`${result.stdout}\n${result.stderr}`);
      throw new Error(`controlled E2E subprocess failed before writing results (exit ${result.exitCode})`);
    }
    throw error;
  })) as { repetitions: number; summaries: ControlledRunSummary[] };
  const { repetitions, summaries } = results;
  if (solarScenario) {
    const e2ePass = result.exitCode === 0 && summaries.length === repetitions * solarModes.split(",").length
      && solarModes.split(",").every((mode) => summaries.filter((run) => run.mode === mode).length === repetitions)
      && summaries.every((run) => run.status === "completed" && run.completionMode === "model_stop"
        && run.artifactCompleteness === 1 && run.artifactValidation.passed && run.modelTurns === commands.length + 1);
    const appliedAsExpected = summaries.every((run) => (run.projectionAudit.applied > 0)
      === ((run.mode === "projection-linked" || (run.mode === "projection-handoff" && expectHandoffProjection) || run.mode === "projection-adaptive") && solarScenario === "split"));
    const reviewFeedbackAsExpected = !repairSolarReview
      || stub.records().filter((record) => record.sawReviewFeedback).length === summaries.length;
    const handoffAsExpected = stub.records().some((record) => record.sawHandoff) === ((verifyAdaptive || (verifyHandoff && expectHandoffProjection)) && solarScenario === "split");
    const adaptiveAsExpected = !verifyAdaptive || summaries.filter((run) => run.mode !== "projection").every((run) => {
      const hits = run.projectionAudit.rows.filter((row) => row.projection.preferredStageProjection);
      return (hits.length > 0) === (solarScenario === "split") && hits.every((hit) =>
        run.stagePolicy?.some((decision) => decision.turn === hit.turn && decision.reason === "eligible"));
    });
    const passed = e2ePass && appliedAsExpected && reviewFeedbackAsExpected && handoffAsExpected && adaptiveAsExpected;
    const audit = { scenario: solarScenario, passed, e2ePass, appliedAsExpected, reviewFeedbackAsExpected, handoffAsExpected, adaptiveAsExpected, summaries, stubRequests: stub.records() };
    await writeFile(join(outputRoot, "controlled-solar-audit.json"), JSON.stringify(audit, null, 2));
    await writeFile(join(outputRoot, "runner.log"), `${result.stdout}\n${result.stderr}`);
    if (!passed) throw new Error(`Controlled solar scenario ${solarScenario} failed. See ${outputRoot}`);
    console.log(JSON.stringify({ scenario: solarScenario, passed, runCount: summaries.length, outputRoot }));
    return;
  }
  const dynamicInputTokens = averageTokens(summaries, "dynamic", "inputTokens");
  const projectionInputTokens = averageTokens(summaries, "projection", "inputTokens");
  const dynamicTotalTokens = averageTokens(summaries, "dynamic", "totalTokens");
  const projectionTotalTokens = averageTokens(summaries, "projection", "totalTokens");
  const inputReduction = dynamicInputTokens > 0 ? (dynamicInputTokens - projectionInputTokens) / dynamicInputTokens : 0;
  const projectionRuns = summaries.filter((summary) => summary.mode === "projection");
  const shadowMode = (process.env.SCIENCE_SPINE_MODES ?? "").split(",").map((mode) => mode.trim()).includes("dynamic-shadow")
    ? "dynamic-shadow" : "shadow";
  const shadowRuns = summaries.filter((summary) => summary.mode === shadowMode);
  const e2ePass = result.exitCode === 0
    && repetitions >= 1
    && summaries.length === repetitions * 3
    && ["dynamic", shadowMode, "projection"].every((mode) => summaries.filter((run) => run.mode === mode).length === repetitions)
    && summaries.every((run) => run.status === "completed" && run.completionMode === "model_stop"
      && run.artifactCompleteness === 1 && run.artifactValidation.passed);
  const valuePass = e2ePass
    && inputReduction >= 0.05
    && projectionTotalTokens <= dynamicTotalTokens
    && projectionRuns.every((run) => run.projectionAudit.applied > 0)
    && shadowRuns.every((run) => run.projectionAudit.admitted > 0 && run.projectionAudit.applied === 0
      && (shadowMode !== "dynamic-shadow" || (run.projectionAudit.observations.length === run.modelTurns
        && run.projectionAudit.observations.every((obs) => !obs.error))));
  const faultRun = injectReportFault || injectStageFault;
  const expectedTurns = 5 + Number(injectReportFault) + Number(injectStageFault);
  const sawStageFailures = stub.records().filter((record) => record.sawStageFailure).length;
  const passed = faultRun ? e2ePass && summaries.every((run) => run.modelTurns === expectedTurns)
    && (!injectStageFault || sawStageFailures === summaries.length) : e2ePass && valuePass;
  const report = [
    "# Controlled E2E acceptance report",
    "",
    "This run uses a local OpenAI-compatible scripted model endpoint to exercise the real Native Agent, Context Assembler, tool dispatch, workspace writes, usage collection and final artifact checks.",
    "",
    `Model requests: ${stub.requestCount()}`,
    "",
    "## Request history audit",
    "",
    "```json",
    JSON.stringify(stub.records(), null, 2),
    "```",
    `E2E pass: ${e2ePass}`,
    `Injected report fault: ${injectReportFault}`,
    `Injected stage fault: ${injectStageFault}`,
    `Model-visible stage failure responses: ${sawStageFailures}`,
    `Shadow mode: ${shadowMode}`,
    `Value pass: ${valuePass}`,
    `Input token reduction, Dynamic to Projection: ${(inputReduction * 100).toFixed(2)}%`,
    `Projected model inputs: ${projectionRuns.reduce((total, run) => total + run.projectionAudit.applied, 0)}`,
    `Total tokens, Dynamic / Projection: ${dynamicTotalTokens} / ${projectionTotalTokens}`,
    "",
    "The value gate requires natural completion, validated artifacts, at least 5% input reduction, no increase in total tokens, and model-visible projection in every Projection run.",
    `Pass: ${passed}`,
    "",
    "| Mode | Status | Input Tokens | Output Tokens | Model Turns | Artifact Completeness |",
    "|---|---|---:|---:|---:|---:|",
    ...summaries.map((summary) => `| ${String(summary.mode)} | ${String(summary.status)} | ${String(summary.inputTokens)} | ${String(summary.outputTokens)} | ${String(summary.modelTurns)} | ${String(summary.artifactCompleteness)} |`),
    "",
    `Subprocess exit code: ${result.exitCode}`,
    "",
  ].join("\n");
  await writeFile(join(outputRoot, "controlled-acceptance-report.md"), report, "utf8");
  process.stdout.write(`${result.stdout}\n${JSON.stringify({ passed, resultsPath, reportPath: join(outputRoot, "controlled-acceptance-report.md") }, null, 2)}\n`);
  if (!passed) {
    process.stderr.write(result.stderr);
    throw new Error("controlled E2E acceptance failed");
  }
}

await run();
