# 按检查点状态恢复验收 · 2026-11-25

## 开跑前约定

待展示检查点使用完整历史。已展示且工具调用和结果能与当前质控表版本绑定时，保留这一对原始工具消息，下游产物独立复算并校验版本后在下一轮成对退出。证据无法绑定但检查点完整时回退完整历史，检查点文件或历史哈希不符时拒绝恢复。

- 光伏从质控检查点续跑，证据保留到 `groups.json` 验收。仪器校准从清洗检查点续跑，证据保留到 `fits.json` 验收。两者均复用现有数据和工作流验收器。
- 受控 E2E 覆盖待展示、已展示、下游首次校验失败后修复和展示证据失配回退。损坏检查点须在首次模型请求前被拒绝。
- 每个真实模型批次使用六个新的冻结点，待展示与已展示各三个。从同一冻结点串行启动完整历史和按状态恢复两条续跑，并交替调整先后顺序。正式批次要求 12/12 自然结束且独立复算，已通过验收的质控文件重写为零。对账覆盖全部业务及压缩请求。
- 收益条件为整批平均总 Token 低于完整历史，并审计两种状态的路由、首次有效推进和额外调用。记录每组交付耗时秒差、倍率、模型请求耗时和轮次。将 **1.8 倍及以上**作为接近两倍的复跑触发值。触发后从相同冻结点逆序复跑整对，保留首次值。复跑仍达 1.8 倍或无法完成复跑审计时，时延项暂缓通过。
- 捕获未匹配指定状态时可重试，归档未使用的捕获。首次请求 502 且未执行工具时可补跑整对。捕获重试、传输补跑和耗时复核均单列，不替换已完成的正式样本。

## 受控端到端验收

光伏和仪器校准均完成四组受控场景，每组两条续跑，合计 **16/16** 自然结束并通过独立复算。待展示和证据失配均走完整历史，首轮模型输入与基线完全一致。已展示组带入经过验证的证据对。故障注入组先写入无效的分组或拟合产物，修复期间证据持续可见，独立验收通过后的下一轮成对退出。两个工作流各在控制场景中损坏了一次已冻结的质控表，两次均在请求模型前拒绝恢复。

| 工作流 | 待展示 | 已展示 | 无效产物后修复 | 证据失配与坏检查点 |
|---|---|---|---|---|
| 光伏 | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-solar-pending-r1) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-solar-displayed-r1) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-solar-repair-r1) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-solar-fallback-r1) |
| 仪器校准 | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-calibration-review-pending-r3) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-calibration-review-displayed-r3) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-calibration-review-repair-r3) | [日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-ctl-calibration-review-fallback-r3) |

## 光伏正式真实模型对照

WSL 上使用 `DeepSeek-V4.1-Flash-1017`。**12/12** 条续跑自然结束并通过独立复算，质控重写为零。待展示三组的首轮输入与完整历史一致，已展示三组均在独立分组验收后退出证据。成功捕获和续跑共对账 71 个业务请求，压缩、模型重试、捕获重试均为零。

| 六组平均或合计 | 完整历史 | 按状态恢复 | 差异 |
|---|---:|---:|---:|
| 首轮输入 Token 均值 | 12,115.83 | 7,912.83 | −34.69% |
| 全请求输入 Token 均值 | 46,778.67 | 40,952.17 | −12.46% |
| 全请求输出 Token 均值 | 3,421.33 | 3,928.17 | +14.81% |
| 全请求总 Token 均值 | 50,200.00 | 44,880.33 | **−10.60%** |
| 已展示组总 Token 均值 | 49,171.33 | 37,617.00 | **−23.50%** |
| 首次工具调用即推进 | 5/6 | 6/6 | +1 组 |
| 去重额外调用 | 1 | 0 | −1 次 |

候选的交付耗时配对中位差为 **−5.354 秒**，配对倍率中位为 **0.920×**。最大倍率 **1.542×**，发生在首轮输入完全相同的待展示第 5 组。交付耗时差 37.603 秒中，累计模型业务请求耗时差为 36.805 秒。两条续跑均发出四次业务请求。本批没有触发 1.8 倍复跑线，光伏准入通过。 [正式逐组审计及原始日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-live-solar-r1/recovery-evidence.md)

## 仪器校准首次对照与失败分析

首批在第 1 组暴露了一个工作流契约问题。完整历史分支在拟合前输出了带行号的 CSV，拟合、漂移判断和报告完成后才按反馈原样展示清洗表。两条续跑生成的产物均正确，完整历史分支违反了拟合前原样展示的顺序。确认后结束首批，保留已产生的原始日志。校准流程明确指定独立调用 `cat cleaned.csv` 后，从六个新冻结点重跑。 [首批审计](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-live-calibration-review-r1/recovery-evidence.md)

