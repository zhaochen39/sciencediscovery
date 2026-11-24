# Research Spine 价值验证用例

这个目录提供第一版价值验证版本的固定科研任务、运行脚本和结果归档。

## 用例

任务使用固定的合成生物医学队列数据 `cohort.csv`，要求 Native Agent 完成六个阶段，并生成以下文件。

- `phase1_quality.json`
- `cleaned_cohort.csv`
- `descriptive_stats.json`
- `model_results.json`
- `sensitivity.json`
- `final_report.md`

运行脚本每次为一个任务实例创建独立 workspace，自动保存模型事件、上下文 Trace、最终消息和验收摘要。

## 对照组

- `dynamic` 作为 B0 当前 Native Context 基线
- `shadow` 作为 B1 Shadow，旁路生成 Scope Projection，但模型仍收到基线输入
- `projection` 作为 V1 价值验证版本，模型收到 Scope Projection 和 Node Memory

第一轮只改变 Context Projection。模型、任务、数据、工具和运行预算保持一致。

## WSL 运行

在仓库根目录执行。

```bash
source /mnt/d/work/agent/ci_bench/env.sh
export SCIENCE_SPINE_REPETITIONS=1
bash test/benchmarks/research-spine-value-validation/run-wsl.sh
```

正式验收可以将 `SCIENCE_SPINE_REPETITIONS` 设置为 10 或 20。日志默认写入 `test/benchmarks/research-spine-value-validation/logs`，也可以通过 `SCIENCE_SPINE_LOG_DIR` 指定绝对路径。

## 关键环境变量

- `E2E_LLM_BASE_URL`
- `E2E_LLM_MODEL`
- `E2E_LLM_TOKEN`
- `SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS`
- `SCIENCE_AGENT_SCOPE_MEMORY_CHARS`
- `SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES`
- `SCIENCE_SPINE_REPETITIONS`
- `SCIENCE_SPINE_LOG_DIR`

脚本不会把模型 Token 写入终端之外的敏感环境变量内容。运行结果只保存统计、事件和上下文结构信息。

## 固定 Transcript 验收

固定 Transcript 用于在不引入模型随机性的情况下，验证 Scope Projection 和 Node Memory 的上下文收益。它不需要加载模型环境变量，也不会产生模型调用费用。

在 WSL 中执行以下命令。

```bash
cd /mnt/d/work/agent/packre/sciencediscovery-analysis
export SCIENCE_SPINE_REPETITIONS=20
export SCIENCE_SPINE_LOG_DIR=/mnt/d/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/logs/deterministic-20261123
bash test/benchmarks/research-spine-value-validation/run-deterministic-wsl.sh
```

脚本会比较三种模式。

- `B0` 对应当前历史输入
- `B1` 生成 Projection Trace，但仍向模型使用当前历史输入
- `V1` 使用 Projection 历史和 Node Memory 作为模型可见输入

结果文件如下。

- `logs/deterministic-20261123/deterministic-results.json`
- `logs/deterministic-20261123/deterministic-acceptance-report.md`

本轮 20 次固定 Transcript 的结果是，V1 平均模型输入 Token 从 15,264 降到 5,355，下降 64.92%，重复读取次数从 2 降到 0，Artifact 引用召回率、主要结论方向保留率和未完成义务保留率均为 100%。这些 Token 是 Context 层估算的模型输入规模，真实模型账单 Token 需要通过实时模型对照进一步确认。
## Native MVP 成本门控验收

Native Agent 仅在显式启用 `projection` 时向模型发送投影历史。候选历史必须节约至少 1,500 个估算 Token，且节约比例达到 10%。原始历史估算门槛为 1,500 Token。`shadow` 记录候选决策，其既有模型路径为 `legacy`，性能比较使用 `dynamic` 和 `projection`。门槛按历史消息估算，端到端 Token 使用模型服务的 usage。实际生效还要在 Trace 的 `llmInput.history` 中看到 `scope_node_memory`。

在 WSL 仓库根目录执行以下命令。每次复测使用一个新的 `SCIENCE_SPINE_LOG_DIR`。

