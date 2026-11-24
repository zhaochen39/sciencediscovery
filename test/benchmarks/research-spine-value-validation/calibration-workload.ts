import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { VerifiedStageClosure } from "../../../packages/context/src/verified-stage-projection.ts";

const batches = ["reference", "production_a", "production_b"] as const;
const parameters = [[1.02, 0.12], [1.03, 0.22], [1.12, 0.20]] as const;
const threshold = 0.05;
const header = "batch,sample_id,setpoint,reading,status";
const rowsFor = (points: number) => batches.flatMap((batch, index) => {
  const [slope, intercept] = parameters[index]!;
  return Array.from({ length: points }, (_, point) =>
    `${batch},${point},${point},${(slope * point + intercept).toFixed(3)},ok`);
});
export const inputsFor = (points = 12) => [header, ...rowsFor(points), "production_a,bad-1,5,,invalid", "production_b,0,0,99.000,ok"].join("\n") + "\n";

export const calibrationStages = [
  ["qc.json", "cleaned.csv"], ["fits.json"], ["drift.json"], ["calibration_report.md"],
] as const;
export const calibrationArtifacts = calibrationStages.flat();
export const calibrationContract = `Use run_shell only. Use the local workspace and standard-library Python. Use one shell call per stage. If the tool reports BENCHMARK_VALIDATION_FAILED, repair the listed artifacts and verify again. Once it reports BENCHMARK_VALIDATION_PASSED, stop naturally with a short completion message.`;
export const calibrationPrompt = `Analyze calibration drift from instrument.csv, a fixed set of readings for one instrument in three batches. Work in the current workspace with run_shell and standard-library Python only. Keep normal tool output concise.
1. Read instrument.csv. Exclude rows whose status is not ok, then deduplicate by (batch, sample_id), preserving the first valid row. Write cleaned.csv with the original columns and rows in source order, and qc.json with integer keys raw_rows, clean_rows, excluded_status_rows, duplicate_rows. In one call, write both artifacts and print a short quality summary.
2. Read cleaned.csv and fit reading = slope * setpoint + intercept by ordinary least squares independently for each batch. Write fits.json as an object keyed by batch name (reference, production_a, production_b). Each record must contain numeric n, slope and intercept. Print a short fit summary.
3. Read fits.json and compare each production slope to the reference slope. Use the rule abs(production_slope - reference_slope) > 0.05. Write drift.json with keys baseline_batch, threshold, slope_deltas, flagged_batches. Use signed production-minus-reference deltas, and list only flagged production batch names. Print a short drift summary.
4. Read qc.json, fits.json and drift.json. Write calibration_report.md with a brief conclusion followed by a section that cites qc.json, cleaned.csv, fits.json and drift.json. Include machine-readable lines exactly of the form 'clean_rows: <number>', 'reference_slope: <number>', 'drift_threshold: <number>', and 'flagged_batches: <comma-separated batch names>'. Verify the artifact set and stop naturally once the tool reports BENCHMARK_VALIDATION_PASSED.`;
export const calibrationContinuation = `Continue the original request using the frozen workspace. The quality and fit stages are validated. Complete stage 3 (drift.json) and stage 4 (calibration_report.md), then stop naturally after acceptance.`;

