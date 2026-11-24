# ScienceDiscovery 第三阶段内部试运行准入复验

实验时间为 2026 年 11 月 25 日至 26 日，北京时间。运行环境为 WSL、Native 和本地 Runner。真实模型为 `DeepSeek-V4.1-Flash-1017`，API 运行在隔离的实验工作区。

## 准入决定

**第三阶段常规试运行未通过准入，继续保持恢复功能默认关闭。** 已展示状态保留为有证据支持的内部实验范围。光伏和仪器校准的已展示组都达到同入口总 Token 降幅门槛，相对原始框架的交付耗时配对中位分别降低 7.58% 和 53.31%。相对同入口完整历史，两个组的配对耗时中位分别增加 27.48% 和 24.83%。这轮结果支持证据投影节省 Token，两个工作流上都观察到延迟代价。

待展示状态使用完整历史。逆序复跑确认三个待展示冻结点相对完整历史仍慢 2.228 至 3.477 倍，且 Run 取消后需要显式停止仍在运行的 Shell。保留显式检查点入口的版本、展示和交付门禁，由普通续跑服务日常使用。代码沿用 SpineCodex 启发的思路，保留原始证据，在获得可复核的下游成果后再从模型视图移出展示内容。

## 对照口径

| 实验臂 | 代码与入口 | 归因 |
|---|---|---|
| `original` | `d684215a2fbbd366b6d455a941efa35cfc868ea9` 的 Dynamic 默认历史和普通续跑 | 衡量整套技术相对原始框架的变化 |
| `full` | `80a94b94fa7147f8894edee8e900519d22b5afa2` 的正式检查点恢复和完整历史 | 保留相同的入口、版本检查、工具策略和交付门禁 |
| `by-state` | 同一提交的正式检查点恢复，按状态选择是否投影原始展示证据 | 与 `full` 配对衡量按状态恢复带来的变化 |

两种工作流分别冻结六个新检查点，每种状态各三个。同一冻结点的三臂使用相同字节的工作区输入、工具历史和后续要求。每对内部串行执行，六对覆盖三臂的六种执行顺序。初始矩阵的四个工作流与状态批次并行，延迟受共享主机和模型服务负载影响。复跑使用同一冻结点和逆序执行。两个正式检查点实验臂都发送并发重复提交并校验同一 Run ID，原始普通续跑只发送一次请求。原始 WSL 目录为 Git 归档展开的目录，逐文件核验共 2,997 个 Git Blob，一致 2,997 个。

真实实验计时覆盖 HTTP 提交、模型与工具运转、终态轮询和 Usage API 对账。捕获和服务启动单列。正确性同时检查持久化终态、单次完成事件、独立数学与报告复算、展示顺序、质控文件保护、重复展示和用量对账。重复展示指同版本整张质控表再次进入模型的工具结果。下游计算在 Python 内部正常读取表。原始臂用文件字节和可见工具副作用检查重写，两个正式臂还校验文件身份及时间戳。分组门槛采用严格正确性全通过、零重复副作用、已展示组总 Token 较 `full` 平均下降至少 20%、相对 `original` 的逐对耗时中位增幅不高于 10%，以及零个经逆序复跑确认的 1.8 倍以上回退。

## 逐对原始数据

每格依次列出续跑耗时、输入 / 输出 / 总 Token、模型请求数 / 工具数。秒数保留三位小数。
工具统计包含已失败的调用。冻结点捕获在计时前完成。

