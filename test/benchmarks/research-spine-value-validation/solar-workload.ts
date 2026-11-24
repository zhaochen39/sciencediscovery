import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { VerifiedStageClosure } from "../../../packages/context/src/verified-stage-projection.ts";

const runFile = promisify(execFile);
const validator = join(import.meta.dirname, "solar_audit.py");
export const solarStages = [["daily_clean.csv", "site_qc.csv"], ["groups.json"], ["sensitivity.json"], ["solar_report.md"]] as const;
export const solarArtifacts = solarStages.flat();
export const solarContract = `Use only run_shell and standard-library Python in the local workspace. Write and verify each stage separately. Repair any BENCHMARK_VALIDATION_FAILED errors. When the tool confirms BENCHMARK_VALIDATION_PASSED, give a short final response and stop.`;
export const solarPrompt = `Review multi-site solar array monitoring measurements. The input files are sites.csv (site_id,technology,capacity_kw) and measurements.csv (site_id,day,peak_sun_hours,energy_kwh,status). Use only run_shell and standard-library Python.
1. In one successful tool call, join the input files by site_id, exclude status other than ok, and compute yield_index = energy_kwh / (peak_sun_hours * capacity_kw). Write daily_clean.csv with columns site_id,day,technology,yield_index. Write site_qc.csv with columns site_id,technology,expected_days,valid_days,excluded_days,mean_index. expected_days is 4, and mean_index is the site's mean across valid days. Print the complete site_qc.csv once as the per-site review table. Review the table for data completeness before proceeding.
2. Group the sites by technology using site_qc.csv. Write groups.json with keys mono, poly, thin_film. Each value is an object with numeric sites and mean_index. Give each site equal weight. Print the three group summaries.
3. Write sensitivity.json with the same schema and calculation for sites with valid_days equal to 4. Print the three group summaries.
4. Write solar_report.md. Compare the group rankings and explain what excluding incomplete sites changes. Cite daily_clean.csv, site_qc.csv, groups.json and sensitivity.json by filename. Include these exact plain lines with the correct technology names: 'top_technology: <name>' and 'complete_site_top_technology: <name>'. Verify all artifacts and stop naturally after BENCHMARK_VALIDATION_PASSED.`;
export const solarContinuation = `Continue from the frozen workspace. Site QC and all-site grouping have passed validation. Complete the sensitivity check and report using the original task constraints and stop naturally after acceptance.`;
export const solarReportContinuation = `Continue from the frozen workspace. Site QC, all-site grouping and complete-site sensitivity artifacts have passed validation. Write the report, verify all artifacts under the original task constraints and stop naturally after acceptance.`;
export const solarForkStage = "technology-grouping";

const stageIds = ["site-quality", solarForkStage, "complete-site-sensitivity"] as const;
const revision = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export type SolarEvidence = VerifiedStageClosure & { inputRevisions: Record<string, string> };
export type SolarSnapshot = Map<string, Buffer>;

export async function writeSolarInput(root: string): Promise<void> {
  await runFile("python3", [validator, "generate", root]);
}

export async function validateSolar(root: string): Promise<{
  errors: string[][]; facts: Array<VerifiedStageClosure["artifacts"][number]["fields"]>;
  handoff: Array<VerifiedStageClosure["artifacts"][number]["fields"]>;
}> {
  const { stdout } = await runFile("python3", [validator, "audit", root]);
  return JSON.parse(stdout);
}

/** Add handoff fields to the model view of current, independently accepted closures. */
export async function solarHandoffClosures(root: string, closures: SolarEvidence[]): Promise<SolarEvidence[]> {
  if (!closures.length) return closures;
  return enrichSolarClosures(closures, await validateSolar(root));
}

export function enrichSolarClosures(closures: SolarEvidence[], { errors, handoff }: Awaited<ReturnType<typeof validateSolar>>): SolarEvidence[] {
  const next = errors[1]!.length ? "Complete all-site grouping and sensitivity, then write the report."
    : errors[2]!.length ? "Complete sensitivity, then compare its results with groups.json in the report."
    : "Use groups.json and sensitivity.json to compare rankings and explain exclusions in the report.";
  return closures.map((closure) => {
    const index = stageIds.findIndex((id) => id === closure.stageId);
    if (index === -1 || errors.slice(0, index + 1).some((stageErrors) => stageErrors.length)) return closure;
    const target = index === 0 ? "site_qc.csv" : solarStages[index]![0];
    return { ...closure, artifacts: closure.artifacts.map((artifact) => artifact.path !== target ? artifact : {
      ...artifact, fields: { ...artifact.fields, ...handoff[index], next_required: next },
    }) };
  });
}

