# 分组验收后退出原始工具证据 · 2026-11-25

## 方案与准入条件

在已展示质控表的检查点，保留一对真实 `run_shell` 调用与工具结果，协助模型完成技术分组。分组通过独立复算后，运行时复核分组产物及输入哈希，并在下一轮上下文组装和压缩之前成对移除这两条消息。冻结检查点保存可回放的原始记录。待展示状态沿用文件状态交接，完成完整展示后再分组。

- 受控 E2E 覆盖待展示、已展示和第一次分组产物无效后修复。损坏检查点须在模型调用前被拒绝。
- 真实模型诊断复用上轮第 2、4、6 组已展示检查点。三组轮换运行文件状态交接、持续保留证据、分组验收后退出证据。九条续跑均须自然结束并通过产物和上下文审计。候选至少 2/3 首次调用生成通过验收的分组产物，且分组后业务输入 Token 均值低于持续保留版。
- 诊断通过后，新捕获待展示和已展示各三个检查点，运行完整历史、原精简、文件状态交接和退出证据。正式门槛为 24 条自然完成且独立复算通过、质控重写零次、首次推进至少 5/6 且每种状态至少 2/3。候选的去重额外调用须低于文件状态交接和原精简，交付耗时的配对中位数须低于三种对照，相对完整历史的首轮输入配对中位降幅须至少 15%，全请求总 Token 均值不得高于文件状态交接。

## 受控验收和真实模型诊断

三种受控场景的 **12/12** 条续跑自然结束并通过独立产物复算。已展示故障组先写入无效 `groups.json`，验收器确认此时模型仍能看到原始工具证据。修复后的分组结果通过验收，下一轮模型输入移除了证据对。待展示组先展示整表，退出事件为零。篡改冻结点的质控表、注入未登记的分组文件，均触发快照校验失败，模型请求为零。第一次故障注入命令缺少 Projection 模式参数，在配置校验处终止。补齐参数后重新验证了两种输入。

`DeepSeek-V4.1-Flash-1017` 的诊断首次批次有一条候选续跑在首轮请求遇到 502，八次重试后退出，尚未调用工具。第一次批次启动后修改脚本导致批末 Bash 解析失败，各续跑的退出码和原始日志均已写入。使用独立审计器补算首次批次，两组通过，一组因上述 502 失败。第二次批次使用相同冻结点重跑受影响的整组，另外两组沿用原始日志。对恢复后的完整样本执行审计，**9/9** 条续跑自然结束并通过验收，质控重写零次。续跑包含 48 个业务请求，压缩请求为零，复用的捕获另有 10 个业务请求。

| 三组已展示诊断 | 文件状态交接 | 持续保留证据 | 分组验收后退出 |
|---|---:|---:|---:|
| 首次调用生成通过验收的分组 | 0/3 | 3/3 | **3/3** |
| 去重额外调用 | 8 | 0 | 0 |
| 首轮输入 Token 均值 | 3,958.67 | 6,871.33 | 6,871.33 |
| 分组后业务输入 Token 均值 | 31,975.67 | 27,410.00 | **25,182.67** |
| 全请求输入 Token 均值 | 49,860.33 | 34,281.33 | 32,054.00 |
| 全请求输出 Token 均值 | 3,487.67 | 3,049.00 | 3,082.33 |
| 全请求总 Token 均值 | 53,348.00 | 37,330.33 | 35,136.33 |
| 故障后交付耗时均值（秒） | 149.28 | 84.23 | 119.68 |

相对持续保留版，分组后业务输入均值少 2,227.33 Token（**−8.13%**），全请求总 Token 均值下降 **5.88%**，但交付耗时均值增加 **42.09%**。相对文件状态交接，候选交付耗时配对中位数缩短 **28.196 秒**。诊断通过预登记的首次分组和分组后输入成本条件。

## 正式真实模型对照结果

在 WSL 用 `DeepSeek-V4.1-Flash-1017` 捕获六个新检查点，待展示和已展示各三个。每组四条续跑从同一个冻结点在不同进程启动，按预先确定的顺序串行执行。完整历史恢复（`resume`）保留冻结轨迹，原精简（`compact`）发送紧凑恢复状态，文件状态交接（`handoff`）发送已验收文件及下一步操作，是本轮直接基线。退出版（`retire-display`）在此基础上为已展示组带入一对已验真的原始工具消息，首次通过分组验收后退出。

