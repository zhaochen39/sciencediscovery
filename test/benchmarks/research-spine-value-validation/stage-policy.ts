import type { VerifiedStageClosure } from "../../../packages/context/src/verified-stage-projection.ts";

export type WorkflowStage = { id: string; kind: "quality" | "analysis" | "report"; consumes: readonly string[] };

export function chooseStageProjection<T extends VerifiedStageClosure>(stages: readonly WorkflowStage[], errors: readonly (readonly string[])[],
  closures: readonly T[]) {
  const next = errors.length === stages.length ? stages[errors.findIndex((items) => items.length > 0)] : undefined;
  const source = next?.kind === "analysis" ? closures.find((closure) => closure.resultSource
    && closure.artifacts.some((artifact) => next.consumes.includes(artifact.path))) : undefined;
  const reason = next?.kind === "analysis" ? source ? "eligible" : "no_current_readout"
    : next?.kind === "report" ? "report_only" : next?.kind === "quality" ? "quality_pending"
      : errors.length === stages.length && errors.every((items) => items.length === 0) ? "complete" : "unknown_stage";
  return { nextStage: next?.id, reason, source };
}
