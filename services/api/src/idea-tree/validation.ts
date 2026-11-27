import { createHash } from "node:crypto";
import type { CasStore } from "@sciencediscovery/cas";
import type { CandidateValidation, CandidateValidationMetric, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 200_000;
const metrics = new Set(["nrmse", "mae", "accuracy"]);

export function validationMetric(metric: unknown): CandidateValidationMetric {
  if (typeof metric !== "string" || !metrics.has(metric)) throw new Error("Select a supported metric");
  return metric as CandidateValidationMetric;
}

export function parseSamples(value: unknown): Map<string, number> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) {
    throw new Error(`Expected an array of 1–${MAX_ROWS} samples`);
  }
  const rows = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256
      || typeof item.value !== "number" || !Number.isFinite(item.value) || Math.abs(item.value) > 1e150
      || rows.has(item.id)) throw new Error("Each sample requires a unique nonempty string ID and a finite numeric value");
    rows.set(item.id, item.value);
  }
  return rows;
}

export function scoreSamples(metric: CandidateValidationMetric, expected: Map<string, number>, predicted: Map<string, number>): number {
  if (predicted.size !== expected.size) throw new Error("Prediction and reference sample IDs must match exactly");
  let total = 0;
  let sumSquares = 0;
  for (const [id, truth] of expected) {
    const prediction = predicted.get(id);
    if (prediction === undefined) throw new Error("Prediction and reference sample IDs must match exactly");
    if (metric === "accuracy") {
      if (!Number.isSafeInteger(truth) || !Number.isSafeInteger(prediction)) throw new Error("Accuracy requires integer class IDs");
      total += Number(truth === prediction);
    } else if (metric === "mae") {
      total += Math.abs(truth - prediction);
    } else {
      total += (truth - prediction) ** 2;
      sumSquares += truth ** 2;
    }
  }
  if (metric === "nrmse" && sumSquares === 0) throw new Error("nRMSE requires a nonzero reference norm");
  const score = metric === "nrmse" ? Math.sqrt(total) / Math.sqrt(sumSquares) : total / expected.size;
  if (!Number.isFinite(score)) throw new Error("Metric is outside the supported numerical range");
  return score;
}

export async function evaluateCandidateValidation(
  store: Pick<SessionStore, "getArtifactVersion" | "listExecutionRuns">,
  cas: Pick<CasStore, "read" | "storedSize">,
  sessionId: string,
  projectId: string,
  input: Record<string, unknown>,
): Promise<CandidateValidation> {
  const { metric, referenceVersionId, baselineVersionId, candidateVersionId } = input;
  const scoreMetric = validationMetric(metric);
  const ids = [referenceVersionId, baselineVersionId, candidateVersionId];
  if (new Set(ids).size !== 3) throw new Error("Choose three distinct artifact versions");
  const [reference, baseline, candidate] = ids.map((id) => {
    if (typeof id !== "string" || !id || id.length > 256) throw new Error("Exact artifact version IDs are required");
    const version = store.getArtifactVersion(sessionId, id);
    if (!version || version.sessionId !== sessionId || version.projectId !== projectId) {
      throw new Error("Artifact versions must belong to this session");
    }
    return version;
  }) as [ScientificArtifactVersion, ScientificArtifactVersion, ScientificArtifactVersion];
  const runs = new Map((await store.listExecutionRuns(sessionId)).map((row) => [row.id, row]));
  function producer(version: typeof baseline) {
    const execution = version.executionRunIds.map((id) => runs.get(id)).find((run) =>
      run && run.sessionId === sessionId && run.status === "succeeded" && run.exitCode === 0
      && run.sandbox !== "none" && run.sandbox !== "unavailable"
      && run.networkPolicy === "none" && !run.directAuthorization
      && version.turnId === run.turnId && (run.stdout?.hash === version.content.hash
        || !!version.sourcePath && [...run.createdFiles, ...run.modifiedFiles].includes(version.sourcePath)));
    if (!execution) throw new Error("Each prediction must come from a successful managed run");
    return execution;
  }
  const baselineRun = producer(baseline);
  const candidateRun = producer(candidate);
  if (baselineRun.id === candidateRun.id) throw new Error("Baseline and candidate require independent runs");
  if (!baselineRun.environmentRevisionId || baselineRun.environmentRevisionId !== candidateRun.environmentRevisionId
    || (baselineRun.runnerId ?? "local") !== (candidateRun.runnerId ?? "local")
    || baselineRun.runnerVersion !== candidateRun.runnerVersion || baselineRun.sandbox !== candidateRun.sandbox
    || baselineRun.tool !== candidateRun.tool || baselineRun.kernelMode !== candidateRun.kernelMode) {
    throw new Error("Baseline and candidate require the same managed Runner and environment revision");
  }
  const load = async (version: typeof baseline) => {
    const stored = await cas.storedSize(version.content.hash);
    if (stored === undefined || stored > MAX_RESULT_BYTES) throw new Error("Validation input is missing or exceeds 16 MiB");
    const bytes = await cas.read(version.content.hash);
    if (bytes.length > MAX_RESULT_BYTES) throw new Error("Validation input exceeds 16 MiB");
    return parseSamples(JSON.parse(bytes.toString("utf8")));
  };
  const expected = await load(reference);
  const baselineScore = scoreSamples(scoreMetric, expected, await load(baseline));
  const candidateScore = scoreSamples(scoreMetric, expected, await load(candidate));
  const improvement = scoreMetric === "accuracy" ? candidateScore - baselineScore : baselineScore - candidateScore;
  if (!Number.isFinite(improvement)) throw new Error("Metric delta is outside the supported numerical range");
  return {
    id: `validation-${createHash("sha256").update(JSON.stringify([metric, ...ids])).digest("hex")}`,
    metric: scoreMetric, scorerVersion: "matched-json-samples/v1", referenceVersionId: reference.id, baselineVersionId: baseline.id, candidateVersionId: candidate.id,
    baselineArtifactId: baseline.artifactId, candidateArtifactId: candidate.artifactId,
    baselineExecutionId: baselineRun.id, candidateExecutionId: candidateRun.id,
    baseline: baselineScore, candidate: candidateScore, improvement, sampleCount: expected.size,
  };
}
