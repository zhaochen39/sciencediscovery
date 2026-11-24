# 质控展示回执恢复验收 · 2026-11-25

恢复器从冻结历史提取与 `run_shell` 调用匹配的成功工具结果。结果必须在标准输出中逐行包含当前版本的完整 `site_qc.csv`。回执记录真实工具调用 ID、原始工具结果 SHA-256 和质控文件 SHA-256。恢复时先校验检查点及产物字节版本，再生成展示回执。有回执时首项待办为分组，否则为单独展示当前完整表。原始工具轨迹留存供重放和审计，模型根据实际数据执行分组、敏感性分析和报告。

## 对照与准入

受控实验验证待展示和已展示。来源回归覆盖失败、截断、只有标准错误包含表、工具调用对不上、重复结果和产物版本不一致。真实模型先用上轮第 2、4 组已展示检查点，重新配对执行文件状态交接版和展示回执版，两组交换执行顺序。正式实验使用六个新检查点，待展示与已展示各三组。每组冻结点在独立进程串行轮换运行完整历史、原精简、文件状态交接和展示回执，文件状态交接是直接基线。

| 指标 | 预定条件 |
|---|---|
| 正确性 | 六组四种恢复全部自然结束，独立复算五项产物，原始输入及质控文件字节一致，质控重写零次，待展示时先完整展示再分组 |
| 首次推进 | 回执版至少 5/6，两种状态各至少 2/3 |
| 额外调用 | 回执版相对文件状态交接和原精简的去重额外调用总量均减少 |
| 故障后交付 | 回执版相对三种对照的交付耗时配对中位数均下降 |
| 首轮输入 | 回执版相对完整历史的配对中位降幅至少 15%，业务和压缩分别对账，另列捕获成本 |

## 受控与复用检查点诊断

受控模型两种状态共 8/8 条交付自然结束并通过独立验收。回执版在待展示时首个调用完整输出质控表，已展示时首个调用写入分组产物。回执回归测试验证有效调用与原始结果字节的绑定，也验证过期或无效的展示不能生成回执。

真实模型诊断使用上轮两组已展示冻结点，两种恢复方式各 2/2 条交付自然结束并通过独立验收。两种方式首次推进都是 **0/2**，各有 **2 次**额外调用和重复整表输出。回执版平均总 Token 由 56,419.50 增至 66,628.50，交付耗时配对中位增加 65.398 秒。两种恢复各触发一次压缩。诊断首次自动汇总读取了该模式缺席的 `compact` 分支，四条交付的退出码均为零，修正汇总后对原始日志离线复核通过。诊断数据单列，正式验收使用新捕获的检查点。

## 正式真实模型验收

WSL 使用 `DeepSeek-V4.1-Flash-1017`。太阳能站点校准用例在质控产物落盘后冻结，六个检查点均首次捕获成功，待展示和已展示各三个。每个检查点派生四条续跑，共 **24/24** 条由模型自然结束并通过独立产物复算。原始输入和质控产物版本一致，续跑质控重写 **0 次**。153 个业务请求（含捕获 19 个）和 5 个压缩请求均完成对账。完整历史触发 3 次压缩，回执触发 2 次。

| 六组正式对照 | 完整历史 | 原精简 | 文件状态交接（直接基线） | 展示回执 |
|---|---:|---:|---:|---:|
| 首次调用推进 | 4/6 | 0/6 | 3/6 | 3/6 |
| 首轮输入 Token 均值 | 10,850.00 | 3,763.33 | 3,918.83 | 3,995.67 |
| 全请求输入 Token 均值 | 60,042.83 | 53,688.33 | 36,983.50 | 43,212.33 |
| 全请求输出 Token 均值 | 5,210.83 | 4,119.83 | 3,482.83 | 4,550.67 |
| 全请求总 Token 均值 | 65,253.67 | 57,808.17 | 40,466.33 | 47,763.00 |
| 去重额外调用合计 | 3 | 16 | 4 | 6 |
| 故障后交付耗时均值（秒） | 131.35 | 137.32 | 106.86 | 102.45 |
| 含捕获总 Token 均值 | 86,811.17 | 79,365.67 | 62,023.83 | 69,320.50 |
| 含捕获墙钟均值（秒） | 201.52 | 207.49 | 177.02 | 172.61 |

全请求用量计入续跑业务请求和压缩请求。含捕获指标把同组一次冻结的成本加到每条恢复路径，用于比较各路径的整体成本。首次调用在待展示状态以完整输出质控表为推进，在已展示状态以直接生成分组产物为推进。额外调用按工具调用 ID 去重，汇总分组前未推进的调用和重复整表输出。重复整表输出根据实际工具结果内容判定。

