import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseStageProjection, type WorkflowStage } from "./stage-policy.ts";

const stages: WorkflowStage[] = [
  { id: "quality", kind: "quality", consumes: [] },
  { id: "fit", kind: "analysis", consumes: ["clean.csv"] },
  { id: "report", kind: "report", consumes: [] },
];
const quality = { stageId: "quality", toolCallId: "write", resultSource: { toolCallId: "read", contentSha256: "a".repeat(64) },
  artifacts: [{ path: "clean.csv", revision: "v1", fields: { count: 50 } }] };

test("projection requires a bound readout consumed by the next incomplete analysis stage", () => {
  const pendingFit = [[], ["missing"], ["missing"]];
  assert.equal(chooseStageProjection(stages, pendingFit, [quality]).source, quality);
  assert.equal(chooseStageProjection(stages, pendingFit, []).reason, "no_current_readout");
  assert.equal(chooseStageProjection(stages, [[], [], ["missing"]], [quality]).reason, "report_only");
  assert.equal(chooseStageProjection(stages, [["stale"], [], []], [quality]).reason, "quality_pending");
  assert.equal(chooseStageProjection(stages, [[], []], [quality]).reason, "unknown_stage");
});
