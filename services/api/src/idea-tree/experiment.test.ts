// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CandidateExperiment, CandidateValidation, IdeaResearchView } from "@sciencediscovery/schema";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { SessionStore } from "../store.js";
import { createExperimentValidation } from "./experiment.js";
import { ResearchTransportError } from "./research.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("restores a persisted comparison after an ambiguous attachment without starting more executions", async () => {
  const data = await mkdtemp(join(tmpdir(), "sd-experiment-recovery-"));
  const id = `experiment-${"a".repeat(64)}`;
  const dir = join(data, "idea-validations");
  const result: CandidateValidation = {
    id: "measured", scorerVersion: "matched-json-samples/v1", metric: "mae",
    referenceVersionId: "labels", baselineVersionId: "baseline-predictions", candidateVersionId: "candidate-predictions",
    baselineArtifactId: "baseline-artifact", candidateArtifactId: "candidate-artifact",
    baselineExecutionId: "baseline-run", candidateExecutionId: "candidate-run", baseline: 5, candidate: 0, improvement: 5, sampleCount: 2,
  };
  const view = { graph: { nodes: [{ id: "candidate", validations: [result] }] } } as unknown as IdeaResearchView;
  const job: CandidateExperiment = {
    id, status: "running", researchId: "research", candidateId: "candidate", createdAt: new Date().toISOString(), timeoutMs: 60_000,
    metric: "mae", inputVersionId: "development", referenceVersionId: "labels", baselineScriptVersionId: "seed", candidateScriptVersionId: "new",
    executionIds: { baseline: result.baselineExecutionId, candidate: result.candidateExecutionId },
    predictionVersionIds: { baseline: result.baselineVersionId, candidate: result.candidateVersionId },
  };
  let attachments = 0;
  let starts = 0;
  const store = {
    workspacePath: () => join(data, "workspace"),
    listProjects: () => [{ id: "project" }],
    listSessions: () => [{ id: "session" }],
    getSession: () => ({ id: "session" }),
    shellExecutions: {
      wait: async (id: string) => ({ id, state: "completed", provenance: "committed" }),
      start: async () => { starts += 1; throw new Error("Must not redispatch"); },
    },
  } as unknown as SessionStore;
  const options = {
    store, runner: {} as RunnerClient, recorder: {} as ProvenanceRecorder, readResearch: async () => view,
    score: async () => {
      attachments += 1;
      if (attachments === 1) throw new ResearchTransportError("Lost attachment response");
      return view;
    },
  };
  const first = createExperimentValidation(options);
  const recovered = createExperimentValidation(options);
  async function waitFor(worker: typeof first, status: CandidateExperiment["status"]) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const current = await worker.poll("session", id);
      if (current.status === status) return current;
      await delay(50);
    }
    throw new Error(`Expected comparison status ${status}`);
  }
  try {
    await mkdir(dir);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(job));
    await first.resume();
    const unconfirmed = await waitFor(first, "unconfirmed");
    assert.equal(unconfirmed.result, undefined);
    first.close();
    await recovered.resume();
    const ready = await waitFor(recovered, "ready");
    assert.deepEqual(ready.result, result);
    assert.deepEqual(ready.executionIds, job.executionIds);
    assert.equal(attachments, 2);
    assert.equal(starts, 0);
  } finally {
    first.close();
    recovered.close();
    await rm(data, { recursive: true, force: true });
  }
});
