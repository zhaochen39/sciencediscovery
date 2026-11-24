import type { AddressInfo } from "node:net";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerClient } from "../../../packages/executor/dist/index.js";
import type { loadServerConfig } from "../../../services/api/src/bootstrap/config.ts";
import { closeApiServer, createApiServer } from "../../../services/api/src/http/index.ts";
import { SessionStore } from "../../../services/api/src/store.ts";

// Separate API process with real durable state and an external test Runner.
process.once("message", async (config: ReturnType<typeof loadServerConfig>) => {
  if (process.env.SCIENCE_SPINE_FORMAL_FAULT === "runner-unavailable") {
    const cancel = RunnerClient.prototype.cancelShellExecution;
    RunnerClient.prototype.cancelShellExecution = async function (...args: Parameters<typeof cancel>) {
      const blocked = await access(join(config.dataDir, "refuse-shell-stop")).then(() => true, () => false);
      if (blocked) throw Object.assign(new Error("Injected loss of Runner cancel transport"), { statusCode: 503 });
      return cancel.apply(this, args);
    };
  }
  if (process.env.SCIENCE_SPINE_FORMAL_CONTROLLED === "queued-rollback") {
    const transition = SessionStore.prototype.updateSessionRunStatusIfCurrent;
    SessionStore.prototype.updateSessionRunStatusIfCurrent = async function (...args: Parameters<typeof transition>) {
      const [, runId, current, next] = args;
      const hold = current === "queued" && next === "running"
        && await access(join(config.dataDir, "hold-queued-run")).then(() => true, () => false);
      if (hold) {
        await writeFile(join(config.dataDir, "observed-queued-run"), runId);
        return await new Promise<never>(() => {});
      }
      return transition.apply(this, args);
    };
  }
  const api = createApiServer(config);
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", resolve);
  });
  process.send!({ port: (api.address() as AddressInfo).port });
  process.once("message", async () => {
    await closeApiServer(api);
    process.disconnect!();
  });
});