```bash
export CI=true
bench=test/benchmarks/research-spine-value-validation
pnpm --filter @sciencediscovery/context build
export SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500
export SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10
export SCIENCE_AGENT_SCOPE_MAX_FACTS=8
export SCIENCE_AGENT_SCOPE_MAX_OBLIGATIONS=5
export SCIENCE_AGENT_SCOPE_MEMORY_CHARS=6000
export SCIENCE_SPINE_REPETITIONS=5
export SCIENCE_SPINE_MODES=dynamic,shadow,projection
export SCIENCE_SPINE_MAX_MODEL_TURNS=8
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=4
export SCIENCE_SPINE_LOG_DIR="$PWD/$bench/logs/controlled-cost-gate-repro"
pnpm exec tsx "$bench/run-controlled.ts"
python3 "$bench/report-paired.py" "$SCIENCE_SPINE_LOG_DIR"
```

真实模型对照使用相同任务和四阶段契约。每对创建独立工作区，相邻对交替运行顺序。给定同一个模型与预算，仅切换上下文模式。

```bash
set -a
source /mnt/d/work/agent/ci_bench/env.sh
set +a
export SCIENCE_SPINE_REPETITIONS=10
export SCIENCE_SPINE_MODES=dynamic,projection
export SCIENCE_SPINE_MAX_MODEL_TURNS=16
export SCIENCE_AGENT_LLM_MAX_TOKENS=4096
export SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS=32768
export SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=6
export SCIENCE_SPINE_THINKING_MODE=disabled
export SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0
export SCIENCE_SPINE_LOG_DIR="$PWD/$bench/logs/live-cost-gate-repro"
pnpm exec tsx "$bench/run-live.ts"
python3 "$bench/report-paired.py" "$SCIENCE_SPINE_LOG_DIR"
```

E2E 要求自然结束、六件产物齐全并通过内容校验、有模型 usage。汇总纳入所有计划样本，失败时保留实际运行到失败前的消耗。真实模型性能门槛沿用总 Token 均值至少降低 5%、至少 2/3 的配对降低输入 Token、平均模型轮次与工具调用均不增加。P50 和 P95 按样本线性插值，延迟按整个任务计时。受控模型返回确定性 usage，仅用来验证上下文机制和运行链路。

如果任务自然结束，但验收器误读报告的 Markdown 格式，修复校验逻辑后可对整批已保存的产物重新校验。该命令写出独立的 `results-revalidated.json`，记录原校验结果、重验结果和重验时间。逐次耗时与模型 usage 来自原运行。

```bash
pnpm exec tsx "$bench/run-live.ts" --revalidate "$SCIENCE_SPINE_LOG_DIR/results.json"
python3 "$bench/report-paired.py" "$SCIENCE_SPINE_LOG_DIR" --results results-revalidated.json
```

设置 `SCIENCE_SPINE_VALIDATE_ON_TOOL=1` 可以让两组使用同一套产物验收反馈。六件文件齐备后，`run_shell` 的结果会列出未通过的校验项，模型可以修正产物并自然结束。最终校验仍在运行结束后独立执行。设置该开关会改变模型输入，比较结果应按同一开关配置分组。

最终受控模型按四个阶段分别写产物，固定长观察文本用于覆盖压缩触发路径。将 `SCIENCE_SPINE_CONTROLLED_REPORT_FAULT=1` 传给受控脚本可注入错误行数并验证模型通过校验反馈触发单独的修复回合。受控正常结果和故障注入结果分别统计。

## Verified Stage Projection 验收

当前 Native Projection 从 `context.verified-stages` 读取工作流提供的已捕获完成证据。一个阶段只关联一个验证过的工具结果，已验收产物带相对路径、内容版本和供下游使用的字段。模型输入中的对应工具结果可替换为该证据，其余消息交由现有 Context 逻辑处理。工作流未提供证据时沿用 Dynamic 输入。

在 WSL 仓库根目录运行。为每次运行指定新日志目录。

```bash
export CI=true
bench=test/benchmarks/research-spine-value-validation
pnpm --filter @sciencediscovery/context build
SCIENCE_SPINE_LOG_DIR="$bench/logs/verified-stage-audit-repro" bash "$bench/run-verified-stage-wsl.sh"
```

