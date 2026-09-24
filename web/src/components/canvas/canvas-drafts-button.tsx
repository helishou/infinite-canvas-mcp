import { useRef, useState } from "react";
import { App, Modal } from "antd";
import { ArchiveRestore } from "lucide-react";
import { saveAs } from "file-saver";
import { canvasThemes } from "@/lib/canvas-theme";
import { reopenCanvasDraftSession } from "@/lib/canvas/canvas-draft-session";
import { listCanvasDrafts, type CanvasDraftBundle } from "@/services/api/canvas-drafts";
import { useThemeStore } from "@/stores/use-theme-store";
import { importCanvasDraftBackup, parseCanvasDraftImport } from "@/services/api/canvas-draft-import";
import type { DraftImport } from "@/lib/canvas/canvas-draft-import-state";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/** 浅层摘要：绝不 stringify 整份 records。
 * 每条记录都可能带完整画布快照（本项目实测单份 ~2.2MB），全量格式化会阻塞主线程。 */
function describeDraftRecord(value: unknown): { hint: string; snapshot: boolean } {
    if (!value || typeof value !== "object") return { hint: `值类型 ${value === null ? "null" : typeof value}`, snapshot: false };
    if (Array.isArray(value)) return { hint: `数组 · ${value.length} 项`, snapshot: false };
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    if (record.projectId) parts.push(`projectId=${String(record.projectId)}`);
    if (record.ownerId) parts.push(`ownerId=${String(record.ownerId)}`);
    if (record.backend) parts.push(`backend=${String(record.backend)}`);
    if (record.baseRevision !== undefined) parts.push(`baseRevision=${String(record.baseRevision)}`);
    if (Array.isArray(record.operations)) parts.push(`operations=${record.operations.length}`);
    if (record.rejected) parts.push(`已拒绝：${String(record.rejected)}`);
    const project = (record.project || record.base || record.submitted) as Record<string, unknown> | undefined;
    if (project && typeof project === "object") {
        if (project.title) parts.push(`title=${String(project.title)}`);
        if (Array.isArray(project.nodes)) parts.push(`nodes=${project.nodes.length}`);
        if (Array.isArray(project.connections)) parts.push(`connections=${project.connections.length}`);
    }
    return { hint: parts.join(" · ") || "（无可读字段）", snapshot: Boolean(project && typeof project === "object") };
}

