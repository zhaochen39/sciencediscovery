# ScienceDiscovery Dynamic 影子观察与仪器校准复验 · 2026-11-24


**本轮满足端到端正确性要求，收益未达到小流量门槛。** 真实完整任务 20/20 自然结束并通过独立验收。Projection 组平均总量从 37,221.60 升到 42,474.30 Token（+14.11%），所有 72 轮均使用 Dynamic 输入。这个差值是门控回退后两组自然运行的观测差异。校准候选最多预计节约 553 个历史 Token，低于 1,500 的绝对门槛。当前适合在 Dynamic 影子模式收集候选命中情况，小流量启用需要在代表性任务上验证真实投影和端到端收益。

## 方案与验收口径

本轮基于 `feat/research-spine` 的 `32d0f4917dbe0151036f2200d6c5903b592b3c72`，在 WSL 上用 `DeepSeek-V4.1-Flash-1017` 复验。上一轮带逐行清洗审计的 cohort 用例 20/20 通过，平均总 Token 下降 21.02%，同前缀首轮输入下降 35.97%。本轮选择输出简短的独立工作流，检查收益能否迁移。[上一轮验收](./native-mvp-verified-stage-results-2026-11-24.md)

SpineCodex 的 `ContextPlanRecipe` 区分源记录和派生的上下文单元。`closed_memory_artifacts()` 只从已关闭的任务节点读取归属该节点的记忆。本轮用同样的分离原则组织 Dynamic 输入和投影候选。验收过的工具产物绑定工具调用 ID、内容哈希和上游产物哈希。候选仅替换满足约束的工具结果，原始用户消息、工具调用配对和可回放的历史仍然完整。[SpineCodex Context Plan](https://github.com/GhabiX/SpineCodex/blob/d90a466a10c7b8c3ca492a827222b164bd78af52/codex-rs/spine-core/src/planner/context_builder.rs) · [SpineCodex 节点记忆](https://github.com/GhabiX/SpineCodex/blob/d90a466a10c7b8c3ca492a827222b164bd78af52/codex-rs/spine-core/src/artifact.rs)

- `dynamic-shadow` 基于 Dynamic 历史计算候选，记录估算收益、门槛拒绝原因和候选计算耗时。选择路径为 Dynamic，模型输入及运行历史的等价性有回归覆盖。候选计算异常时继续走 Dynamic。已有 `shadow` 模式依旧使用 Legacy 输入。
- 校准数据为三个批次共 38 条合成记录。过滤 1 条无效状态并按首条有效观测去重 1 条，共保留 36 条。验证器检查 `qc.json`、`cleaned.csv`、`fits.json`、`drift.json`、`calibration_report.md`。Python 审计校对固定输入 SHA-256，独立重算行级清洗和 OLS，得到参考斜率 1.02，两个生产批次斜率 1.03 和 1.12，漂移阈值 0.05，仅 `production_b` 触发告警。
- 阶段证据来自真实工具写出的产物。按单次工具调用归属阶段，检查各阶段的输出及依赖版本。产物缺失、产物重写和上游哈希变更由回归覆盖。这是基准任务的验收接入，覆盖校准工作流的文件约定。
- 门槛沿用估算历史至少 1,500 Token，预计节省至少 1,500 Token 且至少 10%。保留最近 2 条消息，记忆预算 6,000 字符。两个 A/B 模式收到相同任务、工具与验收反馈，输出保留正常大小，最大 16 个模型轮次，十对按奇偶交替执行顺序，同一对内串行，四个分片并行。监督器允许模型自行修复产物并通过 `model_stop` 自然结束。
- E2E PASS 需要自然结束、五份产物完备、内容通过验收和独立复算，并可用供应商事件复核用量。Token 统计为每次运行所有任务模型轮次的 `model_usage` 加总，分别列输入、输出和总量。估算历史 Token 用于门控，耗时包含模型等待与工具执行。分片并行下的延迟作为观测值。

## 真实模型影子观察

三次运行均自然结束、产物验收和独立复算通过。供应商 usage 为 25/25 轮。

| 重复 | 输入 Token | 输出 Token | 总 Token | 模型轮次 | 工具调用 | 秒 | 验收 |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 49,805 | 3,888 | 53,693 | 8 | 7 | 97.28 | PASS |
| 2 | 62,919 | 5,547 | 68,466 | 10 | 9 | 138.96 | PASS |
| 3 | 36,379 | 3,380 | 39,759 | 7 | 6 | 111.40 | PASS |

25 轮中有 5 轮形成可缩短历史的阶段候选，估算每轮节省 61 Token，均因 `below_savings_threshold` 跳过。其余 20 轮为 `no_verified_stage`，涵盖没有能用于替换的验证结果、结果位于保护窗口内或记忆不比原结果短。候选计算 P50 0.281 ms、P95 0.745 ms、最大 1.131 ms。25 个模型输入均使用 Dynamic 路径。该耗时覆盖投影候选计算。

## 真实模型同前缀对照

使用一次种子运行在通过清洗、拟合验收后冻结前缀。种子刻意停在阶段边界，两个续跑各自执行剩余步骤并自然结束。前缀历史、源工作区文件、原始用户任务、续跑提示、工具列表、系统提示和首轮实际输入均通过核对。两个首轮供应商输入均为 **5,780 Token**。Projection 三轮均因 `below_savings_threshold` 回到 Dynamic，首轮预计节省 51 个历史 Token（1.12%），实际替换 0 次。

| 续跑 | 输入 Token | 输出 Token | 总 Token | 模型轮次 | 工具调用 | 秒 | 验收 |
|---|---:|---:|---:|---:|---:|---:|---|
| Dynamic | 20,152 | 2,277 | 22,429 | 3 | 2 | 77.27 | PASS |
| Projection | 20,037 | 2,477 | 22,514 | 3 | 2 | 60.83 | PASS |

六轮均有供应商 usage。首轮相同的请求验证了低收益路径的回退等价性。续跑总量相差 +85 Token（+0.38%），两条路径执行中未产生投影，是两次自然生成的观测差异。

## 真实模型十对完整任务 A/B

完整实验共 20 次运行，Dynamic 10/10 通过，Projection 10/10 通过。所有样本均计入统计。136 个模型轮次均有供应商用量，逐轮相加与运行汇总一致。

| 指标 | Dynamic 平均 | Projection 平均 | 相对变化 | Dynamic P95 | Projection P95 |
|---|---:|---:|---:|---:|---:|
| 输入 Token | 34,049.10 | 39,158.50 | +15.01% | 37,957.10 | 45,420.10 |
| 输出 Token | 3,172.50 | 3,315.80 | +4.52% | 3,897.45 | 3,720.10 |
| 总 Token | 37,221.60 | 42,474.30 | +14.11% | 41,525.15 | 48,874.60 |
| 模型轮次 | 6.40 | 7.20 | +12.50% | 7.00 | 8.00 |
| 工具调用 | 5.40 | 6.20 | +14.81% | 6.00 | 7.00 |
| 耗时（秒） | 153.65 | 150.06 | -2.34% | 176.09 | 162.92 |

下表数值均为 Dynamic → Projection。通过状态同时要求自然结束、五份产物通过独立验收和用量可复核。

| 配对 | 两组验收 | 输入 Token | 输出 Token | 总 Token | 总量差值 | 模型轮次 | 工具调用 | 秒 | 实际投影轮次 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 31,635 → 36,009 | 2,999 → 2,820 | 34,634 → 38,829 | +4,195 | 6 → 7 | 5 → 6 | 167.46 → 155.44 | 0 |
| 2 | PASS / PASS | 39,425 → 43,325 | 3,987 → 3,279 | 43,412 → 46,604 | +3,192 | 7 → 8 | 6 → 7 | 154.15 → 159.98 | 0 |
| 3 | PASS / PASS | 32,041 → 40,348 | 3,788 → 3,757 | 35,829 → 44,105 | +8,276 | 6 → 7 | 5 → 6 | 136.31 → 136.05 | 0 |
| 4 | PASS / PASS | 35,359 → 38,833 | 3,708 → 3,646 | 39,067 → 42,479 | +3,412 | 6 → 7 | 5 → 6 | 128.59 → 165.32 | 0 |
| 5 | PASS / PASS | 36,163 → 44,000 | 3,056 → 3,185 | 39,219 → 47,185 | +7,966 | 7 → 8 | 6 → 7 | 154.96 → 156.63 | 0 |
| 6 | PASS / PASS | 31,635 → 30,697 | 3,373 → 2,883 | 35,008 → 33,580 | -1,428 | 6 → 6 | 5 → 5 | 133.56 → 159.82 | 0 |
| 7 | PASS / PASS | 35,174 → 36,540 | 2,705 → 3,582 | 37,879 → 40,122 | +2,243 | 7 → 7 | 6 → 6 | 183.14 → 156.94 | 0 |
| 8 | PASS / PASS | 35,598 → 37,830 | 2,753 → 3,306 | 38,351 → 41,136 | +2,785 | 7 → 7 | 6 → 6 | 163.56 → 150.28 | 0 |
| 9 | PASS / PASS | 32,547 → 46,582 | 2,907 → 3,675 | 35,454 → 50,257 | +14,803 | 6 → 8 | 5 → 7 | 164.92 → 143.72 | 0 |
| 10 | PASS / PASS | 30,914 → 37,421 | 2,449 → 3,025 | 33,363 → 40,446 | +7,083 | 6 → 7 | 5 → 6 | 149.89 → 116.43 | 0 |

输入降低 1/10 对，总量降低 1/10 对。Projection 的 72 轮候选评估中，0 轮过门槛，0 轮在实际请求中使用投影。跳过次数为 `no_verified_stage` 54 次，`below_savings_threshold` 18 次。
18 轮形成可缩短历史的阶段候选，估算节省范围为 14–553 个历史 Token。
136 个逻辑模型请求累计经历 11 次传输重试。统计保留这些样本及等待时间。

### 小流量验收

| 项目 | 标准 | 本轮 | 结果 |
|---|---|---|---|
| 端到端质量 | 两组全部 PASS | 20/20 | PASS |
| 平均总 Token | 下降至少 5% | +14.11% | FAIL |
| 输入降低的配对 | 至少 7/10 | 1/10 | FAIL |
| 平均模型轮次 | 不增加 | +12.50% | FAIL |
| 平均工具调用 | 不增加 | +14.81% | FAIL |
| 实际触发 | 存在模型可见投影 | 0 轮 | FAIL |

现有实现只替换有验证证据的工具结果。这个任务的正常输出以短摘要为主，结构化记忆还承担文件引用、摘要字段和版本哈希的成本。估算节省的上限与冻结首轮的实际输入一致性共同解释了门槛回退。上一轮 cohort 的逐行工具输出更长，在那个任务上观察到了实际替换和端到端收益。两轮结果限定了目前的适用范围。下一轮若继续验证，优先选包含自然产生的大体量阶段输出且具备独立验收的科研工作流，先通过影子门控筛选，再复验同前缀和完整任务。

## 受控 E2E 与回归

复用已有 cohort 受控用例中的长工具结果来触发生产门槛。受控端点对生成顺序和 usage 使用脚本，真实 Native Agent 负责模型请求、工具派发、文件落盘、上下文组装、事件采集和验收。三种模式各跑一次，均自然结束、六件产物全部通过。Dynamic 影子命中 1 次、实际替换 0 次，Projection 实际替换 1 次。该批记录用于验证门控、投影与回退链路。

| 模式 | 脚本输入 Token | 脚本输出 Token | 脚本总 Token | 模型轮次 | 验收 |
|---|---:|---:|---:|---:|---|
| Dynamic | 33,396 | 156 | 33,552 | 5 | PASS |
| Dynamic 影子 | 33,397 | 156 | 33,553 | 5 | PASS |
| Projection | 30,493 | 156 | 30,649 | 5 | PASS |

Context 57/57，Native 与校准证据回归合计 56/56，Context/API 和主仓测试类型检查通过。相同前缀的单元测试覆盖影子模式的输入及历史等价性和候选计算失败时的回退。受控统计脚本首轮缺少 `shadowMode` 定义，子进程产物已落盘，修复后在新目录重跑并通过。

## 日志与复现

在 WSL 仓库根目录按 benchmark README 运行。环境文件为 `D:\work\agent\ci_bench\env.sh`。本地每次运行目录下有 `summary.json`、`events.jsonl`、历史输入 Trace、已验证阶段证据和 `workspace` 产物。`results.json` 保留运行配置和汇总。种子前缀另有 `fork-prefix.json`。报告中的相对运行 ID 可在对应日志目录中查找。[复现命令](./README.md)

| 批次 | 本地路径 |
|---|---|
| 真实影子 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-shadow-20261124\shadow` |
| 真实同前缀 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-fork-20261124\fork` |
| 真实十对 A/B | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-paired-20261124` |
| 受控 E2E | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-controlled-20261124-r2` |
| 有统计脚本错误的受控首轮 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-controlled-20261124` |
| 回归和类型检查 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-regression-20261124` |
