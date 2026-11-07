import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Progress, Select, Switch, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import { groupWorkflowFields } from "./field-groups";
import { Play, Trash2, Upload, GripVertical } from "lucide-react";
import { uploadBackendMedia, backendMediaUrl } from "@/services/backend-api";
import type { WorkflowConfig, WorkflowField, WorkflowRunResult } from "@/services/api/workflows";

/** 媒体字段上传：先传 Backend 媒体目录，运行面板和画布共用同一份 URL 语义。 */
type MediaFieldUploadProps = {
    fieldId: string;
    value: string;
    kind: "image" | "audio" | "video";
    onChange: (value: string) => void;
    onUploadingChange: (uploading: boolean) => void;
};

function MediaFieldUpload({ fieldId, value, kind, onChange, onUploadingChange }: MediaFieldUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [previewUrl, setPreviewUrl] = useState(value);
    const [filename, setFilename] = useState("");
    const [uploading, setUploading] = useState(false);
    const uploadVersion = useRef(0);
    const uploadPending = useRef(false);

    const previewValue = (source: string) => {
        if (!source.startsWith("/media/")) return source;
        const storageKey = decodeURIComponent(source.slice("/media/".length).split("?", 1)[0]);
        return backendMediaUrl(storageKey);
    };

    useEffect(() => {
        // A changed value or field belongs to a new input, even if an earlier upload finishes later.
        uploadVersion.current += 1;
        uploadPending.current = false;
        setUploading(false);
        onUploadingChange(false);
        setPreviewUrl(previewValue(value));
        if (!value) setFilename("");
        return () => {
            uploadVersion.current += 1;
            uploadPending.current = false;
            onUploadingChange(false);
        };
        // The callback is an inline field setter; its identity must not cancel an upload on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fieldId, kind, value]);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || uploadPending.current) return;
        const version = ++uploadVersion.current;
        uploadPending.current = true;
        setUploading(true);
        onUploadingChange(true);
        try {
            const media = await uploadBackendMedia({ name: file.name, blob: file, mimeType: file.type || undefined, category: "input" });
            if (version !== uploadVersion.current) return;
            setPreviewUrl(backendMediaUrl(media.storageKey));
            setFilename(file.name);
            onChange(media.url);
        } catch (error) {
            if (version === uploadVersion.current) message.error(error instanceof Error ? error.message : "媒体上传失败");
        } finally {
            if (version === uploadVersion.current) {
                uploadPending.current = false;
                setUploading(false);
                onUploadingChange(false);
            }
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <input ref={inputRef} type="file" accept={`${kind}/*`} className="hidden" disabled={uploading} onChange={handleFileChange} />
                <Button size="small" loading={uploading} icon={<Upload className="size-3" />} onClick={() => inputRef.current?.click()}>
                    {previewUrl ? `更换${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}` : `选择${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}`}
                </Button>
                {previewUrl && (
                    <>
                        <Tag color="blue" className="max-w-48 truncate text-xs">{filename || `已选择${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}`}</Tag>
                        <Button size="small" danger type="text" disabled={uploading} onClick={() => { setPreviewUrl(""); setFilename(""); onChange(""); }}>
                            <Trash2 className="size-3" />
                        </Button>
                    </>
                )}
            </div>
            {previewUrl && (
                kind === "audio"
                    ? <audio src={previewUrl} controls className="w-full" />
                    : kind === "video"
                        ? <video src={previewUrl} controls className="max-h-64 w-full rounded border border-border" />
                        : <div className="inline-block"><img src={previewUrl} alt="" className="h-24 w-24 rounded border border-border object-cover " /></div>
            )}
        </div>
    );
}

export type RunPanelProps = {
    config: WorkflowConfig;
    onRun: (fields: Record<string, string>) => void;
    running: boolean;
    disabled?: boolean;
    cancelPending?: boolean;
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
    /** 高级设置区（运行位置等）；没有就不渲染。 */
    advanced?: ReactNode;
    /** 参考媒体字段拖拽重排后回调，参数为媒体字段 id 的新顺序（左→右）。 */
    onReorderMediaFieldIds?: (orderedMediaIds: string[]) => void;
    /** 运行页签空白时的一键识别入口（扫描节点图媒体输入），由调用方实现。 */
    onAutoDetectFields?: () => void;
};

/**
 * 运行页签。两个数据源共用这一个页签：本地 ComfyUI 与 RunningHub
 * 都已经把字段归一成 WorkflowConfig，所以表单、结果展示都只留一份；
 * 各自的特有内容（默认值运行、取消、批量映射表）通过插槽传入。
 */
export function RunTab({
    config, onRun, running, disabled, cancelPending, result, emptyText, runLabel, hint, toolbar, footer, extra, progress, statusText, onCancel, outputPicker, advanced, onReorderMediaFieldIds, onAutoDetectFields,
}: RunPanelProps & {
    hint?: ReactNode;
    toolbar?: ReactNode;
    footer?: ReactNode;
    extra?: ReactNode;
    /** 高级设置区（运行位置等）；没有就不渲染，云端页签可以一直不传。 */
    advanced?: ReactNode;
}) {
    return (
        <div>
            {outputPicker ? <div className="mb-4">{outputPicker}</div> : null}
            {hint || toolbar ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : <span />}
                    {toolbar}
                </div>
            ) : null}
            <RunPanel
                config={config}
                onRun={onRun}
                running={running}
                disabled={disabled}
                cancelPending={cancelPending}
                result={result}
                emptyText={emptyText}
                runLabel={runLabel}
                progress={progress}
                statusText={statusText}
                onCancel={onCancel}
                advanced={advanced}
                onReorderMediaFieldIds={onReorderMediaFieldIds}
                onAutoDetectFields={onAutoDetectFields}
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
export function RunPanel({ config, onRun, running, disabled, cancelPending, result, emptyText, runLabel, progress, statusText, onCancel, advanced, onReorderMediaFieldIds, onAutoDetectFields }: RunPanelProps) {
    const { t } = useTranslation();
    const uploadingFields = useRef(new Set<string>());
    const [uploadCount, setUploadCount] = useState(0);
    // 拖拽重排参考媒体的瞬时状态：用 ref 承载被拖字段 id，避免 onDrop 闭包读到旧值。
    const dragIdRef = useRef<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    // An owner is isolated by RunTab's key. Within that owner, names/defaults and fresh
    // config objects must not overwrite input; only a different field binding starts anew.
    const fieldKey = (field: WorkflowField) => JSON.stringify([field.id, field.node, field.input, field.type]);
    const identities = Object.fromEntries(config.fields.map((field) => [field.id, fieldKey(field)]));
    const signature = JSON.stringify(identities);
    const defaults = Object.fromEntries(config.fields.filter((field) => field.default !== undefined && field.default !== null).map((field) => [field.id, String(field.default)]));
    const [draft, setDraft] = useState(() => ({ signature, identities, fields: defaults }));
    const fields = draft.signature === signature ? draft.fields : { ...defaults };
    // Reconcile before submission: preserve surviving bindings, seed additions, discard removals.
    if (draft.signature !== signature) {
        for (const field of config.fields) {
            if (draft.identities[field.id] === identities[field.id] && Object.hasOwn(draft.fields, field.id)) fields[field.id] = draft.fields[field.id];
        }
        setDraft({ signature, identities, fields });
    }
    const setField = (id: string, value: string) => setDraft((current) => current.identities[id] !== identities[id] ? current : ({
        ...current, fields: { ...current.fields, [id]: value },
    }));
    const setUploading = (id: string, uploading: boolean) => {
        if (uploading) uploadingFields.current.add(id);
        else uploadingFields.current.delete(id);
        setUploadCount(uploadingFields.current.size);
    };

    const renderFieldControl = (field: WorkflowField) => (
        field.type === "text" ? (
            <Input.TextArea value={fields[field.id] || ""} onChange={(e) => setField(field.id, e.target.value)} rows={2} placeholder={field.name} />
        ) : field.type === "image" ? (
            <MediaFieldUpload fieldId={field.id} kind="image" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} onUploadingChange={(pending) => setUploading(fieldKey(field), pending)} />
        ) : field.type === "audio" ? (
            <MediaFieldUpload fieldId={field.id} kind="audio" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} onUploadingChange={(pending) => setUploading(fieldKey(field), pending)} />
        ) : field.type === "video" ? (
            <MediaFieldUpload fieldId={field.id} kind="video" value={fields[field.id] || ""} onChange={(v) => setField(field.id, v)} onUploadingChange={(pending) => setUploading(fieldKey(field), pending)} />
        ) : field.type === "dropdown" ? (
            <Select value={fields[field.id] || undefined} onChange={(v) => setField(field.id, v)} options={(field.options ?? []).map((o) => ({ label: o, value: o }))} placeholder={field.name} className="w-full" />
        ) : field.type === "boolean" ? (
            <Switch checked={fields[field.id] === "true"} onChange={(v) => setField(field.id, String(v))} />
        ) : (
            <Input value={fields[field.id] || ""} onChange={(e) => setField(field.id, e.target.value)} placeholder={String(field.default || "")} />
        )
    );

    const renderFieldLabel = (field: WorkflowField) => (
        <label className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            {field.name || field.id}
            <Tag color="default" className="text-xs">{field.node.includes(",") ? `多节点 · ${field.input}` : `${field.node}.${field.input}`}</Tag>
        </label>
    );

    const handleMediaDrop = (targetId: string) => {
        const fromId = dragIdRef.current;
        dragIdRef.current = null;
        setDragOverId(null);
        if (!fromId || fromId === targetId || !onReorderMediaFieldIds) return;
        const ids = config.fields.filter((field) => ["image", "video", "audio"].includes(field.type)).map((field) => field.id);
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        onReorderMediaFieldIds(ids);
    };

    return (
        <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t("microTools.workflow.scope")}</p>
            {config.fields.length === 0 ? (
                <div className="space-y-3 text-center">
                    <div className="text-sm text-muted-foreground">{emptyText ?? "请先点击节点配置字段后再运行"}</div>
                    {onAutoDetectFields ? (
                        <Button type="dashed" onClick={onAutoDetectFields}>自动识别媒体字段（扫描节点图）</Button>
                    ) : null}
                </div>
            ) : (
                <div className="space-y-3">
                    {groupWorkflowFields(config.fields).map(group => <section key={group.key} aria-label={t(`microTools.workflow.${group.key}`)} className="space-y-3">
                        <h3 className="text-sm font-medium text-foreground">{t(`microTools.workflow.${group.key}`)}</h3>
                    {group.key === "media" ? (
                        <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">{t("microTools.workflow.mediaReorderHint")}</p>
                            {group.fields.map((field) => (
                                <div
                                    key={fieldKey(field)}
                                    draggable
                                    title={t("microTools.workflow.dragToReorder")}
                                    onDragStart={(event) => { dragIdRef.current = field.id; event.dataTransfer.effectAllowed = "move"; }}
                                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (dragIdRef.current && dragIdRef.current !== field.id) setDragOverId(field.id); }}
                                    onDragLeave={() => { if (dragOverId === field.id) setDragOverId(null); }}
                                    onDrop={(event) => { event.preventDefault(); handleMediaDrop(field.id); }}
                                    onDragEnd={() => { dragIdRef.current = null; setDragOverId(null); }}
                                    className={`flex items-start gap-2 rounded-md border border-transparent p-2 ${dragOverId === field.id ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "hover:border-border"}`}
                                >
                                    <GripVertical className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                                    <div className="min-w-0 flex-1">
                                        {renderFieldLabel(field)}
                                        {renderFieldControl(field)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {group.fields.map((field) => (
                                <div key={fieldKey(field)}>
                                    {renderFieldLabel(field)}
                                    {renderFieldControl(field)}
                                </div>
                            ))}
                        </div>
                    )}
                    </section>)}
                </div>
            )}

            {advanced ? <div className="rounded border border-border p-3" aria-label={t("microTools.workflow.advancedSettings")}>{advanced}</div> : null}

            <div className="border-t border-border pt-3" aria-label={t("microTools.workflow.submit")}>
            <Button type="primary" icon={<Play className="size-4" />} onClick={() => { if (!running && !disabled && !uploadingFields.current.size) onRun({ ...fields }); }} loading={running} disabled={disabled || running || uploadCount > 0 || config.fields.length === 0}>
                {running ? "执行中..." : runLabel ?? "运行工作流"}
            </Button>

            {running ? (
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{statusText || "执行中…"}</span>
                        <span className="tabular-nums">{progress === undefined ? "进度未知" : `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`}</span>
                    </div>
                    <Progress percent={progress === undefined ? undefined : Math.round(Math.min(1, Math.max(0, progress)) * 100)} status="active" showInfo={false} size="small" />
                    {onCancel ? <Button danger size="small" onClick={onCancel} loading={cancelPending} disabled={cancelPending}>取消</Button> : null}
                </div>
            ) : null}

            </div>

            {result?.warning ? <div className="rounded bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">已按输出节点抢救出结果：{result.warning}</div> : null}

            {result && result.media.length > 0 && (
                <div>
                    <h4 className="mb-2 text-sm font-medium">执行结果</h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {result.media.map((item, i) => (
                            <div key={i} className="overflow-hidden rounded border border-border">
                                {item.mimeType?.startsWith("video/") ? <video src={item.url} controls className="w-full" /> : item.mimeType?.startsWith("audio/") ? <audio src={item.url} controls className="w-full p-2" /> : item.mimeType?.startsWith("image/") ? <img src={item.url} alt={item.filename} className="w-full" /> : <a href={item.url} download={item.filename} className="block break-all p-3 text-blue-600">下载 {item.filename || "输出文件"}</a>}
                                <p className="truncate px-2 py-1 text-xs text-muted-foreground">{item.filename}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {result?.texts?.length ? <div className="space-y-2"><h4 className="text-sm font-medium">文本输出</h4>{result.texts.map((item, index) => <pre key={`${item.nodeId}-${index}`} className="whitespace-pre-wrap rounded border border-border bg-muted p-3 text-xs dark:bg-muted">{item.content}</pre>)}</div> : null}

            {result && result.error && <div className="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20">错误: {result.error}</div>}
        </div>
    );
}