**24/24 条续跑自然结束并通过独立产物复算，预登记收益准入未通过。** 续跑质控重写为 0。已展示三组均在首个工具调用生成通过验收的分组。上下文轨迹确认三对历史证据在分组通过后的下一轮全部退出。待展示三组与直接基线的首轮模型输入完全一致，均在首个工具调用展示全表，历史证据退出事件为零。

| 六组正式续跑指标 | 完整历史 | 原精简 | 文件状态交接 | 分组验收后退出 |
|---|---:|---:|---:|---:|
| 自然结束且产物独立复算通过 | 6/6 | 6/6 | 6/6 | 6/6 |
| 首次推进（待展示 / 已展示） | 5/6（3/3、2/3） | 0/6（0/3、0/3） | 3/6（3/3、0/3） | **6/6（3/3、3/3）** |
| 去重额外调用总数 | 1 | 18 | 7 | **4** |
| 重复输出整张质控表总数 | 0 | 3 | 3 | **1** |
| 首轮输入 Token 均值 | 9,393.00 | 3,762.00 | 3,917.50 | 5,360.17 |
| 全请求输入 Token 均值 | 41,436.00 | 54,235.33 | 44,513.33 | **32,414.67** |
| 全请求输出 Token 均值 | 3,162.17 | 3,828.83 | 3,188.00 | **2,874.33** |
| 全请求总 Token 均值 | 44,598.17 | 58,064.17 | 47,701.33 | **35,289.00** |
| 分组后业务输入 Token 均值 | 26,697.50 | 33,694.00 | 31,048.50 | **23,582.83** |
| 交付耗时均值（秒） | 81.87 | 138.46 | 104.51 | 83.64 |
| 退出版减去对应对照的交付耗时配对中位数（秒） | **+3.441** | −59.478 | −13.657 | — |

首次推进要求待展示状态完成整表展示，已展示状态写出经复算合格的分组。额外调用合计对分组前未推进的调用和重复输出整表的调用按调用 ID 去重。耗时从续跑进程启动计至交付，覆盖检查点校验和工作区准备。配对差对同一检查点的候选与对照先相减，再取六组中位数。Token 取供应商 `usage`，全请求包含实际发出的业务和压缩请求。

相对同批文件状态交接，退出版的首轮输入均值增加 **36.83%**，全程输入、输出、总 Token 均值分别减少 **27.18%、9.84%、26.02%**，分组后业务输入减少 **24.05%**。总 Token 每次续跑平均少 **12,412.33**，六组有五组总量下降。正式批次衡量退出版相对文件状态交接的整套改动。只有诊断批次在同一检查点同时运行了持续保留版，可直接比较退出证据这一步。

| 检查点 | 状态 | 退出版与文件状态交接的总 Token 差 | 交付耗时差 vs 文件状态交接（秒） | 交付耗时差 vs 完整历史（秒） |
|---|---|---:|---:|---:|
| 1 | 待展示 | +9,014 | −13.507 | +42.790 |
| 2 | 已展示 | −9,115 | −29.938 | −4.387 |
| 3 | 待展示 | −11,367 | −10.765 | −20.026 |
| 4 | 已展示 | −29,273 | −13.808 | −52.839 |
| 5 | 待展示 | −477 | +38.048 | +33.819 |
| 6 | 已展示 | −33,256 | −95.217 | +11.270 |

对账覆盖 20 个检查点捕获业务请求和 126 个续跑业务请求，续跑四组分别为 24、40、34、28 个。成功批次的压缩请求和模型重试均为 0。第 5 组首次捕获提前展示了质控表，违背该组的待展示状态，包装器在启动任何续跑前按既有规则归档并重试。归档尝试耗时 66.058 秒，产生 3 个业务请求和 29,700 Token，单列为实验捕获开销。该组四条续跑共用第二次捕获的检查点。 [第 5 组首次捕获日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-live-r1/pair-5/capture-attempts/attempt-1/runner.log)

