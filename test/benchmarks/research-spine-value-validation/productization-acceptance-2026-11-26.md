#> 本报告的性能和发布结论适用于 Native。实际部署采用 JiuwenSwarm 时，以 [JiuwenSwarm 后端复验](jiuwenswarm-reassessment-2026-11-26.md) 为准。

 ScienceDiscovery Research Spine 产品化验收

2026-11-26。对照使用未加入 Spine 改动的 ScienceDiscovery 提交 `d684215a2fbbd366b6d455a941efa35cfc868ea9`。WSL 中核对了基线 2,997 个 Git blob，差异为 0。真实模型为 `DeepSeek-V4.1-Flash-1017`。受控 E2E 使用独立的确定性模型响应，通过真实 Native API 和本地 Runner 完成。受控模型的固定 Token 仅用于用量对账。

## 1. 通用检查点契约

服务端以工作流 ID 注册契约，绑定版本、受保护输入、展示证据和复算器。恢复时核对输入摘要与当前契约版本。光伏与校准的旧版检查点按 v1 兼容。新增文献复核契约使用两组 Crossref 公开 DOI 元数据。试验输入在每组加入一个标题错误、一个年份错误和一个快照中未覆盖的 DOI，固定预期为 1 条匹配、2 条不一致和 1 条未解析。不同实验臂从相同源 Run 和工作区继续。原始元数据的 DOI、标题和年份随用例提交。源 Run 由真实模型创建质控表并展示，独立 Python 审计器按冻结的原始元数据重新计算。

受控正式 API **6/6**，真实模型首轮 **6/6**，第一组逆序复跑 **3/3**。严格审计检查自然结束、报告值、保护文件、展示顺序、重复展示和 Token 对账。逐臂数据显示如下。

| 样本 | 路径 | 输入 Token | 输出 Token | 总 Token | 模型请求 | 工具调用 | 交付秒 | 传输重试 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 文献 1 | 原始 | 74,855 | 1,439 | 76,294 | 4 | 3 | 59.849 | 0 |
| 文献 1 | 完整历史 | 44,659 | 2,161 | 46,820 | 5 | 5 | 75.132 | 0 |
| 文献 1 | 按状态恢复 | 21,792 | 2,496 | 24,288 | 3 | 2 | 111.941 | 1 |
| 文献 2 | 原始 | 74,922 | 1,735 | 76,657 | 4 | 3 | 69.292 | 0 |
| 文献 2 | 完整历史 | 75,035 | 3,098 | 78,133 | 8 | 8 | 81.672 | 0 |
| 文献 2 | 按状态恢复 | 37,019 | 2,013 | 39,032 | 5 | 4 | 76.259 | 0 |
| 文献 1 逆序 | 原始 | 75,208 | 1,599 | 76,807 | 4 | 4 | 65.428 | 0 |
| 文献 1 逆序 | 完整历史 | 35,408 | 1,831 | 37,239 | 4 | 3 | 71.177 | 0 |
| 文献 1 逆序 | 按状态恢复 | 53,038 | 1,971 | 55,009 | 7 | 6 | 101.783 | 0 |

三个配对包含两个不同冻结点和一个原点复跑。相对原始框架，平均输入 Token **−50.29%**、输出 **+35.76%**、总量 **−48.50%**，请求合计 **12 → 15**，工具 **10 → 12**，交付的逐对时长比例中位 **+55.56%**。相对同入口完整历史，总 Token **−27.04%**，交付中位 **+43.00%**。最慢相对原始为 **1.870×**，逆序后仍为 **1.556×**，两次候选的模型请求区间为 104.591 秒和 81.725 秒，对应原始为 53.739 秒和 50.795 秒。第二次候选比原始多 3 次模型请求和 2 次工具调用。文献场景保留实验入口，服务端试点门禁拒绝该契约。

## 2. Inline Scope 与 Spawn Receipt

