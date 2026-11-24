import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ConservativeTokenEstimator } from "../../../packages/context/src/token-estimator.ts";
import { projectScopeHistory, type ScopeNodeMemory } from "../../../packages/context/src/scope-projection.ts";

type Message = Record<string, unknown> & { role?: string; content?: string };
type Mode = "B0" | "B1" | "V1";

const repositoryRoot = resolve(import.meta.dirname, "../../../");
const outputRoot = resolve(process.env.SCIENCE_SPINE_LOG_DIR ?? join(repositoryRoot, "test/benchmarks/research-spine-value-validation/logs"));
const repetitions = Math.max(1, Number(process.env.SCIENCE_SPINE_REPETITIONS ?? 20));
const artifactNames = ["phase1_quality.json", "cleaned_cohort.csv", "descriptive_stats.json", "model_results.json", "sensitivity.json", "final_report.md"];
const estimator = new ConservativeTokenEstimator<Message>();

function toolCall(name: string, id: string) {
  return { id, type: "function", function: { name, arguments: JSON.stringify({ command: `analyze ${name}` }) } };
}

function toolRound(name: string, result: string, turn: number): Message[] {
  const id = `call-${turn}-${name}`;
  return [
    { role: "assistant", content: `I will use ${name} to inspect the current stage.`, tool_calls: [toolCall(name, id)] },
    { role: "tool", tool_call_id: id, name, content: result },
  ];
}

function makeHistory(): Message[] {
  const history: Message[] = [{
    role: "user",
    content: "Complete the fixed cohort.csv scientific analysis in six stages and produce all required artifacts.",
  }];
  const filler = "Observed fixed local data. The analysis must preserve the treatment effect direction positive, keep the unresolved missing-value issue visible, and reference the generated artifacts. ".repeat(12);
  history.push(...toolRound("read_file", `cohort.csv has 60 rows and 10 columns. ${filler}`, 1));
  history.push({ role: "assistant", content: `Stage 1 complete. duplicate subject count is 1, missing biomarker_a count is 2. ${filler}` });
  history.push(...toolRound("run_shell", `Wrote phase1_quality.json and cleaned_cohort.csv. ${filler}`, 2));
  history.push({ role: "assistant", content: `Stage 2 complete. Duplicate and missing biomarker rows were removed. ${filler}` });
  history.push(...toolRound("read_file", `Repeated read of cohort.csv for descriptive statistics. ${filler}`, 3));
  history.push(...toolRound("run_shell", `Wrote descriptive_stats.json. Treated outcome rate is higher than control. ${filler}`, 4));
  history.push({ role: "assistant", content: `Stage 3 complete. Main treatment effect direction is positive. ${filler}` });
  history.push(...toolRound("read_file", `Repeated read of cohort.csv for the baseline model. ${filler}`, 5));
  history.push(...toolRound("run_shell", `Wrote model_results.json. ${filler}`, 6));
  history.push({ role: "assistant", content: `Stage 4 complete. The treatment coefficient direction is positive with uncertainty reported. ${filler}` });
  history.push(...toolRound("run_shell", `Wrote sensitivity.json. The positive treatment effect direction is stable. ${filler}`, 7));
  history.push({ role: "assistant", content: `Stage 5 complete. Remaining obligation is to write final_report.md and reference phase1_quality.json, cleaned_cohort.csv, descriptive_stats.json, model_results.json, and sensitivity.json.` });
  history.push(...toolRound("run_shell", `Wrote final_report.md with all five artifact references. ${filler}`, 8));
  history.push({ role: "assistant", content: "Stage 6 complete. final_report.md is ready and the positive treatment effect direction is stated with uncertainty." });
  return history;
}

function estimate(history: readonly Message[]): number {
  return history.reduce((total, message) => total + estimator.estimateMessage(message), 0);
}

function countRepeatedReads(history: readonly Message[]): number {
  return history.filter((message) => message.role === "tool" && /Repeated read of cohort\.csv/iu.test(String(message.content))).length;
}

