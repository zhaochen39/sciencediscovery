# 已验收阶段精简恢复 · 2026-11-24

光伏用例有 120 个合成站点和 480 条日观测。任务先清洗并验证质控，再按技术分组、做仅包含完整站点的敏感性分析并写报告。每组在质控通过独立复算后冻结检查点。两种恢复在新进程中加载同一检查点，从头重跑使用相同的原始任务与输入。试验组在 WSL 串行轮换，真实模型为 `DeepSeek-V4.1-Flash-1017`。

精简恢复沿用 SpineCodex 将持久化轨迹与模型侧派生上下文分开的做法。恢复器核验工作区与历史的 SHA-256 清单，再复算质控。首轮模型输入包含原始任务、质控文件摘要、当前表格展示状态及待完成阶段。历史留在检查点供审计。完整历史组按现有入口注入历史。三组共享工具、预算和最终验收。

## 验收方法

- 三个交付分支均须由模型自然结束。Python 离线从独立参考重算五项产物，并查找成功工具输出中当前版本的完整质控表。恢复分支须在不同进程中加载相同检查点，保持原始输入及质控文件字节一致，且两份质控文件的写入调用计数为零。
- 首轮上下文 Trace 核对精简组仅有原始任务和已验证状态组合出的用户消息。已展示状态由完整表格与工具输出核对，文件版本仍按原始字节校验。
- 从启动运行器计墙钟，包含启动、加载检查点、哈希核验、工作区准备、业务请求、模型压缩和产物验收。故障至交付口径从恢复或重跑运行器启动计起。完整路径口径额外加上故障前捕获的运行器耗时与模型 usage。
- 业务轮次与模型压缩请求分别对账。全请求 Token 合计两类请求的供应商 usage。受控试验使用本地夹具返回的可重复 usage，仅用于功能验收。重试计数单列，供应商未返回的取消或失败尝试消耗无法核算。
- 扩大试验的门槛在运行前设定。所有组须通过正确性审计，且精简恢复相对完整历史恢复的首轮输入配对中位降幅至少为 15%，故障至交付墙钟的配对中位差小于零。

## 首批问题与复测

首批真实模型的九条交付轨迹都自然结束、产物复算通过，三组仅两组通过额外的恢复状态审计。第二组的完整质控表已经展示，文件用 CRLF，工具轨迹用 LF。首版逐字符比对把展示状态标成待完成，后续重复读表。修复后比较表格内容时统一换行，文件摘要及版本核验仍使用原始字节。受控已展示场景加入 CRLF 文件与 LF 输出。第二批完整重跑三个试验组，并采集压缩请求的供应商 usage。首批所有轨迹和失败审计原样保留。

## 正式结果

**正确性验收通过，扩大试验门槛未通过。** 受控模型和真实模型各通过 3/3 组、9/9 条端到端交付。真实模型含捕获共 68/68 个业务轮次及 2/2 个压缩请求完成 usage 对账。两种恢复的六条真实交付轨迹均未重写质控，从头重跑三条轨迹各写入一次。篡改质控文件后的恢复在模型请求前被拒绝。

| 组 | 首轮输入 Token（完整 / 精简 / 重跑） | 全请求总 Token（完整 / 精简 / 重跑） | 故障后秒数（完整 / 精简 / 重跑） |
|---|---:|---:|---:|
| 1 | 15,195 / 3,716 / 3,478 | 57,235 / 50,394 / 67,162 | 37.452 / 40.236 / 61.596 |
| 2 | 14,996 / 3,720 / 3,478 | 40,214 / 47,571 / 57,749 | 41.835 / 43.602 / 60.371 |
| 3 | 13,037 / 3,716 / 3,478 | 163,021 / 52,778 / 57,873 | 145.268 / 53.346 / 61.270 |

| 平均指标 | 完整历史恢复 | 精简恢复 | 从头重跑 | 精简相对完整 | 精简相对重跑 |
|---|---:|---:|---:|---:|---:|
| 首轮输入 Token | 14,409.33 | 3,717.33 | 3,478.00 | -74.20% | +6.88% |
| 全请求输入 Token | 79,059.67 | 47,037.67 | 57,076.67 | -40.50% | -17.59% |
| 全请求输出 Token | 7,763.67 | 3,210.00 | 3,851.33 | -58.65% | -16.65% |
| 全请求总 Token | 86,823.33 | 50,247.67 | 60,928.00 | -42.13% | -17.53% |
| 业务模型轮次 | 6.00 | 6.33 | 7.33 | +5.56% | -13.64% |
| 工具调用 | 5.00 | 6.00 | 6.33 | +20.00% | -5.26% |
| 故障至交付（秒） | 74.85 | 45.73 | 61.08 | -38.91% | -25.13% |
| 含捕获的总 Token | 115,387.00 | 78,811.33 | 60,928.00 | -31.70% | +29.35% |
| 含捕获的墙钟（秒） | 108.61 | 79.49 | 61.08 | -26.81% | +30.14% |

精简恢复相对完整历史恢复的首轮输入配对中位下降 **75.19%**，超过 15% 门槛。三组墙钟差为 **+2.784、+1.767、−91.922 秒**，配对中位数为 **+1.767 秒**，未达到预设耗时条件。第三组完整历史恢复执行了 11 个业务轮次，触发两次模型压缩，共耗时 56.223 秒和 21,979 Token。它拉高了完整历史组的平均耗时。前两组精简恢复都执行了额外的工作区探查和质控表读取。首轮上下文减少之后，额外工具调用仍可抵消节省。

相对从头重跑，精简恢复在三个样本中均更快，墙钟配对中位差为 **-16.769 秒**，全请求总 Token 平均下降 **17.53%**。算上到达检查点的成本后，精简恢复平均消耗增加 **29.35% Token**，墙钟增加 **30.14%**。当前结论适用于这批光伏任务的质控中断点。按预定门槛，本轮交付保留在 benchmark。


## 复现与原始证据

从 WSL 仓库根目录运行。真实模型入口按项目现有方式加载 `/mnt/d/work/agent/ci_bench/env.sh`。

```bash
b=test/benchmarks/research-spine-value-validation
SCIENCE_SPINE_CONTROLLED_RECOVERY=pending SCIENCE_SPINE_REPETITIONS=2 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-pending-repro" pnpm exec tsx "$b/run-controlled.ts"
SCIENCE_SPINE_CONTROLLED_RECOVERY=displayed SCIENCE_SPINE_REPETITIONS=1 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-displayed-repro" pnpm exec tsx "$b/run-controlled.ts"
SCIENCE_SPINE_REPETITIONS=3 SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-live-repro" \
  bash "$b/run-compact-recovery-wsl.sh"
```

每个 `pair-N` 目录包含 `arm-order.txt` 和 `capture/`、`resume/`、`compact/`、`restart/`。各分支有 `runner.log`、`wall-seconds.txt` 和 `exit-code.txt`，运行目录有 `summary.json`、`events.jsonl`、上下文 Trace 与产物。顶层 `recovery-evidence.md` 由独立审计脚本生成。

- [真实复测原始日志和审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/compact-recovery-20261124-live-r2)
- [真实首批原始日志和失败审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/compact-recovery-20261124-live-r1)
- [受控待展示日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/compact-recovery-20261124-controlled-pending-r2) · [受控已展示 CRLF 日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/compact-recovery-20261124-controlled-displayed-r2)
- [检查点篡改拒绝日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/compact-recovery-20261124-tamper)
