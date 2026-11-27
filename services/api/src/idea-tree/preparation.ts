// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";
import type { CandidatePreparation, CandidatePreparationResult, IdeaResearchView, SessionRun } from "@sciencediscovery/schema";
import { CasStore } from "@sciencediscovery/cas";
import type { SessionStore } from "../store.js";

export async function buildCandidatePreparation(store: SessionStore, sessionId: string, view: IdeaResearchView, input: Record<string, unknown>) {
  const { candidateId, sourceVersionId, inputVersionId } = input;
  if (typeof candidateId !== "string" || typeof sourceVersionId !== "string" || typeof inputVersionId !== "string") {
    throw new Error("Choose a candidate, a source script and development inputs");
  }
  const node = view.graph.nodes.find(item => item.id === candidateId);
  if (!view.research.settings.candidateValidationEnabled || !["paused", "interrupted", "completed"].includes(view.research.status)
      || node?.kind !== "candidate" || node.status !== "done") {
    throw new Error("Choose an evaluated candidate in an opted-in research that is paused or complete");
  }
  const source = store.getArtifactVersion(sessionId, sourceVersionId);
  const data = store.getArtifactVersion(sessionId, inputVersionId);
  if (!source?.sourcePath?.toLowerCase().endsWith(".py") || !data?.sourcePath || source.sessionId !== sessionId || data.sessionId !== sessionId) {
    throw new Error("Choose this session's Python source and development dataset versions");
  }
  const sourceBytes = await new CasStore(store.dataDir).read(source.content.hash);
  const sourceText = sourceBytes.toString("utf8");
  if (sourceText.length > 200_000) throw new Error("The selected source script is too large for candidate preparation");
  const citations = new Set(node.basedOnValidationIds ?? []);
  const evidence = view.graph.nodes.flatMap(parent => [
    ...(parent.validations ?? []).filter(item => citations.has(item.id)).map(item => ({
      id: item.id, candidateId: parent.id, metric: item.metric, candidate: item.candidate,
      baseline: item.baseline, improvement: item.improvement, sampleCount: item.sampleCount,
    })),
    ...(parent.validationFailures ?? []).filter(item => citations.has(item.id)).map(item => ({
      id: item.id, candidateId: parent.id, stage: item.stage, failureCode: item.code,
    })),
  ]);
  const preparation: CandidatePreparation = {
    researchId: view.research.id, candidateId, sourceVersionId, inputVersionId,
    outputPath: `idea-candidate-${randomUUID()}.py`, evidenceIds: evidence.map(item => item.id),
  };
  const prompt = [
    "Implement the evaluated Idea Tree proposal as an executable Python candidate.",
    "The complete pinned source is included below. Do not call list_files, read_file, materialize_artifact, run_python, run_scientific, or any other inspection or test tool.",
    "Use exactly one run_shell call to write the supplied candidate source to the requested outputPath, then exactly one declare_artifact call for that path. Do not spend turns explaining the work before publishing the artifact.",
    "Keep the source command-line protocol unchanged. Only use the supplied source, objective, proposal and development inputs.",
    "Preserve the source program's command-line and output protocol. The validation Runner passes input.json as its only argument and reads a JSON array of {id, value} from stdout.",
    "When the file is complete, publish it with declare_artifact using its exact path. Return the path and a short description only after the artifact is published.",
    JSON.stringify({ objective: view.research.objective, proposal: node.hypothesis,
      source: { artifact_id: source.artifactId, version: source.version, path: `${preparation.outputPath}.source.py`, content: sourceText },
      development: { artifact_id: data.artifactId, version: data.version, path: data.sourcePath },
      outputPath: preparation.outputPath, evidence }),
  ].join("\n");
  return { preparation, prompt };
}

export function candidatePreparationOutput(store: SessionStore, sessionId: string, run: SessionRun): CandidatePreparationResult {
  const preparation = run.candidatePreparation;
  if (!preparation || run.sessionId !== sessionId) throw new Error("Candidate preparation not found");
  const identity = { runId: run.id, inputVersionId: preparation.inputVersionId, sourceVersionId: preparation.sourceVersionId };
  if (["queued", "running", "blocked"].includes(run.status)) return { ...identity, status: "running" };
  if (run.status !== "completed") return { ...identity, status: "failed" };
  for (const artifact of store.listArtifacts(sessionId)) {
    if (artifact.origin !== "llm_declared") continue;
    const version = store.listArtifactVersions(sessionId, artifact.id)
      .filter(item => item.sessionId === sessionId && item.turnId === run.id && item.sourcePath === preparation.outputPath)
      .sort((left, right) => right.version - left.version)[0];
    if (version) return { ...identity, status: "ready", versionId: version.id };
  }
  return { ...identity, status: "failed" };
}
