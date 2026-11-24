# ScienceDiscovery 跨调用阶段投影验收报告

实验日期为 2026 年 11 月 24 日。实现基于个人仓 `feat/research-spine` 的 `da0c834`，采用 SpineCodex 中源记录与派生记忆分离的设计。

## 实现和对照口径

上一轮光伏第 7 对的写入调用只输出了质控表的 29 行，后续第 4 次工具调用输出完整的 121 行。阶段证据绑定写入调用，当时最多预计节省 307 个历史 Token，8 个模型轮次均走 Dynamic 路径。[上一轮光伏验收](./native-mvp-solar-results-2026-11-24.md)

工作流提供者为独立质控表读出签发证据。签发时核对已验收记录、输入和产物版本、调用前后工作流文件、完整表输出及工具成功状态。Context 在历史中按工具调用 ID 找到读出并校验完整工具结果的 SHA-256，保留写入调用、用户要求、原始历史和工具配对，只在模型请求的派生历史中替换候选。最近消息保护及既有成本门槛仍用于判定候选。多次读出导致来源歧义时撤销跨调用绑定，版本变化淘汰过期的阶段闭合证据。

Dynamic 使用现有 Native Context，Projection 使用写入和验收所在调用，Projection-linked 也可使用签发的独立读出。三组共用模型、提示、数据、产物验收反馈与调用预算。完整 A/B/C 预设十组，执行顺序轮换，四个分片并行。用三组独立串行运行复测延迟，以供应商 usage 计真实 Token，分别记录模型请求、工具执行和 Context 组装时长。

成本验收要求自然结束、全部产物通过独立复算、供应商 usage 对账和完整质控表输出。相对 Dynamic 的总 Token 至少下降 5%，至少 7/10 组输入 Token 下降，平均轮次和工具调用均至多持平。改进版还需相对当前 Projection 展示增量收益。限定试点另看低并发 P95 是否至多持平于 Dynamic。

## 受控 E2E 与回归

本地脚本模型通过实际 Native、Context、工具分发和 Python 复算运行五个场景，每个三组，15/15 自然结束且五件产物通过。模型用量由脚本提供，适用于验证机制。分段输出场景通过两次调用合计展示 121 行，其余场景有单次完整表输出。

| 场景 | Dynamic / Projection / Projection-linked | 改进版实际投影 | 预期行为 |
|---|---|---:|---|
| 写入和完整读出分开 | PASS / PASS / PASS | 3 轮 | 选择通过核验的独立读出 |
| 读出后改写产物版本 | PASS / PASS / PASS | 0 轮 | 过期证据失效 |
| 输出混入其他文本 | PASS / PASS / PASS | 0 轮 | 保留完整工具结果 |
| 完整表重复读出 | PASS / PASS / PASS | 0 轮 | 撤销有歧义的绑定 |
| 分段输出表格 | PASS / PASS / PASS | 0 轮 | 保留各段工具结果 |

Context 回归 59/59，Native、Context 装配集成及校准工作流证据回归 48/48。Context 构建及 API、测试类型检查通过。Context 专项断言覆盖摘要前后的工具配对、历史保留、摘要来源哈希不匹配、不同阶段共享同一读出时的冲突和最近消息保护。

初次受控实施中，WSL 登录 Shell 的初始化错误进入工具 stderr，安全检查拦下了候选。改为非登录 Shell 后，工具结果仍带空的 `stderr:` 标记，已按实际工具结果格式解析并要求该段为空。两轮受控尝试保留原始结果。对应的前置真实批次在修正前停止或中止冻结，正式数据来自使用最终代码和新日志目录的复跑。

## 真实模型同前缀复验

`DeepSeek-V4.1-Flash-1017` 生成质控和分组产物，再在已核验的独立读出与分组证据齐备后暂停。种子轨迹用 6 轮、71,822 Token，其用量单独记录。从同一个冻结工作区、历史和证据派生三条续跑。三条轨迹均由模型自然结束，全部五件产物通过独立复算，13/13 个模型轮次有供应商 usage。

| 模式 | 首轮输入 Token | 续跑输入 | 续跑输出 | 续跑总量 | 模型轮次 | 工具调用 | 秒 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dynamic | 16,122 | 43,694 | 2,170 | 45,864 | 3 | 2 | 34.49 |
| Projection | 16,122 | 61,458 | 2,595 | 64,053 | 4 | 3 | 146.59 |
| Projection-linked | 14,024 | 70,286 | 2,591 | 72,877 | 6 | 5 | 71.73 |

