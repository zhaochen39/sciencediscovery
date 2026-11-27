// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ExecutionRun, ScientificArtifactVersion } from "@sciencediscovery/schema";
import { evaluateCandidateValidation, parseSamples, scoreSamples } from "./validation.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const samples = (...values: number[]) => values.map((value, index) => ({ id: `i${index}`, value }));

test("matches by exact ID and uses the metric's direction", () => {
  const reference = parseSamples(samples(0, 1, 1));
  const predictions = parseSamples(samples(1, 1, 0).reverse());
  assert.equal(scoreSamples("accuracy", reference, predictions), 1 / 3);
  assert.equal(scoreSamples("mae", reference, predictions), 2 / 3);
  assert.equal(scoreSamples("nrmse", reference, predictions), 1);
  assert.throws(() => scoreSamples("mae", reference, new Map([["i0", 1], ["i1", 1], ["wrong", 0]])), /match exactly/);
  assert.throws(() => scoreSamples("nrmse", parseSamples(samples(0)), parseSamples(samples(0))), /nonzero/);
  assert.throws(() => scoreSamples("accuracy", reference, parseSamples(samples(0, 0.5, 1))), /integer/);
  assert.throws(() => parseSamples([...samples(0), ...samples(1)]), /unique/);
  assert.throws(() => parseSamples(samples(Infinity)), /finite/);
});

function fixture() {
  const versions = new Map<string, ScientificArtifactVersion>();
  const rows = new Map<string, Buffer>();
  const runs: ExecutionRun[] = [];
  for (const [id, values] of [["r", [0, 1]], ["b", [1, 0]], ["c", [0, 1]]] as const) {
    const bytes = Buffer.from(JSON.stringify(samples(...values)));
    rows.set(id, bytes);
    versions.set(id, {
      id, projectId: "p", sessionId: "s", artifactId: `artifact-${id}`, content: { hash: id, size: bytes.length },
      mediaType: "application/json", version: 1, createdAt: "now", sourcePath: `${id}.json`, turnId: id,
      executionRunIds: id === "r" ? [] : [id], inputArtifactVersionIds: [],
    });
    if (id !== "r") runs.push({
      id, turnId: id, sessionId: "s", status: "succeeded", exitCode: 0, sandbox: "bubblewrap",
      networkPolicy: "none", runnerVersion: "1", environmentRevisionId: "env", tool: "run_shell",
      kernelMode: "ephemeral", createdFiles: [`${id}.json`], modifiedFiles: [],
      cgroupMode: "none", language: "shell", kernelId: id, permissionEpochId: "epoch", toolVersion: "1",
      startedAt: "now", finishedAt: "now", workingDirectory: "/workspace",
      code: { hash: "code", size: 5 }, stdout: { hash: "stdout", size: 0 }, stderr: { hash: "stderr", size: 0 },
    });
  }
  const request = { metric: "accuracy", referenceVersionId: "r", baselineVersionId: "b", candidateVersionId: "c", improvement: 500 };
  return { versions, runs, rows, evaluate: () => evaluateCandidateValidation({
    getArtifactVersion: (_session, id) => versions.get(id), listExecutionRuns: async () => runs,
  }, { read: async hash => rows.get(hash)!, storedSize: async hash => rows.get(hash)?.length }, "s", "p", request) };
}

test("scores immutable input versions on the server and retains run lineage", async () => {
  const { evaluate } = fixture();
  const result = await evaluate();
  assert.equal(result.improvement, 1);
  assert.equal(result.baseline, 0);
  assert.equal(result.candidate, 1);
  assert.equal(result.candidateExecutionId, "c");
  assert.deepEqual(await evaluate(), result);
});

test("rejects scope violations, different environments, unresolved or unrelated execution receipts", async () => {
  const { evaluate, versions, runs } = fixture();
  versions.get("c")!.sessionId = "other";
  await assert.rejects(evaluate(), /belong to this session/);
  versions.get("c")!.sessionId = "s";
  runs[1]!.environmentRevisionId = "another environment";
  await assert.rejects(evaluate(), /same managed Runner/);
  runs[1]!.environmentRevisionId = "env";
  runs[1]!.status = "unconfirmed";
  await assert.rejects(evaluate(), /successful managed run/);
  runs[1]!.status = "succeeded";
  versions.get("c")!.sourcePath = "out-of-band-edit.json";
  await assert.rejects(evaluate(), /successful managed run/);
});
