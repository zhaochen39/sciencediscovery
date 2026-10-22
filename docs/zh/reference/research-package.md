# ScienceDiscovery 科研证据包

ScienceDiscovery 使用 `.sdresearch` 作为科研证据包的文件后缀。证据包由 `research-package` 插件提供，插件在构建时安装并由宿主显式启用；包本身只是数据格式，不是可执行插件。

## 首版格式

首版格式标识为 `sciencediscovery-research-package`，schema version 为 `1`，默认 `packageKind` 为 `evidence`。归档采用 tar+gzip，包含：

- `manifest.json`：格式版本、来源项目/会话、生产者版本、包类型、文件清单和遗漏说明；
- `records.json`：结构化科研记录，例如主张、证据引用和运行元数据；
- `README.md`：面向人的包说明；
- `objects/<sha256>`：按 SHA-256 内容寻址的证据对象、日志或产物。

导出时会为每个记录和对象写入大小与 SHA-256 校验值。导入和 inspect 会先校验归档路径、文件类型、重复项、大小限制、清单完整性和所有校验值，再解析记录。导入接口返回只读结果；它不会运行对象、脚本、命令或包内的任何代码。

Web 可从每个会话的“更多会话操作 → 导出”进入会话导出或证据包导出。会话导出支持 Markdown 和浏览器打印为 PDF，并可选择整段对话或指定 Prompt 及其后续回复。证据包支持“必要导出”和“完整导出”，也可以选择包含的工作区文件。

必要导出包含所选会话历史、当前工作区文件、最新产物版本和已有验证记录。完整导出还包含该会话所有可用产物版本、运行事件和工作区文件修订元数据。`.sdresearch` 导入会在目标项目创建或使用的会话中恢复消息、运行、工作区文件、Notebook 文件、产物版本与验证记录；跨会话产物仍归属于来源会话，不能通过会话 A 的文件列表进入会话 B。

## 能力边界

校验通过表示包内字节完整、格式正确，并不表示科研结论已经被复现。要得到可复现结论，还需要在目标环境中具备相同或兼容的代码、数据、模型、依赖、硬件和随机性控制条件。`verified-reproduction` 与 `combined` 类型已预留，后续可以在不改变后缀的情况下扩展清单和复现元数据。

## 宿主接入

`research-package` 插件的 provider 已接入 API 和 Web 宿主：

- `GET /api/projects/:projectId/research-package?sessionId=...` 导出项目或指定会话；
- `POST /api/projects/:projectId/research-package/inspect` 只校验并返回包摘要；
- `POST /api/projects/:projectId/research-package/import?sessionId=...` 导入并保存包。

导出会自动收集项目/会话元数据、会话消息、运行记录、Artifact 版本和工作区文件；大对象以 `objects/<sha256>` 保存，记录中保留对应引用。导入会将可映射的记录写入目标项目数据目录，并保留原始包供审计：

```text
projects/<projectId>/research-packages/<packageChecksum>/
  manifest.json
  records.json
  README.md
  objects/<sha256>
  receipt.json
```

旧版本包若没有工作区当前文件或历史运行/验证记录，系统无法从哈希或元数据重建这些内容，会在 receipt 中保留相应遗漏说明。完整包中的工作区修订目前保存完整修订元数据及当前文件字节；旧修订字节与独立 Notebook 执行历史尚未持久化，因此不承诺恢复它们。运行中的任务导入后会标记为已取消，不会自动重跑；跨环境获得相同结论还需要兼容的软件、数据、模型、硬件与随机性设置。
