# 断点恢复的原始工具证据保留验收 · 2026-11-25

## 改动与实验假设

上轮三个已展示检查点中，完整历史在首轮带入了完整质控表的真实工具响应，首次调用推进 2/3。文件状态交接和展示回执的首轮没有原始工具结果，两组均为 0/3。完整历史还含其他消息，因此先测量单独保留一对工具消息的效果。

证据版通过检查点完整性和质控产物验收后，从冻结轨迹中找到确实完整展示当前质控表的 `run_shell` 调用和结果。SHA-256 绑定产物版本和原始工具返回。首轮模型输入在直接基线的工作区交接文本之前多一对消息，只携带匹配的工具调用对象和对应原始结果。已完成的调用作为历史上下文，由模型执行分组、敏感性分析和最终报告。待展示状态的首轮输入与直接基线一致。独立审计从源检查点重建证据，逐项核对首轮系统提示、工具定义、任务说明和被保留的消息。

## 验收设计

- 受控 E2E 分别验证已展示和待展示，每种状态四条自然完成的续跑。通过独立复算及首轮输入审计。
- 真实模型诊断复用上一轮正式第 2、4、6 组的已展示检查点。文件状态交接为直接基线，候选为原始证据保留，串行配对并交替执行顺序。六条续跑全部自然结束且产物通过独立复算，候选版至少 2/3 首次直接分组，重复整表输出合计少于同批直接基线，即可进入正式实验。
- 正式真实模型对照新捕获六个检查点，待展示和已展示各三个。每组运行完整历史、原精简、文件状态交接和证据保留。24 条续跑均自然结束并通过验收，质控重写零次。候选首次推进至少 5/6 且每状态至少 2/3，相对文件状态交接和原精简均减少去重额外调用，相对三种对照的故障后交付耗时配对中位均下降，相对完整历史的首轮输入配对中位降幅至少 15%。同时核对相对直接基线的总 Token，含压缩的均值不得增加。所有条件达成后进入仪器校准复验。

## 受控 E2E 与三组真实模型诊断

受控实验的已展示和待展示状态各 4/4 条续跑自然完成。候选在待展示状态首个工具调用完成完整展示，在已展示状态首个调用生成分组产物。两种状态均通过独立产物复算与恢复首轮输入审计。三个 TypeScript 单元测试、六个 Python 审计回归、严格 TypeScript 检查和 shell 语法检查通过。

真实诊断使用 `DeepSeek-V4.1-Flash-1017`。复用的三个捕获目录与来源逐文件一致。两组各 3/3 条续跑自然完成，独立审计确认质控重写零次。续跑对账包含 29 个业务请求，压缩请求 0 个。历史捕获另外对账 8 个业务请求。

| 三组已展示检查点 | 文件状态交接 | 证据保留 | 变化 |
|---|---:|---:|---:|
| 首次调用生成分组 | 1/3 | 3/3 | +2 组 |
| 重复整表输出 | 2 | 1 | −1 次 |
| 去重额外调用合计 | 4 | 1 | −3 次 |
| 首轮输入 Token 均值 | 3,956.00 | 7,117.00 | +79.90% |
| 全请求输入 Token 均值 | 37,203.67 | 33,951.00 | −8.74% |
| 全请求输出 Token 均值 | 3,478.33 | 3,600.00 | +3.50% |
| 全请求总 Token 均值 | 40,682.00 | 37,551.00 | −7.70% |
| 故障后交付耗时均值（秒） | 92.38 | 80.12 | −13.28% |

三组耗时差值分别为 +26.495、−41.217、−22.069 秒，配对中位为 **−22.069 秒**。诊断门槛通过。第 3 组候选在首个调用同时完成分组和重复输出整表。初版逐组表只显示了该次调用的展示效果。修正标签后，分组与重复输出同时显示，原始事件、指标数值和准入结果保持一致。初版审计保存在诊断目录的 `recovery-evidence-before-combined-label.md`。

## 六组正式真实模型对照

`DeepSeek-V4.1-Flash-1017` 的六个新检查点均一次捕获成功，待展示与已展示各三个。四路共 **24/24** 条续跑由模型自然结束，均通过独立产物复算、质控展示顺序、首轮输入和用量审计。续跑质控产物重写 **0 次**。模型请求对账覆盖 148 个业务请求（其中捕获 20 个）和 4 个压缩请求（完整历史 3 个、证据保留 1 个）。运行没有请求重试。

| 六组正式对照 | 完整历史 | 原精简 | 文件状态交接（直接基线） | 证据保留 |
|---|---:|---:|---:|---:|
| 首次调用推进 | 2/6 | 0/6 | 3/6 | **6/6** |
| 重复整表输出次数 | 1 | 4 | 3 | **1** |
| 去重额外调用合计 | 4 | 15 | 6 | **2** |
| 首轮输入 Token 均值 | 12,176.50 | 3,763.33 | 3,918.83 | 5,375.17 |
| 全请求输入 Token 均值 | 58,340.33 | 46,872.50 | 37,285.50 | 40,301.17 |
| 全请求输出 Token 均值 | 5,249.50 | 3,079.00 | 3,248.50 | 3,935.00 |
| 全请求总 Token 均值 | 63,589.83 | 49,951.50 | 40,534.00 | 44,236.17 |
| 故障后首次有效推进耗时均值（秒） | 42.01 | 46.96 | 36.88 | 32.85 |
| 故障后交付耗时均值（秒） | 119.61 | 96.44 | 90.62 | 118.38 |
| 含捕获总 Token 均值 | 91,439.67 | 77,801.33 | 68,383.83 | 72,086.00 |
| 含捕获墙钟均值（秒） | 188.37 | 165.19 | 159.37 | 187.14 |