| 预登记门槛 | 实测 | 判定 |
|---|---|---|
| 24/24 自然完成且独立复算通过，质控重写为 0 | 24/24，重写 0 次 | 通过 |
| 首次推进至少 5/6，每种状态至少 2/3 | 6/6，两种状态各 3/3 | 通过 |
| 去重额外调用低于文件状态交接和原精简 | 7、18 降至 4 | 通过 |
| 交付耗时配对中位数低于三种对照 | 相对文件状态交接 −13.657 秒，原精简 −59.478 秒，完整历史 **+3.441 秒** | **未通过** |
| 相对完整历史的首轮输入配对中位降幅至少 15% | 降低 34.12% | 通过 |
| 全请求总 Token 均值不高于文件状态交接 | 降低 26.02% | 通过 |

交付耗时的差异随检查点状态变化。已展示组相对文件状态交接首次分组从 0/3 到 3/3，总 Token 下降 41.90%，交付配对中位快 29.938 秒。相对完整历史，已展示组快 4.387 秒，待展示组慢 33.819 秒。六组里退出版累计执行 28 个业务请求，完整历史执行 24 个。业务模型耗时配对中位增加 4.015 秒，和整段交付耗时方向一致。每种状态只有三个样本，这些结果适合定位下一轮假设，无法单独确定时延差异的成因。

本轮继续保留第二阶段实验开关，仪器校准复验和第三阶段正式运行时接入暂缓。若继续验证，优先冻结按检查点状态选择恢复方式的候选，用新样本检验待展示沿用完整历史、已展示采用证据退出时，能否同时保住成本收益与交付耗时。当前分组结果用于提出假设，正式准入沿用预登记的整批门槛。

## 日志索引

- [诊断首次批次逐组审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-diagnostic-r1/recovery-evidence.md)
- [补跑后的完整诊断审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-diagnostic-r2/recovery-evidence.md)
- [受控已展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-controlled-displayed-r1/recovery-evidence.md) · [受控待展示](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-controlled-pending-r1/recovery-evidence.md) · [无效分组后修复](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-controlled-fault-r1/recovery-evidence.md) · [检查点篡改验收](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-negative-r2)
- [正式实验逐组审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-live-r1/recovery-evidence.md) · [正式实验原始日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/retire-display-20261125-live-r1)

每组分支记录 `runner.log`、`exit-code.txt`、`wall-seconds.txt`。子目录包含原始 `events.jsonl`、模型上下文 `turn-*.json` 和工作区产物。

## WSL 复现

从仓库根目录执行，使用新日志目录。真实模型包装脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 加载模型配置。

```bash
b=test/benchmarks/research-spine-value-validation
pnpm exec tsx --test "$b/display-receipt.test.ts"
python3 -m unittest discover -s "$b" -p test_recovery_progress.py
for state in displayed pending; do
  SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY=1 SCIENCE_SPINE_REPETITIONS=1 \
    SCIENCE_SPINE_CONTROLLED_RECOVERY="$state" SCIENCE_SPINE_LOG_DIR="$b/logs/retire-display-controlled-$state-repro" \
    pnpm exec tsx "$b/run-controlled.ts"
done
SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY=1 SCIENCE_SPINE_REPETITIONS=1 \
  SCIENCE_SPINE_CONTROLLED_GROUPING_FAULT=1 SCIENCE_SPINE_CONTROLLED_RECOVERY=displayed \
  SCIENCE_SPINE_LOG_DIR="$b/logs/retire-display-controlled-fault-repro" pnpm exec tsx "$b/run-controlled.ts"
SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY=1 SCIENCE_SPINE_REPETITIONS=3 \
  SCIENCE_SPINE_RETIRE_DISPLAY_DIAGNOSTIC_SOURCE="$b/logs/evidence-20261125-live-r1" \
  SCIENCE_SPINE_LOG_DIR="$b/logs/retire-display-diagnostic-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/retire-display-diagnostic-repro" --retire-display-diagnostic --expected-pairs 3
```

诊断通过后运行正式实验。

```bash
SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY=1 SCIENCE_SPINE_REPETITIONS=6 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/retire-display-live-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/retire-display-live-repro" --retire-display-recovery --expected-pairs 6
```