export async function readSolarArtifacts(root: string): Promise<SolarSnapshot> {
  const files = await Promise.all([...solarArtifacts, "sites.csv", "measurements.csv"].map(async (path) => {
    try { return [path, await readFile(join(root, path))] as const; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }));
  return new Map(files.filter((entry) => entry !== undefined));
}

export async function captureSolarClosure(root: string, before: SolarSnapshot, after: SolarSnapshot, toolCallId: string,
  onlyStage?: typeof stageIds[number]): Promise<SolarEvidence | undefined> {
  const writtenStages = solarStages.slice(0, stageIds.length).flatMap((names, index) =>
    names.some((name) => after.has(name) && !after.get(name)!.equals(before.get(name) ?? Buffer.alloc(0))) ? [index] : []);
  const index = onlyStage ? writtenStages.find((written) => stageIds[written] === onlyStage)
    : writtenStages.length === 1 ? writtenStages[0] : undefined;
  if (index === undefined) return undefined;
  const audit = await validateSolar(root);
  if (audit.errors.slice(0, index + 1).some((errors) => errors.length)) return undefined;
  return {
    stageId: stageIds[index]!,
    toolCallId,
    artifacts: solarStages[index]!.map((path, file) => ({ path, revision: revision(after.get(path)!),
      fields: file === 0 ? audit.facts[index]! : {} })),
    inputRevisions: Object.fromEntries(["sites.csv", "measurements.csv", ...solarStages.slice(0, index).flat()]
      .map((path) => [path, revision(after.get(path)!)])),
  };
}

/** Accept only a later, successful, standalone readout of the current validated table. */
export function auditedReadoutCandidate(before: SolarSnapshot, after: SolarSnapshot, stdout: string, stderr: string,
  evidence: readonly SolarEvidence[], stageId: string, file: string): string | undefined {
  const quality = evidence.find((stage) => stage.stageId === stageId);
  const table = before.get(file);
  if (!quality || !table || stderr.trim() || before.size !== after.size
    || [...before].some(([path, bytes]) => !bytes.equals(after.get(path) ?? Buffer.alloc(0)))
    || [...quality.artifacts.map(({ path, revision }) => [path, revision] as const), ...Object.entries(quality.inputRevisions)]
      .some(([path, hash]) => !before.has(path) || revision(before.get(path)!) !== hash)) return undefined;
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalize(stdout) === normalize(table.toString("utf8")) ? quality.toolCallId : undefined;
}

export function solarReadoutCandidate(before: SolarSnapshot, after: SolarSnapshot, stdout: string, stderr: string, evidence: SolarEvidence[]): string | undefined {
  return auditedReadoutCandidate(before, after, stdout, stderr, evidence, "site-quality", "site_qc.csv");
}

export function attestSolarReadout(closure: SolarEvidence, toolCallId: string, wire: string, stdout: string): NonNullable<SolarEvidence["resultSource"]> | undefined {
  if (closure.toolCallId === toolCallId) return undefined;
  const marker = "\nstdout:\n";
  const offset = wire.indexOf(marker);
  const stderrMarker = "\nstderr:";
  const stderrOffset = wire.lastIndexOf(stderrMarker);
  if (offset < 0 || stderrOffset <= offset || wire.slice(stderrOffset + stderrMarker.length).trim()
    || wire.slice(offset + marker.length, stderrOffset).trimEnd() !== stdout.trimEnd()) return undefined;
  try {
    const metadata = JSON.parse(wire.slice(0, offset));
    if (metadata.executionId !== toolCallId || metadata.state !== "completed" || metadata.exitCode !== 0
      || !Array.isArray(metadata.createdFiles) || metadata.createdFiles.length
      || !Array.isArray(metadata.modifiedFiles) || metadata.modifiedFiles.length) return undefined;
  } catch { return undefined; }
  return { toolCallId, contentSha256: revision(Buffer.from(wire)) };
}