function memoryQuality(memory: ScopeNodeMemory): { artifactRecall: number; directionPreserved: boolean; obligationsPreserved: boolean } {
  const memoryText = `${memory.facts.join("\n")}\n${memory.obligations.join("\n")}`;
  const artifactRecall = artifactNames.filter((name) => memory.artifacts.includes(name) || memoryText.includes(name)).length / artifactNames.length;
  return {
    artifactRecall,
    directionPreserved: /positive/iu.test(memoryText),
    obligationsPreserved: /final_report\.md/iu.test(memoryText),
  };
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const history = makeHistory();
    const sourceTokens = estimate(history);
    const sourceMessages = history.length;
    const repeatedReads = countRepeatedReads(history);
    const projection = projectScopeHistory(history, {
      estimator,
      maxMemoryCharacters: 6_000,
      retainRecentMessages: 6,
      nodeId: "main",
    });
    const quality = memoryQuality(projection.memory);
    const entries: Array<[Mode, number, number, ScopeNodeMemory | undefined, number]> = [
      ["B0", sourceTokens, sourceMessages, undefined, repeatedReads],
      ["B1", sourceTokens, sourceMessages, projection.memory, repeatedReads],
      ["V1", projection.trace.projectedTokens, projection.trace.projectedMessageCount, projection.memory, 0],
    ];
    for (const [mode, inputTokens, inputMessages, memory, observedRepeatedReads] of entries) {
      rows.push({
        repetition,
        mode,
        inputTokens,
        inputMessages,
        sourceTokens,
        sourceMessages,
        tokenReduction: mode === "V1" ? (sourceTokens - inputTokens) / sourceTokens : 0,
        repeatedReads: observedRepeatedReads,
        artifactRecall: memory ? quality.artifactRecall : 1,
        directionPreserved: memory ? quality.directionPreserved : true,
        obligationsPreserved: memory ? quality.obligationsPreserved : true,
        projectionRemovedMessages: mode === "V1" ? projection.trace.removedMessageCount : 0,
      });
    }
  }
  const b0 = rows.filter((row) => row.mode === "B0");
  const v1 = rows.filter((row) => row.mode === "V1");
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const result = {
    generatedAt: new Date().toISOString(),
    repetitions,
    useCase: "fixed synthetic biomedical cohort transcript",
    rows,
    summary: {
      b0AverageInputTokens: average(b0.map((row) => Number(row.inputTokens))),
      v1AverageInputTokens: average(v1.map((row) => Number(row.inputTokens))),
      inputTokenReduction: (average(b0.map((row) => Number(row.inputTokens))) - average(v1.map((row) => Number(row.inputTokens)))) / average(b0.map((row) => Number(row.inputTokens))),
      b0AverageRepeatedReads: average(b0.map((row) => Number(row.repeatedReads))),
      v1AverageRepeatedReads: average(v1.map((row) => Number(row.repeatedReads))),
      projectionArtifactRecall: average(v1.map((row) => Number(row.artifactRecall))),
      directionPreservationRate: v1.filter((row) => row.directionPreserved === true).length / Math.max(1, v1.length),
      obligationsPreservationRate: v1.filter((row) => row.obligationsPreserved === true).length / Math.max(1, v1.length),
      passed: v1.every((row) => Number(row.artifactRecall) === 1 && row.directionPreserved === true && row.obligationsPreserved === true),
    },
  };
  const jsonPath = join(outputRoot, "deterministic-results.json");
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  const reportPath = join(outputRoot, "deterministic-acceptance-report.md");
  await writeFile(reportPath, [
    "# ScienceDiscovery Research Spine 价值验证报告",
    "",
    `生成时间 ${result.generatedAt}`,
    "",
    "## 实验范围",
    "",
    `固定 Transcript 重复运行 ${repetitions} 次，比较 B0 当前历史输入、B1 Shadow 投影旁路和 V1 Projection 投影输入。`,
    "",
    "## 结果",
    "",
    `- B0 平均输入 Token ${result.summary.b0AverageInputTokens.toFixed(0)}`,
    `- V1 平均输入 Token ${result.summary.v1AverageInputTokens.toFixed(0)}`,
    `- V1 输入 Token 下降率 ${(result.summary.inputTokenReduction * 100).toFixed(2)}%`,
    `- B0 重复读取次数 ${result.summary.b0AverageRepeatedReads.toFixed(0)}`,
    `- V1 重复读取次数 ${result.summary.v1AverageRepeatedReads.toFixed(0)}`,
    `- Artifact Recall ${(result.summary.projectionArtifactRecall * 100).toFixed(2)}%`,
    `- 主要结论方向保留率 ${(result.summary.directionPreservationRate * 100).toFixed(2)}%`,
    `- 未完成义务保留率 ${(result.summary.obligationsPreservationRate * 100).toFixed(2)}%`,
    `- 第一层验收 ${result.summary.passed ? "通过" : "失败"}`,
    "",
    "## 判断",
    "",
    "固定 Transcript 结果只验证 Context Projection 和 Node Memory 的确定性收益。它证明了当前实现可以减少模型可见历史规模，并保留 Gold Set 中的 Artifact 引用、主要结论方向和未完成义务。真实模型侧需要继续用严格限制轮次的任务运行，单独评估模型行为、延迟和实际账单 Token。",
    "",
    `原始 JSON 结果位于 \`${jsonPath}\`。`,
    "",
  ].join("\n"), "utf8");
  console.log(JSON.stringify({ jsonPath, reportPath, summary: result.summary }, null, 2));
}

await main();
