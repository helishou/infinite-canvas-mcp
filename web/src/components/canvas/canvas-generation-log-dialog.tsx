import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Empty, Modal, Segmented, Tag, message } from "antd";
import { ChevronDown, ChevronUp, Copy, Maximize2, Trash2 } from "lucide-react";

import { deleteBackendGenerationLogs, fetchBackendGenerationLogs, backendMediaUrl, type BackendGenerationLog as GenerationLog } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

const PAGE_SIZE = 30;
const ESTIMATED_ROW_HEIGHT = 220;

type LogKind = "image" | "video" | "audio" | "text" | "workflow" | "other";
type LogFilterKind = LogKind | "all";

const KIND_TABS: Array<{ value: LogFilterKind; label: string }> = [
    { value: "all", label: "全部" },
    { value: "image", label: "生图" },
    { value: "video", label: "生视频" },
    { value: "audio", label: "生音频" },
    { value: "text", label: "生文" },
    { value: "workflow", label: "工作流" },
    { value: "other", label: "其他" },
];

const KIND_LABEL: Record<LogKind, string> = { image: "生图", video: "生视频", audio: "生音频", text: "生文", workflow: "工作流", other: "其他" };
const KIND_COLOR: Record<LogKind, string | undefined> = { image: "blue", video: "purple", audio: "orange", text: "cyan", workflow: "geekblue", other: undefined };

/** 归类单条日志：先看 outputs 的实际媒体，再用 platform/model 推断。
 *  卡片类型标签与筛选按钮共用这一个函数，保证两边永远一致。 */
function logKind(log: GenerationLog): LogKind {
    const platform = String(log.platform || "").toLowerCase();
    const model = String(log.model || "").toLowerCase();
    if (platform === "workflow" || /\.json$/.test(model)) return "workflow";
    if (/text|llm|chat|completion/.test(platform)) return "text";
    const media = outputMediaKind(log.outputs);
    if (media) return media;
    if (platform.includes("image")) return "image";
    if (platform.includes("h3") || platform.includes("video")) return "video";
    if (platform.includes("audio") || platform.includes("tts") || platform.includes("speech")) return "audio";
    return "other";
}

function outputMediaKind(outputs: Array<Record<string, unknown>> | undefined): "image" | "video" | "audio" | "" {
    for (const output of outputs || []) {
        const value = `${output?.mimeType || ""} ${output?.type || ""}`.toLowerCase();
        if (/video|mp4|webm|mov/.test(value)) return "video";
        if (/audio|mp3|wav|m4a/.test(value)) return "audio";
        if (/image|png|jpe?g|webp/.test(value)) return "image";
    }
    return "";
}

export function CanvasGenerationLogDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const connected = useBackendStore((state) => state.connected);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [kind, setKind] = useState<LogFilterKind>("all");
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
    // 筛选只作用于视图：logs 始终保留后端已拉取的全量，分页 offset 不受筛选影响
    const visible = useMemo(() => kind === "all" ? logs : logs.filter((log) => logKind(log) === kind), [kind, logs]);
    const kindOptions = useMemo(() => {
        const counts: Record<LogFilterKind, number> = { all: logs.length, image: 0, video: 0, audio: 0, text: 0, workflow: 0, other: 0 };
        for (const log of logs) counts[logKind(log)] += 1;
        return KIND_TABS.map((tab) => ({ value: tab.value, label: `${tab.label} ${counts[tab.value]}` }));
    }, [logs]);
    return <Modal title={`生成日志${logs.length ? ` (${logs.length}${hasMore ? "+" : ""})` : ""}`} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented size="small" value={kind} options={kindOptions} onChange={(value) => setKind(value as LogFilterKind)} />
            <Button danger size="small" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={() => void remove()}>清空日志</Button>
        </div>
        {!connected ? <Empty description="Canvas Agent 未连接" /> : !logs.length ? <Empty description={loading ? "加载中…" : "暂无生成日志"} /> : visible.length ? <LogList logs={visible} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} onDelete={(id) => void remove(id)} /> : <Empty description="当前筛选下暂无日志">{hasMore ? <Button size="small" loading={loadingMore} onClick={() => void loadMore()}>继续加载更多</Button> : null}</Empty>}
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

