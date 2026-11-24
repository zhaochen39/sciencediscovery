# JiuwenSwarm Scope 落地与对照验收

日期 2026-11-26。基线为原始 ScienceDiscovery `d684215a2fbbd366b6d455a941efa35cfc868ea9`，候选为 `feat/research-spine`（自 `0e4945a` 起增加本轮补丁）。两组均由 WSL 中实际运行的 JiuwenSwarm `workswarm0.2.6` 执行主 Run，使用正式 HTTP API、本地 Runner 和全新会话、数据目录。真实模型使用 `DeepSeek-V4.1-Flash-1017`。受控组只替换模型响应，使用相同的 Run API、执行器、持久化和核验路径。固定回报的受控 Token 用于对账。

## 放行范围

| 技术点 | 实现与验收 | 决策 |
|---|---|---|
| Scope 树、Node Memory | SQLite 事件重放，Scope `open`、`next`、`close`，节点记忆走 CAS。活跃节点冲突、重复操作、跨 Run 产物引用和取消有覆盖。观察模式记录工具、结果引用和回执。 | 本地 JiuwenSwarm 可以按请求启用观察。显式树可独立试验，性能门槛未过。 |
| Scope Projection | Swarm 网关压缩已闭合的历史工具对，保留用户约束和当前证据。显式 Scope 只缩短过时的状态快照。独立从模型上下文 CAS 复算。 | 保持独立开关。一次追问耗时 201 秒，批次延迟门槛未过。 |
| 检查点、Inline 和已核验产物 | `by-state` 恢复交付，校验输入摘要和逐条 DOI 数据，并将输出注册为当前 Run 的 Artifact Version。重开 API 后按 Scope 或 Node Memory 读回。Inline 对账实际模型工具清单和子 Run 数。 | 现有会话准入下开放验证过的工作流。恢复含重新计算和校验，Shell 次数可能增加。 |
| Scope 与 ScienceMemory | 按精确版本关联 Scope 和可见图谱节点，从产物溯源反查 Scope 和 Run。图谱的 Scope 连边取自服务端持久化索引。 | 真实与受控各一对通过。可以作为只读追溯能力。 |
| Spawn Receipt | 平台 `task` 路径与 Swarm `subagent_spawn` / `subagent_wait` 记录关联。原生回执只接收本 Run 已知子任务的终态，真实复跑验证了子结果 CAS 内容和重启后回执一致性。 | 按需读回。`task_tool`、跨 Run 委派和任意运行中子任务未纳入当前回执协议。 |
| Web 与桌面 | 共用 ScopeExplorer。Web 放在 Trajectory，桌面可从会话打开。可查 Scope、节点记忆、产物溯源和研究执行引用。组件用 1100px、390px 浏览器实测，API、Web、桌面、Trajectory 类型检查均通过。 | 双端生产构建通过。实际 Web 和桌面前端均在浏览器连到同一已重启的 API，展开 Scope 后查到对应的产物版本。 |
| Idea Tree / Evolve | Scope 记录工具发起的研究，按所属会话查询研究状态、候选评分和结果。Evolve 读取已记录评估的父子链路，分别保留 gate 分数与最终 held-out 分数。 | 根据下文端到端结果放行，评分由引擎维护。Scope 在查询时投影结果。 |

默认 Run 无 Scope 开销路径。试运行按 Run 设置 `researchScopes: "observe"`，同时令 `SCIENCE_AGENT_JIUWENSWARM_SCOPES=1`。在试点实例上可另设 `SCIENCE_AGENT_JIUWENSWARM_SCOPE_DEFAULT=observe`，使 Web 和桌面常规消息入口一并记录。显式树需要 `SCIENCE_AGENT_JIUWENSWARM_SCOPE_MANUAL=1` 并每次明确提交。长历史投影由 `SCIENCE_AGENT_JIUWENSWARM_SCOPE_PROJECTION=1` 单独控制。直接从引擎页面发起的搜索目前没有父 Scope。

## 端到端结果

数字来自双臂均自然完成且通过独立审计的配对。Token 是提供方报告的输入、输出、总量。请求数按实际 gateway 请求和 `turnsRecorded` 求和，Shell 数来自 Runner。交付耗时从提交正式 Run 到轮询到终态。文献全流程仅合计质控与续跑，独立短问答和 Inline 验证在日志保留。各类用例的耗时分别比较。

### 文献质控 → 续跑 → Scope、Node Memory 查证

两套冻结 DOI 样本独立复算逐条审计、汇总和输入 SHA-256。表内采用两个启用 Scope 观察的真实模型配对，即 `swarm-scope-integrated-20261126/real-1` 与 `swarm-scope-product-final-20261126/real-2`。受控组合 `controlled-2` 两臂通过，续跑均为 3 次模型请求、2 次 Shell。候选恢复后可从 Scope 反查经验证的交付版本。

