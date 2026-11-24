# JiuwenSwarm Spine 接入验收

日期 2026-11-26。对照为原始 ScienceDiscovery `d684215a2fbbd366b6d455a941efa35cfc868ea9` 与个人分支 `09ae447de434a39a2a1bc8e2afdb294e3697f48a` 加本轮适配补丁。两臂都在 WSL 使用实际 `workswarm0.2.6`、正式 API 和本地 Runner。每臂新建会话、工作区和 Run。受控实验只替换模型端点，真实实验使用 `DeepSeek-V4.1-Flash-1017`。本报告使用本轮新生成的数据。

## 原因与修复

| 功能 | 原因 | 本轮实现与验收方式 |
|---|---|---|
| Scope Projection | 旧投影调用在 Native 上下文组装器。Swarm 自己组装历史，其模型请求没有经过该入口。 | 将投影放在 Swarm 模型网关发请求前。保留当前请求、之前的用户约束与近期完整工具对，跳过短历史、收益不足或工具对未闭合的前缀。用受控模型收到的请求及持久化模型上下文检查实际投影。 |
| 检查点恢复 | 旧路由明确拦截 Swarm。Swarm 模型请求还将用户正文包装进消息信封。 | 正式 Run 请求封存并校验检查点。网关解析信封定位当前请求，恢复经验证的历史和证据。按状态恢复打通阶段交付验收及已验证展示证据退出。 |
| Inline | 旧路由拒绝 Swarm，平台和 Swarm 原生委派均需处理。 | 正式 `delegationMode: "inline"` 可运行，检查模型工具清单及子 Run 记录。 |
| Node Memory | 入口需要已完成恢复 Run 及其可验证的 Artifact Version。旧 Swarm 屏蔽恢复，Shell 产生的文件也没有自动登记为当前 Run 的 Artifact Version。 | 校验交付后，从 Runner 中已提交的成功执行登记 JSON。登记前核对哈希。重开 API 后按版本读取并核对 SHA-256、JSON 内容和错误 Run 拒绝。 |

Scope Projection 由 `SCIENCE_AGENT_JIUWENSWARM_SCOPE_PROJECTION=1` 显式启用。检查点恢复用会话准入与工作流清单控制。文件变化、跨 Run 引用和不满足检查点约束继续返回明确错误。Swarm 模型请求找不到恢复边界时终止恢复，保留该错误诊断。

## 对照口径

- 文献场景基线通过正常 Run 续跑，候选通过 `researchResume` 正式 API 按状态恢复。两组都验收质控表、原始输入 SHA-256、逐 DOI 审计结果和汇总统计。候选在恢复前重开 API，测时从提交恢复请求到完成轮询，含 API 和产物登记开销。基线使用常规同会话续跑。
- Scope 场景把五份固定快照分别经 Shell 提供给模型，然后追问前一轮给定规则与总计。独立核对读取日志和预期答案，基线及候选的模型工具清单可从 CAS 模型输入对账。
- 输入、输出、总 Token 取模型提供方用量，逐 Run 与模型网关调用数对账。受控模型每次固定报告 250 输入和 50 输出，只用于用量对账。消息大小取受控模型实际收到的序列化消息字节数和独立读回的模型上下文。Shell 次数来自 Runner 记录。

## Scope Projection 对照

两臂的五个快照分别读出，模型都提交了正确答案 `FROZEN/155`。追问的工具清单都是 68 项，模型各调用一次，均无 Shell 读取。模型上下文快照确认候选省略了首份快照的原始工具输出，并保留用户规则和当轮请求。

| 模型 | 指标 | 原始 Swarm | Swarm + Spine | 差异 |
|---|---|---:|---:|---:|
| 受控 | 追问实际发送的 messages JSON | 61,091 B | 54,963 B | −10.03% |
| 受控 | 追问耗时 | 2.249 s | 2.278 s | +0.029 s |
| 真实 | 追问对话历史快照 | 22,422 B | 15,034 B | −32.95% |
| 真实 | 追问输入 Token | 45,931 | 42,420 | −7.64% |
| 真实 | 追问输出 Token | 7 | 44 | +37 |
| 真实 | 追问总 Token | 45,938 | 42,464 | −7.56% |
| 真实 | 追问耗时 | 18.040 s | 14.979 s | −3.061 s |
| 真实 | 五次读取加追问总 Token | 292,327 | 288,570 | −1.29% |
| 真实 | 五次读取加追问总耗时 | 106.538 s | 112.459 s | +5.921 s |

候选少发送了历史内容，收益集中在跨 Run 的长历史追问。源 Run 的五次读取是两臂共有的固定成本。真实 Scope 目前有一对样本，用户规则和答案正确性仅覆盖本场景。边界、闭合工具对、短历史与低收益跳过已有专项测试。

## 检查点恢复、Inline 和 Node Memory 对照

主批次的 12 个实验臂完成 36 个 Run。两对受控文献和两对真实文献均校验通过，候选四次恢复都额外执行了 Node Memory 正向读取、错误 Run 拒绝、重复提交同一 Run 和 Inline 检查。另跑 `full` 完整历史恢复和普通对照，共 7 个受控 Run 自然完成。`full` 的三次模型请求均包含完整表格，文件改动后 Node Memory 返回预期的 `409`。

