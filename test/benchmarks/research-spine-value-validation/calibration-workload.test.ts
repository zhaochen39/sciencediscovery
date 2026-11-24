import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureCalibrationClosure, currentCalibrationClosures, validateCalibration, writeCalibrationInput } from "./calibration-workload.ts";

test("calibration stage evidence expires when its output or an upstream revision changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "spine-calibration-"));
  try {
    await writeCalibrationInput(workspace);
    const raw = (await readFile(join(workspace, "instrument.csv"), "utf8")).trimEnd().split("\n");
    const empty = new Map<string, Buffer>();
    const qc = new Map([
      ["cleaned.csv", Buffer.from(`${raw.slice(0, -2).join("\n")}\n`)],
      ["qc.json", Buffer.from(JSON.stringify({ raw_rows: 38, clean_rows: 36, excluded_status_rows: 1, duplicate_rows: 1 }))],
    ]);
    const fit = new Map(qc);
    fit.set("fits.json", Buffer.from(JSON.stringify({
      reference: { n: 12, slope: 1.02, intercept: 0.12 },
      production_a: { n: 12, slope: 1.03, intercept: 0.22 },
      production_b: { n: 12, slope: 1.12, intercept: 0.20 },
    })));
    assert.deepEqual(validateCalibration(fit).slice(0, 2), [[], []]);
    assert.equal(captureCalibrationClosure(empty, fit, "combined"), undefined);
    const quality = captureCalibrationClosure(empty, qc, "quality");
    const regression = captureCalibrationClosure(qc, fit, "fit");
    assert.ok(quality && regression);
    assert.deepEqual(currentCalibrationClosures(fit, [quality, regression]), [quality, regression]);
    const missingOutput = new Map(fit);
    missingOutput.delete("fits.json");
    assert.deepEqual(currentCalibrationClosures(missingOutput, [quality, regression]), [quality]);
    const reformattedOutput = new Map(fit);
    reformattedOutput.set("fits.json", Buffer.from(`${fit.get("fits.json")}\n`));
    assert.deepEqual(currentCalibrationClosures(reformattedOutput, [quality, regression]), [quality]);
    const revisedQuality = new Map(fit);
    revisedQuality.set("qc.json", Buffer.from(`${qc.get("qc.json")}\n`));
    assert.deepEqual(validateCalibration(revisedQuality).slice(0, 2), [[], []]);
    assert.deepEqual(currentCalibrationClosures(revisedQuality, [quality, regression]), []);
    const newQuality = captureCalibrationClosure(fit, revisedQuality, "new-quality");
    assert.ok(newQuality);
    assert.deepEqual(currentCalibrationClosures(revisedQuality, [newQuality, regression]), [newQuality]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
