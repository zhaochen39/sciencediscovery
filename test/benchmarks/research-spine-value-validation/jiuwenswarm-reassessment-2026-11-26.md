# ScienceDiscovery Research Spine 的 JiuwenSwarm 后端复验

2026-11-26 · 原始提交 `d684215a2fbbd366b6d455a941efa35cfc868ea9` · 候选提交 `09ae447de434a39a2a1bc8e2afdb294e3697f48a`

## 验收结论

**JiuwenSwarm 上的普通科研任务通过正确性复验，现有分支尚未达到 Spine 优化在该执行器上的试运行准入。** 原报告的上下文节省、Inline 和 Node Memory 指标来自 Native。JiuwenSwarm 上实际验证通过的新增能力是平台 `task` 路径的 Spawn Receipt。检查点恢复、Inline 和 Node Memory 未形成可用的候选执行路径。

## 复验对象与方法

- 在 WSL 启动独立的 JiuwenSwarm 实例、适配器、正式 ScienceDiscovery API 和本地 Runner。每条实验臂都检查适配器的 `/agent/info`，并将带 `gatewayRequestId` 的模型网关日志与 API 记录的模型轮次逐条对账。用量按 Run 汇总。校验了原始提交的 2,997 个 Git blob，差异为 0。
- 两组文献输入沿用前一轮冻结的公开 Crossref 记录。每个实验臂重新创建会话，由 JiuwenSwarm 执行质控，再在同一个 Swarm 会话完成续跑。两组对照交替基线与候选顺序。每臂另跑一条独立的短问答，预期为 14。
- 质控阶段必须写出与原始 JSON 相符的完整 TSV，且恰有一次完整的 Shell 日志输出。续跑必须自然结束，提交助手消息，保留 3 个受保护输入，并生成和独立 Python 复算一致的逐条审计及汇总。每组的汇总预期为 4 条，匹配 1，不一致 2，未解析 1。
- 受控模型提供确定性回答和固定用量，Swarm、适配器、工具桥接和 Runner 均为实际运行组件。真实模型使用 `DeepSeek-V4.1-Flash-1017`。交付耗时从提交 Run 到轮询观察到终态。Shell 数按 API 中归属该 Run 的执行记录统计。
- 基线与候选的普通续跑均使用 JiuwenSwarm 会话历史。候选另发显式检查点恢复、Inline 及 Node Memory 请求核对门禁，三者均返回 `409`，新增 Run 和模型调用均为 0。文献普通续跑的对照与这三个门禁请求独立计时。

## 逐臂结果

**受控模型。** 两组输入、两种提交，短问答、质控和续跑共 **12/12** 自然完成并通过独立审计。每次文献续跑均为输入 750、输出 150、总计 900 Token、3 次模型请求和 2 次 Shell 执行。两对续跑的交付耗时分别为 **5.312 → 5.737 秒**和 **5.124 → 4.916 秒**。固定 Token 只用于用量对账。

**真实模型。** 首轮四个实验臂中 **3/4** 完整通过。文献 1 候选续跑在 240.083 秒时仍为 `running`，对应基线 85.101 秒，已达到 **2.82×**。该次两条 Shell 执行已完成，模型网关中有一条请求耗时 92.634 秒。将采集上限由 240 秒提高到 480 秒后，使用新会话复跑该候选。复跑在 69.313 秒自然完成，产物复算通过。至此两组的四个实验臂均取得完整通过样本，共有 **4 个通过实验臂和 1 个超时实验臂**。

下表是通过严格审计的真实模型逐臂数据。文献 1 候选一列使用复跑，首次超时记在上段和原始日志中。

| 用例 | 提交 | 阶段 | 输入 Token | 输出 Token | 总 Token | 模型请求 | Shell 执行 | 交付秒 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 文献 1 | 原始 | 短问答 | 36,194 | 54 | 36,248 | 1 | 0 | 16.509 |
| 文献 1 | 原始 | 质控 | 186,576 | 1,016 | 187,592 | 5 | 3 | 93.620 |
| 文献 1 | 原始 | 续跑 | 198,863 | 1,655 | 200,518 | 5 | 3 | 85.101 |
| 文献 1 | 候选（复跑） | 短问答 | 36,198 | 54 | 36,252 | 1 | 0 | 9.043 |
| 文献 1 | 候选（复跑） | 质控 | 226,700 | 1,496 | 228,196 | 6 | 4 | 91.188 |
| 文献 1 | 候选（复跑） | 续跑 | 163,590 | 2,434 | 166,024 | 4 | 2 | 69.313 |
| 文献 2 | 原始 | 短问答 | 36,194 | 24 | 36,218 | 1 | 0 | 15.168 |
| 文献 2 | 原始 | 质控 | 261,099 | 1,171 | 262,270 | 7 | 4 | 96.086 |
| 文献 2 | 原始 | 续跑 | 283,006 | 1,808 | 284,814 | 7 | 4 | 89.655 |
| 文献 2 | 候选 | 短问答 | 36,180 | 2 | 36,182 | 1 | 0 | 5.559 |
| 文献 2 | 候选 | 质控 | 223,017 | 1,143 | 224,160 | 6 | 2 | 32.931 |
| 文献 2 | 候选 | 续跑 | 197,580 | 1,434 | 199,014 | 5 | 2 | 67.615 |

