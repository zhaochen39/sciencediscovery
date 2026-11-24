# ScienceDiscovery JiuwenSwarm 两组重新执行的验收记录

实验日期 2026-11-26。两组在 WSL 重新创建会话、Run 和工作区。报告对应本轮新执行的原始记录。

## 版本与执行环境

| 实验臂 | ScienceDiscovery 源码 | 实际后端 | 本轮可执行路径 |
|---|---|---|---|
| 原始基线 | `d684215a2fbbd366b6d455a941efa35cfc868ea9` | JiuwenSwarm 0.2.6 | 原有 Run、Shell、同会话文献续跑和平台 `task` 子任务查询 |
| 当前分支 | `09ae447de434a39a2a1bc8e2afdb294e3697f48a`（个人仓 `feat/research-spine`） | JiuwenSwarm 0.2.6 | 原有 Run、Shell 与同会话文献续跑。平台 `task` 完成后可生成 Spawn Receipt。另探测显式 Spine 恢复、Inline 和 Node Memory |

基线源码逐文件匹配 Git 树，核对 2,997 个 blob，差异 0。候选的正式服务和执行器相关源码与当前提交一致。两臂用正式 API、同版本适配器与本地 Runner，确认每臂的 `/agent/info` 报告 `executor=jiuwenswarm` 和 `reachable=true`，再按模型网关记录对账。Swarm 运行时标签 `workswarm0.2.6`，源提交 `70aa6715992d9cb2c3ec81ee35991d13747e5ce0`。真实模型配置从 WSL 的 `/mnt/d/work/agent/ci_bench/env.sh` 加载。受控用例替换模型端点并保留相同的真实执行器和工具路径。

对照包含两个冻结文献用例，每个实验臂包括短问答、质控和续跑。独立复算检查受保护输入、逐条审计、汇总 JSON 和完整展示证据。两组轮换基线与候选的执行顺序。单个 Run 的观测上限为 480 秒。Spawn Receipt 对照使用实际平台 `task`，原始基线从子任务 API 查询终态，当前分支另生成回执并在重新打开 API 后解引用校验。

## 代码与路由证据

| 技术点 | 当前分支在 JiuwenSwarm 上的执行结果 |
|---|---|
| Scope Projection | Swarm 的会话历史由 Swarm 自己持有。仓库中的投影由 Native 上下文组装器接入，Swarm 适配器没有该接入路径。 |
| 检查点恢复 | 候选启用 `by-state` 并指定当前会话。显式请求返回 `409`，要求 Native 会话。随后普通同会话续跑可用于检查默认路径。 |
| Inline | 显式指定 `delegationMode: "inline"` 返回 `409`，要求 Native 会话。 |
| Node Memory | 普通 Swarm Run 缺少 `researchResume` 绑定，源码在读取产物版本前就要求该绑定。当前探针携带占位版本 ID，响应 `409`。 |
| Spawn Receipt | 平台 `task` 存在正式回执路径。真实适配器可以运行父子模型任务，API 可从持久化子任务生成 CAS 回执。 |
| Scope Tree、Scope UI、完整图谱与 Idea Tree/Evolve 联动 | 当前分支尚无对应的完整 Swarm 执行路径。 |

[Swarm 适配器历史边界](D:/work/agent/packre/sciencediscovery-analysis/services/api/src/agent-run/jiuwenswarm-agent.ts:1115) · [恢复与 Inline 门禁](D:/work/agent/packre/sciencediscovery-analysis/services/api/src/runs/index.ts:3506) · [Node Memory 前置校验](D:/work/agent/packre/sciencediscovery-analysis/services/api/src/runs/research-checkpoint.ts:231) · [回执 API](D:/work/agent/packre/sciencediscovery-analysis/services/api/src/http/index.ts:4187)

## 普通 Run 的重新执行结果

受控模型 **12/12**、真实模型 **12/12** 个 Run 均自然结束并完成独立验收。四个候选文献实验臂的显式门禁探针均被拒绝，新增 Run 和模型调用均为 0。外层 WSL 脚本在全部八个实验臂写入退出码后报了读脚本尾部的语法错误。执行期间更新了脚本以增加回执用例。八个逐臂进程均退出 0，原始结果和请求对账均通过。现行脚本通过 `bash -n`，回执批次使用更新后的脚本。

受控文献续跑两边每次均为输入 750、输出 150、总量 900 Token、3 次模型请求和 2 次 Shell 执行。固定用量用于确认记录链正确。以下为重新执行后通过审计的真实模型结果。

| 用例 | 阶段 | 输入 Token（基线 → 当前分支） | 输出 Token | 总 Token | 模型请求 | Shell 执行 | 交付秒 |
|---|---|---|---|---|---|---|---|
| 文献 1 | 短问答 | 36,204 → 36,198 | 25 → 46 | 36,229 → 36,244 | 1 → 1 | 0 → 0 | 28.533 → 8.628 |
| 文献 1 | 质控 | 187,729 → 264,916 | 1,192 → 1,925 | 188,921 → 266,841 | 5 → 7 | 3 → 5 | 87.724 → 115.279 |
| 文献 1 | 续跑 | 200,370 → 247,698 | 1,330 → 2,735 | 201,700 → 250,433 | 5 → 6 | 2 → 3 | 63.169 → 115.718 |
| 文献 2 | 短问答 | 36,192 → 36,188 | 47 → 25 | 36,239 → 36,213 | 1 → 1 | 0 → 0 | 36.359 → 25.060 |
| 文献 2 | 质控 | 265,886 → 223,915 | 1,218 → 1,750 | 267,104 → 225,665 | 7 → 6 | 5 → 2 | 134.937 → 110.253 |
| 文献 2 | 续跑 | 205,303 → 161,522 | 1,895 → 1,909 | 207,198 → 163,431 | 5 → 4 | 3 → 2 | 96.068 → 119.967 |