Native 的 Run 可显式采用 `delegationMode: "inline"`，持久化策略在模型工具列表中排除 `task`。同 Run 复核分别审计标题和年份，并合并结论。原始臂通过两次 `task` 委派独立子智能体。候选通过持久化 Run 字段、模型输入工具表和子智能体列表核对实际执行路径。通过样本的结论与冻结元数据独立计算一致。

Spawn Receipt 已接入正式 API。独立受控 E2E 在一个子分支通过、另一个结构化结果校验失败时，重启 API 后生成相同的凭据摘要。保留一个成功结果引用和一个失败原因。单测也覆盖取消、乱序、重复与冲突结果，以及重启占位记录。生成回执由客户端显式触发，读取回执不会新增模型调用或子 Run。

## 3. Node Memory 与 ScienceMemory

两组已验收文献产物均在隔离数据目录中登记版本，由本地 ScienceMemory sidecar 回读各自 2 个 Artifact 节点及实际生成执行边。审计产物到汇总执行的输入边均存在。版本上的 CAS 内容摘要与工作区一致。两个样本各 2 个 JSON 产物通过正式 `node-memory` API 读取，接口对越过来源 Run 的版本和修改过的工作区文件返回 409。恢复相同字节后返回同一版本内容。变更当前文件版本后，原 Node Memory 凭据也会被拒绝。

复核模型分别从同一冻结记录继续。原始臂读取 `citation_summary.json` 后计算。候选臂使用 API 返回的有版本约束的 JSON。候选时长给出模型 Run 和已记录的 HTTP 读取时长之和。建立初次 Artifact Version 和图谱关系发生在前一阶段。原型复跑单独记录了直接 CAS 读取路径的两对结果。

| 通过严格审计的实际 API 配对 | 指标 | 原始 ScienceDiscovery | 候选 | 变化 |
|---|---|---:|---:|---:|
| 同 Run 文献 2 | 输入 Token | 60,524 | 15,594 | −74.24% |
| 同 Run 文献 2 | 输出 Token | 2,142 | 965 | −54.95% |
| 同 Run 文献 2 | 总 Token | 62,666 | 16,559 | −73.58% |
| 同 Run 文献 2 | 模型请求 / 子 Run | 4 / 2 | 1 / 0 | −75% / −100% |
| 同 Run 文献 2 | 交付秒 | 51.889 | 19.486 | −62.45% |
| Node Memory 文献 1 | 输入 Token | 35,167 | 17,482 | −50.29% |
| Node Memory 文献 1 | 输出 Token | 273 | 65 | −76.19% |
| Node Memory 文献 1 | 总 Token | 35,440 | 17,547 | −50.49% |
| Node Memory 文献 1 | 模型请求 / Shell 读取 | 2 / 1 | 1 / 0 | −50% / −100% |
| Node Memory 文献 1 | 交付秒，候选计入 HTTP 读取 | 47.002 | 8.088 | −82.79% |

实际 API 复核候选四条均完成并通过独立审计。原始框架四条均自然结束，其中同 Run 用例对应的原始委派一条在 JSON 前输出进度，Node Memory 对应用例的原始读取一条在 JSON 后输出说明。两条数值正确，严格审计仍判失败，日志保留。表中只纳入成对严格通过的结果。对照原型的补充数据包括同 Run 文献 1 和文献 2 的两个严格通过配对，以及直接 CAS 读取的两个配对。这些原型支持方向判断。实际 API 收益表只使用它自己的对照数据。

## 4. 发布与回归

发布范围及关闭方式见 [Research Spine 产品化支持范围](productization-support-2026-11-26.md)。本批覆盖单 API、本地 Native Runner、一个真实模型和独立受控模型。远程 Runner、JiuwenSwarm 请求、未知契约、失效质控表及文献试点请求通过正式 API 做拒绝验收，拒绝新增模型请求为 0。对受控模型故意返回错误汇总的用例，Run 失败且缺少已提交的助手交付消息。Idea Tree 与 Evolve 的实际 Python sidecar 兼容路径通过三个标准集成测试，JiuwenSwarm 保持已有执行路径与兼容性回归。光伏和校准白名单各真实模型复跑一条，**2/2** 自然完成且复算、展示顺序和用量对账均通过。298 个相关测试全部通过。多 API 共享工作区、Neo4j 部署组合和 Scope Tree 图形界面属于这次发布范围之外。

