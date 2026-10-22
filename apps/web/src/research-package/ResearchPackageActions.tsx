import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api.js";
import type { ChatMessage } from "@sciencediscovery/schema";

export type ResearchPackageDialogTarget = { projectId: string; sessionId: string; kind: "conversation" | "package" | "import" };
type DialogProps = { client: ApiClient; target: ResearchPackageDialogTarget; onClose: () => void; onImported?: (sessionIds: string[]) => Promise<void> };

function DialogFrame({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const section = ref.current;
    section?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab" || !section) return;
      const items = [...section.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), summary, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} aria-modal="true" aria-label={title} className="research-export-dialog" role="dialog">
      <header className="research-export-header"><div><span className="eyebrow">ScienceDiscovery</span><h2>{title}</h2><p>{description}</p></div><button aria-label="关闭" className="icon-button" onClick={onClose} type="button">×</button></header>
      {children}
    </section>
  </div>;
}
function ChoiceCard({ checked, title, description, onClick }: { checked: boolean; title: string; description: string; onClick: () => void }) {
  return <button aria-pressed={checked} className={checked ? "research-choice-card selected" : "research-choice-card"} onClick={onClick} type="button"><span><strong>{title}</strong><small>{description}</small></span><span className="research-choice-radio" aria-hidden="true">{checked ? "✓" : ""}</span></button>;
}
function download(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = href; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : "操作失败，请重试";
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

function ConversationExportDialog({ client, target, onClose }: DialogProps) {
  const [format, setFormat] = useState<"markdown" | "pdf">("markdown");
  const [scope, setScope] = useState<"all" | "custom">("all");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState("读取会话…");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void client.getSession(target.sessionId).then((detail) => {
      if (!active) return;
      const prompts = detail.messages.filter((item) => item.role === "user" && (!item.kind || item.kind === "message"));
      setTitle(detail.title); setMessages(prompts); setSelectedIds(prompts.map((item) => item.id));
    }).catch((reason: unknown) => { if (active) setError(errorText(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, target.sessionId]);
  const exportConversation = async () => {
    setBusy(true); setError(undefined);
    const printWindow = format === "pdf" ? window.open("about:blank", "_blank") : null;
    try {
      if (format === "pdf" && !printWindow) throw new Error("浏览器拦截了打印窗口，请允许弹出窗口后重试");
      const blob = await client.exportConversation(target.sessionId, format, scope === "custom" ? selectedIds : undefined);
      if (printWindow) {
        const href = URL.createObjectURL(blob); printWindow.location.href = href;
        window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
      } else download(blob, `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`);
      onClose();
    } catch (reason) { printWindow?.close(); setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <DialogFrame description={title} onClose={onClose} title="导出会话">
    <div className="research-export-body">
      <fieldset><legend>格式</legend><div className="research-choice-grid"><ChoiceCard checked={format === "pdf"} description="通过浏览器打印窗口保存 PDF" onClick={() => setFormat("pdf")} title="PDF" /><ChoiceCard checked={format === "markdown"} description="保留结构，便于继续编辑" onClick={() => setFormat("markdown")} title="Markdown" /></div></fieldset>
      <fieldset><legend>内容</legend><div className="research-choice-grid"><ChoiceCard checked={scope === "all"} description="当前会话中的全部消息" onClick={() => setScope("all")} title="整个对话" /><ChoiceCard checked={scope === "custom"} description="勾选 Prompt 及其后续回复" onClick={() => setScope("custom")} title="已选择" /></div></fieldset>
      {scope === "custom" ? <div className="research-message-picker"><div className="research-picker-heading"><strong>选择 Prompt</strong><span>{selectedIds.length}/{messages.length}</span></div>{messages.map((message, index) => <label key={message.id}><input checked={selectedIds.includes(message.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} type="checkbox" /><span>{message.content.trim() || `Prompt ${index + 1}`}</span></label>)}{!messages.length ? <p>当前会话没有可导出的 Prompt。</p> : null}</div> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}
    </div>
    <footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy || loading || (scope === "custom" && !selectedIds.length)} onClick={() => void exportConversation()} type="button">{busy ? "导出中…" : `导出 ${format === "pdf" ? "PDF" : "Markdown"}`}</button></footer>
  </DialogFrame>;
}

function PackageExportDialog({ client, target, onClose }: DialogProps) {
  const [level, setLevel] = useState<"necessary" | "complete">("necessary");
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[] | undefined>();
  const [preview, setPreview] = useState<{ estimatedBytes: number; omissions: string[] }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [sessionTitle, setSessionTitle] = useState("当前会话");
  useEffect(() => {
    let active = true;
    if (typeof client.getSession !== "function") return () => { active = false; };
    void client.getSession(target.sessionId).then((detail) => {
      if (active) setSessionTitle(detail.title || "当前会话");
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client, target.sessionId]);
  useEffect(() => {
    let active = true;
    setPreview(undefined); setError(undefined);
    void client.previewResearchPackage(target.projectId, target.sessionId, level, selectedPaths).then((result) => {
      if (active) { setPreview(result); setFiles(result.files); }
    }).catch((reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [client, level, selectedPaths, target.projectId, target.sessionId]);
  const exportPackage = async () => {
    setBusy(true); setMessage(undefined); setError(undefined);
    try {
      const safeTitle = sessionTitle.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120) || "科研会话";
      download(await client.exportResearchPackage(target.projectId, target.sessionId, level, selectedPaths), `${safeTitle}.sdresearch`);
      onClose();
    }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <DialogFrame description="始终包含当前会话的研究历史。选择证据完整度和工作区文件。" onClose={onClose} title="导出证据包">
    <div className="research-export-body">
      <div className="research-choice-grid"><ChoiceCard checked={level === "necessary"} description="会话消息、当前文件和最新产物" onClick={() => setLevel("necessary")} title="必要导出" /><ChoiceCard checked={level === "complete"} description="会话历史、全部产物版本、运行事件和已有验证记录" onClick={() => setLevel("complete")} title="完整导出" /></div>
      <div className="research-export-estimate"><strong>{preview ? `预计 ${formatSize(preview.estimatedBytes)}` : "正在计算大小…"}</strong><span>研究历史与产物 · 已选择 {selectedPaths?.length ?? files.length}/{files.length} 个工作区文件</span></div>
      <details className="research-export-details"><summary>自定义内容</summary><p>勾选工作区文件。会话历史与产物始终包含；取消文件不会删除其已登记的产物版本。</p><div className="research-message-picker">
        {files.map((file) => <label key={file.path}><input checked={selectedPaths ? selectedPaths.includes(file.path) : true} onChange={(event) => setSelectedPaths((current) => { const paths = current ?? files.map((item) => item.path); return event.target.checked ? [...paths, file.path] : paths.filter((path) => path !== file.path); })} type="checkbox" /><span>{file.path} <small>{formatSize(file.size)}</small></span></label>)}
        {!files.length ? <p>当前会话没有工作区文件。</p> : null}
      </div></details>
      <p className="research-export-note">完整导出保留已有文件修订元数据及当前文件内容；Notebook 以工作区中的 .ipynb 文件保存，不会生成尚未持久化的历史内容。</p>
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}{message ? <p role="status" className="research-export-status">{message}</p> : null}
    </div>
    <footer className="dialog-actions"><span className="dialog-actions-spacer" /><button className="secondary-button" disabled={busy} onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy || !preview} onClick={() => void exportPackage()} type="button">{busy ? "处理中…" : "导出证据包"}</button></footer>
  </DialogFrame>;
}

type PackageInspectionView = {
  manifest?: { source?: { projectId?: string; title?: string; sessionIds?: string[] }; packageKind?: string; createdAt?: string; omissions?: string[] };
  files?: Array<{ path: string; sizeBytes: number; kind: string }>;
  objectCount?: number;
  recordsBytes?: number;
  totalBytes?: number;
};

type ImportStage = "select" | "review" | "importing" | "complete";

function PackageImportDialog({ client, target, onClose, onImported }: DialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<ImportStage>("select");
  const [file, setFile] = useState<File>();
  const [inspection, setInspection] = useState<PackageInspectionView>();
  const [receipt, setReceipt] = useState<{ artifactCount?: number; importedSessionIds?: string[]; omissions?: string[] }>();
  const [error, setError] = useState<string>();
  const busy = stage === "importing";
  const selectPackage = async (candidate: File) => {
    setError(undefined);
    if (!candidate.name.toLowerCase().endsWith(".sdresearch")) {
      setError("请选择 .sdresearch 科研证据包");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(candidate);
    try {
      const result = await client.inspectResearchPackage(target.projectId, candidate) as PackageInspectionView;
      setInspection(result);
      setStage("review");
    } catch (reason) {
      setFile(undefined); setInspection(undefined); setError(errorText(reason));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  const importPackage = async () => {
    if (!file) return;
    setStage("importing"); setError(undefined);
    try {
      const imported = await client.importResearchPackage(target.projectId, file, target.sessionId) as { artifactCount?: number; importedSessionIds?: string[]; omissions?: string[] };
      setReceipt(imported);
      await onImported?.(imported.importedSessionIds ?? [target.sessionId]);
      setStage("complete");
    } catch (reason) { setStage("review"); setError(errorText(reason)); }
  };
  return <DialogFrame description="仅允许导入到没有消息、运行记录、文件或产物的新会话。" onClose={busy ? () => undefined : onClose} title="导入证据包">
    {stage === "select" ? <>
      <div className="research-export-body research-import-empty"><div className="research-import-file-icon">↓</div><strong>选择科研证据包</strong><p>仅支持 ScienceDiscovery 的 .sdresearch 格式。</p>{error ? <p role="alert" className="research-export-error">{error}</p> : null}</div>
      <footer className="dialog-actions"><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" onClick={() => inputRef.current?.click()} type="button">选择证据包</button><input ref={inputRef} accept=".sdresearch" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void selectPackage(selected); }} type="file" /></footer>
    </> : null}
    {stage === "review" ? <>
      <div className="research-export-body">
        <div className="research-import-file-row"><span className="research-import-file-icon">▣</span><div><strong>{file?.name}</strong><small>{file ? formatSize(file.size) : ""}</small></div></div>
        <div className="research-import-summary"><div><span>来源</span><strong>{inspection?.manifest?.source?.title || "科研会话"}</strong></div><div><span>会话</span><strong>{inspection?.manifest?.source?.sessionIds?.length ?? 1} 个</strong></div><div><span>记录</span><strong>{formatSize(inspection?.recordsBytes ?? 0)}</strong></div><div><span>文件对象</span><strong>{inspection?.objectCount ?? 0} 个</strong></div></div>
        <p className="research-import-target">将导入到当前空会话。导入后会话消息、产物和证据记录会写入此会话。</p>
        {(inspection?.manifest?.omissions?.length ?? 0) > 0 ? <p className="research-export-note">此包包含 {inspection?.manifest?.omissions?.length} 条内容限制记录，导入后仍会保留在包记录中。</p> : null}
        {error ? <p role="alert" className="research-export-error">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={() => { setFile(undefined); setInspection(undefined); setStage("select"); }} type="button">重新选择</button><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" onClick={() => void importPackage()} type="button">导入</button></footer>
    </> : null}
    {stage === "importing" ? <div className="research-import-progress"><div className="research-import-spinner" aria-hidden="true" /><h3>正在导入研究…</h3><p>正在恢复会话、文件和产物，请保持应用打开。</p><div className="research-import-progress-track"><span /></div><small>正在校验并写入科研证据</small></div> : null}
    {stage === "complete" ? <>
      <div className="research-import-complete"><div className="research-import-success" aria-hidden="true">✓</div><h3>包操作已完成</h3><p>{file?.name}</p><div className="research-import-complete-stats"><span>{receipt?.importedSessionIds?.length ?? 1} 个会话</span><span>{receipt?.artifactCount ?? 0} 个产物</span><span>{receipt?.omissions?.length ?? 0} 条限制记录</span></div></div>
      <footer className="dialog-actions"><span className="dialog-actions-spacer" /><button className="primary-button" onClick={onClose} type="button">打开导入的会话</button></footer>
    </> : null}
  </DialogFrame>;
}
export function ResearchPackageDialogs({ client, target, onClose, onImported }: { client: ApiClient; target?: ResearchPackageDialogTarget; onClose: () => void; onImported?: (sessionIds: string[]) => Promise<void> }) {
  if (!target) return null;
  if (target.kind === "conversation") return <ConversationExportDialog client={client} onClose={onClose} target={target} />;
  if (target.kind === "import") return <PackageImportDialog client={client} onClose={onClose} onImported={onImported} target={target} />;
  return <PackageExportDialog client={client} onClose={onClose} target={target} />;
}