| 工作流 / 状态 | 配对 | 原始 | 完整历史 | 候选 | 严格通过数 |
|---|---:|---:|---:|---:|---:|
| 光伏 / 待展示 | 1 | 255.559 秒<br>365185/6154/371339<br>12/11 | 67.840 秒<br>117267/5869/123136<br>6/5 | 195.320 秒<br>212196/5257/217453<br>10/9 | 3/3 |
| 光伏 / 已展示 | 2 | 161.249 秒<br>211516/5223/216739<br>7/6 | 102.739 秒<br>148543/10341/158884<br>7/6 | 256.504 秒<br>116215/4509/120724<br>11/10 | 3/3 |
| 光伏 / 待展示 | 3 | 102.399 秒<br>224761/4849/229610<br>10/9 | 96.315 秒<br>106795/5887/112682<br>8/7 | 170.239 秒<br>225311/9739/235050<br>15/14 | 2/3 |
| 光伏 / 已展示 | 4 | 146.143 秒<br>273171/7646/280817<br>11/13 | 111.699 秒<br>151661/5718/157379<br>10/9 | 135.064 秒<br>110619/4779/115398<br>11/10 | 3/3 |
| 光伏 / 待展示 | 5 | 94.691 秒<br>185096/4358/189454<br>8/7 | 75.474 秒<br>107841/5318/113159<br>8/7 | 196.734 秒<br>160232/8745/168977<br>11/13 | 3/3 |
| 光伏 / 已展示 | 6 | 221.826 秒<br>411803/6239/418042<br>13/12 | 70.019 秒<br>182137/5904/188041<br>9/8 | 89.263 秒<br>80556/3876/84432<br>8/8 | 3/3 |
| 仪器校准 / 待展示 | 1 | 276.399 秒<br>308331/5021/313352<br>13/13 | 61.696 秒<br>94454/3389/97843<br>8/10 | 73.664 秒<br>64311/2856/67167<br>6/5 | 3/3 |
| 仪器校准 / 已展示 | 2 | 230.688 秒<br>234075/4652/238727<br>9/9 | 82.502 秒<br>104782/3367/108149<br>7/9 | 116.762 秒<br>43609/2288/45897<br>5/4 | 3/3 |
| 仪器校准 / 待展示 | 3 | 161.191 秒<br>337528/6173/343701<br>14/14 | 85.491 秒<br>92587/3251/95838<br>8/10 | 74.473 秒<br>81268/3993/85261<br>7/6 | 3/3 |
| 仪器校准 / 已展示 | 4 | 117.194 秒<br>261606/5426/267032<br>10/10 | 46.010 秒<br>52295/2777/55072<br>4/3 | 51.104 秒<br>43742/2263/46005<br>5/4 | 3/3 |
| 仪器校准 / 待展示 | 5 | 98.568 秒<br>178936/3593/182529<br>8/7 | 45.293 秒<br>55770/2872/58642<br>5/4 | 140.676 秒<br>102404/4862/107266<br>8/7 | 3/3 |
| 仪器校准 / 已展示 | 6 | 163.174 秒<br>269754/4817/274571<br>10/12 | 61.036 秒<br>72752/3662/76414<br>5/4 | 76.193 秒<br>74581/4322/78903<br>8/7 | 3/3 |

## 分组收益与门槛

配对统计使用三路均通过的冻结点。失败及待确认样本留在逐对表中。
耗时相对变化取逐对比例的中位数。Token、模型和工具指标采用各臂均值，其百分比由未舍入数值计算。

| 工作流 / 状态 | 三路通过的冻结点 | 相对原始输入 / 输出 / 总 Token | 相对原始模型 / 工具请求 | 相对原始耗时中位 | 相对完整历史输入 / 输出 / 总 Token | 相对完整历史耗时中位 |
|---|---:|---:|---:|---:|---:|---:|
| 光伏/待展示 | 2/3 | -32.32% / +33.20% / -31.09% | +5.00% / +22.22% | +42.10%（+20.902 秒） | +65.44% / +25.16% / +63.54% | +174.29%（+124.370 秒） |
| 光伏/已展示 | 3/3 | -65.71% / -31.11% / -64.99% | -3.23% / -9.68% | -7.58%（-11.079 秒） | -36.27% / -40.06% / -36.44% | +27.48%（+23.365 秒） |
| 仪器校准/待展示 | 3/3 | -69.93% / -20.80% / -69.07% | -40.00% / -47.06% | -53.80%（-86.718 秒） | +2.13% / +23.12% / +2.92% | +19.40%（+11.968 秒） |
| 仪器校准/已展示 | 3/3 | -78.84% / -40.43% / -78.11% | -37.93% / -51.61% | -53.31%（-86.981 秒） | -29.54% / -9.51% / -28.72% | +24.83%（+15.157 秒） |

