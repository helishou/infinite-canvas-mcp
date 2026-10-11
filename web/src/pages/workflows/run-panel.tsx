import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Progress, Select, Switch, Tag, message } from "antd";
import { Play, Trash2, Upload } from "lucide-react";
import { uploadBackendMedia, backendMediaUrl } from "@/services/backend-api";
import type { WorkflowConfig, WorkflowField, WorkflowRunResult } from "@/services/api/workflows";

/** 媒体字段上传：先传 Backend 媒体目录，运行面板和画布共用同一份 URL 语义。 */
type MediaFieldUploadProps = {
    fieldId: string;
    value: string;
    kind: "image" | "audio" | "video";
    onChange: (value: string) => void;
};

function MediaFieldUpload({ fieldId, value, kind, onChange }: MediaFieldUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [previewUrl, setPreviewUrl] = useState(value);
    const [filename, setFilename] = useState("");
    const [uploading, setUploading] = useState(false);

    const previewValue = (source: string) => {
        if (!source.startsWith("/media/")) return source;
        const storageKey = decodeURIComponent(source.slice("/media/".length).split("?", 1)[0]);
        return backendMediaUrl(storageKey);
    };

    useEffect(() => {
        setPreviewUrl(previewValue(value));
        if (!value) setFilename("");
    }, [fieldId, kind, value]);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setUploading(true);
        try {
            const media = await uploadBackendMedia({ name: file.name, blob: file, mimeType: file.type || undefined, category: "input" });
            setPreviewUrl(backendMediaUrl(media.storageKey));
            setFilename(file.name);
            onChange(media.url);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体上传失败");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <input ref={inputRef} type="file" accept={`${kind}/*`} className="hidden" onChange={handleFileChange} />
                <Button size="small" loading={uploading} icon={<Upload className="size-3" />} onClick={() => inputRef.current?.click()}>
                    {previewUrl ? `更换${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}` : `选择${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}`}
                </Button>
                {previewUrl && (
                    <>
                        <Tag color="blue" className="max-w-48 truncate text-xs">{filename || `已选择${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}`}</Tag>
                        <Button size="small" danger type="text" onClick={() => { setPreviewUrl(""); setFilename(""); onChange(""); }}>
                            <Trash2 className="size-3" />
                        </Button>
                    </>
                )}
            </div>
            {previewUrl && (
                kind === "audio"
                    ? <audio src={previewUrl} controls className="w-full" />
                    : kind === "video"
                        ? <video src={previewUrl} controls className="max-h-64 w-full rounded border border-stone-200 dark:border-stone-700" />
                        : <div className="inline-block"><img src={previewUrl} alt="" className="h-24 w-24 rounded border border-stone-200 object-cover dark:border-stone-700" /></div>
            )}
        </div>
    );
}

export type RunPanelProps = {
    config: WorkflowConfig;
    onRun: (fields: Record<string, string>) => void;
    running: boolean;
    result: WorkflowRunResult | null;
    emptyText?: string;
    runLabel?: string;
    /** 运行中的真实进度（0–1）。后端未上报时为 undefined，只显示不确定状态。 */
    progress?: number;
    /** 运行中可见的阶段说明，例如「已提交 RunningHub」。 */
    statusText?: string;
    onCancel?: () => void;
    /** 指定输出节点；为空表示不过滤。 */
    outputNodes?: string[];
    onOutputNodesChange?: (next: string[]) => void;
    /** 输出节点选择器（需要节点图才能给出候选）。 */
    outputPicker?: ReactNode;
};

/**
 * 运行页签。两个数据源共用这一个页签：本地 ComfyUI 与 RunningHub
 * 都已经把字段归一成 WorkflowConfig，所以表单、结果展示都只留一份；
 * 各自的特有内容（默认值运行、取消、批量映射表）通过插槽传入。
 */
export function RunTab({
    config, onRun, running, result, emptyText, runLabel, hint, toolbar, footer, extra, progress, statusText, onCancel, outputPicker,
}: RunPanelProps & {
    hint?: ReactNode;
    toolbar?: ReactNode;
    footer?: ReactNode;
    extra?: ReactNode;
}) {
    return (
        <div>
            {outputPicker ? <div className="mb-4">{outputPicker}</div> : null}
            {hint || toolbar ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    {hint ? <p className="text-xs text-stone-500">{hint}</p> : <span />}
                    {toolbar}
                </div>
            ) : null}
            <RunPanel
                config={config}
                onRun={onRun}
                running={running}
                result={result}
                emptyText={emptyText}
                runLabel={runLabel}
                progress={progress}
                statusText={statusText}
                onCancel={onCancel}
            />
            {footer}
            {extra}
        </div>
    );
}

/**
 * 运行面板：按 config.fields 渲染可填写输入并提交。本地 ComfyUI 与 RunningHub
 * 都把字段归一化成 WorkflowConfig 后复用它，所以两边运行体验一致。
 */