| 预登记门槛 | 正式结果 | 判定 |
|---|---|---|
| 交付正确性 | 六组四路全部通过，未重写质控产物 | 通过 |
| 首次推进至少 5/6，两种状态各至少 2/3 | 待展示 3/3，已展示 0/3。已展示三组均重复输出整表 | 未通过 |
| 相对文件状态交接和原精简均减少额外调用 | 文件状态交接 4→6，原精简 16→6 | 未通过 |
| 相对三种对照的故障后交付耗时配对中位数均下降 | 相对完整历史 −16.286 秒，相对原精简 −40.840 秒，相对文件状态交接 +10.453 秒 | 未通过 |
| 相对完整历史的首轮输入配对中位降幅至少 15% | 下降 61.16%，业务与压缩用量均已对账 | 通过 |

直接基线已经根据验证过的文件状态交接下一步，因此应以这列衡量回执的新增收益。回执续跑平均输入 Token **增加 16.84%**、输出 **增加 30.66%**、总量 **增加 18.03%**。交付耗时的算术均值下降 4.13%，逐组配对中位数增加 10.453 秒，六组各有三组更快、更慢。第三组的单对差值为 −105.174 秒，对均值影响较大。按预登记的配对口径，端到端提速未通过。相对完整历史和原精简的改善体现了精简恢复路径的效果，无法代表回执相对直接基线的收益。

**功能验收通过，第三阶段准入未通过。** 回执可以验证当前文件版本在冻结轨迹中已完整展示，但本轮真实模型仍在已展示状态重复展示。受控实验验证了回执生成和恢复分支的行为，真实模型的结果表明该提示不足以稳定改变下一次工具调用。代码保留为 benchmark 实验，仪器校准用例复验和第三阶段接入暂缓。

### 审计修正与原始证据

- 复用检查点诊断只有文件状态交接和回执两路。首次汇总读取了缺席的 `compact` 分支。修正诊断的对照集合后，原始四条交付全部通过。初版汇总仍保存在诊断目录的 `recovery-evidence-initial.md`。
- 正式第 5 组的原精简分支尝试调用不存在的 `stage2.py`，工作区在启动 shell 前拒绝，模型随后恢复并完成交付。审计器补上对这种结构化拒绝的校验，把该事件计为一次分组前无进展调用。修正前汇总仍保存在正式目录的 `recovery-evidence-before-preexecution-fix.md`。两处修正均使用既有日志离线复算，原始日志和模型输出保持原样。
- 正式日志按 `pair-1` 至 `pair-6` 分组，子目录 `capture`、`resume`、`compact`、`handoff`、`receipt` 包含 `runner.log`、`exit-code.txt` 和墙钟记录。续跑目录下的 `events.jsonl`、`turn-*.json` 和 `workspace` 保存工具轨迹、模型请求记录和交付产物。批处理退出码 0 表示脚本执行和正确性审计通过，准入判定见审计报告的 `Predeclared cross-workload gate FAIL`。

## WSL 复现

从仓库根目录运行。真实模型的包装脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 加载环境。使用新的日志目录。

```bash
b=test/benchmarks/research-spine-value-validation
pnpm exec tsx --test "$b/display-receipt.test.ts"
for state in pending displayed; do
  SCIENCE_SPINE_RECOVERY_RECEIPT=1 SCIENCE_SPINE_REPETITIONS=1 SCIENCE_SPINE_CONTROLLED_RECOVERY="$state" \
    SCIENCE_SPINE_LOG_DIR="$b/logs/display-receipt-controlled-$state-repro" pnpm exec tsx "$b/run-controlled.ts"
done
SCIENCE_SPINE_RECOVERY_RECEIPT=1 SCIENCE_SPINE_REPETITIONS=2 \
  SCIENCE_SPINE_RECEIPT_DIAGNOSTIC_SOURCE="$b/logs/workspace-handoff-20261125-live-r1" \
  SCIENCE_SPINE_LOG_DIR="$b/logs/display-receipt-diagnostic-repro" bash "$b/run-compact-recovery-wsl.sh"
SCIENCE_SPINE_RECOVERY_RECEIPT=1 SCIENCE_SPINE_REPETITIONS=6 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/display-receipt-live-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/display-receipt-live-repro" --display-receipt-recovery --expected-pairs 6
```

- [预诊断逐组审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/display-receipt-20261125-diagnostic-r1/recovery-evidence.md)
- [正式真实模型逐组审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/display-receipt-20261125-live-r1/recovery-evidence.md)
- [受控待展示审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/display-receipt-20261125-controlled-pending-r1/recovery-evidence.md)
- [受控已展示审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/display-receipt-20261125-controlled-displayed-r1/recovery-evidence.md)