现版 Projection 首轮与 Dynamic 发送相同的完整输入。改进版只替换独立质控读出的工具结果，模型供应商记录的首轮输入节省 2,098 Token（13.01%）。冻结产物哈希、历史哈希、读出内容摘要、原用户要求、系统提示、工具列表和其他历史均通过核验。之后改进版 6 轮均实际命中。其续跑多执行了工作区和分组检查，以及额外的阶段处理调用，完整续跑总 Token 较当前 Projection 增加 13.78%，较 Dynamic 增加 58.90%。这一次观察确认了首轮输入节省，也记录了后续执行路径对续跑成本的影响。

## 真实模型普通光伏任务 · 十组三版本对照

三组各 10/10 自然结束，共 30/30 通过五件产物的独立复算。工具日志确认每次都有一次完整质控表输出。203/203 个模型轮次具有供应商 usage，逐轮与汇总可对账。

| 平均指标 | Dynamic | Projection | Projection-linked | 改进版相对 Dynamic | 改进版相对 Projection |
|---|---:|---:|---:|---:|---:|
| 输入 Token | 78,203.50 | 69,685.00 | 73,919.60 | −5.48% | +6.08% |
| 输出 Token | 4,867.50 | 4,669.60 | 4,616.50 | −5.16% | −1.14% |
| 总 Token | 83,071.00 | 74,354.60 | 78,536.10 | −5.46% | +5.62% |
| 模型轮次 | 6.60 | 6.30 | 7.40 | +0.80 次 | +1.10 次 |
| 工具调用 | 6.00 | 6.10 | 6.70 | +0.70 次 | +0.60 次 |
| 耗时 | 145.33 s | 122.32 s | 160.27 s | +10.28% | +31.03% |
| P95 耗时 | 233.10 s | 194.97 s | 255.81 s | +9.74% | +31.21% |

| 组 | Dynamic 总 Token | Projection 总 Token | Projection-linked 总 Token | 改进版相对当前 Projection |
|---|---:|---:|---:|---:|
| 1 | 71,813 | 77,674 | 101,319 | +23,645 |
| 2 | 76,153 | 81,879 | 82,264 | +385 |
| 3 | 90,029 | 55,171 | 69,590 | +14,419 |
| 4 | 71,580 | 85,651 | 77,812 | −7,839 |
| 5 | 85,601 | 100,317 | 54,500 | −45,817 |
| 6 | 77,209 | 56,447 | 78,886 | +22,439 |
| 7 | 85,833 | 82,185 | 68,572 | −13,613 |
| 8 | 98,004 | 78,277 | 59,557 | −18,720 |
| 9 | 94,678 | 69,131 | 81,039 | +11,908 |
| 10 | 79,810 | 56,814 | 111,822 | +55,008 |

改进版相对 Dynamic 的平均总 Token 降幅达到了 5% 门槛，输入下降的组数为 5/10，低于 7/10 的门槛。平均模型轮次、工具调用也上升，成本验收未通过。相对同批当前 Projection，改进版 4/10 组节省输入与总量，整批多用 41,815 Token。当前 Projection 相对 Dynamic 的平均总 Token 下降 10.49%，输入下降 6/10 组，平均工具调用增加 0.10 次。两种 Projection 在本批都未达完整门槛。

本批 Dynamic 和当前 Projection 分别有 2/10 和 1/10 条轨迹将完整表留在单独的调用。改进版 10/10 条轨迹都在阶段写入调用中输出完整表。改进版的 32 次模型可见投影均来自现有绑定路径，跨调用投影为 0/74 轮。没有经过跨调用投影的完整任务轨迹可用于估计该路径对整次任务成本的影响。同前缀实验对新增路径的直接输入节省提供了单独的证据。

## 真实串行延迟复测与校准回退

串行首批三组三版本均自然结束，9/9 次产物通过独立复算，61/61 轮有供应商 usage。第 2 组当前版把质控表分段输出，改进版只显示了部分表，原在线判定都接受了文件。按完整任务审计，这两次缺少单次完整表输出，整批完整任务审计为 7/9。新增所有模式共用的在线检查，模型拿到缺项反馈后可以补做完整读出。首批留在原目录。

