import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Empty, Modal, Tag, message } from "antd";
import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";

import { deleteBackendGenerationLogs, fetchBackendGenerationLogs, backendMediaUrl, type BackendGenerationLog as GenerationLog } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

const PAGE_SIZE = 30;
const ESTIMATED_ROW_HEIGHT = 220;

export function CanvasGenerationLogDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const connected = useBackendStore((state) => state.connected);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const load = useCallback(async () => {
        if (!connected || !projectId) return;
        setLoading(true);
        try {
            const page = (await fetchBackendGenerationLogs({ projectId, limit: PAGE_SIZE, offset: 0 })).logs || [];
            setLogs(page);
            setHasMore(page.length === PAGE_SIZE);
        } finally { setLoading(false); }
    }, [connected, projectId]);
    const loadMore = useCallback(async () => {
        if (!connected || !projectId || loading || loadingMore || !hasMore) return;
        setLoadingMore(true);
        try {
            const page = (await fetchBackendGenerationLogs({ projectId, limit: PAGE_SIZE, offset: logs.length })).logs || [];
            setLogs((current) => [...current, ...page.filter((item) => !current.some((existing) => existing.id === item.id))]);
            setHasMore(page.length === PAGE_SIZE);
        } finally { setLoadingMore(false); }
    }, [connected, hasMore, loading, loadingMore, logs.length, projectId]);
    useEffect(() => { if (open) void load(); }, [load, open]);
    const remove = async (id?: string) => {
        if (!connected) return;
        await deleteBackendGenerationLogs(id ? { id } : { projectId });
        await load();
    };
    return <Modal title={`生成日志${logs.length ? ` (${logs.length}${hasMore ? "+" : ""})` : ""}`} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden>
        <div className="mb-3 flex justify-end"><Button danger size="small" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={() => void remove()}>清空日志</Button></div>
        {!connected ? <Empty description="Canvas Agent 未连接" /> : !logs.length ? <Empty description={loading ? "加载中…" : "暂无生成日志"} /> : <LogList logs={logs} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} onDelete={(id) => void remove(id)} />}
    </Modal>;
}

function LogList({ logs, hasMore, loadingMore, onLoadMore, onDelete }: { logs: GenerationLog[]; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onDelete: (id: string) => void }) {
    // 普通文档流渲染（每页 30 条，无需虚拟化）。之前的手写虚拟列表用 absolute+top 定位，
    // 行高靠 getBoundingClientRect 测量——antd Modal 打开动画（transform 缩放）期间测得
    // 偏小的行高且 ResizeObserver 事后不重报，导致条目相互重叠错位；删除/刷新后按索引
    // 缓存的高度也会错配。改回流式布局后此类错位不存在。
    const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        if (hasMore && element.scrollTop + element.clientHeight >= element.scrollHeight - 600) onLoadMore();
    };
    return <div onScroll={onScroll} className="max-h-[65vh] overflow-y-auto pr-1">
        <div className="flex flex-col gap-3">
            {logs.map((log) => <LogCard key={log.id} log={log} onDelete={() => onDelete(log.id)} />)}
        </div>
        {loadingMore ? <div className="py-2 text-center text-xs text-stone-500">加载更多…</div> : null}
    </div>;
}

function collectReferences(log: GenerationLog): Array<Record<string, unknown>> {
    const refs = Array.isArray(log.references) ? [...log.references] : [];
    const hasUrl = (item: Record<string, unknown>) => (typeof item.url === "string" && item.url) || (typeof item.storageKey === "string" && item.storageKey);
    const add = (item: Record<string, unknown>) => { if (item && !refs.some((ref) => ref.url === item.url && ref.storageKey === item.storageKey)) refs.push(item); };
    const pushRefs = (source: unknown) => {
        if (!source || typeof source !== "object") return;
        if (Array.isArray(source)) { source.filter((item) => item && typeof item === "object").forEach((item) => add(item as Record<string, unknown>)); return; }
        const record = source as Record<string, unknown>;
        for (const key of ["image", "video", "audio"]) {
            const list = record[key];
            if (Array.isArray(list)) list.filter((item) => item && typeof item === "object").forEach((item) => add({ ...item, type: typeof (item as Record<string, unknown>).type === "string" ? (item as Record<string, unknown>).type : key } as Record<string, unknown>));
        }
        if (Array.isArray(record.refItems)) record.refItems.filter((item) => item && typeof item === "object").forEach((item) => add(item as Record<string, unknown>));
    };
    const params = typeof log.params === "object" && log.params ? (log.params as Record<string, unknown>) : {};
    if (params.refs) pushRefs(params.refs);
    if (params.refItems) pushRefs(params.refItems);
    // 如果顶层 references 已经全都有 url，保持原样；否则用 params 中补充到的完整 ref 替换
    return refs.length && refs.every(hasUrl) ? refs : refs.filter(hasUrl).length ? refs.filter(hasUrl) : refs;
}

