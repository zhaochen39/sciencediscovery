import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionStore } from "../../../services/api/src/store.ts";
import { researchCheckpointContract } from "../../../services/api/src/runs/research-workflows.ts";
import { readNodeMemory, verifyNodeMemory } from "./scope-experiments.ts";

const arm = process.argv[2];
assert.ok(arm, "Provide a completed formal experiment arm");
assert.equal((await readFile(join(arm, "exit-code.txt"), "utf8")).trim(), "0");
const result = JSON.parse(await readFile(join(arm, "result.json"), "utf8"));
const audit = spawnSync("python3", ["test/benchmarks/research-spine-value-validation/report-formal-recovery.py", arm, "--single"], { encoding: "utf8" });
assert.equal(audit.status, 0, audit.stderr || audit.stdout);
const checks = JSON.parse(audit.stdout);
assert.ok(checks.completion && checks.quality && checks.review_order && checks.token_reconciliation && checks.qc_unchanged);
assert.deepEqual(checks.qc_rewrites, []);
assert.equal(checks.repeated_table_reads, 0);
assert.equal(result.run.status, "completed");
const profile = researchCheckpointContract(result.run.researchResume?.workflow);
assert.ok(profile);
const root = (await readFile(join(arm, "data-dir.txt"), "utf8")).trim();
const store = new SessionStore(root);
await store.load();
try {
  const stored = await verifyNodeMemory(store, result.sessionId, result.run.id, profile.outputs);
  await assert.rejects(readNodeMemory(store, stored.ref, result.sessionId, "wrong-run"), /owner mismatch/);
  console.log(JSON.stringify({ arm, ...stored }));
} finally { store.close(); }
