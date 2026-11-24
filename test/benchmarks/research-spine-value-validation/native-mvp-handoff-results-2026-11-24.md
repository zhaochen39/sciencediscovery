# Native MVP 阶段记忆交接验收 · 2026-11-24

**功能验收通过，续跑成本验收未通过。** 四组真实模型三方对照共 12 次续跑，全部自然结束，五项产物通过独立验收，42/42 轮供应商 usage 与汇总对账。交接版较现版 Projection 首轮输入平均下降 **15.53%**，续跑总 Token 平均下降 **3.13%**，同时平均模型轮次从 3.00 增至 3.50，工具调用从 2.00 增至 2.75。按本轮准入条件，交接版保留为基准测试的实验模式，本轮止于冻结前缀对照。

## 改动与对照

`projection` 使用现有阶段投影，`projection-linked` 增加跨调用独立读出的证据绑定，`projection-handoff` 在相同绑定上增加工作流提供的阶段记忆。灵感来自 SpineCodex 对闭合节点记忆与活动任务的区分。光伏工作流从独立核验过的当前版本产物提取站点完整性口径、按技术分类的缺测站点数、已验收的分组值和下一步操作提示。模型输入中的事实跟随对应产物及版本。前序产物改变会使依赖其版本的闭合证据失效，成本门控仍根据完整候选记忆计算。实验代码通过 benchmark 显式模式启用。

真实模型为 `DeepSeek-V4.1-Flash-1017`。每组在同一工作区、历史和继续执行提示上分叉，阶段记忆是第一条模型请求的唯一差异。保持至少 1,500 估算 Token、至少 10% 的投影门槛及最近两条消息保护。独立审核首轮请求的工具、系统提示、未替换历史、读出 SHA-256、派生内容和冻结文件字节。验收使用原始 fixture 复算清洗结果、完整质控表、分组、敏感性数值，并检查报告产物引用和两条排名结论。调用预算允许模型修复后自然结束。三种模式按组轮换顺序。统计续跑 Token 时排除共享前缀的生成费用。

- 第 1、2 组复用上一轮受约束生成的检查点。质控和分组已经通过验收，仍待敏感性分析和报告。
- 第 3、4 组提取自之前自然完成的真实轨迹 `01-projection-linked-940e4383`。选在原轨迹同时生成分组和敏感性结果的工具返回之后、写报告之前。冻结脚本核对独立表的证据摘要、原输入与质控文件版本，以及输出中打印的两份 JSON 与复制文件的内容。保留原历史前十条消息及当时已有的辅助脚本。原轨迹将两个统计产物写入同一调用，只有质控阶段有可投影的独立证据。后续还需写报告和完成验收。

## 真实模型逐组结果

下表的 Token、轮次和调用均从冻结检查点开始计算。所有 12 条续跑的第一请求审计、自然结束、五项产物验收、完整质控表版本和供应商 usage 对账均通过。现版 Projection 首轮实际替换 0 个结果。跨调用版和交接版各在 4/4 个首轮替换 1 个独立读出，并分别在 16/16 和 14/14 个续跑轮次实际采用投影。

| 组别 | 模式 | 首轮输入 | 续跑输入 | 续跑输出 | 续跑总 Token | 模型轮次 | 工具调用 |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 · 待敏感性 | Projection | 16,122 | 43,985 | 2,154 | 46,139 | 3 | 2 |
| 1 | Projection-linked | 14,024 | 38,109 | 1,866 | 39,975 | 3 | 3 |
| 1 | Projection-handoff | 14,123 | 39,043 | 2,472 | 41,515 | 3 | 3 |
| 2 · 待敏感性 | Projection | 16,122 | 54,377 | 2,297 | 56,674 | 4 | 3 |
| 2 | Projection-linked | 14,024 | 72,251 | 3,251 | 75,502 | 6 | 5 |
| 2 | Projection-handoff | 14,123 | 37,878 | 2,290 | 40,168 | 3 | 2 |
| 3 · 待报告 | Projection | 9,622 | 31,990 | 2,571 | 34,561 | 3 | 2 |
| 3 | Projection-linked | 7,521 | 26,056 | 2,615 | 28,671 | 3 | 2 |
| 3 | Projection-handoff | 7,623 | 44,812 | 2,391 | 47,203 | 5 | 4 |
| 4 · 待报告 | Projection | 9,622 | 21,038 | 2,241 | 23,279 | 2 | 1 |
| 4 | Projection-linked | 7,521 | 39,568 | 3,124 | 42,692 | 4 | 3 |
| 4 | Projection-handoff | 7,623 | 25,089 | 1,644 | 26,733 | 3 | 2 |

