// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VersionStore } from "@sciencediscovery/cas";
import type { Subagent } from "@sciencediscovery/schema";
import { writeSpawnReceipt } from "./spawn-receipt.js";

const timestamp = "2026-11-26T00:00:00Z";
function child(id: string, patch: Partial<Subagent> = {}): Subagent {
  return { id, sessionId: "session", parentTurnId: "parent", createdAt: timestamp, finishedAt: timestamp,
    status: "completed", structuredResult: { result: id }, steps: [], input: { description: id, prompt: id, subagentType: "general-purpose" },
    turnCount: 1, maxTurns: 3, timeoutSeconds: 30, ...patch };
}

test("spawn receipt preserves mixed outcomes, and replay is independent of order and duplicates", async context => {
  const root = await mkdtemp(join(tmpdir(), "spawn-receipt-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const success = child("a");
  const failed = child("b", { status: "failed", error: "result validation failed" });
  const cancelled = child("c", { status: "cancelled" });
  const receipt = await writeSpawnReceipt(root, "session", "parent", [cancelled, failed, success]);
  assert.deepEqual(await writeSpawnReceipt(root, "session", "parent", [success, cancelled, failed, success]), receipt);
  assert.deepEqual(receipt.branches.map(row => row.status), ["completed", "failed", "cancelled"]);
  assert.equal(receipt.branches[1]?.error, "result validation failed");
  assert.equal(receipt.branches[2]?.resultRef, undefined);
  const versions = new VersionStore(root);
  assert.deepEqual((await versions.readRecord(receipt.branches[0]!.resultRef!, "ResearchDelegationResult")).value,
    { childId: "a", result: { result: "a" } });
  await assert.rejects(writeSpawnReceipt(root, "session", "parent", [success, { ...success, status: "failed" }]), /conflicting/);
  for (const uncommitted of [child("running", { status: "running" }), child("restart", { interruptedByRestart: true }), child("other", { parentTurnId: "other" })]) {
    await assert.rejects(writeSpawnReceipt(root, "session", "parent", [uncommitted]), /committed terminal/);
  }
});
