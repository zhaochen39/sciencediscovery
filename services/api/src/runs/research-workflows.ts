// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { citationWorkflow } from "./research-citations.js";

type Files = ReadonlyMap<string, Buffer>;
export interface ResearchCheckpointContract {
  version: number;
  pilotEligible: boolean;
  table: string;
  inputs: readonly string[];
  outputs: readonly string[];
  acceptQuality(files: Files): boolean;
  acceptDownstream(files: Files): boolean;
  acceptDelivery(files: Files): boolean;
  handoff: string;
}

function csv(files: Files, name: string, header: string): string[][] {
  const text = files.get(name)?.toString("utf8").replaceAll("\r\n", "\n").trimEnd();
  if (!text || /["\r\0]/u.test(text)) throw new Error("Unsupported CSV encoding");
  const [columns, ...lines] = text.split("\n");
  const width = header.split(",").length;
  const rows = lines.map(line => line.split(","));
  if (columns !== header || !rows.length || rows.some(row => row.length !== width)) throw new Error("Unexpected CSV schema");
  return rows;
}

function number(value: string | undefined): number {
  if (value === undefined || !value.trim() || !Number.isFinite(Number(value))) throw new Error("Invalid numeric value");
  return Number(value);
}

const near = (actual: unknown, expected: number) => typeof actual === "number" && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-6;
const mean = (numbers: number[]) => numbers.reduce((sum, item) => sum + item, 0) / numbers.length;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function json(files: Files, name: string) {
  return object(JSON.parse(files.get(name)?.toString("utf8") ?? ""));
}
function validate(fn: (files: Files) => boolean) {
  return (files: Files) => {
    try { return fn(files); }
    catch { return false; }
  };
}

const calibrationHeader = "batch,sample_id,setpoint,reading,status";
const calibrationBatches = ["reference", "production_a", "production_b"];
const calibrationQuality = validate(files => {
  const raw = csv(files, "instrument.csv", calibrationHeader);
  let excluded = 0;
  let duplicates = 0;
  const expected = new Map<string, string[]>();
  for (const row of raw) {
    const [batch, id, x, y, status] = row;
    if (status !== "ok") { excluded++; continue; }
    if (!calibrationBatches.includes(batch!) || !id) return false;
    number(x); number(y);
    const key = JSON.stringify([batch, id]);
    if (expected.has(key)) { duplicates++; continue; }
    expected.set(key, row);
  }
  const actual = csv(files, "cleaned.csv", calibrationHeader);
  const qc = json(files, "qc.json");
  return JSON.stringify(actual) === JSON.stringify([...expected.values()]) && qc.raw_rows === raw.length
    && qc.clean_rows === actual.length && qc.excluded_status_rows === excluded && qc.duplicate_rows === duplicates;
});
const calibrationFit = validate(files => {
  const rows = csv(files, "cleaned.csv", calibrationHeader);
  const result = json(files, "fits.json");
  return Object.keys(result).length === calibrationBatches.length && calibrationBatches.every(batch => {
    const points = rows.filter(row => row[0] === batch).map(row => [number(row[2]), number(row[3])] as const);
    const mx = mean(points.map(([x]) => x));
    const my = mean(points.map(([, y]) => y));
    const variance = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
    if (points.length < 2 || variance <= 0) return false;
    const slope = points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / variance;
    const fit = object(result[batch]);
    return fit.n === points.length && near(fit.slope, slope) && near(fit.intercept, my - slope * mx);
  });
});

const groups = ["mono", "poly", "thin_film"];
const qualityHeader = "site_id,technology,expected_days,valid_days,excluded_days,mean_index";
const solarQuality = validate(files => {
  const sites = new Map<string, { technology: string; capacity: number; seen: Set<number>; yields: number[] }>();
  for (const [id, technology, capacity] of csv(files, "sites.csv", "site_id,technology,capacity_kw")) {
    if (!id || sites.has(id) || !groups.includes(technology!) || number(capacity) <= 0) return false;
    sites.set(id, { technology: technology!, capacity: number(capacity), seen: new Set(), yields: [] });
  }
  const clean = new Map<string, { technology: string; value: number }>();
  for (const [id, rawDay, sun, energy, status] of csv(files, "measurements.csv", "site_id,day,peak_sun_hours,energy_kwh,status")) {
    const site = sites.get(id!);
    const day = number(rawDay);
    if (!site || !Number.isInteger(day) || day < 1 || day > 4 || site.seen.has(day)) return false;
    site.seen.add(day);
    if (status !== "ok") continue;
    if (number(sun) <= 0 || number(energy) < 0) return false;
    const value = number(energy) / (number(sun) * site.capacity);
    site.yields.push(value);
    clean.set(JSON.stringify([id, day]), { technology: site.technology, value });
  }
  for (const [id, day, technology, value] of csv(files, "daily_clean.csv", "site_id,day,technology,yield_index")) {
    const key = JSON.stringify([id, number(day)]);
    const expected = clean.get(key);
    if (!expected || expected.technology !== technology || !near(number(value), expected.value)) return false;
    clean.delete(key);
  }
  if (clean.size) return false;
  for (const [id, technology, expected, valid, excluded, value] of csv(files, "site_qc.csv", qualityHeader)) {
    const site = sites.get(id!);
    if (!site || site.seen.size !== 4 || site.technology !== technology || number(expected) !== 4
      || number(valid) !== site.yields.length || number(excluded) !== 4 - site.yields.length || !near(number(value), mean(site.yields))) return false;
    sites.delete(id!);
  }
  return sites.size === 0;
});
const solarGrouping = validate(files => {
  const rows = csv(files, "site_qc.csv", qualityHeader);
  const result = json(files, "groups.json");
  return Object.keys(result).length === groups.length && groups.every(group => {
    const values = rows.filter(row => row[1] === group).map(row => number(row[5]));
    const summary = object(result[group]);
    return values.length > 0 && summary.sites === values.length && near(summary.mean_index, mean(values));
  });
});

function reportField(files: Files, filename: string, key: string): string | undefined {
  const prefix = `${key}:`;
  const lines = files.get(filename)?.toString("utf8").split(/\r?\n/u).map(line => line.trimStart()).filter(line => line.startsWith(prefix));
  return lines?.length === 1 ? lines[0]!.slice(prefix.length).trim() : undefined;
}

function cites(files: Files, filename: string, paths: readonly string[]) {
  const report = files.get(filename)?.toString("utf8") ?? "";
  return paths.every(path => report.includes(path));
}

const calibrationDelivery = validate(files => {
  if (!calibrationFit(files)) return false;
  const fits = json(files, "fits.json");
  const baseline = number(String(object(fits.reference).slope));
  const drift = json(files, "drift.json");
  const deltas = object(drift.slope_deltas);
  const production = calibrationBatches.slice(1);
  const flagged = production.filter(batch => Math.abs(number(String(object(fits[batch]).slope)) - baseline) > 0.05);
  const report = "calibration_report.md";
  return drift.baseline_batch === "reference" && drift.threshold === 0.05
    && Object.keys(deltas).length === production.length
    && production.every(batch => near(deltas[batch], number(String(object(fits[batch]).slope)) - baseline))
    && Array.isArray(drift.flagged_batches) && JSON.stringify([...drift.flagged_batches].sort()) === JSON.stringify([...flagged].sort())
    && cites(files, report, ["qc.json", "cleaned.csv", "fits.json", "drift.json"])
    && number(reportField(files, report, "clean_rows")) === json(files, "qc.json").clean_rows
    && near(number(reportField(files, report, "reference_slope")), baseline)
    && number(reportField(files, report, "drift_threshold")) === 0.05
    && reportField(files, report, "flagged_batches")?.split(",").map(batch => batch.trim()).filter(Boolean).sort().join(",") === [...flagged].sort().join(",");
});

const solarDelivery = validate(files => {
  if (!solarGrouping(files)) return false;
  const table = csv(files, "site_qc.csv", qualityHeader);
  const all = json(files, "groups.json");
  const complete = json(files, "sensitivity.json");
  if (Object.keys(complete).length !== groups.length || !groups.every(group => {
    const values = table.filter(row => row[1] === group && number(row[3]) === 4).map(row => number(row[5]));
    return values.length > 0 && object(complete[group]).sites === values.length && near(object(complete[group]).mean_index, mean(values));
  })) return false;
  const top = (results: Record<string, unknown>) => groups.reduce((best, group) =>
    number(String(object(results[group]).mean_index)) > number(String(object(results[best]).mean_index)) ? group : best);
  const report = "solar_report.md";
  return cites(files, report, ["daily_clean.csv", "site_qc.csv", "groups.json", "sensitivity.json"])
    && reportField(files, report, "top_technology") === top(all)
    && reportField(files, report, "complete_site_top_technology") === top(complete);
});

const checkpointWorkflows = {
  solar: {
    version: 1,
    pilotEligible: true,
    table: "site_qc.csv",
    inputs: ["sites.csv", "measurements.csv", "daily_clean.csv", "site_qc.csv"],
    outputs: ["groups.json", "sensitivity.json", "solar_report.md"],
    acceptQuality: solarQuality,
    acceptDownstream: solarGrouping,
    acceptDelivery: solarDelivery,
    handoff: "Continue the solar analysis after the validated quality stage. The full current site_qc.csv was already displayed in the preceding verified tool result. Preserve the quality files. Start by grouping site_qc.csv into groups.json, with equal weight per site. Apply the user's continuation instructions to the unfinished work.",
  },
  calibration: {
    version: 1,
    pilotEligible: true,
    table: "cleaned.csv",
    inputs: ["instrument.csv", "qc.json", "cleaned.csv"],
    outputs: ["fits.json", "drift.json", "calibration_report.md"],
    acceptQuality: calibrationQuality,
    acceptDownstream: calibrationFit,
    acceptDelivery: calibrationDelivery,
    handoff: "Continue calibration after the validated quality stage. The full current cleaned.csv was already displayed in the preceding verified tool result. Preserve the quality files. Start by reading cleaned.csv and fitting each batch by ordinary least squares to produce fits.json. Apply the user's continuation instructions to the unfinished work.",
  },
  citations: citationWorkflow,
} satisfies Record<string, ResearchCheckpointContract>;

export const researchCheckpointContract = (id: unknown): ResearchCheckpointContract | undefined =>
  typeof id === "string" && Object.hasOwn(checkpointWorkflows, id)
    ? checkpointWorkflows[id as keyof typeof checkpointWorkflows]
    : undefined;