| 平均指标 | Projection | Projection-linked | Projection-handoff | 交接版较现版 | 交接版较跨调用版 |
|---|---:|---:|---:|---:|---:|
| 首轮输入 Token | 12,872.00 | 10,772.50 | 10,873.00 | −15.53% | +0.93% |
| 续跑输入 Token | 37,847.50 | 43,996.00 | 36,705.50 | −3.02% | −16.57% |
| 续跑输出 Token | 2,315.75 | 2,714.00 | 2,199.25 | −5.03% | −18.97% |
| 续跑总 Token | 40,163.25 | 46,710.00 | 38,904.75 | −3.13% | −16.71% |
| 模型轮次 | 3.00 | 4.00 | 3.50 | +0.50 | −0.50 |
| 工具调用 | 2.00 | 3.25 | 2.75 | +0.75 | −0.50 |

## 轨迹归因与验收判定

- **待敏感性检查点。** 交接版平均续跑 40,841.50 Token，较现版 Projection 下降 **20.55%**，较跨调用版下降 **29.26%**。第 2 组跨调用版先检查工作区和分组，又单独计算质控统计、修改报告。交接版直接计算敏感性并写报告，共 2 次工具调用，跨调用版用了 5 次。第 1 组交接版仍先读 `groups.json`，并比跨调用版多用 1,540 Token。按任务要求读取 `site_qc.csv` 进行敏感性计算属于必要工作。
- **待报告检查点。** 交接版平均续跑 36,968 Token，较现版 Projection 增加 **27.83%**，较跨调用版增加 **3.61%**。第 3 组交接版重读分组和敏感性文件，随后额外写了校验脚本。首次校验自设的误差为 `1e-9`，触发断言失败。模型改为 `1e-6` 后完成验证并自然结束。第 4 组交接版先检查文件并汇总，再写报告。现版把写报告和检查放在一次工具调用中完成。
- 四组中交接版相对现版有两组节省总 Token，两组增加。每个检查点只有两次重复。报告阶段的额外检查和误差重试说明本轮无法把续跑成本差归因到某个遗漏字段。准入条件要求保住首轮收益，降低续跑总 Token，模型轮次和工具调用均至多持平，且全部自然通过。模型轮次和工具调用未满足准入条件。当前数据也未测量该版本从零运行时的自然命中率或低并发尾延迟。

## 受控回归

受控 E2E 28/28 自然结束并通过产物验收，Context 回归 59/59，仓库测试类型检查通过。受控脚本模型覆盖单独完整读出、改写产物版本、混合输出、重复读出、分段输出、补做完整表、增强记忆超出成本门槛七个场景。初次按 1,500 估算 Token 运行 split 时四组都完成端到端，断言因交接版门控预期有误而失败。候选实际估算只节省 1,474–1,482 Token。保留该批记录，并在受控测试用 1,400 覆盖模型实际收到交接字段的路径，用 1,500 单独断言交接版回退。两轮真实模型对照及自然报告阶段对照均使用 1,500 门槛。受控脚本用量只用于机制验收。

## 复现与日志

在 WSL 的仓库目录执行。实验脚本按原方式加载 `/mnt/d/work/agent/ci_bench/env.sh`。使用新的日志目录。

```bash
b=test/benchmarks/research-spine-value-validation
logs="$b/logs"
export SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_EXPERIMENT=fork
export SCIENCE_SPINE_MODES=projection,projection-linked,projection-handoff
export SCIENCE_SPINE_REQUIRE_REVIEW=1 SCIENCE_SPINE_REPETITIONS=2
SCIENCE_SPINE_SPLIT_QC=1 SCIENCE_SPINE_FIRST_PAIR=1 \
  SCIENCE_SPINE_FORK_SEED_DIR="$logs/solar-linked-fork-20261124-r4/fork/00-dynamic-d55eb8fe" \
  SCIENCE_SPINE_LOG_DIR="$logs/solar-handoff-grouping-repro" bash "$b/run-calibration-wsl.sh"
python3 "$b/prepare-solar-replay.py" \
  "$logs/solar-linked-serial-20261124-r2/serial/01-projection-linked-940e4383" \
  call_00_t1enqbwrlcvydnsw6o91qfuz "$logs/solar-handoff-natural-repro" \
  --support work/stage1.py --support work/stage1.out --support work/stage2.py
SCIENCE_SPINE_SPLIT_QC=0 SCIENCE_SPINE_FIRST_PAIR=3 \
  SCIENCE_SPINE_FORK_SEED_DIR="$logs/solar-handoff-natural-repro" \
  SCIENCE_SPINE_LOG_DIR="$logs/solar-handoff-report-repro" bash "$b/run-calibration-wsl.sh"
python3 "$b/report-paired.py" "$logs/solar-handoff-grouping-repro/fork" \
  --handoff-dir "$logs/solar-handoff-report-repro/fork"
```

- [自动证据汇总](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-evidence.md)
- [第 1 组原始目录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-grouping/fork)
- [第 2 组原始目录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-grouping-repeat/fork)
- [第 3、4 组原始目录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-report/fork)
- [受控回归](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-controlled-r2) · [受控首轮记录](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/solar-handoff-20261124-controlled/split/controlled-solar-audit.json)
