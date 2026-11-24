# Research Spine 产品化支持范围

2026-11-26。本文描述已接入的 Native API 能力及其发布限制。普通 Run 继续使用现有执行路径。三个入口都需要既有 API 授权。

## 检查点恢复

`POST /api/sessions/{sessionId}/runs` 可附带 `researchResume: { sourceRunId, workflow }`。服务端只接受已注册的工作流 ID，且要求来源 Run 为当前会话最新完成的质控阶段。每个契约指定版本、受保护文件、完整展示证据、第一阶段复算与最终交付复算。服务端把契约版本和输入摘要封存到 CAS。已有光伏与校准检查点按 v1 兼容。

| 契约 | 开放范围 |
|---|---|
| `solar`、`calibration` | 单 API 实例、Native、本地 Runner、显式工作流和 Session 白名单，且已展示可核验的完整质控表 |
| `citations` | `full` 或 `by-state` 实验模式。白名单试点门禁会拒绝该契约。 |

试点配置使用 `SCIENCE_AGENT_RESEARCH_RECOVERY_MODE=pilot`、`SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS` 和 `SCIENCE_AGENT_RESEARCH_RECOVERY_PILOT_WORKFLOWS`。部署默认关闭。未完整展示的任务沿用普通续跑。取消设置后，新的检查点请求返回 409，之前入队的本地检查点走受限工具和完整历史。持久化任务在执行前再次检查 Runner 和 Executor 的兼容性。

## 同 Run 执行与 Spawn Receipt

客户端可在 `POST /api/sessions/{sessionId}/runs` 指定 `delegationMode: "inline"`。调度器持久化选择，Native 的主 Run 隐藏 `task` 工具。适合共享上下文且无需独立工作区的步骤。缺省委派方式沿用现有设置。Inline 与 `researchResume` 组合返回 400，远程 Runner 或 JiuwenSwarm 上的 Inline 请求返回 409。

`POST /api/sessions/{sessionId}/runs/{runId}/spawn-receipt` 为已经终结的父 Run 生成凭据。响应包括父 Run 的凭据引用，以及每个子分支的终态、成功结果引用和失败诊断。回执由持久化子 Run 计算。子 Run 尚在运行或仅有重启产生的中断占位记录时，接口返回 409。同一终态快照重复读取生成相同 CAS 摘要。此接口按需计算，父 Run 的常规提交路径不调用它。

## Node Memory

`GET /api/sessions/{sessionId}/runs/{runId}/node-memory?versionId={artifactVersionId}` 读取经复算的、有确切版本的 JSON 产物。接口核对 Session、Run、契约版本、输入文件摘要、当前工作区版本、Artifact Version 和 CAS 内容。正文上限为 64 KiB，响应禁用缓存。证据缺失、失效或归属不符时返回 409，调用方可以改走普通读取并重新核验。读取动作不修改工作区，也不会自动启动模型调用。客户端显式选择是否向后续 Run 附带取回的内容。

本地 ScienceMemory sidecar 已验证能够把已登记的 Artifact Version 链接到生成执行和输入版本。Node Memory 校验以工作区、版本存储与 CAS 为准。Scope Tree 图形界面、跨 API 共享工作区、远程 Runner 恢复、Neo4j 部署组合和 JiuwenSwarm 的新功能接入属于当前支持范围之外。Idea Tree、Evolve 和 JiuwenSwarm 原有路径执行兼容性回归。
