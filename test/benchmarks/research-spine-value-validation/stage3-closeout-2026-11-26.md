# ScienceDiscovery 第三阶段收口验收

日期为 2026-11-26。测试在 WSL 通过 Native API 和本地 Runner 执行，真实矩阵使用 DeepSeek-V4.1-Flash-1017。校准记录和光伏记录均来自基准生成器。基准收益适用于记录中的冻结点。现场试点仍缺可核验来源的内部仪器数据或经授权的实际工作会话。

## 对照和通过条件

- `original` 为 `d684215a2fbbd366b6d455a941efa35cfc868ea9` 上的普通续跑。冻结源消息及文件一致。原始 checkout 的 2,997 个 Git blob 均核对一致。
- `full` 为当前版本正式检查点入口加完整历史。`by-state` 使用同一入口，已展示时复用验证过的证据，待展示时传完整历史。对 `full` 的差值度量选路收益，对 `original` 的差值度量完整变更的效果。
- 正常臂须自然完成，独立复算通过，追踪证据、质控文件、展示顺序、Token 用量均一致，质控重写和重复整表展示均为零。已展示的候选对 `full` 平均总 Token 至少降 20%，对 `original` 的逐对耗时比例中位数增幅不超过 10%，出现 ≥1.8× 的差值保留首轮并逆序复核。工具计数来自持久化事件，模型请求数来自传输日志，含压缩请求。耗时从提交研究请求到终态与 Usage 对账，未计源历史生成和 API 启动。

## 工作区保护和回滚

| 场景 | 验收 |
|---|---|
| 排队中的检查点关闭试点并重启 | 同一个 Run ID 从持久化的 `queued` 状态恢复，选用 `full-history`，交付验证通过。仍只开放 `execution_logs`、`execution_status`、`read_tool_output`、`run_shell`、`update_plan`。新检查点请求返回 409，模型增量为 0。 |
| 光伏待展示请求进入试点 | 首次调用模型前返回 409，同 Session 改走普通续跑，自然完成并通过独立复算。 |
| 活跃 Shell 取消 | 活跃阶段拒绝竞争写入。仅取消 Run，Shell 达到已落盘的 `cancelled`。确认终止后，探针和待释放写入数均为 0。 |
| Runner 停止调用不可达且 API 重启 | 初测 Runner 返回真实终止证据后旧 API 账本仍留在 `running`。修复复用原执行 ID 的恢复、观察租约和终态落盘机制。Runner 停止接口不可达且 API 重启后仍返回 409，未生成竞争写入。Runner 恢复、旧租约失效、取消账本提交后才放行写入。再次重启仍可读到 `cancelled`。 |
| 写首个产物后终止 API | 重启后 Run 为 `interrupted`，保留部分产物原字节，交付消息为 0。修复前 Usage 汇总没有任务行，逐轮事件有 250 输入、50 输出。修复从持久化事件补记 300 Token，并按 Run 保证幂等。 |
| 完成后重启并重试 | 返回原 Run ID。重复提交新增模型请求和 Shell 执行均为 0。 |

两条正常回滚路径退出码均为 0，交付均通过独立科学复算。四条故障路径均通过各自的预期终态、持久化证据和无重复副作用审计。API TypeScript 和全仓测试 TypeScript 检查通过。Shell、检查点、用量及启动恢复相关测试共 67 条通过。

## 关闭试点后的普通路径

两套批次各做三轮交替次序对照。每轮每臂完成 4 条普通问答和 6 条长历史的 Shell 计算。长历史包含 96 条消息和 800 条历史 Run。总计 `original` 60/60 和关闭试点的当前版本 60/60。所有最终答案、产物字节、历史可见性、Usage 和请求计数一致。每条问答 1 次模型请求、0 次工具调用，每条长历史 3 次模型请求（含 1 次独立压缩）、1 次工具调用。Usage 人工固定的模型返回为每个任务请求 250 输入、50 输出 Token，两个版本均按任务轮次对账。普通路径的 Token 和调用数量变化均为 0%。

