import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { loadServerConfig } from "../../../services/api/src/bootstrap/config.ts";
import { closeApiServer, createApiServer } from "../../../services/api/src/http/index.ts";
import { SessionStore } from "../../../services/api/src/store.ts";

const [source, output] = process.argv.slice(2);
assert.ok(source && output, "Provide a citation memory proof and HTTP result output path");
const proof = JSON.parse(await readFile(source, "utf8"));
const run = JSON.parse(await readFile(join(proof.arm, "result.json"), "utf8"));
assert.ok(proof.memoryStore);
const settings = loadServerConfig({ ...process.env, SCIENCE_AGENT_DATA_DIR: proof.memoryStore, SCIENCE_AGENT_MEMORY_GRAPH_AUTO_INSTALL: "0" });
const api = createApiServer({ ...settings, host: "127.0.0.1", port: 0, disableBootstrapProject: true, memoryGraph: { url: "", internalToken: "" } });
await new Promise<void>((done, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", done); });
const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const store = new SessionStore(proof.memoryStore);
const url = (runId: string, versionId: string) => `${origin}/api/sessions/${run.sessionId}/runs/${runId}/node-memory?versionId=${encodeURIComponent(versionId)}`;
const get = (target: string) => fetch(target, { headers: { authorization: `Bearer ${settings.authToken}` } });
try {
  const proofs = [];
  for (const link of proof.linked) {
    const target = url(run.run.id, link.versionId);
    const start = performance.now();
    const answer = await get(target);
    assert.equal(answer.status, 200, await answer.clone().text());
    const retrieved = await answer.json() as { content: string; versionId: string; path: string; sha256: string };
    const retrievalMs = performance.now() - start;
    assert.equal(retrieved.versionId, link.versionId);
    assert.equal(retrieved.path, link.path);
    assert.equal(retrieved.sha256, link.sha256);
    await store.load();
    const path = join(store.workspacePath(run.sessionId), link.path);
    store.close();
    const initial = await readFile(path);
    assert.equal(retrieved.content, initial.toString("utf8"));
    assert.equal((await get(url(run.sourceRunId, link.versionId))).status, 409);
    try {
      await writeFile(path, "{}\n");
      assert.equal((await get(target)).status, 409);
    } finally { await writeFile(path, initial); }
    assert.deepEqual(await (await get(target)).json(), retrieved);
    proofs.push({ ...retrieved, retrievalMs });
  }
  await writeFile(output, JSON.stringify({ proofs, tamperedRejected: true, wrongRunRejected: true }, null, 2));
} finally {
  await closeApiServer(api);
}
