// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CasStore, VersionStore, type AgentStateRef } from "@sciencediscovery/cas";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import type { ExecutionLogPage, SessionRun } from "@sciencediscovery/schema";

import { planResearchRecovery, projectVerifiedResearchEvidence } from "../native-agent/research-recovery.js";
import type { SessionStore } from "../store.js";
import { closedModelContext } from "./model-context.js";
import { researchCheckpointContract } from "./research-workflows.js";

const maxArtifactBytes = 1024 * 1024;
const maxHistoryBytes = 4 * 1024 * 1024;
const recordKind = "ResearchQualityCheckpoint";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export type ResearchResumeBinding = NonNullable<SessionRun["researchResume"]>;
export class ResearchCheckpointError extends Error {}

interface Checkpoint {
  sessionId: string;
  projectId: string;
  sourceRunId: string;
  sourceMessageId: string;
  workspace: string;
  workflow: string;
  contractVersion?: number;
  revisions: Record<string, string>;
  history: AgentHistoryMessage[];
  swarmHistory?: AgentHistoryMessage[];
  originalTask: string;
}

export function researchRecoveryPilotAllows(workflow: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return researchCheckpointContract(workflow)?.pilotEligible === true
    && (env.SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS?.split(",").map(value => value.trim()).includes(workflow) ?? false);
}

export function researchRecoveryMode(sessionId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!env.SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS?.split(",").map(id => id.trim()).includes(sessionId)) return;
  const mode = env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE;
  if (mode === "full" || mode === "by-state") return mode;
  if (mode === "pilot") return "by-state" as const;
}

async function readArtifact(root: string, name: string): Promise<Buffer> {
  const path = join(root, name);
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n || entry.size > maxArtifactBytes) throw new ResearchCheckpointError("Unsupported checkpoint artifact");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    const bytes = Buffer.alloc(Number(before.size > maxArtifactBytes ? 0n : before.size) + 1);
    if (before.size > maxArtifactBytes || !before.isFile() || before.nlink !== 1n) throw new ResearchCheckpointError("Unsupported checkpoint artifact");
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (BigInt(bytesRead) !== before.size || before.size !== after.size || before.ctimeNs !== after.ctimeNs
      || before.mtimeNs !== after.mtimeNs || entry.ino !== before.ino || entry.dev !== before.dev
      || !current.isFile() || current.ino !== after.ino || current.dev !== after.dev || await realpath(path) !== path) throw new ResearchCheckpointError("Checkpoint artifact changed during read");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function readArtifacts(root: string, paths: readonly string[]) {
  return new Map(await Promise.all(paths.map(async name => [name, await readArtifact(root, name)] as const)));
}

async function checkpointWorkspace(store: SessionStore, sessionId: string) {
  const workspace = resolve(store.workspacePath(sessionId));
  if (await realpath(workspace) !== workspace) throw new ResearchCheckpointError("Unsupported checkpoint workspace alias");
  return workspace;
}

/** The source run must have finished at the quality boundary. A failed or
 * interrupted process may have unrecorded effects, so it cannot publish a checkpoint. */