全体三路通过配对的均值如下。

| 指标 | 原始 | 完整历史 | 候选 | 候选相对原始 |
|---|---:|---:|---:|---:|
| 输入 Token | 276,091.00 | 107,280.82 | 99,066.64 | -64.12% |
| 输出 Token | 5,391.09 | 4,769.82 | 4,340.91 | -19.48% |
| 总 Token | 281,482.09 | 112,050.64 | 103,407.55 | -63.26% |
| 模型请求数 | 10.45 | 7.00 | 8.18 | -21.74% |
| 工具调用数 | 10.36 | 6.82 | 7.55 | -27.19% |
| 耗时（秒） | 175.15 | 73.62 | 127.80 | -27.04% |

## 实际失败及复跑

| 工作流 / 配对 | 实验臂 | 严格审计失败原因 |
|---|---|---|
| 光伏 / 3 | 候选 | completion, delivery_attested |

完整历史和候选使用同一个正式入口。超过任一个对照臂 1.8 倍的用例均在同一冻结点逆序复跑。

| 工作流 / 状态 / 配对 | 首轮 ≥1.8× 的比值 | 逆序后候选 / 原始 | 逆序后候选 / 完整历史 | 复跑三路通过数 |
|---|---|---:|---:|---:|
| 光伏 / 待展示 / 1 | 相对完整历史 2.879× | 1.007× | 2.817× | 3/3 |
| 光伏 / 已展示 / 2 | 相对完整历史 2.497× | 0.466× | 0.792× | 3/3 |
| 光伏 / 待展示 / 5 | 相对原始 2.078×、相对完整历史 2.607× | 1.652× | 3.477× | 3/3 |
| 仪器校准 / 待展示 / 5 | 相对完整历史 3.106× | 1.244× | 2.228× | 3/3 |

首轮真实模型 **35/36** 条自然完成并通过严格审计。所有首轮已完成的 Run 重复整表展示和已观测的质控重写均为 0。光伏待展示第 3 对的旧候选生成了正确产物，交付门禁报 `The quality table must be displayed before downstream computation`。`run_shell` 执行 `cat site_qc.csv` 时先返回运行中，随后模型依序确认同一执行 ID 成功，并拿到未截断的日志整表。独立审计从模型可见日志复核了展示顺序。原门禁仅识别 `run_shell` 内联输出。

修复将当前 Run 的 Shell 执行、同 ID 的成功状态、实际交给模型的完整 stdout 日志页连起来校验。未知执行、截断内容和确认展示前已观测的下游写入均由门禁拒绝。受控桩使用同一冻结点稳定覆盖这条路径，旧版被拒，修复版完成并通过复算。修复版在原光伏冻结点的真实模型逆序实验 **3/3** 通过，原始、完整历史、候选耗时分别为 186.856、223.341、145.853 秒，候选总 Token 为 217,017。真实复跑这次用的是同步 Shell 展示，异步路径的确定性覆盖来自受控 E2E。首轮矩阵和修复后专项数据分别保留，分组收益表只汇总首轮三路全通过的 11 对。

四组达到 1.8 倍的冻结点完成逆序复跑，**12/12** 通过。光伏已展示第 2 对的回退未复现。光伏待展示第 1 对、第 5 对和仪器校准待展示第 5 对相对 `full` 的回退复现。三组中相对原始框架的首轮 2 倍以上回退在复跑中降至 1.652 倍。

## 旧样本逆序复跑与时间线

| 冻结点 | 原始 / 完整历史 / 候选（秒） | 候选 / 完整历史 | 解释 |
|---|---:|---:|---|
| 光伏待展示第 1 对 | 115.024 / 83.283 / 185.315 | 2.225× | 两条正式臂均为 `full-history`。候选 20 次模型请求、19 次工具调用，完整历史分别为 7 次和 6 次。候选有 6 次成功的 `update_plan` 和 1 次失败的 `list_artifacts`。 |
| 仪器校准已展示第 2 对 | 93.894 / 73.483 / 78.026 | 1.062× | 候选总 Token 58,893，完整历史 121,032，下降 51.34%。候选相对原始快 15.868 秒，相对完整历史慢 4.543 秒。 |