以下是逐对耗时比例的中位变化，同一轮、同一顺序位置配成一对。

| WSL 批次 | 用例 | 对数 | 文件写入 | 入队 | Run 执行 | 交付 |
|---|---|---:|---:|---:|---:|---:|
| `ordinary-gate` | 普通问答 | 12 | +4.54% | +11.38% | +4.55% | +1.53% |
| `ordinary-gate` | 长历史 Shell | 18 | −9.05% | −1.44% | +0.11% | +0.24% |
| `ordinary-matched` | 普通问答 | 12 | −29.72% | −23.27% | −19.56% | −19.93% |
| `ordinary-matched` | 长历史 Shell | 18 | +1.70% | −7.42% | +6.69% | +6.93% |

第二批明确设置 Runner `SCIENTIFIC_ENVS=0`。其长历史交付各臂中位为 18.213 / 19.082 秒。第一次批次首轮普通问答与长历史的配对中位为 2.567×、2.155×。两批各自的后两轮中位最高为 1.109×。第二批首轮仍有 3 条单条 1.8× 以上样本，后两轮为 0 条。保留上述波动和逐样本数据。当前结果支持关闭试点后的兼容性，长历史配对尾部仍会波动。

## 实验数据

### 真实模型首轮

四个新冻结点共 **12/12** 条严格通过。全部自然完成且通过独立复算。质控重写、重复整表展示和模型传输重试均为 0。

逐臂单元格依序为输入 / 输出 / 总 Token，模型请求 / 工具调用，交付秒数。

| 冻结点 | 原始 `original` | 完整历史 `full` | 候选 `by-state` |
|---|---:|---:|---:|
| 仪器校准已展示 4 | 149,730 / 4,056 / 153,786<br>6 / 5<br>122.717 | 90,037 / 4,012 / 94,049<br>6 / 5<br>141.093 | 54,217 / 2,542 / 56,759<br>6 / 5<br>124.613 |
| 光伏已展示 2 | 252,784 / 5,920 / 258,704<br>8 / 7<br>147.823 | 172,783 / 5,722 / 178,505<br>8 / 10<br>161.096 | 45,155 / 3,277 / 48,432<br>5 / 4<br>100.606 |
| 光伏已展示 6 | 325,583 / 7,151 / 332,734<br>10 / 15<br>271.612 | 96,867 / 4,525 / 101,392<br>5 / 4<br>137.418 | 73,564 / 4,521 / 78,085<br>8 / 8<br>182.305 |
| 光伏待展示 1 | 181,457 / 3,893 / 185,350<br>6 / 5<br>144.738 | 192,926 / 6,120 / 199,046<br>9 / 8<br>194.087 | 237,404 / 4,072 / 241,476<br>11 / 10<br>284.065 |

分组变化按未舍入的 Token 和调用均值计算。耗时取逐对时长比例的中位数。

| 场景 | 原始或同入口参照 | 输入 Token | 输出 Token | 总 Token | 模型请求 | 工具调用 | 交付耗时 |
|---|---|---:|---:|---:|---:|---:|---:|
| 光伏已展示，2 对 | `original` | -79.47% | -40.34% | -78.61% | -27.78% | -45.45% | -32.41% |
| 光伏已展示，2 对 | `full` | -55.97% | -23.90% | -54.80% | 0% | -14.29% | -2.44% |
| 校准已展示，1 对 | `original` | -63.79% | -37.33% | -63.09% | 0% | 0% | +1.55% |
| 校准已展示，1 对 | `full` | -39.78% | -36.64% | -39.65% | 0% | 0% | -11.68% |
| 光伏待展示，1 对 | `original` | +30.83% | +4.60% | +30.28% | +83.33% | +100.00% | +96.26% |
| 光伏待展示，1 对 | `full` | +23.05% | -33.46% | +21.32% | +22.22% | +25.00% | +46.36% |

光伏待展示的 `full` 与 `by-state` 首轮 `history`、`systemPrompt`、`tools` 一致。候选后续比 `full` 多 2 次模型请求和 2 次工具调用。相对原始交付 1.963×，同一冻结点按相反次序复跑。

