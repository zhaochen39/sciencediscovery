# 按阶段投影与断点恢复验收 · 2026-11-24

## 按阶段启用投影

工作流在每轮组装上下文前，使用独立产物验收确定第一个待完成阶段。投影候选要求该阶段是分析任务、会实际消费独立读出对应的产物、产物输入和输出版本有效。首选候选必须实际覆盖这条读出并通过 Context 的预算和近期消息保护，才记一次命中。只剩报告、待质控、版本失效或候选被拒绝时使用现版 Projection 规则。影子组运行 Dynamic 模型输入并记录候选评估。

两种真实任务共用 `DeepSeek-V4.1-Flash-1017`、1,500 估算 Token 和 10% 相对节省的门槛。光伏任务要求展示完整站点质控表，仪器校准扩展到每批 72 个测点，也要求展示完整清洗表。用例让模型自行决定输出表格与写入文件是否共用一次调用。验收独立重算光伏质量、分组、敏感性和报告，校准清洗记录、OLS、漂移和报告。逐轮对账供应商 usage。每个任务三次完整运行，进入十组 A/B 的预设门槛为同一任务 2/3 次在最后一轮之前自然命中，并且全部自然结束和验收通过。

| 用例 | 自然结束和独立验收 | 供应商 usage 对账 | 有早期命中的任务 | 首选投影命中轮次 |
|---|---:|---:|---:|---:|
| 光伏 | 3/3 | 23/23 | 0/3 | 0/23 |
| 仪器校准 | 3/3 | 18/18 | 0/3 | 0/18 |

两个用例均未达到完整 A/B 的准入门槛。六条轨迹都有完整质控表输出，仍有 11 轮处于待分析且缺少当前可绑定的独立读出。多条轨迹在写入质控文件的调用内同时输出长表，部分轨迹把完整表留到验收补做。该批看到了正常完成所需的调用分布，无法估计从头运行时阶段投影的 Token 收益。按预设流程进入跨进程断点恢复对照。

首次影子批次也保留原始结果。随后加强了优先候选的命中判断，要求确实替换指定的独立读出，防止候选里其他普通投影的命中被计入。受控模型 15/15 次端到端 PASS，覆盖独立完整读出、版本变化、混合输出、重复读出和不完整读出。Context 回归 60/60，工作流策略和仪器校准测试 2/2，API 类型检查与仓库测试类型检查通过。

## 已验收质控点的跨进程恢复

复用 Native Agent 的阶段暂停和历史注入。光伏质控文件完成并通过独立验收时，运行器保存工作区、历史、阶段证据及 SHA-256 清单，再退出进程。新的 WSL 进程读取检查点，复核清单、原始输入及质控产物版本和阶段验收，继续分组、敏感性分析和报告。最终仍要获得完整质控表输出。质控写入指标从每次工具执行前后文件修改时间核对，并逐条记录调用 ID。恢复后两份质控文件还需与检查点逐字节一致。

真实对照两组都用 Projection。每对使用同一原始模型任务和数据，交替运行先恢复还是先从头重跑。统计两个口径，故障点之后开始计的恢复和重跑，以及把此前成功到达检查点的成本计入的完整路径。运行器内耗时从工作区准备完成起到交付完成，包含模型等待与工具耗时。三对独立执行，延迟作为小样本观察。另复制一份检查点修改质控文件，恢复进程在发起模型请求前拒绝了摘要不匹配的输入。

首批三条捕获有两条在展示完整质控表之前已经继续到后续阶段，未生成预定检查点。新版在两份质控产物通过独立复算时保存，将仍待展示的质控表纳入恢复后的端到端验收。两个批次原始日志都保留。

正式批次 **3/3 对通过**，恢复与从头重跑的六条轨迹都自然结束，五项产物通过独立复算和完整表检查。三个检查点均由不同 PID 恢复，质控文件逐字节保留。包括捕获在内的 44/44 个模型轮次均完成供应商 usage 对账。

| 组 | 恢复总 Token | 从头重跑总 Token | 恢复耗时 | 从头重跑耗时 | 质控写入调用（恢复 / 重跑） |
|---|---:|---:|---:|---:|---:|
| 1 | 52,374 | 66,739 | 250.43 s | 111.72 s | 0 / 1 |
| 2 | 56,330 | 97,074 | 144.82 s | 137.43 s | 0 / 1 |
| 3 | 70,291 | 56,052 | 205.15 s | 138.87 s | 0 / 1 |

| 平均指标 | 恢复 | 从头重跑 | 恢复相对重跑 |
|---|---:|---:|---:|
| 输入 Token | 56,157.33 | 69,025.33 | −18.64% |
| 输出 Token | 3,507.67 | 4,263.00 | −17.72% |
| 总 Token | 59,665.00 | 73,288.33 | −18.59% |
| 模型轮次 | 4.67 | 7.00 | −33.33% |
| 工具调用 | 4.00 | 6.67 | −40.00% |
| 耗时 | 200.14 s | 129.34 s | +54.74% |

检查点捕获阶段平均为 29,139.33 Token、35.69 秒。计入捕获与恢复后，完整路径平均 **88,804.33 Token、235.83 秒**，较完整重跑分别增加 **21.17%、82.34%**。恢复机制在这三个样本中省去一次质控写入，故障点后的总 Token 有两组下降、一组上升，三组耗时均高于从头重跑。当前收益是已验收的计算结果可以跨进程复用，以及这批任务故障点之后的平均 Token 减少。该对照使用受控暂停在已验收边界保存状态，结果适用于这一中断条件。首批唯一完整配对的恢复与重跑也都自然通过，分别为 55,537 和 81,309 Token，作为首次试跑单独存档。

## 复现

从 WSL 仓库根目录运行，实验入口按现有方式加载模型环境。

```bash
b=test/benchmarks/research-spine-value-validation
for task in solar calibration-review; do
  SCIENCE_SPINE_CASE="$task" SCIENCE_SPINE_EXPERIMENT=shadow \
    SCIENCE_SPINE_MODES=adaptive-shadow SCIENCE_SPINE_REQUIRE_REVIEW=1 \
    SCIENCE_SPINE_LOG_DIR="$b/logs/stage-policy-$task-repro" bash "$b/run-calibration-wsl.sh"
done
python3 "$b/report-paired.py" "$b/logs/stage-policy-solar-repro/shadow" \
  --adaptive-dir "$b/logs/stage-policy-calibration-review-repro/shadow"
SCIENCE_SPINE_LOG_DIR="$b/logs/stage-recovery-repro" \
  SCIENCE_SPINE_REPETITIONS=3 bash "$b/run-recovery-wsl.sh"
```

- [影子验证证据汇总](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-policy-20261124-evidence-r2.md)
- [光伏原始轨迹](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-policy-20261124-solar-r2/shadow) · [校准原始轨迹](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-policy-20261124-calibration-review-r2/shadow)
- [恢复对照证据及逐对日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-recovery-20261124-r2) · [首轮恢复批次](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-recovery-20261124-r1)
- [检查点完整性拒绝](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-recovery-20261124-tamper) · [受控回归](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/stage-policy-20261124-controlled)