正式长任务固定 10 对、4 个进程分片。配对内串行，奇偶对交换 Dynamic 和 Projection 执行顺序。所有分片使用同一模型配置、清洗审计、验收反馈和门槛。并发分片可能影响延迟，报告按整次任务耗时给出 P50 和 P95。`results.json` 和 `paired-evidence.md` 保留所有配对，单次的模型输入、使用量、工作区和阶段产物版本位于分片子目录。日志按本地 Git 忽略规则保存。

```bash
export SCIENCE_SPINE_CASE=audit SCIENCE_SPINE_REPETITIONS=5
export SCIENCE_SPINE_VALIDATE_ON_TOOL=1 SCIENCE_AGENT_SCOPE_RETAIN_MESSAGES=2
SCIENCE_SPINE_LOG_DIR="$bench/logs/verified-stage-controlled-repro" pnpm exec tsx "$bench/run-controlled.ts"
SCIENCE_SPINE_REPETITIONS=1 SCIENCE_SPINE_CONTROLLED_REPORT_FAULT=1 \
  SCIENCE_SPINE_LOG_DIR="$bench/logs/verified-stage-report-fault-repro" pnpm exec tsx "$bench/run-controlled.ts"
SCIENCE_SPINE_REPETITIONS=1 SCIENCE_SPINE_CONTROLLED_STAGE_FAULT=1 \
  SCIENCE_SPINE_LOG_DIR="$bench/logs/verified-stage-stage-fault-repro" pnpm exec tsx "$bench/run-controlled.ts"
```

真实分叉使用 `SCIENCE_SPINE_CASE=audit`、`SCIENCE_SPINE_FORK=1`、`SCIENCE_SPINE_REPETITIONS=1` 和 `SCIENCE_SPINE_MODES=dynamic,projection` 执行 `run-wsl.sh`。两条分支从同一段已归档的历史、阶段产物和完成证据启动。`fork-prefix.json` 记录归档哈希，`report-paired.py` 检查第一个请求的原始用户消息、工具配对、证据字段以及模型服务报告的输入 Token。用于冻结前缀的种子运行有意停在阶段边界，两条续跑单独执行自然结束和产物验收。

短任务使用 `SCIENCE_SPINE_CASE=short`、`SCIENCE_SPINE_FORK=0`、`SCIENCE_SPINE_MODES=dynamic,projection` 和 `SCIENCE_SPINE_SUSPEND_ON_ARTIFACTS=0` 执行 `run-wsl.sh`。短任务的独立校验只要求清洗产物，并复算数据清洗结果。

### Dynamic 影子观察与仪器校准复验

`dynamic-shadow` 基于 Dynamic 评估候选并记录门槛结果和耗时。模型接收 Dynamic 输入，原始历史保持完整。`shadow` 继续沿用 Legacy 输入。校准任务使用固定三批仪器数据和正常工具输出，依次清洗、拟合 OLS、判定漂移和生成报告。Python 审计独立复算输入、清洗、拟合、漂移及报告字段。

在 WSL 仓库根目录执行，分别使用新目录。真实批次从 `D:\work\agent\ci_bench\env.sh` 加载模型配置。

```bash
bench=test/benchmarks/research-spine-value-validation
for kind in shadow fork paired; do
  SCIENCE_CALIBRATION_EXPERIMENT="$kind" SCIENCE_SPINE_LOG_DIR="$bench/logs/calibration-$kind-repro" \
    bash "$bench/run-calibration-wsl.sh"
done
python3 "$bench/report-paired.py" "$bench/logs/calibration-shadow-repro/shadow"
python3 "$bench/report-paired.py" "$bench/logs/calibration-fork-repro/fork"
```

`paired` 测完整任务，共十对，奇偶配对交换执行顺序。`fork` 将清洗与拟合已经完成的工作区与历史作为预备种子，各续跑一次并分别验收。零替换时核对首轮完整模型输入是否一致。模型用量以事件中的供应商 usage 为准，候选估算只用于判门槛。