export async function sealResearchCheckpoint(store: SessionStore, sessionId: string, sourceRunId: string,
  workflow: string, mode: ResearchResumeBinding["mode"], swarm = false): Promise<ResearchResumeBinding> {
  const profile = researchCheckpointContract(workflow);
  if (!profile) throw new ResearchCheckpointError("Unknown research checkpoint workflow");
  const session = store.assertSessionWritable(sessionId);
  const source = await store.getSessionRun(sessionId, sourceRunId);
  const messages = await store.readMessages(sessionId);
  const last = messages.at(-1);
  if (!source || source.status !== "completed" || !last?.modelContext?.length || last.id !== source.assistantMessageId
    || source.researchResume || !source.userMessageId) throw new ResearchCheckpointError("The latest Run must have completed the quality stage");
  const original = messages.find(message => message.id === source.userMessageId);
  if (!original || original.role !== "user") throw new ResearchCheckpointError("Original task is missing");
  const history = closedModelContext(last.modelContext);
  if (history.length !== last.modelContext.length || Buffer.byteLength(JSON.stringify(history)) > maxHistoryBytes) {
    throw new ResearchCheckpointError("Checkpoint history is incomplete or too large");
  }
  const swarmHistory = swarm ? messages.flatMap((message): AgentHistoryMessage[] => {
    if (message.role === "assistant" && message.modelContext?.length) return closedModelContext(message.modelContext);
    return [{ role: message.role, content: message.content }];
  }) : undefined;
  if (swarmHistory && Buffer.byteLength(JSON.stringify(swarmHistory)) > maxHistoryBytes) {
    throw new ResearchCheckpointError("Swarm checkpoint history is too large");
  }
  const workspace = await checkpointWorkspace(store, sessionId);
  const artifacts = await readArtifacts(workspace, profile.inputs);
  if (!profile.acceptQuality(artifacts)) throw new ResearchCheckpointError("Independent quality verification failed");
  if (process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE === "pilot") {
    if (!researchRecoveryPilotAllows(workflow)) throw new ResearchCheckpointError("This workflow is not enrolled in the research recovery pilot");
    const table = artifacts.get(profile.table)!;
    const evidence = planResearchRecovery({ history, table, artifactSha256: digest(table), displayObserved: true }).evidence;
    if (!evidence) throw new ResearchCheckpointError("The research recovery pilot requires a verified table display");
  }
  for (const name of profile.outputs) {
    const found = await lstat(join(workspace, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (found) throw new ResearchCheckpointError("Workspace already contains downstream outputs");
  }
  const value: Checkpoint = { sessionId, projectId: session.projectId, sourceRunId, sourceMessageId: last.id, workspace,
    workflow, contractVersion: profile.version, revisions: Object.fromEntries([...artifacts].map(([name, bytes]) => [name, digest(bytes)])),
    history, ...(swarmHistory ? { swarmHistory } : {}), originalTask: original.content };
  const ref = await new VersionStore(store.dataDir).putRecord(recordKind, value);
  return { sourceRunId, workflow, mode, ref };
}

export async function loadResearchCheckpoint(store: SessionStore, sessionId: string, binding: ResearchResumeBinding, swarm = false) {
  const session = store.assertSessionWritable(sessionId);
  const workspace = await checkpointWorkspace(store, sessionId);
  const { value } = await new VersionStore(store.dataDir).readRecord<Checkpoint>(binding.ref as AgentStateRef, recordKind);
  const messages = await store.readMessages(sessionId);
  if (swarm !== Boolean(value.swarmHistory)) throw new ResearchCheckpointError("Research checkpoint executor changed");
  if (value.sessionId !== sessionId || value.projectId !== session.projectId || value.sourceRunId !== binding.sourceRunId
    || value.workflow !== binding.workflow || value.workspace !== workspace || messages.at(-1)?.id !== value.sourceMessageId) {
    throw new ResearchCheckpointError("Checkpoint does not match this session, workspace or source Run");
  }
  const profile = researchCheckpointContract(binding.workflow);
  // Before versioning, only the two original contracts could be sealed.
  const contractVersion = value.contractVersion ?? (binding.workflow === "solar" || binding.workflow === "calibration" ? 1 : undefined);
  if (!profile || contractVersion !== profile.version) throw new ResearchCheckpointError("Research checkpoint contract changed");
  const artifacts = await readArtifacts(workspace, profile.inputs);
  const matches = (files: Map<string, Buffer>) => profile.inputs.every(name => {
    const bytes = files.get(name);
    return bytes !== undefined && value.revisions[name] === digest(bytes);
  });
  if (!matches(artifacts) || !profile.acceptQuality(artifacts)) throw new ResearchCheckpointError("Checkpoint artifacts changed");
  for (const name of profile.outputs) {
    const found = await lstat(join(workspace, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (found) throw new ResearchCheckpointError("Downstream output exists before resume");
  }
  const fingerprints = async () => Promise.all(profile.inputs.map(async name => {
    const item = await lstat(join(workspace, name), { bigint: true });
    return `${item.dev}:${item.ino}:${item.mtimeNs}:${item.ctimeNs}`;
  }));
  const beforeDelivery = await fingerprints();
  const table = artifacts.get(profile.table)!;
  const displayText = table.toString("utf8").replaceAll("\r\n", "\n").trimEnd();
  const plan = planResearchRecovery({ history: value.history, table, artifactSha256: value.revisions[profile.table]!, displayObserved: true });
  let displayObserved = plan.evidence !== undefined;
  let downstreamBeforeDisplay = false;
  const pendingDisplays = new Set<string>();
  const completedDisplays = new Set<string>();
  const hasTable = (text: string | undefined) => text !== undefined
    && `\n${text.replaceAll("\r\n", "\n")}\n`.includes(`\n${displayText}\n`);
  const observeTool = (name: string, failed: boolean, details: unknown, text: string | undefined, args?: Record<string, unknown>) => {
    if (!details || typeof details !== "object") return;
    const tool = details as { executionId?: unknown; state?: unknown; finalization?: unknown; result?: unknown;
      exitCode?: unknown; createdFiles?: unknown; modifiedFiles?: unknown };
    const result = tool.result && typeof tool.result === "object" ? tool.result as typeof tool : tool;
    const changes = [result.createdFiles, result.modifiedFiles];
    const files = changes.flatMap(value => Array.isArray(value) ? value : []);
    if (!displayObserved && files.some(file => profile.outputs.includes(file))) downstreamBeforeDisplay = true;
    if (failed || displayObserved) return;
    const executionId = tool.executionId;
    const success = tool.state === "completed" && result.exitCode === 0
      && (tool.finalization === undefined || tool.finalization === "committed");
    if (name === "run_shell") {
      const stdout = text?.replaceAll("\r\n", "\n").split("\nstdout:\n", 2)[1]?.split("\nstderr:\n", 1)[0];
      if (success && hasTable(stdout)) displayObserved = true;
      if (typeof executionId === "string" && /^shell:[a-f0-9]{64}$/u.test(executionId)
        && (tool.state === "running" || tool.state === "queued")) pendingDisplays.add(executionId);
    }
    if (name === "execution_status" && typeof executionId === "string" && args?.execution_id === executionId
      && pendingDisplays.has(executionId) && success && changes.every(value => Array.isArray(value) && value.length === 0)) {
      completedDisplays.add(executionId);
    }
    if (name !== "execution_logs" || typeof args?.execution_id !== "string"
      || !completedDisplays.has(args.execution_id) || (args.cursor !== undefined && args.cursor !== 0) || !text) return;
    // Parse only the page delivered to the model, not hidden Runner stdout or a
    // partial preview. A successful status alone does not count as a display.
    try {
      const page = JSON.parse(text) as ExecutionLogPage | null;
      if (page?.state === "completed" && page.truncated === false && page.retentionTruncated === false
        && Array.isArray(page.chunks) && page.chunks.every(chunk => typeof chunk?.text === "string")) {
        displayObserved = hasTable(page.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join(""));
      }
    } catch { /* Rendered output is not a complete log page. */ }
  };
  const verifyDelivery = async () => {
    const files = await readArtifacts(workspace, [...profile.inputs, ...profile.outputs]);
    const afterDelivery = await fingerprints();
    if (!matches(files) || !profile.acceptDelivery(files) || afterDelivery.some((id, i) => id !== beforeDelivery[i])) {
      throw new ResearchCheckpointError("Scientific outputs failed independent verification or accepted files were rewritten");
    }
    if (!displayObserved || downstreamBeforeDisplay) throw new ResearchCheckpointError("The quality table must be displayed before downstream computation");
    return profile.outputs.filter(path => path.endsWith(".json")).map(path => ({ path, hash: digest(files.get(path)!) }));
  };
  const enabled = researchRecoveryMode(sessionId);
  const enrolled = process.env.SCIENCE_AGENT_RESEARCH_RECOVERY_MODE !== "pilot" || researchRecoveryPilotAllows(binding.workflow);
  if (binding.mode !== "by-state" || enabled !== "by-state" || !enrolled || !plan.evidence) {
    const reason = binding.mode === "full" ? "baseline" : enabled !== "by-state" || !enrolled ? "disabled" : "display-evidence-unavailable";
    // A queued checkpoint accepted before rollback keeps the same execution boundary.
    return { verifyDelivery, observeTool, restrictedTools: true, route: "full" as const, reason, swarmHistory: value.swarmHistory };
  }
  const receipt = plan.evidence.receipt;
  return {
    verifyDelivery,
    observeTool,
    restrictedTools: true,
    route: "retire-display" as const,
    reason: "verified-display",
    history: plan.evidence.messages as AgentHistoryMessage[],
    swarmHistory: swarm ? plan.evidence.messages as AgentHistoryMessage[] : undefined,
    handoff: `${profile.handoff}
The quality stage is complete. The runtime verified the following files and the full table display for this revision. Do not rewrite them, repeat the display, list the directory, or regenerate the quality stage. Read rows only inside the calculation that needs them. The current continuation supplies the deliverable requirements.
Verified files: ${JSON.stringify(value.revisions)}
Preserve constraints from the original stage request:
${value.originalTask}`,
    createProjection(onTransition: (state: "retired" | "restored", turn: number) => void | Promise<void>) {
      return projectVerifiedResearchEvidence<AgentHistoryMessage>({ receipt, onTransition, acceptedInputRevision: async () => {
        try {
          const files = await readArtifacts(workspace, [...profile.inputs, profile.outputs[0]!]);
          if (matches(files) && profile.acceptDownstream(files)) return receipt.artifactSha256;
        } catch { /* Inconclusive acceptance keeps the original tool evidence. */ }
      } });
    },
  };
}

/** Fetch an exact, still-current artifact from an independently verified Run. */
export async function readResearchNodeMemory(store: SessionStore, sessionId: string, runId: string, versionId: string) {
  const session = store.getSession(sessionId);
  const run = await store.getSessionRun(sessionId, runId);
  const binding = run?.researchResume;
  if (!session || run?.status !== "completed" || !binding) throw new ResearchCheckpointError("Node Memory requires a completed research checkpoint Run");
  const version = store.getArtifactVersion(sessionId, versionId);
  const profile = researchCheckpointContract(binding.workflow);
  if (!profile || version?.sessionId !== sessionId || version.turnId !== runId || !version.sourcePath
    || !profile.outputs.includes(version.sourcePath) || version.mediaType !== "application/json" || version.content.size > 64 * 1024) {
    throw new ResearchCheckpointError("Node Memory requires a bounded JSON Artifact Version from this Run");
  }
  const path = version.sourcePath;
  const current = () => store.getWorkspaceFileProvenance(sessionId, path)?.currentRevision;
  const revision = current();
  if (revision?.runId !== runId || !revision.artifactVersionIds.includes(version.id) || revision.contentHash !== version.content.hash) {
    throw new ResearchCheckpointError("Node Memory Artifact Version is stale");
  }
  const workspace = await checkpointWorkspace(store, sessionId);
  const { value } = await new VersionStore(store.dataDir).readRecord<Checkpoint>(binding.ref as AgentStateRef, recordKind);
  const contractVersion = value.contractVersion ?? (binding.workflow === "solar" || binding.workflow === "calibration" ? 1 : undefined);
  if (value.sessionId !== sessionId || value.projectId !== session.projectId || value.sourceRunId !== binding.sourceRunId
    || value.workflow !== binding.workflow || contractVersion !== profile.version) {
    throw new ResearchCheckpointError("Node Memory checkpoint contract changed");
  }
  const files = await readArtifacts(workspace, [...profile.inputs, ...profile.outputs]);
  const bytes = await new CasStore(store.dataDir, "data").read(version.content.hash);
  if (!profile.inputs.every(name => digest(files.get(name)!) === value.revisions[name]) || !profile.acceptDelivery(files)
    || !files.get(path)!.equals(bytes) || digest(bytes) !== version.content.hash || bytes.length !== version.content.size
    || current()?.id !== revision.id) {
    throw new ResearchCheckpointError("Node Memory Artifact Version no longer matches verified evidence");
  }
  return { versionId, path, revisionId: revision.id, sha256: version.content.hash, content: bytes.toString("utf8") };
}