光伏旧样本候选相对 `full` 多耗时 102.032 秒。模型请求时间区间并集多 74.824 秒，工具调用区间并集多 22.514 秒，尚未归因的区间多 4.694 秒。两类观测区间未重叠。模型请求数和额外工具足以解释这次尾延迟的大部分差值。双方首轮均曝光 `run_shell`、`execution_status`、`execution_logs`、`update_plan` 和 `read_tool_output`。`update_plan` 来自计划贡献，`list_artifacts` 的调用失败。待展示路径本来就需要展示完整质控证据，光伏这组回退发生在两条完整历史路径之间。代码仍按显式检查点入口执行版本检查、展示顺序和交付门禁。

校准旧样本候选的模型请求区间为 33.424 秒，完整历史为 34.827 秒。工具区间为 27.959 秒和 24.125 秒。Runner 的执行起止区间并集为 19.873 秒和 4.895 秒，完整历史另有一次 `execution_status` 和一次 `execution_logs`。单次工具调用时间包含调度、Runner 执行与结果观察。不同任务脚本和轮次改变执行时间，不能通过上述累计值单独归因到工作区同步。审计输出中分别保留模型首字节、工具事件、Runner 开始和结束、交付通过事件、持久化终态和客户端拿到结果的时间戳。

## 正式 API 故障注入

受控 SSE 桩给出固定命令。正常计算运行在实际 Runner 沙箱中。取消通过持续写入测试工作区的 Shell 标记同步。强制退出发生在第一个下游产物已落盘、API 等待下一次模型请求的时候。各场景重启了一个 PID 不同的 API 进程并重新打开原数据目录。

| 场景 | 持久化终态 | 结果 |
|---|---|---|
| Shell 进行中取消 | `cancelled` | Run 取消后 Shell 仍响应探测标记，继续调用该 Run 持有的执行取消接口后，受控 Shell 进入 `cancelled`，释放标记未触发写入。仅启动 1 个 Shell。 |
| 下游产物已写入，Run 尚未提交时 SIGKILL API | `interrupted` | `groups.json` 按独立复算正确并保持原字节，Run 未发布助手结果和交付通过事件，`solar_report.md` 不存在。仅启动 1 个 Shell。 |
| 正常完成后重启，重复提交同一请求 | `completed` | 已完成的助理消息和科学产物有效。重试返回原 Run 和原消息，三次 Shell 调用全部来自首次提交。 |

三项均通过持久化事件、质控字节、用量和重复副作用审计。同内容并发重试返回同一个 Run，改内容返回 409，重试新增模型请求和 Shell 执行均为 0。日志中 `cancel-shell` 的 10.420 秒、`crash-before-commit` 的 6.783 秒、`retry-after-restart` 的 22.189 秒用于复盘故障过程。Run 与 Shell 有独立生命周期，Run 停止后如果需要阻断工作区写入，运维需要等待对应 Shell 执行确认终态。最终验证关闭了无关的科学环境初始化，三个驱动均自行退出 0。

早期故障驱动保留在 `pilot-fault-v1` 到 `v3`。首次按 Run 取消等待 Shell 自行退出，发现了独立生命周期。第二次驱动误把 bubblewrap 命名空间内的 PID 当作宿主机 PID，导致等待超时。后来改用工作区标记、执行 API 和重启后重读记录。第三次开启环境预置，取消场景写出了正确结果但驱动清理超时，对应退出码 124。首次通过的三项数据位于 `pilot-fault-v4`。异步展示修复后重跑，同样三项全通过，结果位于 `pilot-fault-fixed`。日志中校准新冻结点第 1 组的第一次捕获被请求状态门禁拒绝，保留在 `capture-attempts/attempt-1`，重新捕获后才纳入对照。

## 回归结果