用现有 cohort 受控模型检验高收益候选进入 Projection 并在 Dynamic 影子模式中保持不可见。

```bash
SCIENCE_SPINE_MODES=dynamic,dynamic-shadow,projection SCIENCE_AGENT_CONTEXT_TRACE=1 \
  SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500 \
  SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 SCIENCE_SPINE_LOG_DIR="$bench/logs/calibration-controlled-repro" \
  pnpm exec tsx "$bench/run-controlled.ts"
```

### 逐阶段诊断与光伏观测工作流

`SCIENCE_AGENT_CONTEXT_TRACE=1` 时，阶段投影 Trace 会记录已接收和有效的阶段证据数量，以及各阶段的候选结果、保留原因和可比较的估算大小。`report-paired.py` 汇总影子模式在结束轮以前首次过门槛的轮次。这些字段来自私有 Trace。

光伏用例的输入为 120 个站点和 480 条确定性合成日观测。任务中要求审核完整站点质控表、按技术类型分组和执行仅含完整站点的敏感性分析。工具运行写出的站点质控表就是审核输出。Python 审计从独立生成的预期输入重算五件产物。在 WSL 的仓库根目录按顺序执行，分别使用新目录。

```bash
bench=test/benchmarks/research-spine-value-validation
SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_EXPERIMENT=shadow \
  SCIENCE_SPINE_LOG_DIR="$bench/logs/solar-shadow-repro" bash "$bench/run-calibration-wsl.sh"
python3 "$bench/report-paired.py" "$bench/logs/solar-shadow-repro/shadow"

SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_EXPERIMENT=fork \
  SCIENCE_SPINE_LOG_DIR="$bench/logs/solar-fork-repro" bash "$bench/run-calibration-wsl.sh"
python3 "$bench/report-paired.py" "$bench/logs/solar-fork-repro/fork"

SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_EXPERIMENT=paired \
  SCIENCE_SPINE_LOG_DIR="$bench/logs/solar-paired-repro" bash "$bench/run-calibration-wsl.sh"
```

`feat/research-spine` 的科研改动以 `d684215a2fbbd366b6d455a941efa35cfc868ea9` 为父提交，分支持续维护一个科研提交。后续更新使用 `git commit --amend`，核对基线以上的提交数为 1，再以已验证的远端 HEAD 为 lease 更新个人仓 `personal/feat/research-spine`。

### 跨调用的阶段证据

光伏用例用 `projection-linked` 比较已验收阶段的工具结果来源。`dynamic` 是当前 Native 基线，`projection` 使用产物验收所在调用，`projection-linked` 还可使用与同一版本产物一致的独立读出。状态提供者核对文件版本和输出，再签发工具调用 ID 与内容 SHA-256。Context 据此核验模型历史中的工具结果并生成派生记忆。三组使用相同的成本门槛和验收反馈。

在 WSL 的仓库根目录运行下列命令。每次使用新日志目录。串行延迟批次在其他模型实验结束后运行。

```bash
b=test/benchmarks/research-spine-value-validation
pnpm --filter @sciencediscovery/context build

for scenario in split revised mixed ambiguous incomplete; do
  SCIENCE_SPINE_CONTROLLED_SOLAR="$scenario" SCIENCE_AGENT_SCOPE_MIN_SOURCE_TOKENS=1500 \
    SCIENCE_AGENT_SCOPE_MIN_SAVINGS_TOKENS=1500 SCIENCE_AGENT_SCOPE_MIN_SAVINGS_PERCENT=10 \
    SCIENCE_SPINE_LOG_DIR="$b/logs/linked-controlled-repro/$scenario" pnpm exec tsx "$b/run-controlled.ts"
done

export SCIENCE_SPINE_CASE=solar SCIENCE_SPINE_MODES=dynamic,projection,projection-linked
SCIENCE_SPINE_SPLIT_QC=1 SCIENCE_SPINE_EXPERIMENT=fork \
  SCIENCE_SPINE_LOG_DIR="$b/logs/linked-fork-repro" bash "$b/run-calibration-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/linked-fork-repro/fork"

SCIENCE_SPINE_EXPERIMENT=paired SCIENCE_SPINE_LOG_DIR="$b/logs/linked-triple-repro" \
  bash "$b/run-calibration-wsl.sh"

SCIENCE_SPINE_EXPERIMENT=serial SCIENCE_SPINE_REPETITIONS=3 SCIENCE_SPINE_REQUIRE_REVIEW=1 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/linked-serial-repro" bash "$b/run-calibration-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/linked-serial-repro/serial"

SCIENCE_SPINE_CASE=calibration SCIENCE_SPINE_EXPERIMENT=serial SCIENCE_SPINE_REPETITIONS=1 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/linked-calibration-repro" bash "$b/run-calibration-wsl.sh"
python3 "$b/report-paired.py" "$b/logs/linked-calibration-repro/serial"
```