两批普通 Run 共 **80/80** 通过，原始与候选各 40 条。答案、Shell 产物、历史可见性、Token 对账、模型请求和工具调用一致。短问答每条 1 次模型请求。长历史每条 3 次请求，包含一次压缩，及 1 次 Shell 调用。长历史由 96 条消息和 800 条历史 Run 构成。按固定顺序位置配对计算候选与原始的交付时长比。

| 普通路径批次 | 每臂样本 | 短问答配对中位变化 | 长历史配对中位变化 | 长历史最大比例 |
|---|---:|---:|---:|---:|
| 首批两轮 | 20 | −2.69% | +6.50% | 1.819× |
| 等真实模型实验结束后隔离复跑 | 20 | +8.27% | −0.56% | 1.709× |

首批第二轮长历史中位增加 **21.10%**，单条最慢 **1.819×**。隔离复跑的两轮长历史中位为 **−1.43%** 和 **+0.95%**，未复现两倍级慢样本。短问答相对波动保留在表内，复跑两轮中位为 **+11.38%** 和 **+4.53%**。这些结果支持默认路径的功能兼容和保守放量。性能数字适用于已验收的样本和环境。

## 复现与日志

在 WSL 预构建候选和原始两个 checkout。脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 读取真实模型参数。先固定输入及源 Run，完整路径可参照以下命令。

```bash
bench=test/benchmarks/research-spine-value-validation
source /mnt/d/work/agent/ci_bench/env.sh
export TMPDIR="$HOME/.cache/science-spine-tmp" SCIENTIFIC_ENVS=0
mkdir -p "$TMPDIR"
SCIENCE_SPINE_FORMAL_CAPTURE_ONLY=1 \
  pnpm exec tsx "$bench/run-formal-recovery.ts" \
  "$bench/fixtures/citations/case-1" "$capture" original
bash "$bench/run-productization-wsl.sh" citations "$capture/source-checkpoint" "$results" "$baseline"
SCIENCE_SPINE_REVERSE=1 bash "$bench/run-productization-wsl.sh" controlled \
  "$capture/source-checkpoint" "$controlled_results" "$baseline"
```

`run-productization-wsl.sh` 的 `scope`、`memory` 参数运行相同来源的配对试验。Node Memory 先通过 `verify-citation-memory.ts` 连接隔离的本地 ScienceMemory 服务并输出凭据，然后通过 `run-node-memory-http.ts` 验证正式 API。把该 API 的输出路径设为 `SCIENCE_SPINE_NODE_MEMORY_HTTP_PROOF` 可复现带 HTTP 证据的模型复核。原始日志目录为 `logs/productization-20261126-recheck/`，其下保留每个实验的 `driver.log`、`result.json` 或专项结果、退出码、API 耗时和独立审计。`logs/productization-20261126/` 保留最早的测试驱动失败，原因是初次恢复助手上下文来自已关闭的源 Run，其中首条用户消息单独存储，驱动原先要求它同时出现在该上下文中。

## JiuwenSwarm 适配复验

本轮将视觉界面共享的正式 API 执行路径接入 Swarm，上述旧版探针的通用执行器拦截已修复。Scope Projection 在实际模型请求中生效。`by-state`、`full`、Inline 和 Node Memory 已通过实际 Swarm 复验。输入成本下降和整体时延及 Shell 回归的具体数据、适用边界及原始失败日志见 [Swarm Spine 接入报告](./jiuwenswarm-spine-adaptation-2026-11-26.md)。