修复版 API 类型检查和检查点专项测试 **2/2** 通过。检查点测试覆盖同一成功执行的完整日志、错误 ID、截断页和展示前推进。双方关闭检查点恢复时，用同一受控模型、真实 Runner 和普通续跑入口测试 **2/2**，均自然完成、通过复算并保护质控文件。并行真实实验期间，修复版相关套件通过 **112/113**，子 Agent 用量用例在既有轮询窗口内还处于 `running`，独立复跑通过。原始提交独立执行该用例也出现过轮询超时。保留全部日志，真实模型批跑结束后，在独立目录串行复跑同一套件，**113/113** 通过。两个科研用例没有子 Agent 调用。

## 复现与日志

在 WSL、当前项目根目录运行。`$baseline` 指向原始提交安装依赖并构建后的独立目录。日志目录应为新目录。密钥通过 `/mnt/d/work/agent/ci_bench/env.sh` 加载。

```bash
b=test/benchmarks/research-spine-value-validation
bash "$b/capture-pilot-wsl.sh" solar "$b/logs/new-solar-captures"
bash "$b/capture-pilot-wsl.sh" calibration-review "$b/logs/new-calibration-captures"
bash "$b/run-pilot-wsl.sh" "$b/logs/new-solar-captures" "$b/logs/new-solar-formal" "$baseline"
bash "$b/run-formal-faults-wsl.sh" "$b/logs/new-solar-captures/pair-2/capture" "$b/logs/new-faults"
```

可用 `run-pilot-wsl.sh` 的第 4 个参数开始传入冻结点号，例如 `1 3 5`。使用 `rerun-pilot-pair-wsl.sh CAPTURE NEW_OUTPUT BASELINE PRIOR_PAIR` 根据 `arm-order.txt` 反转三臂顺序。`summarize-pilot.py LOGS` 按本报告的四组目录名生成严格审计 JSON。`report-formal-recovery.py PAIR --require-pass` 可单独复核完成事件、科研产物、用量和逐请求时间线。对受控故障使用 `--require-fault-pass`。`config.txt` 中的原始版本字段在首批归档目录下因无 `.git` 为空，报告采用独立 Blob 核验的结果，脚本支持传入核验后的原始 SHA。

每个实验臂目录内的 `driver.log` 保留逐请求输出，`result.json` 保留终态，`exit-code.txt` 保留进程退出码。`data-dir.txt` 指向 WSL 内该臂的持久化试验目录，下面的 `run-events`、`context-traces`、`logs/run.log` 和 `logs/runner.log` 可对照本报告时间线。

- [实验日志总目录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs)
- [光伏新冻结点](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-captures-solar) · [仪器校准新冻结点](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-captures-calibration)
- [光伏待展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-formal-solar-pending) · [光伏已展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-formal-solar-displayed)
- [校准待展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-formal-calibration-pending) · [校准已展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-formal-calibration-displayed)
- [正式故障结果](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-fault-v4/formal-audit.jsonl) · [原始版本核验](D:/work/agent/packre/sciencediscovery-analysis/.tmp/pilot-baseline-verification.log)
- [异步展示旧版受控](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-async-controlled-before) · [修复版受控](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-async-controlled-v1) · [同冻结点真实复跑](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-async-fix-solar-pair3/formal-audit.jsonl)
- [修复后故障验收](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-fault-fixed/formal-audit.jsonl) · [并行期间回归日志](D:/work/agent/packre/sciencediscovery-analysis/.tmp/pilot-regression-final.log) · [独立串行回归日志](D:/work/agent/packre/sciencediscovery-analysis/.tmp/pilot-regression-cold.log) · [专项测试](D:/work/agent/packre/sciencediscovery-analysis/.tmp/pilot-fixed-recovery-tests.log)
- [光伏待展示第 1 对逆序](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-recheck-solar-pending-pair1/formal-audit.jsonl) · [光伏待展示第 5 对逆序](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-recheck-solar-pending-pair5/formal-audit.jsonl) · [光伏已展示第 2 对逆序](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-recheck-solar-displayed-pair2/formal-audit.jsonl) · [校准待展示第 5 对逆序](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/pilot-recheck-calibration-pending-pair5/formal-audit.jsonl)