真实 Token 取供应商 usage。时延证据包括批次端到端耗时、单次模型请求耗时、工具调用事件耗时和 Context 组装 Trace。串行小样本可核对耗时方向，P95 仍受个别样本波动影响。`report-paired.py` 保留全部轨迹，按组报告产物审计、工具输出审计、阶段投影命中和逐对差异。


### 已验收阶段的精简恢复

每组捕获一个通过独立复算的光伏质控检查点。完整历史恢复和精简恢复共用该检查点，从头重跑使用同一任务和确定性输入。三种方式在 WSL 串行轮换。精简恢复发送原始任务与结构化阶段证据，完整工具轨迹保留在检查点。独立审计核对首轮上下文、质控表是否已展示、两份质控文件的版本及写入次数、成功自然结束、五项产物和逐轮业务请求 usage。

用新日志目录复现。`run-compact-recovery-wsl.sh` 通过 `run-wsl.sh` 加载真实模型环境。受控运行使用本地 HTTP 夹具，并覆盖质控表待展示和已展示两种状态。

```bash
b=test/benchmarks/research-spine-value-validation
SCIENCE_SPINE_CONTROLLED_RECOVERY=pending SCIENCE_SPINE_REPETITIONS=2 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-pending-repro" pnpm exec tsx "$b/run-controlled.ts"
SCIENCE_SPINE_CONTROLLED_RECOVERY=displayed SCIENCE_SPINE_REPETITIONS=1 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-displayed-repro" pnpm exec tsx "$b/run-controlled.ts"
SCIENCE_SPINE_REPETITIONS=3 SCIENCE_SPINE_LOG_DIR="$b/logs/compact-recovery-live-repro" \
  bash "$b/run-compact-recovery-wsl.sh"
```

每组独立保存退出码、运行器墙钟耗时、模型请求摘要、上下文 Trace 及产物。故障后耗时从启动运行器计到退出，覆盖检查点加载、校验和工作区准备。完整路径额外计入捕获阶段。汇总分别核对业务轮次和模型压缩请求的 usage，合计输入、输出及总 Token。真实模型试跑的扩大门槛是所有组通过正确性审计，精简恢复相对完整历史恢复的首轮输入配对中位降幅至少为 15%，且故障到交付的耗时配对中位差小于零。


### 精简恢复的下一步交接

在 WSL 仓库根目录运行，使用新的日志目录。受控夹具覆盖同一版本质控表待展示和已展示的两种状态。真实批次交替捕获两种状态，每组保存一份检查点，随后串行轮换完整历史恢复、原精简恢复、新版和从头重跑。新版把经过复算的质控事实和第一项待办交给模型。四组使用同一后续任务和验收契约。

```bash
b=test/benchmarks/research-spine-value-validation
for state in pending displayed; do
  SCIENCE_SPINE_RECOVERY_NEXT_STEP=1 SCIENCE_SPINE_REPETITIONS=1 SCIENCE_SPINE_CONTROLLED_RECOVERY="$state" \
    SCIENCE_SPINE_LOG_DIR="$b/logs/next-step-controlled-repro-$state" pnpm exec tsx "$b/run-controlled.ts"
done
SCIENCE_SPINE_RECOVERY_NEXT_STEP=1 SCIENCE_SPINE_REPETITIONS=6 \
  SCIENCE_SPINE_LOG_DIR="$b/logs/next-step-live-repro" bash "$b/run-compact-recovery-wsl.sh"
python3 -m unittest discover -s "$b" -p 'test_recovery_progress.py'
```