export async function writeCalibrationInput(root: string, points = 12): Promise<void> {
  await writeFile(join(root, "instrument.csv"), inputsFor(points), { encoding: "utf8", flag: "wx" });
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const near = (value: unknown, target: number) => typeof value === "number" && Math.abs(value - target) <= 1e-6;
const flagged = batches.slice(1).filter((_, i) => Math.abs(parameters[i + 1]![0] - parameters[0][0]) > threshold);
const sameFlags = (value: unknown) => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify(flagged);
const countsFor = (points: number) => ({ raw_rows: 3 * points + 2, clean_rows: 3 * points, excluded_status_rows: 1, duplicate_rows: 1 });

type Snapshot = Map<string, Buffer>;
export const revision = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export async function readCalibrationArtifacts(root: string, includeInput = false): Promise<Snapshot> {
  const entries = await Promise.all((includeInput ? [...calibrationArtifacts, "instrument.csv"] : calibrationArtifacts).map(async (name) => {
    try { return [name, await readFile(join(root, name))] as const; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }));
  return new Map(entries.filter((item) => item !== undefined));
}

function json(files: Snapshot, name: string): JsonObject {
  try { return object(JSON.parse(files.get(name)?.toString("utf8") ?? "null")); }
  catch { return {}; }
}

export function validateCalibration(files: Snapshot, points = 12): string[][] {
  const rows = rowsFor(points);
  const counts = countsFor(points);
  const qc = json(files, "qc.json");
  const cleaned = files.get("cleaned.csv")?.toString("utf8").trim().split(/\r?\n/u) ?? [];
  const cleanRows = cleaned.slice(1).map((line) => line.split(","));
  const qcErrors: string[] = [];
  if (files.has("instrument.csv") && files.get("instrument.csv")!.toString("utf8") !== inputsFor(points)) qcErrors.push("instrument.csv differs from the original fixture");
  if (!Object.entries(counts).every(([key, count]) => qc[key] === count)) qcErrors.push("qc.json counts are incorrect");
  if (cleaned[0] !== header || cleanRows.length !== rows.length || cleanRows.some((cells, index) => {
    const original = rows[index]!.split(",");
    return cells.length !== original.length || cells.some((cell, column) => column === 3
      ? !cell.trim() || !near(Number(cell), Number(original[column])) : cell !== original[column]);
  })) qcErrors.push("cleaned.csv does not match the original valid first-occurrence rows");
  const fits = json(files, "fits.json");
  const fitErrors = batches.flatMap((batch, index) => {
    const fit = object(fits[batch]);
    const [slope, intercept] = parameters[index]!;
    return fit.n === points && near(fit.slope, slope) && near(fit.intercept, intercept) ? [] : [`fits.json has incorrect fit for ${batch}`];
  });
  const drift = json(files, "drift.json");
  const deltas = object(drift.slope_deltas);
  const driftErrors = drift.baseline_batch === "reference" && near(drift.threshold, threshold) && sameFlags(drift.flagged_batches)
    && batches.slice(1).every((batch, i) => near(deltas[batch], parameters[i + 1]![0] - parameters[0][0]))
    ? [] : ["drift.json has incorrect baseline, threshold, signed deltas or flags"];
  const report = files.get("calibration_report.md")?.toString("utf8") ?? "";
  const field = (key: string) => report.match(new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*:\\s*(.+?)\\s*$`, "mu"))?.[1];
  const reportErrors = calibrationArtifacts.slice(0, -1).every((name) => report.includes(name)) && Number(field("clean_rows")) === counts.clean_rows
    && near(Number(field("reference_slope")), parameters[0][0]) && near(Number(field("drift_threshold")), threshold)
    && sameFlags(field("flagged_batches")?.split(",").map((name) => name.trim()))
    ? [] : ["calibration_report.md has missing references or incorrect quality/fit/drift facts"];
  return [qcErrors, fitErrors, driftErrors, reportErrors];
}

const stageIds = ["instrument-qc", "batch-fit", "drift-check"] as const;

/** Stage evidence pins the output and all upstream artifact revisions it depends on. */
export type CalibrationEvidence = VerifiedStageClosure & { inputRevisions: Record<string, string> };

export function captureCalibrationClosure(before: Snapshot, after: Snapshot, toolCallId: string, points = 12): CalibrationEvidence | undefined {
  const dirtyStages = calibrationStages.slice(0, -1).flatMap((names, index) => names.some((name) => {
    const data = after.get(name);
    return !!data && !data.equals(before.get(name) ?? Buffer.alloc(0));
  }) ? [index] : []);
  if (dirtyStages.length !== 1) return undefined;
  const stage = dirtyStages[0]!;
  const results = validateCalibration(after, points);
  const counts = countsFor(points);
  if (results.slice(0, stage + 1).some((errors) => errors.length)) return undefined;
  const names = calibrationStages[stage]!;
  const fields = (name: string): VerifiedStageClosure["artifacts"][number]["fields"] => {
    if (name === "cleaned.csv") return { rows: json(after, "qc.json").clean_rows as number };
    if (name === "qc.json") return Object.fromEntries(Object.keys(counts).map((key) => [key, json(after, name)[key] as number]));
    if (name === "fits.json") return Object.fromEntries(batches.flatMap((batch) => ["n", "slope", "intercept"].map((key) =>
      [`/${batch}/${key}`, object(json(after, name)[batch])[key] as number])));
    const actual = json(after, "drift.json");
    return { baseline_batch: actual.baseline_batch as string, threshold: actual.threshold as number,
      flagged_batches: (actual.flagged_batches as string[]).join(","),
      ...Object.fromEntries(Object.entries(object(actual.slope_deltas)).map(([batch, delta]) => [`/slope_deltas/${batch}`, delta as number])) };
  };
  return { stageId: stageIds[stage]!, toolCallId,
    artifacts: names.map((path) => ({ path, revision: revision(after.get(path)!), fields: fields(path) })),
    inputRevisions: Object.fromEntries([...(after.has("instrument.csv") ? ["instrument.csv"] : []), ...calibrationStages.slice(0, stage).flat()].map((path) => [path, revision(after.get(path)!)])),
  };
}

export function currentCalibrationClosures(snapshot: Snapshot, evidence: readonly CalibrationEvidence[]): CalibrationEvidence[] {
  return evidence.filter((item) => {
    if (!item.inputRevisions) return false;
    const dependencies = Object.entries(item.inputRevisions);
    const outputs = item.artifacts.map(({ path, revision: digest }) => [path, digest] as const);
    return [...dependencies, ...outputs].every(([path, expected]) => {
      const data = snapshot.get(path);
      return data && revision(data) === expected;
    });
  });
}