function actualSubmissionText(params: unknown) {
    const submission = params && typeof params === "object" ? (params as Record<string, unknown>).actualSubmission : undefined;
    if (!submission || typeof submission !== "object") return "";
    const value = submission as Record<string, unknown>;
    const loras = Array.isArray(value.loras) ? value.loras.map((item) => item && typeof item === "object" ? `${String((item as Record<string, unknown>).name || "")} @ ${String((item as Record<string, unknown>).strength ?? "")}`.trim() : "").filter(Boolean).join("，") : "";
    // 媒体槽位：图片N/视频N/音频N 是「上一段成品被当成视频1 塞进来」这类隐式注入唯一的可见证据。
    const media = value.mediaInputs && typeof value.mediaInputs === "object" ? value.mediaInputs as Record<string, unknown> : undefined;
    const slotText = (key: string, prefix: string) => {
        const list = media && Array.isArray(media[key]) ? media[key] as unknown[] : [];
        const names = list.map((item) => String(item || "")).filter(Boolean);
        return `${prefix}${names.length}：${names.length ? names.map((name, index) => `${prefix}${index + 1}=${name}`).join("，") : "无"}`;
    };
    return [
        `ComfyUI promptId：${String(value.promptId || "-")}`,
        `Seed：${String(value.seed ?? "-")}`,
        `帧数：${String(value.frames ?? "-")}`,
        `分辨率：${value.width && value.height ? `${value.width} × ${value.height}` : "-"}`,
        `LoRA：${loras || "无"}`,
        `注意力：${String(value.attention || "-")}`,
        `Sigma：${String(value.sigma || "-")}`,
        ...(media ? [slotText("images", "图片"), slotText("videos", "视频"), slotText("audios", "音频")] : []),
    ].join("\n");
}

