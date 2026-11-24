import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CasStore, VersionStore, type AgentStateRef } from "../../../packages/cas/src/index.ts";
import type { SessionStore } from "../../../services/api/src/store.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Call only after independent delivery audit accepts the terminal Run. */
export async function verifyNodeMemory(store: SessionStore, sessionId: string, runId: string, paths: readonly string[]) {
  const versions = new VersionStore(store.dataDir);
  const cas = new CasStore(store.dataDir);
  const entries = [];
  for (const path of paths) {
    const provenance = store.getWorkspaceFileProvenance(sessionId, path);
    const revision = provenance?.currentRevision;
    const bytes = await readFile(join(store.workspacePath(sessionId), path));
    const sha256 = digest(bytes);
    if (!provenance || !revision || revision.contentHash !== sha256 || revision.runId !== runId) {
      throw new Error(`Verified output has no matching Run file revision: ${path}`);
    }
    const linked = provenance.artifacts.flatMap(link => {
      const version = store.getArtifactVersion(sessionId, link.versionId);
      return version?.content.hash === sha256 ? [{ artifactId: link.artifactId, versionId: link.versionId }] : [];
    });
    const stored = await cas.read(sha256);
    if (!stored.equals(bytes)) throw new Error(`CAS bytes disagree with verified delivery: ${path}`);
    entries.push({ path, revisionId: revision.id, sha256, bytes: bytes.length, artifactVersions: linked });
  }
  const ref = await versions.putRecord("ResearchNodeMemory", { sessionId, runId, entries });
  const recovered = await readNodeMemory(store, ref, sessionId, runId);
  return { ref, entries: recovered, workspaceBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), memoryBytes: ref.size };
}

type MemoryEntry = { path: string; revisionId: string; sha256: string; bytes: number; artifactVersions: Array<{ artifactId: string; versionId: string }> };

export async function readNodeMemory(store: SessionStore, ref: AgentStateRef, sessionId: string, runId: string) {
  const { value } = await new VersionStore(store.dataDir).readRecord<{ sessionId: string; runId: string; entries: MemoryEntry[] }>(ref, "ResearchNodeMemory");
  if (value.sessionId !== sessionId || value.runId !== runId) throw new Error("Research Node Memory owner mismatch");
  for (const entry of value.entries) {
    const revision = store.getWorkspaceFileProvenance(sessionId, entry.path)?.currentRevision;
    if (revision?.id !== entry.revisionId || revision.contentHash !== entry.sha256) throw new Error(`Research Node Memory revision expired: ${entry.path}`);
    const bytes = await readFile(join(store.workspacePath(sessionId), entry.path));
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Research Node Memory file changed: ${entry.path}`);
    const cas = new CasStore(store.dataDir, "data");
    for (const link of entry.artifactVersions) {
      const artifact = store.getArtifactVersion(sessionId, link.versionId);
      if (artifact?.artifactId !== link.artifactId || artifact.content.hash !== entry.sha256 || artifact.content.size !== entry.bytes
        || !revision.artifactVersionIds.includes(link.versionId) || !(await cas.read(entry.sha256)).equals(bytes)) {
        throw new Error(`Research Node Memory artifact link expired: ${entry.path}`);
      }
    }
  }
  return value.entries;
}