| 指标 | 续跑 原始 → 候选 | 差异 | 质控 + 续跑 原始 → 候选 | 差异 |
|---|---:|---:|---:|---:|
| 输入 Token | 459,312 → 144,003 | −68.65% | 915,873 → 672,397 | −26.58% |
| 输出 Token | 5,831 → 3,615 | −38.00% | 9,040 → 6,713 | −25.74% |
| 总 Token | 465,143 → 147,618 | −68.26% | 924,913 → 679,110 | −26.58% |
| 模型请求 | 11 → 11 | 0 | 23 → 25 | +8.70% |
| Shell | 7 → 8 | +14.29% | 16 → 17 | +6.25% |
| 累计耗时 | 117.849 → 101.783 s | −13.63% | 234.269 → 204.130 s | −12.87% |

单对文献全流程耗时分别为 118.013 → 98.052 s 与 116.256 → 106.078 s。另一批 `swarm-scope-final-20261126` 两对没有启用观察的恢复对照，续跑总 Token 460,954 → 116,842（−74.65%），质控加续跑总 Token 955,173 → 644,901（−32.48%）。早期普通短问答耗时和新批独立短问答仍有波动，其中一对为 8.235 → 16.757 s。当前样本支持受控准入的文献恢复收益。

### 专项真实模型配对

| 场景 | 输入 Token | 输出 Token | 总 Token | 模型请求 | Shell | 交付秒数 |
|---|---:|---:|---:|---:|---:|---:|
| Scope 观察复跑 | 72,676 → 72,663 | 207 → 218 | 72,883 → 72,881 | 2 → 2 | 1 → 1 | 17.290 → 19.288 |
| Scope + ScienceMemory | 109,983 → 110,062 | 388 → 553 | 110,371 → 110,615 | 3 → 3 | 1 → 1 | 41.375 → 38.992 |
| 显式 Scope 树复跑 | 72,871 → 171,216 | 331 → 516 | 73,202 → 171,732 | 2 → 5 | 1 → 0 | 13.858 → 40.542 |
| Scope Projection 长历史追问 | 45,715 → 42,322 | 216 → 7 | 45,931 → 42,329 | 1 → 1 | 0 → 0 | 5.549 → 201.155 |
| Swarm 原生 Spawn Receipt 复跑 | 126,788 → 126,818 | 651 → 700 | 127,439 → 127,518 | 4 → 4 | 0 → 0 | 23.207 → 31.870 |
| 平台 `task` Spawn Receipt | 134,469 → 134,367 | 1,069 → 989 | 135,538 → 135,356 | 4 → 4 | 0 → 0 | 27.454 → 23.104 |

- 观察模式两轮成功配对都独立复算 `ASSAY/36`，受控实际发送消息字节数首轮为 85,093 → 85,093。真实复跑总 Token −0.003%，增加了重启后可查询的 Scope 轨迹。
- 显式树受控为 1 → 4 次请求，真实复跑为 2 → 5，真实总 Token +134.60%，耗时为 2.93 倍。操作过程确实持久化，但小任务为每次转移支付一个模型轮次。
- 长历史追问输入 −7.42%，保留之前的约束，模型答案均为 `FROZEN/155`。同一批次含五次读取的总耗时为 98.154 → 224.727 s。网关日志可检查上游首包和完成时间。
- 原生回执的收益为精确绑定子结果及重启后保持同一 CAS 摘要。两组均计算 `36`，总 Token +0.06%，候选为 31.870 s。另有一次候选子代理把说明文字写进了输出，尽管父 Run 自然完成且答对，仍按验收失败保留。复跑明确区分父子指令，双臂使用同一新提示。

## 失败与边界

- `swarm-scope-tree-r1-20261126` 记录了 Swarm 未传递空数组导致的受控用例失败。桥接允许省略空数组并归一化后复跑成功。
- `swarm-scope-final-20261126/observe-real/original` 与 `swarm-scope-integrated-20261126/real-2/original` 在上游请求发出后 240 秒未收到数据，正式 Run 失败。补跑采用全新会话和双臂，失败配对不进入差异计算。
- `swarm-scope-product-final-20261126/native-receipt-real/candidate` 记录子输出检查失败。另有旧版受控子类型与结果格式问题，见 `swarm-native-receipt-r1` 至 `r4`。回执只证明观察到的终态和具体结果，科研正确性需要独立核验。
- Scope 树重放和显式检查点续跑已有验收覆盖。任意执行中的 Swarm 进程重启恢复、远程 Runner、跨 Run 和其他委派类型仍超出通过范围。桌面验收覆盖实际桌面前端构建，安装包发布另有独立验证流程。

## 日志与复现

以仓库 `test/benchmarks/research-spine-value-validation/logs/` 为日志根目录。各批次的 `final-audit.json` 汇总配对和供方用量。每臂含 `driver.log`、`result.json`、`exit-code.txt`、`data-dir.txt`。最后一个文件指向 WSL 的 SQLite、消息、Runner 与 CAS。`swarm-scope-ui-20261126` 包含浏览器检查和两张截图。