第二批 **12/12** 条续跑自然结束并通过独立复算，质控重写为零。完整历史和候选的平均总 Token 为 **43,102.00 → 38,994.83（−9.53%）**，已展示组三组下降 **18.14%**，整批交付耗时配对中位差为 **+6.630 秒**。第 4 组的完整历史与候选耗时为 **43.561 → 89.024 秒（2.044×）**。逆序复跑结果为 **45.090 → 87.538 秒（1.941×）**，两条复跑均通过正确性审计。两次候选都先检查工作区、重复展示清洗表，模型轮次从 4 增至 6。第二批通过正确性和成本验收，未通过耗时门槛。该批第 3 组首次捕获提前展示了清洗表，按状态校验规则归档并重试。归档尝试耗时 30.831 秒，涉及 2 个业务请求和 11,423 Token。 [第二批审计与逆序复跑记录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-live-calibration-review-r2/recovery-evidence.md)

第三批把校准的已展示恢复提示改为经验证的工作区交接。它携带清洗产物的相对路径、哈希、已完成展示状态和下一步拟合操作，模型可在拟合或报告的工具调用中直接读取所需文件。工作区复制后再次复核产物哈希，审计工具独立比对发送给模型的交接记录。继续使用六个新冻结点和相同的功能、成本、耗时门槛。

## 仪器校准最终真实模型对照

第三批 **12/12** 条续跑自然结束并通过独立复算，质控重写为零。待展示三组的首轮输入与完整历史一致。已展示三组的候选均直接产出符合要求的拟合，在验收后的下一轮退出证据。成功捕获 21 个业务请求，两条恢复路径合计 61 个业务请求。完整历史有 2 个压缩请求，候选为 0。全部请求参与用量对账，正式续跑没有模型重试。

| 六组平均或合计 | 完整历史 | 按状态恢复 | 差异 |
|---|---:|---:|---:|
| 首轮输入 Token 均值 | 7,786.00 | 5,983.50 | −23.15% |
| 全请求输入 Token 均值 | 53,964.50 | 35,799.33 | −33.66% |
| 全请求输出 Token 均值 | 3,820.67 | 2,385.33 | −37.57% |
| 全请求总 Token 均值 | 57,785.17 | 38,184.67 | **−33.92%** |
| 已展示组总 Token 均值 | 63,784.33 | 24,135.00 | **−62.16%** |
| 首次工具调用即推进 | 5/6 | 6/6 | +1 组 |
| 去重额外调用 | 1 | 0 | −1 次 |

候选交付耗时配对中位差为 **−11.954 秒**，配对倍率中位为 **0.826×**，最大倍率为 **1.253×**。最大倍率出现在本批第 4 组，耗时为 65.368 → 81.904 秒。两条续跑分别发出 5 个业务加 1 个压缩请求和 4 个业务请求。没有触发 1.8 倍复跑线。上一批第 4 组的 2.044× 和复跑的 1.941× 属于上一实现，第三批从新冻结点验证了工作区交接版。每批每种状态只有三组，结论覆盖当前任务与模型配置。 [最终批逐组审计及原始日志](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/state-20261125-live-calibration-review-r3/recovery-evidence.md)

第 3、5 组各有两次首次冻结状态不符的捕获尝试，原始日志归档在对应组的 `capture-attempts`。四次归档尝试合计 116.688 秒、8 个业务请求、46,009 Token，单列为测试捕获开销。每组两条正式续跑均复用当组最终通过验收的冻结点。

## 第三阶段启动判定

**三个前置任务完成，第三阶段正式运行时接入的启动条件已达到。** 按状态恢复通过 16 条受控续跑。光伏与校准的最终真实对照共 **24/24** 条续跑自然交付且复算通过，两批均满足成本、分状态路由与大幅时延回归门槛。运行时接入和内部开放仍需经过正式入口的跨进程恢复、幂等、故障注入、回退和开关验收。

## WSL 复现

从仓库根目录执行，选择新的日志目录。真实模型包装脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 加载配置。

```bash
b=test/benchmarks/research-spine-value-validation
for case in solar calibration-review; do
  SCIENCE_SPINE_CASE="$case" SCIENCE_SPINE_REPETITIONS=6 \
    SCIENCE_SPINE_LOG_DIR="$b/logs/state-live-$case-repro" bash "$b/run-state-recovery-wsl.sh"
  audit_options=()
  if [[ "$case" == calibration-review ]]; then audit_options+=(--require-calibration-handoff); fi
  python3 "$b/report-state-recovery.py" "$b/logs/state-live-$case-repro" --workload "$case" --pairs 6 "${audit_options[@]}"
done
```

每组的 `capture`、`full` 和 `by-state` 目录记录启动时间、退出码、耗时、原始模型日志、上下文轨迹和产物。`recovery-evidence.md` 从这些文件复算功能和收益两项判定。它打印的 `Advancement gate` 表示该工作流的收益准入，审计进程退出码表示正确性审计是否成功。