| 真实模型指标 | 原始 Swarm | Swarm + Spine | 差异 |
|---|---:|---:|---:|
| 续跑输入 Token | 402,388 | 129,866 | −67.73% |
| 续跑输出 Token | 3,604 | 3,379 | −6.24% |
| 续跑总 Token | 405,992 | 133,245 | −67.18% |
| 续跑模型调用 | 10 | 10 | 0 |
| 续跑 Shell 执行 | 5 | 8 | +60.00% |
| 续跑累计交付耗时 | 117.044 s | 131.352 s | +12.22% |
| 质控加续跑总 Token | 820,478 | 630,348 | −23.17% |
| 质控加续跑模型调用 | 21 | 23 | +9.52% |
| 质控加续跑 Shell 执行 | 11 | 18 | +63.64% |
| 质控加续跑累计交付耗时 | 235.242 s | 274.267 s | +16.59% |

真实 Case 1 续跑总 Token **204,174 → 81,034**，Shell **2 → 5**，交付 **67.008 → 85.794 秒**。追加调用包含表头预览、输入字段检查和 Hash 检查。Case 2 续跑总 Token **201,818 → 52,211**，Shell **3 → 3**，交付 **50.036 → 45.558 秒**。两对续跑累计耗时上升约 14 秒，配对比值中位数上升 9.54%。候选在不同的决策回合减少了向模型重发完整表格的次数。真实用例的最终模型输入均省略了该表格。全流程输出 Token **6,479 → 6,866（+5.97%）**。

候选恢复还将模型可见工具定义从常规续跑的 68 项收窄到 5 项，续跑 Token 的差异包含工具和历史两个变化。受控 `full` 的三次调用保留了原始表格。受控 `by-state` 随验证退出部分工具输出，两臂的模型调用和 Shell 执行次数一致。受控文献续跑累计 **10.233 → 16.254 秒**，含恢复校验及产物登记。真实短问答 Case 1 **8.242 → 34.676 秒**，其上游请求首字节 **5.303 → 30.899 秒**，投影和恢复均未触发。Case 2 短问答 **9.613 → 16.048 秒**，上游首字节 **5.935 → 12.280 秒**。短问答时延差主要出现在模型网关发出请求之后。真实用例均需进一步重复采样才能估算稳定的时延和重复读取变化。

Inline 的测试确认工具表没有委派入口，子 Run 为 0，问答产物正确。Node Memory 的测试确认版本归属、重启后的持久化读取、错误 Run 及外部文件改动的拒绝。两项分别提供执行约束和证据复用能力，当前用例给出功能验收结果。

当前结果支持在明确启用的 Swarm 场景使用这些入口。时延和 Shell 指标仍有回归，维持 Scope Projection 显式启用和恢复会话准入。

## 早期失败与修复

| WSL 实验日志目录 | 结果 |
|---|---|
| `jiuwenswarm-adapt-controlled-20261126` | 候选恢复进入网关后失败。原代码拿原始用户字符串与 Swarm 信封全文匹配，找不到续跑边界。基线通过。 |
| `jiuwenswarm-adapt-controlled-r2-20261126` | 修复信封后，候选恢复自然完成且产物内容正确。Node Memory 前置检查发现无当前 Run Artifact Version，实验失败。基线通过。 |
| `jiuwenswarm-adapt-r3-20261126` | 补齐正式 Artifact Version 登记之后重新执行，主批次 12/12 实验臂通过。 |
| `jiuwenswarm-adapt-full-20261126` | WSL 非登录 Shell 没有加载 `uv` 的路径，启动失败。 |
| `jiuwenswarm-adapt-full-r2-20261126` | 用 WSL 登录 Shell 重跑完整历史及文件变化拒绝用例，2/2 实验臂通过。 |

主批次启动命令的外层 `tee` 在结果目录创建前尝试打开 `launch.log`，故外层命令退出码为 1。内部批次完成，各臂的 `exit-code.txt` 均为 0，独立审计直接读取了逐臂产物。

聚焦回归测试中，Scope Projection、检查点及 Artifact Manager 新校验均通过，API 类型检查通过。网关现有测试 `invalid arguments retain private diagnostics without leaking payload into ordinary logs` 在候选和干净基线均出现 `Unexpected end of JSON input`。

## 复跑

```bash
bench=test/benchmarks/research-spine-value-validation
baseline=/home/zjc/.cache/science-spine-tmp/baseline.0TnPyK
results="$bench/logs/jiuwenswarm-adapt-local-rerun"
SCIENCE_SPINE_SWARM_ADAPTED=1 bash "$bench/run-jiuwenswarm-reassessment-wsl.sh" \
  "$baseline" "$results" controlled-2 real-1 scope-controlled scope-real real-2 controlled-1
python3 "$bench/audit-jiuwenswarm-reassessment.py" "$results" \
  controlled-2 real-1 scope-controlled scope-real real-2 controlled-1 --record-failures --context-evidence
```

模型环境由脚本从 `/mnt/d/work/agent/ci_bench/env.sh` 读取。每臂的 `data-dir.txt` 指向本次在 WSL 的 Runner、CAS、API 和工作区记录。`driver.log` 是逐调用原始日志。有失败时 `exit-code.txt` 和 `result.json` 保留原始终态。

[主批次逐臂日志](./logs/jiuwenswarm-adapt-r3-20261126) · [独立复算 JSON](./logs/jiuwenswarm-adapt-r3-20261126/final-audit.json) · [完整历史及失效校验](./logs/jiuwenswarm-adapt-full-r2-20261126/final-audit.json)