同一冻结点逆序复跑 **3/3** 严格通过。`original`、`full`、`by-state` 交付分别为 **175.791、233.991、185.381 秒**，总 Token 分别为 **298,124、232,868、206,368**。候选对原始交付为 **1.055×**，首轮的 1.963× 未复现。候选对同入口 `full` 总 Token 下降 **11.38%**，首轮则增加 **21.32%**。两轮里 `full` 与 `by-state` 的首轮模型入参均一致，收益方向随模型后续行为变化。两轮数据分别保留。

### 准入判定

- **仪器校准已展示**满足显式白名单试点的技术门槛。上一批有 4/4 对通过，对 `full` 平均总 Token −29.29%，对原始配对耗时中位 −42.05%。本轮新冻结点同样满足门槛。现场试点仍缺真实样本或经授权的内部会话。
- **光伏已展示**通过本轮显式白名单准入。上一批有 3/4 对严格通过，唯一失败为 `full` 重复展示一次，该记录继续保留。本轮 2/2 对三臂严格通过，对 `full` 平均总 Token −54.80%，对原始配对交付 −32.41%。`by-state` 两条相对 `full` 最慢 1.327×。准入范围限本地 Native 单实例和经过展示证据验证的指定 Session。
- **光伏待展示**通过科研结果正确性审计，未达到性能准入。试点入口在模型调用前拒绝，同 Session 用普通入口继续。部署模式保持默认关闭。

## 复现和日志

以预构建的当前项目为工作目录，使用预构建的原始 checkout 作为 `baseline`。模型入口读取 `/mnt/d/work/agent/ci_bench/env.sh`。日志在 `test/benchmarks/research-spine-value-validation/logs/stage3-closeout-20261126/`，其中 `real` 保留逐臂 `driver.log`、`result.json`、`exit-code.txt`、`data-dir.txt` 和独立审计。`real-recheck` 保留待展示逆序复跑。`status.txt` 保留真实矩阵状态，`rollback-verified` 保留回滚与待展示，`faults-final` 保留四条严格通过的故障日志。`faults-recovery-fix` 保留第一轮修复的结果，当时硬退出用量对账仍失败。`controlled-final` 保留初次组合故障、关闭门禁和测试驱动退出超时。`ordinary-gate` 与 `ordinary-matched` 保留切换顺序的普通续跑实验。日志和运行数据用于本地复核，提交只包含代码与报告。

```bash
bench=test/benchmarks/research-spine-value-validation
logs="$bench/logs/stage3-closeout-20261126"
export TMPDIR="$HOME/.cache/science-spine-tmp"
mkdir -p "$TMPDIR"
python3 "$bench/summarize-pilot.py" "$logs/real" --rollout
SCIENCE_SPINE_FORMAL_PILOT=1 bash "$bench/run-formal-recovery-wsl.sh" \
  "$logs/captures/solar-6/pair-6/capture" "$logs/repro-displayed" "$baseline" by-state,full,original
bash "$bench/rerun-pilot-pair-wsl.sh" "$logs/captures/solar-1/pair-1/capture" \
  "$logs/repro-pending-recheck" "$baseline" "$logs/real/solar-pending-1"
SCIENCE_SPINE_FORMAL_TRAJECTORY_AUDIT=1 bash "$bench/run-formal-faults-wsl.sh" \
  "$bench/logs/pilot-captures-solar/pair-2/capture" "$logs/repro-faults"
CHECKOUT_DATA=$(mktemp -d "$TMPDIR/ordinary-closeout.XXXXXX")
pnpm exec tsx "$bench/run-ordinary-closeout.ts" "$logs/repro-ordinary-original.json" "$CHECKOUT_DATA" "$baseline"
CHECKOUT_DATA=$(mktemp -d "$TMPDIR/ordinary-closeout.XXXXXX")
pnpm exec tsx "$bench/run-ordinary-closeout.ts" "$logs/repro-ordinary-disabled.json" "$CHECKOUT_DATA"
```