function LogCard({ log, onDelete }: { log: GenerationLog; onDelete: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const copy = async (value: string) => { await navigator.clipboard?.writeText(value); message.success("已复制"); };
    const statusColor = log.status === "success" ? "green" : log.status === "failed" ? "red" : log.status === "running" ? "processing" : "default";
    const references = collectReferences(log);
    return <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
        <div className="flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-1.5"><Tag color={statusColor}>{log.status}</Tag><Tag>{log.platform}</Tag>{log.taskMode ? <Tag>{log.taskMode}</Tag> : null}{log.model ? <Tag>{log.model}</Tag> : null}<span className="text-xs text-stone-500">{new Date(log.createdAt).toLocaleString()} · {Math.round(log.durationMs / 1000)}s</span></div><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /></div>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-stone-500"><span>节点：{log.nodeId || "-"}</span><span>Clip：{log.segmentId || "-"}</span><span>任务：{log.runtimeTaskId || log.promptId || "等待任务 ID"}</span></div>
        {references.length ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="self-start pt-1 text-stone-500">输入 refs：</span>{references.map((reference, index) => <ReferencePreview key={`${log.id}-ref-${index}`} reference={reference} index={index} />)}</div> : null}
        {log.prompt ? <ExpandableText label="提示词" value={log.prompt} expanded={expanded} onToggle={() => setExpanded((value) => !value)} onCopy={() => void copy(log.prompt || "")} /> : null}
        {log.error ? <ExpandableText label="错误" value={log.error} expanded={expanded} error onToggle={() => setExpanded((value) => !value)} onCopy={() => void copy(log.error || "")} /> : null}
        {log.outputs.length ? <div className="mt-3 grid grid-cols-4 gap-2">{log.outputs.map((output, index) => <Output key={`${log.id}-${index}`} output={output} />)}</div> : null}
    </div>;
}

function ReferencePreview({ reference, index }: { reference: Record<string, unknown>; index: number }) {
    const storageKey = typeof reference.storageKey === "string" && reference.storageKey ? reference.storageKey : "";
    const url = storageKey ? backendMediaUrl(storageKey) : String(reference.url || "");
    const rawType = String(reference.type || "").toLowerCase();
    const mimeType = String(reference.mimeType || "").toLowerCase();
    const name = String(reference.name || "").toLowerCase();
    const inferred = inferMediaType(rawType, mimeType, url, name);
    const label = `${inferred.label} ${index + 1}`;
    const fallbackName = typeof reference.name === "string" && reference.name.trim() ? reference.name.trim() : undefined;
    if (!url) return <Tag title={fallbackName || label}>{fallbackName || label}</Tag>;
    // 固定预览框尺寸，预留布局空间，避免缩略图陆续加载时反复触发重排/重绘
    if (inferred.kind === "image") return <div style={{ width: 96, height: 64, flex: "0 0 auto", borderRadius: 6, overflow: "hidden", background: "rgba(120,120,120,0.10)" }}><img src={url} alt={fallbackName || label} title={fallbackName || label} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /></div>;
    if (inferred.kind === "video") return <div style={{ width: 112, height: 64, flex: "0 0 auto", borderRadius: 6, overflow: "hidden", background: "#000" }}><video src={url} title={fallbackName || label} controls muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>;
    if (inferred.kind === "audio") return <audio src={url} title={fallbackName || label} controls preload="metadata" className="h-8 w-52" />;
    return <Tag title={fallbackName || label}>{fallbackName || label}</Tag>;
}

function inferMediaType(rawType: string, mimeType: string, url: string, name = "") {
    if (rawType.includes("image") || mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|svg)(?:\?|#|$)/i.test(url) || /\.(png|jpe?g|webp|gif|bmp|avif|svg)(?:\?|#|$)/i.test(name)) return { kind: "image" as const, label: "图片" };
    if (rawType.includes("video") || mimeType.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v|flv)(?:\?|#|$)/i.test(url) || /\.(mp4|mov|mkv|webm|avi|m4v|flv)(?:\?|#|$)/i.test(name)) return { kind: "video" as const, label: "视频" };
    if (rawType.includes("audio") || mimeType.startsWith("audio/") || /\.(mp3|wav|flac|aac|ogg|m4a|wma)(?:\?|#|$)/i.test(url) || /\.(mp3|wav|flac|aac|ogg|m4a|wma)(?:\?|#|$)/i.test(name)) return { kind: "audio" as const, label: "音频" };
    return { kind: "unknown" as const, label: "参考" };
}

function ExpandableText({ label, value, expanded, error, onToggle, onCopy }: { label: string; value: string; expanded: boolean; error?: boolean; onToggle: () => void; onCopy: () => void }) {
    const collapsible = value.split(/\r?\n/).length > 5 || value.length > 360;
    return <div className={`mt-2 rounded ${error ? "bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300" : ""}`}><div className="flex gap-2 p-2 text-sm"><div className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${collapsible && !expanded ? "line-clamp-5" : ""}`}><span className="mr-1 text-xs text-stone-500">{label}：</span>{value}</div><Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={onCopy} /></div>{collapsible ? <Button type="text" size="small" className="!h-7 !w-full !text-xs" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={onToggle}>{expanded ? "收起" : "展开"}</Button> : null}</div>;
}

function Output({ output }: { output: Record<string, unknown> }) {
    const storageKey = typeof output.storageKey === "string" && output.storageKey ? output.storageKey : "";
    const url = storageKey ? backendMediaUrl(storageKey) : String(output.url || output.localUrl || "");
    const video = String(output.mimeType || output.type || "").startsWith("video");
    const [failed, setFailed] = useState(false);
    if (!url) return null;
    if (failed) return <a href={url} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-500 hover:underline">{String(output.name || url)}（加载失败，点击新窗口打开）</a>;
    return video ? <video src={url} controls muted playsInline onError={() => setFailed(true)} className="aspect-video w-full rounded object-cover" /> : <img src={url} alt="output" loading="lazy" decoding="async" onError={() => setFailed(true)} className="aspect-video w-full rounded object-cover" />;
}