| 串行首批 | Dynamic | Projection | Projection-linked |
|---|---:|---:|---:|
| 平均总 Token | 53,660.33 | 78,438.00 | 93,771.00 |
| 平均端到端秒数 | 52.05 | 52.62 | 68.56 |
| P95 端到端秒数 | 58.65 | 58.28 | 81.16 |
| 平均客户端模型请求总耗时每次任务 | 51.04 s | 51.56 s | 67.12 s |
| 平均工具调用总耗时每次任务 | 701.67 ms | 760.00 ms | 1,080.67 ms |
| Context 组装 P95 | 3.65 ms | 3.39 ms | 3.69 ms |

所有模式启用完整质控表检查后，在新目录重跑三组。9/9 次自然结束并通过文件与完整表审计，82/82 轮供应商 usage 可对账。受控补做流程另有 3/3 通过，原输出分段时三组都收到反馈并补交单次完整表。真实复验 8/9 条轨迹收到过补做反馈。改进版在第 1 组的 5 个模型轮次实际替换跨调用读出。

| 串行复验 | Dynamic | Projection | Projection-linked |
|---|---:|---:|---:|
| 平均总 Token | 120,003.33 | 82,180.00 | 86,934.67 |
| 平均工具调用 | 8.67 | 8.67 | 10.67 |
| 平均端到端秒数 | 116.26 | 83.94 | 108.02 |
| P95 端到端秒数 | 179.50 | 113.32 | 161.31 |
| 平均客户端模型请求总耗时每次任务 | 114.66 s | 82.59 s | 106.30 s |
| 平均工具调用总耗时每次任务 | 1,149.00 ms | 1,009.00 ms | 1,333.67 ms |
| Context 组装 P95（含组装内模型压缩） | 18,210.38 ms | 17,532.90 ms | 3.35 ms |

复验中，改进版相对 Dynamic 总 Token 降低 27.56%，P95 耗时下降 10.13%。相对同批当前 Projection，总 Token 增加 5.79%，P95 耗时增加 42.35%。Context 组装耗时包含组装期间的模型压缩请求，与模型请求计时可能重叠。串行复验每模式仅三次，P95 按线性插值计算，两批对 Dynamic 的时延差方向相反。本批改进版平均工具调用额外增加 2 次，结合完整十组对照判定为未达到试点门槛。

仪器校准按三种模式各跑一次，3/3 自然结束，五件产物都通过独立复算，22/22 轮有供应商 usage。Dynamic、Projection、Projection-linked 分别使用 37,793、40,372、48,246 个总 Token，均走 Dynamic 模型输入路径。两个投影组分别在 0/7 和 0/8 轮采用候选。这组三次运行用于确认短工具结果的自然回退行为。

## 结论与日志

跨调用绑定通过受控用例和真实同前缀机制验收。在原始历史相同的模型请求中，改进版用同一产物版本的证据替换独立读出，首轮输入少 2,098 Token。真实续跑及两批完整任务均记录了模型轮次和工具调用变化。十组普通任务中跨调用路径出现 0 次，串行复验中出现 1/3 条改进版轨迹。十组完整对照及串行复验里，改进版平均总 Token 都高于同批当前 Projection，未达到限定试点门槛。

| 批次 | 日志目录 |
|---|---|
| 首次、第二次受控尝试 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-controlled-20261124`、`D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-controlled-20261124-r2` |
| 受控验收、补做反馈和回归 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-controlled-20261124-r3` |
| 真实同前缀 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-fork-20261124-r4\fork` |
| 真实完整十组 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-triple-20261124-r4` |
| 串行首批 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-serial-20261124\serial` |
| 串行复验 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\solar-linked-serial-20261124-r2\serial` |
| 校准真实回退 | `D:\work\agent\packre\sciencediscovery-analysis\test\benchmarks\research-spine-value-validation\logs\calibration-linked-20261124-r2\serial` |

各批保留运行清单 `results.json`、逐次 `events.jsonl` 和 Context Trace。完整对照另有 `paired-evidence.md`，冻结实验有 `fork-evidence.md` 和 `fork-prefix.json`，串行各批有 `serial-evidence.md`。前置真实尝试位于同一日志根目录，名称以 `solar-linked-fork-20261124`、`solar-linked-triple-20261124` 开头。复现命令见 Benchmark README。[复现命令](./README.md)