export function RunPanel({ config, onRun, running, result, emptyText, runLabel, progress, statusText, onCancel }: RunPanelProps) {
    const [fields, setFields] = useState<Record<string, string>>({});
    // 只有「字段集合或默认值真的变了」才重置表单。
    // 不能依赖 config.fields 这个数组本身：调用方常在渲染时用 map 派生它
    // （RunningHub 面板就是这样），数组身份每次都不同，于是点一下运行
    // 触发 re-render 后，用户刚填的内容就被冲回 default。
    const defaultsKey = JSON.stringify(config.fields.map((f) => [f.id, f.default ?? null]));

    useEffect(() => {
        const defaults: Record<string, string> = {};
        for (const f of config.fields) {
            if (f.default !== undefined && f.default !== null) defaults[f.id] = String(f.default);
        }
        setFields(defaults);
    }, [defaultsKey]);

    const setField = (id: string, value: string) => setFields((p) => ({ ...p, [id]: value }));

    return (
        <div className="space-y-4">
            {config.fields.length === 0 ? (
                <div className="text-center text-sm text-stone-500">{emptyText ?? "请先点击节点配置字段后再运行"}</div>
            ) : (
                <div className="space-y-3">
                    {config.fields.map((field) => (
                        <div key={field.id}>
                            <label className="mb-1 flex items-center gap-2 text-xs text-stone-500">
                                {field.name || field.id}
                                <Tag color="default" className="text-xs">{field.node.includes(",") ? `多节点 · ${field.input}` : `${field.node}.${field.input}`}</Tag>
                            </label>
                            {field.type === "text" ? (
                                <Input.TextArea value={fields[field.id] || ""} onChange={(e) => setField(field.id, e.target.value)} rows={2} placeholder={field.name} />
                            ) : field.type === "image" ? (
                                <MediaFieldUpload fieldId={field.id} kind="image" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} />
                            ) : field.type === "audio" ? (
                                <MediaFieldUpload fieldId={field.id} kind="audio" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} />
                            ) : field.type === "video" ? (
                                <MediaFieldUpload fieldId={field.id} kind="video" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} />
                            ) : field.type === "dropdown" ? (
                                <Select value={fields[field.id] || undefined} onChange={(v) => setField(field.id, v)} options={(field.options ?? []).map((o) => ({ label: o, value: o }))} placeholder={field.name} className="w-full" />
                            ) : field.type === "boolean" ? (
                                <Switch checked={fields[field.id] === "true"} onChange={(v) => setField(field.id, String(v))} />
                            ) : (
                                <Input value={fields[field.id] || ""} onChange={(e) => setField(field.id, e.target.value)} placeholder={String(field.default || "")} />
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Button type="primary" icon={<Play className="size-4" />} onClick={() => onRun(fields)} loading={running} disabled={config.fields.length === 0}>
                {running ? "执行中..." : runLabel ?? "运行工作流"}
            </Button>

            {running ? (
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-stone-600">
                        <span>{statusText || "执行中…"}</span>
                        <span className="tabular-nums">{progress === undefined ? "进度未知" : `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`}</span>
                    </div>
                    <Progress percent={progress === undefined ? undefined : Math.round(Math.min(1, Math.max(0, progress)) * 100)} status="active" showInfo={false} size="small" />
                    {onCancel ? <Button danger size="small" onClick={onCancel}>取消</Button> : null}
                </div>
            ) : null}

            {result?.warning ? <div className="rounded bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">已按输出节点抢救出结果：{result.warning}</div> : null}

            {result && result.media.length > 0 && (
                <div>
                    <h4 className="mb-2 text-sm font-medium">执行结果</h4>
                    <div className="grid grid-cols-2 gap-3">
                        {result.media.map((item, i) => (
                            <div key={i} className="overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                                {item.mimeType?.startsWith("video/") ? <video src={item.url} controls className="w-full" /> : item.mimeType?.startsWith("audio/") ? <audio src={item.url} controls className="w-full p-2" /> : item.mimeType?.startsWith("image/") ? <img src={item.url} alt={item.filename} className="w-full" /> : <a href={item.url} download={item.filename} className="block break-all p-3 text-blue-600">下载 {item.filename || "输出文件"}</a>}
                                <p className="truncate px-2 py-1 text-xs text-stone-500">{item.filename}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {result?.texts?.length ? <div className="space-y-2"><h4 className="text-sm font-medium">文本输出</h4>{result.texts.map((item, index) => <pre key={`${item.nodeId}-${index}`} className="whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-3 text-xs dark:border-stone-700 dark:bg-stone-800">{item.content}</pre>)}</div> : null}

            {result && result.error && <div className="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20">错误: {result.error}</div>}
        </div>
    );
}