function LogCard({ log, onDelete }: { log: GenerationLog; onDelete: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const [preview, setPreview] = useState<{ url: string; video: boolean; name?: string } | null>(null);
    const copy = async (value: string) => { await navigator.clipboard?.writeText(value); message.success("已复制"); };
    const statusColor = log.status === "success" ? "green" : log.status === "failed" ? "red" : log.status === "running" ? "processing" : "default";
    const references = collectReferences(log);
    const actualSubmission = actualSubmissionText(log.params);
    const kind = logKind(log);
    const typeLabel = kind === "other" ? String(log.platform || "其他") : KIND_LABEL[kind];
    const openPreview = useCallback((url: string, video: boolean, name?: string) => {
        if (!url) return;
        setPreview({ url, video, name });
    }, []);
    return <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
        <div className="flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-1.5"><Tag color={KIND_COLOR[kind]}>{typeLabel}</Tag><Tag color={statusColor}>{log.status}</Tag><Tag>{log.platform}</Tag>{log.taskMode ? <Tag>{log.taskMode}</Tag> : null}{log.model ? <Tag>{log.model}</Tag> : null}<span className="text-xs text-stone-500">{new Date(log.createdAt).toLocaleString()} · {Math.round(log.durationMs / 1000)}s</span></div><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /></div>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-stone-500"><span>节点：{log.nodeId || "-"}</span><span>Clip：{log.segmentId || "-"}</span><span>任务：{log.runtimeTaskId || log.promptId || "等待任务 ID"}</span></div>
        {references.length ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="self-start pt-1 text-stone-500">输入 refs：</span>{references.map((reference, index) => <ReferencePreview key={`${log.id}-ref-${index}`} reference={reference} index={index} onPreview={openPreview} />)}</div> : null}
        {log.prompt ? <ExpandableText label="提示词" value={log.prompt} expanded={expanded} onToggle={() => setExpanded((value) => !value)} onCopy={() => void copy(log.prompt || "")} /> : null}
        {actualSubmission ? <ExpandableText label="实际提交配置" value={actualSubmission} expanded={expanded} onToggle={() => setExpanded((value) => !value)} onCopy={() => void copy(actualSubmission)} /> : null}
        {log.error ? <ExpandableText label="错误" value={log.error} expanded={expanded} error onToggle={() => setExpanded((value) => !value)} onCopy={() => void copy(log.error || "")} /> : null}
        {log.outputs.length ? <div className="mt-3 grid grid-cols-4 gap-2">{log.outputs.map((output, index) => <Output key={`${log.id}-${index}`} output={output} onPreview={openPreview} />)}</div> : null}
        <Modal open={!!preview} onCancel={() => setPreview(null)} footer={null} width="80%" destroyOnHidden title={preview?.name} centered>
            {preview?.video
                ? <video src={preview.url} controls autoPlay playsInline style={{ width: "100%", maxHeight: "70vh", display: "block", background: "#000" }} />
                : <img src={preview?.url} alt={preview?.name || "preview"} style={{ width: "100%", maxHeight: "70vh", display: "block", objectFit: "contain", background: "#111" }} />}
        </Modal>
    </div>;
}

function ReferencePreview({ reference, index, onPreview }: { reference: Record<string, unknown>; index: number; onPreview?: (url: string, video: boolean, name?: string) => void }) {
    const storageKey = typeof reference.storageKey === "string" && reference.storageKey ? reference.storageKey : "";
    const url = storageKey ? backendMediaUrl(storageKey) : String(reference.url || "");
    const rawType = String(reference.type || "").toLowerCase();
    const mimeType = String(reference.mimeType || "").toLowerCase();
    const name = String(reference.name || "").toLowerCase();
    const inferred = inferMediaType(rawType, mimeType, url, name);
    const label = `${inferred.label} ${index + 1}`;
    const fallbackName = typeof reference.name === "string" && reference.name.trim() ? reference.name.trim() : undefined;
    const openPreview = (event: React.MouseEvent) => {
        event.stopPropagation();
        onPreview?.(url, inferred.kind === "video", fallbackName || label);
    };
    const previewButton = onPreview && (inferred.kind === "image" || inferred.kind === "video") ? (
        <button
            type="button"
            onClick={openPreview}
            aria-label="放大预览"
            title={fallbackName ? `放大预览：${fallbackName}` : "放大预览"}
            className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded border border-white/15 bg-black/60 text-white/85 opacity-0 transition hover:border-sky-300 hover:bg-sky-700 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
        >
            <Maximize2 className="size-3.5" />
        </button>
    ) : null;
    if (!url) return <Tag title={fallbackName || label}>{fallbackName || label}</Tag>;
    // 固定预览框尺寸，预留布局空间，避免缩略图陆续加载时反复触发重排/重绘
    if (inferred.kind === "image") return <div className="group relative" style={{ width: 96, height: 64, flex: "0 0 auto", borderRadius: 6, overflow: "hidden", background: "rgba(120,120,120,0.10)" }}><img src={url} alt={fallbackName || label} title={fallbackName || label} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />{previewButton}</div>;
    if (inferred.kind === "video") return <div className="group relative" style={{ width: 112, height: 64, flex: "0 0 auto", borderRadius: 6, overflow: "hidden", background: "#000" }}><video src={url} title={fallbackName || label} controls muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} />{previewButton}</div>;
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

function Output({ output, onPreview }: { output: Record<string, unknown>; onPreview?: (url: string, video: boolean, name?: string) => void }) {
    const storageKey = typeof output.storageKey === "string" && output.storageKey ? output.storageKey : "";
    const url = storageKey ? backendMediaUrl(storageKey) : String(output.url || output.localUrl || "");
    const video = String(output.mimeType || output.type || "").startsWith("video");
    const [failed, setFailed] = useState(false);
    const name = typeof output.name === "string" && output.name.trim() ? output.name.trim() : undefined;
    if (!url) return null;
    if (failed) return <a href={url} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-500 hover:underline">{name || url}（加载失败，点击新窗口打开）</a>;
    const openPreview = (event: React.MouseEvent) => {
        event.stopPropagation();
        onPreview?.(url, video, name);
    };
    const mediaProps = {
        onError: () => setFailed(true),
        title: name || "output",
        className: "aspect-video w-full rounded object-cover",
    };
    const previewButton = (
        <button
            type="button"
            onClick={openPreview}
            aria-label="放大预览"
            title={name ? `放大预览：${name}` : "放大预览"}
            className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded border border-white/15 bg-black/60 text-white/85 opacity-0 transition hover:border-sky-300 hover:bg-sky-700 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
        >
            <Maximize2 className="size-3.5" />
        </button>
    );
    return video ? (
        <div className="group relative">
            <video src={url} controls muted playsInline {...mediaProps} />
            {previewButton}
        </div>
    ) : (
        <div className="group relative">
            <img src={url} alt={name || "output"} loading="lazy" decoding="async" {...mediaProps} />
            {previewButton}
        </div>
    );
}