全请求 Token 包含业务请求与压缩请求。含捕获口径将同组冻结成本加到每条恢复路径。首次调用推进按工作状态判定，待展示须输出当前完整质控表，已展示须成功写入分组产物。已展示时重复打印完整表仍计入额外调用。相对直接基线，证据版平均输入 Token **+8.09%**、输出 **+21.13%**、总 Token **+9.13%**。故障后交付耗时均值 **+30.64%**，配对中位 **+16.491 秒**。

| 对照组的冻结状态 | 证据版相对直接基线总 Token 差值 | 证据版相对直接基线交付耗时差值（秒） |
|---|---:|---:|
| 1 · 待展示 | −15,897 | +2.536 |
| 2 · 已展示 | +8,958 | +63.742 |
| 3 · 待展示 | −4,618 | +22.519 |
| 4 · 已展示 | −131 | −7.447 |
| 5 · 待展示 | −350 | +10.463 |
| 6 · 已展示 | +34,251 | +74.767 |

在实际带入原始证据的三组「已展示」检查点，首次调用直接分组由 **0/3 升至 3/3**，首次推进耗时配对中位缩短 **16.193 秒**。这三组的平均总 Token 升高 **36.27%**，交付耗时配对中位增加 **63.742 秒**。第 6 组在分组后仍重复输出了一次整表，且触发一次压缩，消耗 12,670 个 Token。即使只计该组业务请求，候选仍比直接基线多 21,581 个 Token。待展示三组的首轮输入一致，其中的后续差异只能作为同一恢复策略自然运行的波动观察。

| 预登记门槛 | 实际结果 | 判定 |
|---|---|---|
| 24 条均通过自然完成与产物审计，质控重写 0 | 24/24，重写 0 | 通过 |
| 首次推进至少 5/6，每种状态至少 2/3 | 6/6，待展示与已展示各 3/3 | 通过 |
| 相对直接基线和原精简均减少额外调用 | 分别从 6 和 15 次减至 2 次 | 通过 |
| 相对三种对照的交付耗时配对中位均下降 | 相对完整历史 −8.559 秒，原精简 +13.980 秒，直接基线 +16.491 秒 | 未通过 |
| 相对完整历史的首轮输入配对中位降幅至少 15% | 降低 55.38% | 通过 |
| 相对直接基线的全请求总 Token 均值不得增加 | 增加 9.13% | 未通过 |

**功能、首次推进和额外调用验收通过，端到端收益准入未通过。** 保留原始证据让已展示状态更早开始有效计算，同时增加了本批次的整段续跑成本。诊断中的总 Token 和交付耗时收益没有在正式批次复现。按阶段条件，仪器校准复验和第三阶段正式运行时接入暂缓，证据版保留为基准实验。

## 原始日志

- [受控待展示审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/evidence-20261125-controlled-pending-r1/recovery-evidence.md)
- [受控已展示审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/evidence-20261125-controlled-displayed-r1/recovery-evidence.md)
- [真实模型诊断逐组审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/evidence-20261125-diagnostic-r1/recovery-evidence.md)
- [正式真实模型日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/evidence-20261125-live-r1)

每组下的 `capture`、`resume`、`compact`、`handoff`、`evidence` 目录记录实际运行的分支。`runner.log`、`exit-code.txt` 和 `wall-seconds.txt` 在分支目录内。更深一层的 `events.jsonl`、`turn-*.json`、`workspace` 保存原始事件、模型可见上下文记录和交付产物。

## WSL 复现

从仓库根目录运行。真实模型环境由包装脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 读取。每次使用新的日志目录。

```bash
b=test/benchmarks/research-spine-value-validation
pnpm exec tsx --test "$b/display-receipt.test.ts"
python3 -m unittest discover -s "$b" -p test_recovery_progress.py
for state in displayed pending; do
  SCIENCE_SPINE_RECOVERY_EVIDENCE=1 SCIENCE_SPINE_REPETITIONS=1 \
    SCIENCE_SPINE_CONTROLLED_RECOVERY="$state" SCIENCE_SPINE_LOG_DIR="$b/logs/evidence-controlled-$state-repro" \
    pnpm exec tsx "$b/run-controlled.ts"
done
SCIENCE_SPINE_RECOVERY_EVIDENCE=1 SCIENCE_SPINE_REPETITIONS=3 \
  SCIENCE_SPINE_EVIDENCE_DIAGNOSTIC_SOURCE="$b/logs/display-receipt-20261125-live-r1" \
  SCIENCE_SPINE_LOG_DIR="$b/logs/evidence-diagnostic-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/evidence-diagnostic-repro" --evidence-diagnostic --expected-pairs 3
```

诊断通过后，使用以下命令运行正式实验。

```bash
SCIENCE_SPINE_RECOVERY_EVIDENCE=1 SCIENCE_SPINE_REPETITIONS=6 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/evidence-live-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/evidence-live-repro" --display-evidence-recovery --expected-pairs 6
```