独立审计把工具结果与产物变化按调用 ID 对齐。需要展示时，完整的当前版本表格必须出现在更早的成功工具结果里。预分组且没有更新验收产物或履行展示义务的工具调用计入额外调用。重复展示完整表也计入额外调用，与前一项重合时只计一次。模型打开文件进行实际计算仍属正常操作。首个待办推进时间从启动运行器计到首次成功展示或分组写入。

进入第二用例的门槛为全部六组通过正确性审计，两种检查点状态各至少三组。新版相对原精简版的额外调用总数及耗时配对中位数均下降。新版相对完整历史恢复的首轮输入配对中位降幅至少为 15%，故障到交付的耗时配对中位数下降。报告同时保留故障后和计入故障前捕获的模型 usage 及耗时。

## 已验证文件状态的恢复交接

设置 `SCIENCE_SPINE_RECOVERY_HANDOFF=1`，在同一冻结质控检查点比较完整历史恢复、原精简恢复、当前待办版和新交接版。交接由已验证的文件版本、表列名、展示状态和首项待办组成。审计器检查交接记录、首轮输入、工具执行及产物版本。真实模型六组的门槛和复现命令见[专项验收报告](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/native-mvp-workspace-handoff-results-2026-11-25.md)。

## 质控展示回执恢复

设置 `SCIENCE_SPINE_RECOVERY_RECEIPT=1`，在同一冻结质控检查点比较完整历史、原精简、文件状态交接和展示回执。回执绑定成功工具输出与当前文件版本。正式六组门槛、复现命令和日志见[专项验收报告](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/native-mvp-display-receipt-results-2026-11-25.md)。


### 保留一对已验证的原始工具消息

设置 `SCIENCE_SPINE_RECOVERY_EVIDENCE=1`。以文件状态交接为直接基线，验收器比对首轮输入并从冻结轨迹独立重建工具证据。`SCIENCE_SPINE_EVIDENCE_DIAGNOSTIC_SOURCE` 指向上一轮六组检查点目录时，复用第 2、4、6 组进行小规模配对。复现命令、门槛与日志索引见[专项验收报告](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/native-mvp-display-evidence-results-2026-11-25.md)。


### 分组验收后退出原始工具证据

使用 `SCIENCE_SPINE_RECOVERY_RETIRE_DISPLAY=1` 验证原始工具证据的生命周期。设置 `SCIENCE_SPINE_RETIRE_DISPLAY_DIAGNOSTIC_SOURCE` 可复用上一轮第 2、4、6 组已展示检查点，和文件状态交接及持续保留证据同批比较。复现命令、诊断门槛和日志索引见[专项验收报告](D:/work/agent/packre/sciencediscovery-analysis/test/benchmarks/research-spine-value-validation/native-mvp-display-retirement-results-2026-11-25.md)。


### 按检查点状态恢复

`run-state-recovery-wsl.sh` 从同一冻结点分别运行完整历史和按状态恢复。后者仅在可验证展示证据匹配当前产物版本时带入该工具消息对，在下游阶段通过验收后退出证据。`SCIENCE_SPINE_CASE=solar` 验证 `groups.json`，`SCIENCE_SPINE_CASE=calibration-review` 验证 `fits.json`。`report-state-recovery.py` 独立核对快照、路由、自然完成、产物、用量和时延。

`SCIENCE_SPINE_RECOVERY_BY_STATE=1` 可启用 `run-controlled.ts` 的配对断点测试。`SCIENCE_SPINE_CONTROLLED_RECOVERY=pending|displayed` 选择冻结状态。已展示场景可以分别通过 `SCIENCE_SPINE_CONTROLLED_GROUPING_FAULT=1`、`SCIENCE_SPINE_CONTROLLED_UNVERIFIED_DISPLAY=1` 和 `SCIENCE_SPINE_CONTROLLED_CORRUPT_CHECKPOINT=1` 验证下游产物修复、证据失配回退和损坏检查点拒绝。