export function CanvasDraftsButton() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { modal, message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [bundles, setBundles] = useState<CanvasDraftBundle[]>([]);
    const [expanded, setExpanded] = useState("");
    const [expandedRecord, setExpandedRecord] = useState("");
    const [preview, setPreview] = useState<DraftImport | null>(null);
    const importProject = useCanvasStore((state) => state.importProject);
    const fileInput = useRef<HTMLInputElement>(null);
    const refresh = async () => {
        setBusy(true); setError("");
        try { setBundles(await listCanvasDrafts()); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const importBackup = async (archive: DraftImport) => {
        setBusy(true); setError("");
        try {
            await importCanvasDraftBackup(archive);
            setPreview(null);
            message.success("已导入本机草稿；选择对应会话的“恢复会话”后才会提交后台");
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally {
            try { setBundles(await listCanvasDrafts()); }
            catch (error) { setError(error instanceof Error ? error.message : String(error)); }
            setBusy(false);
        }
    };
    const buttonStyle = "rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    return <>
        <button type="button" aria-label="本机草稿" className={`flex h-8 shrink-0 items-center gap-1 whitespace-nowrap ${buttonStyle}`} style={{ color: theme.node.muted }} onClick={() => { setOpen(true); void refresh(); }}>
            <ArchiveRestore className="size-3.5" /><span>本机草稿</span>
        </button>
        <Modal title="本机未确认草稿" open={open} onCancel={() => setOpen(false)} footer={null} width={680}>
            <p className="text-sm" style={{ color: theme.node.muted }}>这里只读取当前浏览器的草稿。恢复会话会刷新页面并继续同步原操作；当前窗口草稿仍会保留。已同步内容以后台为准。</p>
            <div className="my-3 flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                <span>{busy ? "正在读取…" : `${bundles.length} 份会话草稿`}</span>
                <div className="flex gap-1">
                    <button type="button" className={buttonStyle} disabled={busy} onClick={() => fileInput.current?.click()}>导入备份</button>
                    <button type="button" className={buttonStyle} disabled={busy} onClick={() => void refresh()}>刷新列表</button>
                </div>
            </div>
            <input ref={fileInput} type="file" accept=".json,application/json" aria-label="选择草稿备份" className="hidden" onChange={async (event) => {
                const file = event.target.files?.[0]; event.target.value = "";
                if (!file) return;
                setError(""); setPreview(null);
                try { setPreview(parseCanvasDraftImport(await file.text())); }
                catch (error) { setError(error instanceof Error ? error.message : String(error)); }
            }} />
            {preview ? <section aria-label="备份导入预览" className="mb-3 border-y py-3 text-xs" style={{ borderColor: theme.node.stroke }}>
                <p className="break-all">后台：{preview.backend} · 窗口：{preview.ownerId}</p>
                <p className="my-2">共 {preview.records.length} 条记录。仅导入本机，不会立即改动画布；后续恢复会话可能继续原有编辑和项目删除意图。媒体文件不在备份中。</p>
                {preview.skipped ? <p>已跳过 {preview.skipped} 条清理记录，不会删除本机已有数据。</p> : null}
                <details className="my-2"><summary>查看待导入记录（{preview.records.length} 条）</summary>
                    <div className="mt-1 max-h-48 overflow-auto rounded border text-xs" style={{ borderColor: theme.node.stroke }}>
                        {preview.records.map((record, index) => {
                            const id = `import#${index}`;
                            const info = describeDraftRecord(record.value);
                            const open = expandedRecord === id;
                            return <div key={id} className="border-t" style={{ borderColor: theme.node.stroke }}>
                                <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setExpandedRecord(open ? "" : id)}>
                                    <span className="shrink-0">{open ? "▾" : "▸"}</span>
                                    <span className="shrink-0 opacity-60">{index + 1}.</span>
                                    <span className="shrink-0 opacity-60">{record.store}</span>
                                    <span className="min-w-0 flex-1 truncate">{info.hint}</span>
                                    {info.snapshot ? <span className="shrink-0 rounded px-1" style={{ color: theme.node.muted, border: `1px solid ${theme.node.stroke}` }}>含快照</span> : null}
                                </button>
                                {open ? <pre className="mx-2 mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(record.value, null, 2)}</pre> : null}
                            </div>;
                        })}
                    </div>
                </details>
                <button type="button" className={buttonStyle} disabled={busy} onClick={() => void importBackup(preview)}>确认导入到本机</button>
                <button type="button" className={buttonStyle} disabled={busy} onClick={() => setPreview(null)}>取消导入</button>
            </section> : null}
            {error ? <p role="alert">{error}</p> : null}
            {!busy && !bundles.length ? <p className="py-6 text-center text-sm" style={{ color: theme.node.muted }}>没有待找回的本机草稿</p> : null}
            <div className="max-h-[60vh] overflow-auto">
                {bundles.map((bundle) => <section key={bundle.key} className="border-t py-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 text-sm">
                            <div>{bundle.current ? "当前窗口" : bundle.ownerId ? `窗口 ${bundle.ownerId.slice(-8)}` : "旧记录 · 无法确认窗口归属"}</div>
                            <div className="mt-1 break-words text-xs" style={{ color: theme.node.muted }}>{bundle.projects.join("、") || "项目删除意图"}</div>
                        </div>
                        <span className="shrink-0 text-xs" style={{ color: theme.node.muted }}>{bundle.pending} 条待处理{bundle.rejected ? ` · ${bundle.rejected} 条被拒绝` : ""}</span>
                    </div>
                    <p className="my-2 text-xs" style={{ color: theme.node.muted }}>{bundle.importPending ? "备份尚未完整导入，不能恢复部分记录；可以继续导入或导出完整档案。" : !bundle.ownerId ? bundle.recoverableProjects.length ? "可将旧画布快照恢复为新 ID 的副本；未知文本和删除意图仍只供检查或导出。" : "仅检查或导出，不自动提交未知归属记录。" : bundle.current ? "当前窗口仍在持有这份草稿。" : bundle.active === true ? "另一窗口仍在使用，不能抢占。" : bundle.active === null ? "暂时无法向后台确认窗口状态，请稍后刷新或先导出备份。" : "原窗口已关闭，可以恢复整个会话（包括其中的删除意图）。"}</p>
                    <div className="flex gap-1">
                        {bundle.importPending ? <button type="button" className={buttonStyle} disabled={busy || bundle.active !== false} onClick={() => void importBackup({ backend: bundle.backend!, ownerId: bundle.ownerId!, records: bundle.records, skipped: 0 })}>继续导入</button> : null}
                        {!bundle.ownerId && bundle.recoverableProjects.length ? <button type="button" className={buttonStyle} disabled={busy} onClick={() => modal.confirm({
                            title: "恢复旧画布副本？", content: `将恢复 ${bundle.recoverableProjects.length} 个新 ID 画布，不覆盖现有画布，不执行旧文本或删除意图；原记录继续保留。`, okText: "恢复副本", cancelText: "取消",
                            onOk: () => { bundle.recoverableProjects.forEach((project) => importProject({ ...project, title: `${project.title || "旧画布"}（恢复副本）` })); message.success(`已恢复 ${bundle.recoverableProjects.length} 个画布副本`); },
                        })}>恢复画布副本</button> : null}
                        <button type="button" className={buttonStyle} disabled={busy || bundle.importPending || !bundle.ownerId || bundle.current || bundle.active !== false} onClick={() => modal.confirm({
                            title: "恢复这份会话草稿？", content: "页面会刷新，随后继续提交原会话的未确认修改与删除意图。当前会话草稿不会删除。", okText: "恢复会话", cancelText: "取消",
                            onOk: async () => { try { await reopenCanvasDraftSession(bundle.ownerId!); } catch (error) { setError(error instanceof Error ? error.message : String(error)); throw error; } },
                        })}>恢复会话</button>
                        <button type="button" className={buttonStyle} onClick={() => {
                            // 逐条 stringify 后交给 Blob 拼接：避免为 60MB+ 的 records 生成单个巨型字符串。
                            // 手工拼 JSON 而非字符串切割，保证导出文件仍能被 parseCanvasDraftImport 读回。
                            const { records, ...meta } = bundle;
                            const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n");
                            const envelope = { format: "canvas-draft-backup", version: 1, ...meta };
                            const metaLines = JSON.stringify(envelope, null, 2).slice(1, -1).replace(/\n\s*$/, "");
                            const parts = [`{${metaLines}${metaLines.trim() ? "," : ""}\n  "records": [\n`];
                            records.forEach((record, index) => {
                                parts.push(indent(JSON.stringify(record, null, 2)) + (index < records.length - 1 ? ",\n" : "\n"));
                            });
                            parts.push("  ]\n}\n");
                            saveAs(new Blob(parts, { type: "application/json" }), `canvas-draft-${bundle.ownerId?.slice(-8) || "legacy"}.json`);
                        }}>导出备份</button>
                        <button type="button" className={buttonStyle} onClick={() => setExpanded(expanded === bundle.key ? "" : bundle.key)}>{expanded === bundle.key ? "收起记录" : "查看记录"}</button>
                    </div>
                    {expanded === bundle.key ? <div className="mt-2 max-h-64 overflow-auto rounded border text-xs" style={{ borderColor: theme.node.stroke }}>
                        <div className="px-2 py-1" style={{ color: theme.node.muted }}>共 {bundle.records.length} 条记录；点单条标题才展开，避免整份快照阻塞页面。</div>
                        {bundle.records.map((record, index) => {
                            const id = `${bundle.key}#${index}`;
                            const info = describeDraftRecord(record.value);
                            const open = expandedRecord === id;
                            return <div key={id} className="border-t" style={{ borderColor: theme.node.stroke }}>
                                <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setExpandedRecord(open ? "" : id)}>
                                    <span className="shrink-0">{open ? "▾" : "▸"}</span>
                                    <span className="shrink-0 opacity-60">{index + 1}.</span>
                                    <span className="shrink-0 opacity-60">{record.store}</span>
                                    <span className="min-w-0 flex-1 truncate">{info.hint}</span>
                                    {info.snapshot ? <span className="shrink-0 rounded px-1" style={{ color: theme.node.muted, border: `1px solid ${theme.node.stroke}` }}>含快照</span> : null}
                                </button>
                                {open ? <div className="px-2 pb-2">
                                    <div className="mb-1 break-all opacity-60">{record.key}</div>
                                    <div className="mb-1 flex gap-1">
                                        <button type="button" className={buttonStyle} onClick={() => saveAs(new Blob([JSON.stringify(record.value, null, 2)], { type: "application/json" }), `canvas-draft-record-${index + 1}.json`)}>导出这一条</button>
                                    </div>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(record.value, null, 2)}</pre>
                                </div> : null}
                            </div>;
                        })}
                    </div> : null}
                </section>)}
            </div>
        </Modal>
    </>;
}