```bash
bench=test/benchmarks/research-spine-value-validation
export SCIENCE_SPINE_SWARM_ADAPTED=1 SCIENCE_SPINE_SCOPE_TRACE_RECOVERY=1
bash "$bench/run-jiuwenswarm-reassessment-wsl.sh" "$baseline" "$fresh_results" \
  controlled-2 real-1 real-2 observe-controlled observe-real tree-controlled tree-real
python3 "$bench/audit-jiuwenswarm-reassessment.py" "$fresh_results" \
  controlled-2 real-1 real-2 observe-controlled observe-real tree-controlled tree-real \
  --context-evidence --record-failures
```

脚本读取 `/mnt/d/work/agent/ci_bench/env.sh`。已有成果的重新核验与首次失败都保存在各自批次，下文记录 Idea Tree、Evolve 和常规消息入口的专项结果。

## Idea Tree 与 Evolve 联动

Scope 中的「已提交」表示主 Run 已将工作交给引擎。打开执行详情后使用引擎记录的状态和评分。候选回读核对同一研究或搜索 ID、评分和重启前后结果，并确认其他会话用同一 Scope URL 返回 `404`。

- Idea Tree 受控模型的两候选用例双臂都跑过真实 Python 引擎，独立审计读回两个评分 `7`，背景模型调用 `16 → 16`、总 Token `2,400 → 2,400`。候选额外提供 Scope 入口。第一次真实双臂的候选完成，原始组在第二次选枝时因模型返回非法父节点中断。随后双方以相同的深度 2、节点上限 3 复跑，受控和真实模型四臂均自然完成。真实主 Run 的输入 164,518 → 123,239，输出 2,285 → 1,554，总量 166,803 → 124,793，模型请求 4 → 3，Shell 0 → 0，交付 51.083 → 36.785 s。背景总 Token 105,689 → 69,689，从提交到研究结束 329.827 → 270.972 s。双臂均有两个完成评分的候选，分数分别为 7.8 / 8.125 和 7.15 / 6.825。评分和模型轮次有样本差异，放行依据为正确挂接、重启一致、跨会话拒绝与持久化评分核验。证据在 `swarm-scope-idea-single-20261126/final-audit.json`。
- Evolve 的独立评估器读取冻结分片。受控双臂均从种子分 `0.4` 到 `0.54`，背景模型调用 `4 → 4`，总 Token `1,200 → 1,200`，从提交到搜索结束 `7.844 → 5.810 s`。真实双臂均完成，独立读取事件核对最高有效分 `1.0 → 1.0`。主 Run 的输入 `83,071 → 83,042`、输出 `684 → 1,001`、总 Token `83,755 → 84,043`、模型请求 `2 → 2`、Shell `0 → 0`、交付 `21.516 → 24.553 s`。背景总 Token `1,976 → 3,860`，从提交到搜索结束 `29.195 → 47.262 s`。受控组证明相同评估过程的接入开销，真实结果保留原始波动。该路径的放行依据是可查证的研究结果。
- 初期实验修复包括使用 Idea Tree 支持的探索设置、API 重启后关闭旧 HTTP 连接、令 Evolve 评估器按分片报告失败结果，以及安装锁定的 `candidates` 依赖。原始失败日志在 `swarm-scope-idea-r1`、`swarm-scope-idea-r2`、`swarm-scope-evolve-r1` 至 `r3` 批次中。

## 常规消息入口

`swarm-scope-default-entry-20261126` 用 Web 与桌面共用的 `/messages` SSE 入口完成受控双臂。双方都返回 `ASSAY/36`，实际模型请求 `2 → 2`、Shell `1 → 1`。候选试点配置会为常规消息记录 Scope，重开 API 后读回一致。

C-off 使用候选代码并关闭新功能，`swarm-scope-off-final-20261126` 的原始与候选四个实验臂均通过。真实模型输入 72,664 → 72,691，输出 99 → 88，总量 72,763 → 72,779（+0.02%），请求 2 → 2，Shell 1 → 1，交付 28.552 → 18.414 s。该短用例核验了默认路径，单对耗时用作观测值。

`swarm-scope-ui-e2e-r3-20261126` 使用实际 Web 和桌面构建、真实 ScienceMemory 与 Runner。候选浏览器从 Web Trajectory 与桌面会话分别打开 Scope 树，展开 `declare_artifact`，检查溯源内容含同一 Artifact Version。两臂底层实验自然完成，浏览器产物溯源检查通过。截图保存在候选目录的 `scope-web.png`、`scope-desktop.png`。最初两轮分别修复了浏览器依赖入口及定位器歧义，原始日志保留。

## 后续三臂复验与回退

同一后端增加了原版、候选关闭和候选开启的三臂对照，重新执行文献、仪器校准、长历史追问、平台委派、Evolve 和普通消息入口。新增试点回退用例和已关闭 Scope 的证据折叠用例。对照明细、失败记录和试点开关见 [JiuwenSwarm Spine 三臂验收报告](./jiuwenswarm-spine-matrix-2026-11-26.md)。