| 两对完整样本的变化 | 输入 Token | 输出 Token | 总 Token | 模型请求 | Shell 执行 | 交付耗时配对中位 |
|---|---:|---:|---:|---|---|---:|
| 质控 | +0.46% | +20.67% | 449,862 → 452,356（+0.55%） | 12 → 12 | 7 → 6 | -34.16% |
| 续跑 | -25.05% | +11.70% | 485,332 → 365,038（-24.79%） | 12 → 9 | 7 → 4 | -21.57% |
| 文献全流程（质控 + 续跑） | -12.77% | +15.17% | 935,194 → 817,394（-12.60%） | 24 → 21 | 14 → 10 | -28.03% |
| 短问答 | -0.01% | -28.21% | 72,466 → 72,434（-0.04%） | 2 → 2 | 0 → 0 | -54.29% |

真实模型的续跑总 Token 在完整样本中记录到 **−24.79%**，计入质控的全流程为 **−12.60%**。两边都走普通 Swarm 路径。请求数、产物生成顺序和模型提供方响应时间存在差异，且文献 1 候选存在一次超时。上述数字描述本批样本，不能用于归因 Spine 优化或作出性能准入结论。短问答也出现候选首次 **47.616 秒**、同组基线 **16.509 秒**的 **2.88×** 样本。

## 原方案逐项复评

| 原方案 | JiuwenSwarm 实测范围 | 验收结果 |
|---|---|---|
| Scope Projection / 按状态恢复 | 普通文献续跑和恢复请求的正式 API 门禁 | 普通续跑通过的样本有正确交付。恢复请求返回 409。Scope Projection 仍由 Native 上下文组装器调用，JiuwenSwarm 的模型历史由 Swarm 持有，上一版光伏、校准和文献恢复收益仅适用于 Native。 |
| Inline Scope | 对真实 JiuwenSwarm 配置提交 `delegationMode: "inline"` | 返回 409，节省子 Run、Token 和延迟的指标在此模式无可运行的候选臂。 |
| Node Memory / ScienceMemory | 对真实 Swarm 的已完成普通 Run 调用 `node-memory` | 返回 409。当前接口依赖已完成的 `researchResume` 绑定，Swarm 普通 Run 无法生成这类凭据。上一版图谱写入测试仅验证隔离 sidecar 中的产物版本边。 |
| Spawn Receipt | 实际 Swarm 执行器和默认的产品 `task` 子任务，受控父 Run 触发两条子任务 | 父 Run 自然完成，一个子任务输出 `{ "value": 14 }`，另一个因结构校验失败。重新创建 API 服务并从持久化记录读取后，回执、成功结果引用和失败诊断一致。生成及重读回执新增 0 次模型调用。该用例覆盖 `task` 路径。 |
| Scope UI / Idea Tree、Evolve / JiuwenSwarm 适配 | 对照源码和本轮可执行功能 | Scope 树界面、Idea Tree/Evolve 的 Scope 联动、Swarm Scope 上下文适配仍待实现。此前 Idea Tree/Evolve 结果属于既有路径兼容性。 |

本轮覆盖短问答与两阶段文献审计。光伏、校准、原 Native 96 条历史消息与 800 条 Run 的压力负载，以及 Swarm 原生 `subagent_spawn` 模式，属于未复跑的负载。前一轮 Native 的压力和节省比例保留为原实验数据。

## 复现记录

在 WSL 从候选源码根目录运行。`$baseline` 指向预装依赖的原始提交目录。默认用 `/mnt/d/work/agent/ci_bench/env.sh` 加载真实模型配置。

```bash
bench=test/benchmarks/research-spine-value-validation
bash "$bench/run-jiuwenswarm-reassessment-wsl.sh" "$baseline" "$results" \
  controlled-1 controlled-2 real-1 real-2
python3 "$bench/audit-jiuwenswarm-reassessment.py" "$results" \
  controlled-1 controlled-2 real-1 real-2
```

Spawn Receipt 模式使用实际 JiuwenSwarm 和受控模型。

```bash
export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task SCIENCE_SPINE_RECEIPT_PROBE=1
bash scripts/with-jiuwenswarm.sh pnpm exec tsx "$bench/run-jiuwenswarm-reassessment.ts" \
  "$receipt_results" "$(mktemp -d)" "$bench/fixtures/citations/case-1" controlled candidate
```

原始输出在 `logs/jiuwenswarm-20261126/`。`audited/` 保存正式对照，`receipt/` 保存回执测试。早期的 `controlled-1/`、`controlled-recheck/`、`real-1/`、`real-2/` 保存试跑记录。早期驱动先因读取未加载的 Store 失败，再因未调用质控阶段导致缺少 TSV，两处均已修正。`real-retry/` 保存文献 1 候选超时后的复跑。`final-audit.json` 包含逐臂对账和配对变化，并标记该复跑。需要重算本次表格时，为审计命令追加 `--retry-real-1-candidate "$logroot/real-retry/real-1/candidate"`，其中 `$logroot` 指向本轮原始输出目录。首次超时保留在 `$logroot/audited/real-1/candidate/`。