| 两组汇总 | 输入 Token | 输出 Token | 总 Token | 模型请求 | Shell 执行 | 交付耗时配对比值中位数 |
|---|---|---|---|---|---|---|
| 普通续跑 | 405,673 → 409,220（+0.87%） | 3,225 → 4,644（+44.00%） | 408,898 → 413,864（+1.21%） | 10 → 10 | 5 → 5 | +54.03% |
| 文献流程，质控及续跑 | 859,288 → 898,051（+4.51%） | 5,635 → 8,319（+47.63%） | 864,923 → 906,370（+4.79%） | 22 → 23 | 13 → 12 | +26.37% |

文献 1 的续跑耗时为基线的 1.83 倍，多 52.549 秒，文献 2 为 1.25 倍，多 23.899 秒。两边使用普通 Swarm 路径。本批观察到的延迟变化超过原报告建议的默认路径回归阈值，样本仅两对，不能定位为框架代码回退。此前旧批次普通续跑的 Token 降幅在本批未复现。两批都缺少实际采用 Spine 投影或恢复的候选臂。

## Spawn Receipt 在平台 `task` 的重新执行结果

受控和真实模型各有一个基线臂和一个候选臂，四个父 Run 均自然结束。受控模型的两个子任务分别交付 `{ "value": 14 }` 和结构校验失败。真实模型的两个子任务交付 `{ "value": 14 }` 和 `{ "value": 21 }`。基线可以在 API 重开后查询原有子任务记录。候选增加稳定回执，回执逐一关联子任务 ID，重开后摘要和内容一致，CAS 成功解引用至每个正确结果，且受控场景保留失败诊断。生成及重读均增加 **0 次模型请求**。

| 模型 | 输入 Token（基线 → 当前分支，包含子任务） | 输出 Token | 总 Token | 模型请求 | Shell 执行 | 父 Run 交付秒 | 候选生成回执 / 重开后读取 |
|---|---|---|---|---|---|---|---|
| 受控 | 1,000 → 1,000 | 200 → 200 | 1,200 → 1,200 | 4 → 4 | 0 → 0 | 11.685 → 8.903 | 102 / 1,052 毫秒 |
| 真实 | 134,656 → 135,087 | 1,147 → 1,200 | 135,803 → 136,287（+0.36%） | 4 → 4 | 0 → 0 | 85.356 → 82.940 | 123 / 873 毫秒 |

回执在父 Run 完成后按需生成，父 Run 延迟与回执开销分别计量。该功能本批验证的收益是获得可重复解析的持久化分支凭据，固定结果和失败原因可以按同一引用核查。平台 `task` 以外的 `subagent_spawn` 路径不在本批覆盖范围内。

## 判定

- **当前分支的正确性范围**包括普通短问答、文献工作流以及平台 `task` 的回执。受控和真实模型合计 **28/28 个主 Run** 通过对应的独立验收。真实模型为 `DeepSeek-V4.1-Flash-1017`。
- **普通路径的性能回归未达到原报告的延迟门槛。** 本批文献全流程总 Token 增长 4.79%，交付耗时的配对比值中位数增加 26.37%。使用两组输入，可以标出差异并追查模型和工具请求。更广泛的性能判定需要更大的样本。
- **完整 JiuwenSwarm Spine 的收益当前无法验收。** `feat/research-spine` 上可正向验证的新增 Swarm 特性是 Spawn Receipt。Scope Projection、检查点恢复、Inline、Node Memory 和 Scope 联动仍缺少同一后端的完整候选路径。整体验收需要候选实际产出 Spine 路由、模型请求与交付证据。

## 复现与日志

在候选仓库根目录执行。`$baseline` 指向由原始提交导出的干净源码及已装依赖，`$output` 是新的输出目录。

```bash
bench=test/benchmarks/research-spine-value-validation
export SCIENCE_SPINE_SWARM_RUN_TIMEOUT_MS=480000
bash "$bench/run-jiuwenswarm-reassessment-wsl.sh" "$baseline" "$output" \
  controlled-1 controlled-2 real-1 real-2
bash "$bench/run-jiuwenswarm-reassessment-wsl.sh" "$baseline" "$output" \
  receipt-controlled receipt-real
python3 "$bench/audit-jiuwenswarm-reassessment.py" "$output" \
  controlled-1 controlled-2 real-1 real-2 receipt-controlled receipt-real --record-failures
```

日志按 `用例/arm/` 保存，每臂有 `driver.log`、`result.json` 和 `exit-code.txt`。完整通过的对才用于计算指标差值，失败臂保留原始状态。延迟从正式 API 提交至轮询观测到终态。回执 API 耗时按单次请求单列。

[本轮原始日志目录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/jiuwenswarm-fresh-20261126) · [基线完整性校验](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/jiuwenswarm-fresh-20261126/baseline-integrity.json) · [逐臂审计 JSON](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/jiuwenswarm-fresh-20261126/final-audit.json)
