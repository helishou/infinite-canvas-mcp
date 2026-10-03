import { useEffect, useState, useCallback, useRef } from "react";
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Spin, Table, Tabs, Tag, message, Select, Switch } from "antd";
import { Upload as UploadIcon, Upload, Download, Play, Trash2, Settings2, Workflow, Code, History } from "lucide-react";
import { request, fetchBackendGenerationLogs, deleteBackendGenerationLogs, uploadBackendMedia, backendMediaUrl, type BackendRuntimeTask } from "@/services/backend-api";
import { exportWorkflowPackage, importWorkflowPackage, renameWorkflowTitle, runWorkflow, pollWorkflowTask, type WorkflowConfig, type WorkflowField, type WorkflowPackage, type WorkflowRunResult } from "@/services/api/workflows";
import { WorkflowGraphPanel } from "./workflow-graph-panel";
import { ComfyChannelsPanel, ComfyRuntimePanel } from "./comfy-management-panels";
import "../../styles/workflow-graph.css";
import { cancelRunningHubTask, deleteRunningHubWorkflow, fetchRunningHubStatus, fetchRunningHubWorkflowTasks, fetchRunningHubWorkflows, inspectRunningHubWorkflow, runRunningHubWorkflow, saveRunningHubWorkflow, type RunningHubField, type RunningHubWorkflowProfile } from "@/services/api/runninghub";

type WorkflowItem = {
    name: string;
    title: string;
    builtin: boolean;
    fieldCount: number;
};

type WorkflowDetail = {
    name: string;
    workflow: Record<string, any>;
    config: WorkflowConfig;
    builtin: boolean;
};

type TaskResult = WorkflowRunResult;

export default function WorkflowsPage() {
    const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<WorkflowDetail | null>(null);
    const [running, setRunning] = useState(false);
    const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
    const [section, setSection] = useState("workflows");
    const [activeTab, setActiveTab] = useState("structure");
    const [historyLogs, setHistoryLogs] = useState<Array<{ id: string; workflow: string; prompt: string; status: string; createdAt: string; outputs: Array<{ url: string; mimeType: string }>; error?: string }>>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");

    const fetchWorkflows = useCallback(async () => {
        try {
            const data = await request<{ workflows: WorkflowItem[] }>("GET", "/api/workflows");
            setWorkflows(data.workflows);
        } catch (err) {
            message.error(err instanceof Error ? err.message : "加载工作流失败");
        }
    }, []);

    useEffect(() => { fetchWorkflows(); }, [fetchWorkflows]);

    const handleUpload = async (file: File) => {
        setLoading(true);
        try {
            const text = await file.text();
            const value = JSON.parse(text) as Record<string, unknown>;
            if (value.format === "infinite-canvas-workflow") {
                await importWorkflowPackage(file.name, value as WorkflowPackage);
                message.success("工作流包导入成功");
            } else {
                await request("POST", "/api/workflows", { name: file.name.replace(/\.json$/, ""), workflow: value });
                message.success("ComfyUI 工作流导入成功");
            }
            await fetchWorkflows();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "导入失败");
        } finally {
            setLoading(false);
        }
        return false;
    };

    const handleExport = async () => {
        if (!selected) return;
        try {
            const workflowPackage = await exportWorkflowPackage(selected.name);
            const title = (selected.config.title || selected.name.replace(/^custom\//, "").replace(/\.json$/, ""))
                .replace(/[\\/:*?"<>|]+/g, "-");
            const url = URL.createObjectURL(new Blob([JSON.stringify(workflowPackage, null, 2)], { type: "application/json" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${title}.workflow.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            message.success("工作流包已导出");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "导出失败");
        }
    };

    const handleDelete = async (name: string) => {
        try {
            await request("DELETE", `/api/workflows/${encodeURIComponent(name)}`);
            message.success("工作流已删除");
            fetchWorkflows();
            if (selected?.name === name) setSelected(null);
        } catch (err) {
            message.error(err instanceof Error ? err.message : "删除失败");
        }
    };

    const handleRename = async (name: string) => {
        const trimmed = editValue.trim();
        setEditingName(null);
        if (!trimmed) return;
        const item = workflows.find((w) => w.name === name);
        if (!item || item.builtin) return;
        if (item.title === trimmed) return;
        try {
            await renameWorkflowTitle(name, trimmed);
            setWorkflows((prev) => prev.map((w) => (w.name === name ? { ...w, title: trimmed } : w)));
            if (selected?.name === name) setSelected({ ...selected, config: { ...selected.config, title: trimmed } });
            message.success("已重命名");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "重命名失败");
        }
    };

    const handleLoadDetail = async (name: string) => {
        try {
            const detail = await request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(name)}`);
            setSelected(detail);
            setTaskResult(null);
            setActiveTab("structure");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "加载详情失败");
        }
    };

    const handleSaveConfig = async (config: WorkflowConfig) => {
        if (!selected) return;
        try {
            await request("PUT", `/api/workflows/${encodeURIComponent(selected.name)}/config`, config);
            setSelected({ ...selected, config });
            fetchWorkflows();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "保存配置失败");
        }
    };

    const handleRun = async (fields: Record<string, string>) => {
        if (!selected) return;
        setRunning(true);
        setTaskResult(null);
        try {
            const { taskId } = await runWorkflow(selected.name, fields, selected.config);
            const result = await pollWorkflowTask(taskId);
            setTaskResult(result);
            if (result.status.status_str === "success") {
                message.success("工作流执行完成");
            } else {
                message.error(result.error || "执行失败");
            }
        } catch (err) {
            message.error(err instanceof Error ? err.message : "运行失败");
        } finally {
            setRunning(false);
        }
    };

    const loadHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            const data = await fetchBackendGenerationLogs({ projectId: "workflow", limit: 50 });
            setHistoryLogs((data.logs || [])
                .filter((log) => !selected?.name || log.workflow === selected.name)
                .map((log) => ({
                    id: log.id,
                    workflow: log.workflow || "unknown",
                    prompt: log.prompt || "",
                    status: log.status,
                    createdAt: log.createdAt,
                    outputs: (log.outputs || []).map((o: any) => ({ url: o.url, mimeType: o.mimeType })),
                    error: log.error,
                })));
        } catch (err) {
            message.error(err instanceof Error ? err.message : "加载历史失败");
        } finally {
            setLoadingHistory(false);
        }
    }, [selected?.name]);

    useEffect(() => { if (activeTab === "history") loadHistory(); }, [activeTab, loadHistory]);

    const handleDeleteHistory = async (id: string) => {
        try {
            await deleteBackendGenerationLogs({ id });
            loadHistory();
            message.success("已删除");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "删除失败");
        }
    };

    const handleFieldsChange = (newFields: WorkflowField[]) => {
        if (!selected) return;
        const updatedConfig = { ...selected.config, fields: newFields };
        setSelected({ ...selected, config: updatedConfig });
        handleSaveConfig(updatedConfig);
    };

    return (
        <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden px-6 py-4">
            <div className="shrink-0">
                <h1 className="flex items-center gap-2 text-xl font-semibold"><Workflow className="size-5" /> ComfyUI</h1>
                <p className="mt-0.5 text-xs text-stone-500">集中管理工作流、本地模型和运行环境。</p>
            </div>

            <Tabs
                className="mt-2 shrink-0 [&_.ant-tabs-nav]:!mb-3"
                activeKey={section}
                onChange={setSection}
                items={[
                    { key: "workflows", label: "工作流库" },
                    { key: "runninghub", label: "RunningHub 工作流" },
                    { key: "models", label: "模型" },
                    { key: "runtime", label: "运行环境" },
                ]}
            />

            <div className={`min-h-0 flex-1 ${section === "workflows" ? "overflow-hidden" : "overflow-y-auto"}`}>
            {section === "workflows" ? <div className="grid h-full min-h-0 grid-cols-12 gap-4">
                <div className="col-span-8 min-h-0">
                    {!selected ? (
                        <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                            <div className="text-center">
                                <Workflow className="mx-auto size-10 text-stone-300" />
                                <p className="mt-2 text-sm text-stone-500">选择工作流查看详情</p>
                            </div>
                        </div>
                    ) : (
                        <div className="flex h-full min-h-0 flex-col gap-3">
                            <div className="flex shrink-0 items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
                                <div className="min-w-0">
                                    {editingName === selected.name ? (
                                        <Input
                                            autoFocus
                                            size="small"
                                            value={editValue}
                                            onChange={(e) => setEditValue(e.target.value)}
                                            onPressEnter={() => handleRename(selected.name)}
                                            onBlur={() => handleRename(selected.name)}
                                            className="w-full"
                                        />
                                    ) : (
                                        <h2
                                            className={`truncate text-base font-semibold ${selected.builtin ? "" : "cursor-pointer hover:text-blue-600"}`}
                                            title={selected.builtin ? "" : "双击重命名"}
                                            onDoubleClick={() => {
                                                if (selected.builtin) return;
                                                setEditingName(selected.name);
                                                setEditValue(selected.config.title || selected.name);
                                            }}
                                        >
                                            {selected.config.title || selected.name}
                                        </h2>
                                    )}
                                    <p className="mt-0.5 truncate text-xs text-stone-500">{selected.name.replace(/^custom\//, "")} · {Object.keys(selected.workflow).length} 个节点 · {selected.config.fields.length} 字段</p>
                                </div>
                                <div className="ml-3 flex shrink-0 gap-2">
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={handleExport}>
                                        导出
                                    </Button>
                                    {!selected.builtin && (
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete(selected.name)}>
                                            删除
                                        </Button>
                                    )}
                                </div>
                            </div>

                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                                <div className="flex shrink-0 border-b border-stone-200 dark:border-stone-700">
                                    <button
                                        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition ${activeTab === "structure" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("structure")}
                                    >
                                        <Code className="size-3.5" /> 节点图
                                    </button>
                                    <button
                                        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition ${activeTab === "run" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("run")}
                                    >
                                        <Play className="size-3.5" /> 运行
                                    </button>
                                    <button
                                        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition ${activeTab === "history" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("history")}
                                    >
                                        <History className="size-3.5" /> 历史 ({historyLogs.length})
                                    </button>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                                    {activeTab === "structure" && (
                                        <div className="h-full min-h-[280px]">
                                            <WorkflowGraphPanel
                                                name={selected.name}
                                                workflow={selected.workflow}
                                                fields={selected.config.fields}
                                                onFieldsChange={handleFieldsChange}
                                                onWorkflowChange={(workflow) => {
                                                    if (!selected) return;
                                                    const next = { ...selected, workflow };
                                                    setSelected(next);
                                                    void request("PUT", `/api/workflows/${encodeURIComponent(selected.name)}/workflow`, workflow).catch((error) => message.error(error instanceof Error ? error.message : "保存节点图失败"));
                                                }}
                                            />
                                        </div>
                                    )}

                                    {activeTab === "run" && (
                                        <RunPanel config={selected.config} onRun={handleRun} running={running} result={taskResult} />
                                    )}

                                    {activeTab === "history" && (
                                        <div>
                                            <div className="mb-3 flex items-center justify-between">
                                                <p className="text-xs text-stone-500">工作流运行历史（与生图/画布日志共享存储）</p>
                                                <Button size="small" onClick={loadHistory} disabled={loadingHistory}>刷新</Button>
                                            </div>
                                            {loadingHistory ? (
                                                <Spin />
                                            ) : historyLogs.length === 0 ? (
                                                <Empty description="暂无运行历史" />
                                            ) : (
                                                <div className="space-y-2">
                                                    {historyLogs.map((log) => (
                                                        <div key={log.id} className="flex items-center gap-3 rounded border border-stone-200 bg-white p-3 text-sm dark:border-stone-700 dark:bg-stone-800">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <Tag color={log.status === "success" ? "green" : log.status === "failed" ? "red" : "blue"}>{log.status}</Tag>
                                                                    <span className="font-medium truncate">{log.workflow}</span>
                                                                    <span className="text-xs text-stone-400 shrink-0">{new Date(log.createdAt).toLocaleString()}</span>
                                                                </div>
                                                                {log.prompt && <p className="text-xs text-stone-500 truncate" title={log.prompt}>{log.prompt}</p>}
                                                                {log.error && <p className="text-xs text-red-500 truncate" title={log.error}>{log.error}</p>}
                                                                {log.outputs.length > 0 && (
                                                                    <div className="mt-1 flex gap-1">
                                                                        {log.outputs.slice(0, 4).map((o, i) => (
                                                                            o.mimeType?.startsWith("audio/")
                                                                                ? <audio key={i} src={o.url} controls className="h-10 w-56" />
                                                                                : o.mimeType?.startsWith("video/")
                                                                                    ? <video key={i} src={o.url} className="h-10 w-16 rounded object-cover" />
                                                                                    : <img key={i} src={o.url} alt="" className="h-10 w-10 rounded object-cover" />
                                                                        ))}
                                                                        {log.outputs.length > 4 && (
                                                                            <span className="flex h-10 w-10 items-center justify-center rounded bg-stone-100 text-xs text-stone-500">+{log.outputs.length - 4}</span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <Button size="small" danger icon={<Trash2 className="size-3" />} onClick={() => handleDeleteHistory(log.id)} />
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="col-span-4 flex min-h-0 flex-col gap-3">
                    <div className="relative flex shrink-0 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                        {loading ? <Spin size="small" /> : <UploadIcon className="size-4 shrink-0 text-stone-400" />}
                        <span className="text-sm text-stone-600 dark:text-stone-300">{loading ? "正在导入…" : "导入 ComfyUI JSON / 工作流包"}</span>
                        <input
                            type="file"
                            accept=".json"
                            disabled={loading}
                            onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (file) { await handleUpload(file); e.target.value = ""; }
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                        />
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                        <div className="shrink-0 border-b border-stone-200 px-3 py-2.5 dark:border-stone-700">
                            <h2 className="text-sm font-medium">工作流列表</h2>
                        </div>
                        {workflows.length === 0 ? (
                            <div className="flex flex-1 items-center justify-center p-6"><Empty description="暂无工作流" /></div>
                        ) : (
                            <div className="min-h-0 flex-1 divide-y divide-stone-200 overflow-y-auto dark:divide-stone-700">
                                {workflows.map((wf) => (
                                    <div
                                        key={wf.name}
                                        className={`cursor-pointer px-3 py-2.5 transition hover:bg-stone-50 dark:hover:bg-stone-800 ${selected?.name === wf.name ? "bg-stone-100 dark:bg-stone-800" : ""}`}
                                        onClick={() => { if (editingName !== wf.name) handleLoadDetail(wf.name); }}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="min-w-0 flex-1">
                                                {editingName === wf.name ? (
                                                    <Input
                                                        autoFocus
                                                        size="small"
                                                        value={editValue}
                                                        onChange={(e) => setEditValue(e.target.value)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onPressEnter={() => handleRename(wf.name)}
                                                        onBlur={() => handleRename(wf.name)}
                                                        className="w-full"
                                                    />
                                                ) : (
                                                    <p
                                                        className="truncate text-sm font-medium"
                                                        title={wf.builtin ? "" : "双击重命名"}
                                                        onDoubleClick={(e) => {
                                                            e.stopPropagation();
                                                            if (wf.builtin) return;
                                                            setEditingName(wf.name);
                                                            setEditValue(wf.title);
                                                        }}
                                                    >
                                                        {wf.title}
                                                    </p>
                                                )}
                                                <p className="mt-0.5 truncate text-xs text-stone-500">{wf.name.replace(/^custom\//, "")}</p>
                                            </div>
                                            <Tag color="blue">{wf.fieldCount} 字段</Tag>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div> : section === "runninghub" ? <RunningHubWorkflowsPanel onOpenRuntime={() => setSection("runtime")} /> : section === "models" ? <ComfyChannelsPanel /> : <ComfyRuntimePanel />}
            </div>
        </div>
    );
}

// ─── RunPanel ───
type RunPanelProps = {
    config: WorkflowConfig;
    onRun: (fields: Record<string, string>) => void;
    onFieldChange?: (fieldId: string, value: string) => void;
    running: boolean;
    result: TaskResult | null;
};

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
        if (kind === "image") localStorage.removeItem(`wf_image_${fieldId}`);
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
                        <Tag color="blue" className="text-xs truncate max-w-48">{filename || `已选择${kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片"}`}</Tag>
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
                        : <div className="relative inline-block"><img src={previewUrl} alt="" className="h-24 w-24 rounded object-cover border border-stone-200 dark:border-stone-700" /></div>
            )}
        </div>
    );
}

export function RunPanel({ config, onRun, running, result }: RunPanelProps) {
    const [fields, setFields] = useState<Record<string, string>>({});

    useEffect(() => {
        const defaults: Record<string, string> = {};
        for (const f of config.fields) {
            if (f.default !== undefined && f.default !== null) defaults[f.id] = String(f.default);
        }
        setFields(defaults);
    }, [config.fields]);

    return (
        <div className="space-y-4">
            {config.fields.length === 0 ? (
                <div className="text-center text-sm text-stone-500">
                    <Settings2 className="mx-auto mb-2 size-8 text-stone-300" />
                    <p>请先点击节点配置字段后再运行</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {config.fields.map((field) => (
                        <div key={field.id}>
                            <label className="mb-1 flex items-center gap-2 text-xs text-stone-500">
                                {field.name || field.id}
                                <Tag color="default" className="text-xs">{field.node.includes(",") ? `多节点 · ${field.input}` : `${field.node}.${field.input}`}</Tag>
                            </label>
                            {field.type === "text" ? (
                                <Input.TextArea value={fields[field.id] || ""} onChange={(e) => setFields((p) => ({ ...p, [field.id]: e.target.value }))} rows={2} placeholder={field.name} />
                            ) : field.type === "image" ? (
                                <MediaFieldUpload fieldId={field.id} kind="image" value={fields[field.id] || ""} onChange={(v) => setFields((p) => ({ ...p, [field.id]: v }))} />
                            ) : field.type === "audio" ? (
                                <MediaFieldUpload fieldId={field.id} kind="audio" value={fields[field.id] || ""} onChange={(v) => setFields((p) => ({ ...p, [field.id]: v }))} />
                            ) : field.type === "video" ? (
                                <MediaFieldUpload fieldId={field.id} kind="video" value={fields[field.id] || ""} onChange={(v) => setFields((p) => ({ ...p, [field.id]: v }))} />
                            ) : field.type === "dropdown" ? (
                                <Select value={fields[field.id] || undefined} onChange={(v) => setFields((p) => ({ ...p, [field.id]: v }))} options={(field.options ?? []).map((o) => ({ label: o, value: o }))} placeholder={field.name} className="w-full" />
                            ) : field.type === "boolean" ? (
                                <Switch checked={fields[field.id] === "true"} onChange={(v) => setFields((p) => ({ ...p, [field.id]: String(v) }))} />
                            ) : (
                                <Input value={fields[field.id] || ""} onChange={(e) => setFields((p) => ({ ...p, [field.id]: e.target.value }))} placeholder={String(field.default || "")} />
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Button type="primary" icon={<Play className="size-4" />} onClick={() => onRun(fields)} loading={running} disabled={config.fields.length === 0}>
                {running ? "执行中..." : "运行工作流"}
            </Button>

            {running && <Spin size="small" />}

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

function runningHubFieldId(field: RunningHubField) { return field.id || `${field.nodeId}::${field.fieldName}`; }

function workflowFieldType(field: RunningHubField): WorkflowField["type"] {
    if (field.source === "image" || field.source === "video" || field.source === "audio" || field.source === "prompt") return field.source === "prompt" ? "text" : field.source;
    if (field.fieldType === "number") return "number";
    if (field.fieldType === "boolean") return "boolean";
    return "text";
}

function workflowFormField(field: RunningHubField): WorkflowField {
    return { id: runningHubFieldId(field), node: field.nodeId, input: field.fieldName, name: field.label || `${field.nodeId}.${field.fieldName}`, type: workflowFieldType(field), required: field.required, default: field.fieldValue };
}

function numericValue(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return value;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
}

function RunningHubWorkflowsPanel({ onOpenRuntime }: { onOpenRuntime: () => void }) {
    const [profiles, setProfiles] = useState<RunningHubWorkflowProfile[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [workflowId, setWorkflowId] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [error, setError] = useState("");
    const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
    const [history, setHistory] = useState<BackendRuntimeTask[]>([]);
    const [taskId, setTaskId] = useState("");
    const selected = profiles.find((item) => item.id === selectedId) || null;
    const mappedFields = (selected?.fields || []).filter((field) => field.enabled !== false);
    const formConfig: WorkflowConfig = { title: selected?.name || "RunningHub", backend: "runninghub", operation: "workflow", description: "", fields: mappedFields.map(workflowFormField) };

    const refresh = async () => {
        setLoading(true); setError("");
        try {
            const [data, status] = await Promise.all([fetchRunningHubWorkflows(), fetchRunningHubStatus()]);
            setProfiles(data.workflows);
            setHasApiKey(status.hasApiKey);
            setSelectedId((current) => data.workflows.some((item) => item.id === current) ? current : data.workflows[0]?.id || "");
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);
    useEffect(() => {
        if (!selected) { setHistory([]); return; }
        let active = true;
        fetchRunningHubWorkflowTasks(selected.id).then(({ tasks }) => { if (active) setHistory(tasks); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : String(err)); });
        return () => { active = false; };
    }, [selectedId]);

    const addWorkflow = async () => {
        const id = workflowId.trim();
        if (!id) return;
        setLoading(true); setError("");
        try {
            const inspected = await inspectRunningHubWorkflow(id);
            const profile: RunningHubWorkflowProfile = { id: crypto.randomUUID(), name: `Workflow ${id.slice(-6)}`, workflowId: id, fields: inspected.fields, instanceType: "default" };
            const { workflow } = await saveRunningHubWorkflow(profile);
            setProfiles((current) => [workflow, ...current]);
            setSelectedId(workflow.id); setWorkflowId(""); setTaskResult(null);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setLoading(false); }
    };
    const updateField = (index: number, patch: Partial<RunningHubField>) => {
        if (!selected) return;
        setProfiles((current) => current.map((profile) => profile.id === selected.id ? { ...profile, fields: profile.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field) } : profile));
    };
    const saveProfile = async () => {
        if (!selected) return;
        setSaving(true); setError("");
        try {
            const { workflow } = await saveRunningHubWorkflow(selected);
            setProfiles((current) => current.map((profile) => profile.id === workflow.id ? workflow : profile));
            message.success("RunningHub 工作流映射已保存");
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setSaving(false); }
    };
    const deleteProfile = async () => {
        if (!selected) return;
        try {
            await deleteRunningHubWorkflow(selected.id);
            const next = profiles.filter((item) => item.id !== selected.id);
            setProfiles(next); setSelectedId(next[0]?.id || ""); setTaskResult(null);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    };
    const run = async (fields: Record<string, string>) => {
        if (!selected) return;
        setRunning(true); setTaskResult(null); setError(""); setTaskId("");
        try {
            const { workflow: savedProfile } = await saveRunningHubWorkflow(selected);
            setProfiles((current) => current.map((item) => item.id === savedProfile.id ? savedProfile : item));
            const input: Record<string, unknown> = {};
            const values: Record<string, unknown> = {};
            const params: Record<string, unknown> = {};
            const pushMedia = (key: "references" | "videos" | "audios", value: string, index?: number) => {
                const current = Array.isArray(input[key]) ? input[key] as string[] : [];
                if (index === undefined) current.push(value);
                else { while (current.length < index) current.push(""); current[index - 1] = value; }
                input[key] = current;
            };
            const cursors = { image: 0, video: 0, audio: 0 };
            const mediaIndices = new Map<string, number>();
            for (const field of mappedFields) {
                const source = field.source;
                if (source !== "image" && source !== "video" && source !== "audio") continue;
                const index = field.index ?? cursors[source] + 1;
                cursors[source] = Math.max(cursors[source], index);
                mediaIndices.set(runningHubFieldId(field), index);
            }
            for (const field of mappedFields) {
                const key = runningHubFieldId(field);
                const value = fields[key];
                if (field.source === "image") { pushMedia("references", value || "", mediaIndices.get(key)); continue; }
                if (field.source === "video") { pushMedia("videos", value || "", mediaIndices.get(key)); continue; }
                if (field.source === "audio") { pushMedia("audios", value || "", mediaIndices.get(key)); continue; }
                if (field.source === "prompt") { input.prompt = value ?? ""; continue; }
                if (field.source === "param" && field.paramKey) { if (value !== undefined && value !== "") params[field.paramKey] = numericValue(value); continue; }
                if (value === undefined) continue;
                values[key] = field.fieldType === "boolean" ? value === "true" : numericValue(value);
            }
            const result = await runRunningHubWorkflow(selected.id, input, values, params);
            setTaskId(result.taskId);
            const output = await pollWorkflowTask(result.taskId);
            setTaskResult(output);
            const refreshed = await fetchRunningHubWorkflowTasks(selected.id);
            setHistory(refreshed.tasks);
            message.success("RunningHub 工作流执行完成");
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setRunning(false); }
    };
    const runDefaults = () => void run({});
    const cancel = async () => {
        if (!taskId) return;
        try { await cancelRunningHubTask(taskId); message.success("已发送取消请求"); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    };

    const sourceOptions = ["constant", "prompt", "image", "video", "audio", "param"] as const;
    return <div className="grid h-full min-h-0 grid-cols-12 gap-4">
        <section className="col-span-4 flex min-h-0 flex-col rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
            <div className="border-b border-stone-200 p-3 dark:border-stone-700">
                <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium">RunningHub 工作流</h2><Button size="small" onClick={() => void refresh()} loading={loading}>刷新</Button></div>
                <Input.Search aria-label="RunningHub workflow ID" placeholder="输入 RunningHub workflowId" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} onSearch={() => void addWorkflow()} enterButton="读取并添加" loading={loading} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-stone-200 dark:divide-stone-700">
                {profiles.map((profile) => <button key={profile.id} type="button" onClick={() => { setSelectedId(profile.id); setTaskResult(null); }} className={`w-full px-3 py-3 text-left hover:bg-stone-50 dark:hover:bg-stone-800 ${selectedId === profile.id ? "bg-stone-100 dark:bg-stone-800" : ""}`}>
                    <span className="block truncate text-sm font-medium">{profile.name}</span><span className="mt-1 block truncate text-xs text-stone-500">{profile.workflowId} · {profile.fields.filter((field) => field.enabled !== false).length} 个映射</span>
                </button>)}
                {!loading && profiles.length === 0 && <Empty className="py-8" description="添加一个 RunningHub workflowId" />}
            </div>
        </section>
        <section className="col-span-8 min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
            {!hasApiKey ? <Alert type="warning" showIcon message="请先到运行环境配置 RunningHub API Key" action={<Button size="small" onClick={onOpenRuntime}>打开运行环境</Button>} className="mb-4" /> : null}
            {error ? <Alert type="error" showIcon message={error} className="mb-4" /> : null}
            {!selected ? <Empty description="先添加一个 RunningHub 工作流" /> : <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 gap-2"><Input aria-label="工作流名称" value={selected.name} onChange={(event) => setProfiles((current) => current.map((item) => item.id === selected.id ? { ...item, name: event.target.value } : item))} /><Input aria-label="workflowId" value={selected.workflowId} disabled /><Select aria-label="RunningHub 运行实例" style={{ width: 130 }} value={selected.instanceType || "default"} options={[{ value: "default", label: "default" }, { value: "plus", label: "plus" }, { value: "ultra", label: "ultra" }]} onChange={(instanceType) => setProfiles((current) => current.map((item) => item.id === selected.id ? { ...item, instanceType } : item))} /></div>
                    <div className="flex gap-2"><Button onClick={() => void saveProfile()} loading={saving}>保存映射</Button><Button danger onClick={() => void deleteProfile()}>移除</Button></div>
                </div>
                <p className="mb-3 text-xs text-stone-500">在 RunningHub 节点编辑器安装好工作流依赖后，用 API 格式字段配置要覆写的输入。未启用的字段沿用工作流默认值。</p>
                <Table size="small" rowKey={(field) => runningHubFieldId(field)} dataSource={selected.fields.map((field, index) => ({ ...field, index }))} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 780 }} columns={[
                    { title: "启用", width: 64, render: (_value, field) => <Checkbox checked={field.enabled !== false} onChange={(event) => updateField(field.index, { enabled: event.target.checked })} /> },
                    { title: "节点输入", width: 250, render: (_value, field) => <div><div>{field.nodeId} · {field.fieldName}</div><div className="text-xs text-stone-500">{field.label}</div></div> },
                    { title: "值来源", width: 150, render: (_value, field) => <Select value={field.source || "constant"} className="w-full" options={sourceOptions.map((source) => ({ value: source, label: ({ constant: "运行时填写", prompt: "工作流提示词", image: "图片上传", video: "视频上传", audio: "音频上传", param: "H3 参数" })[source] }))} onChange={(source) => updateField(field.index, { source, enabled: true, ...(source === "image" || source === "video" || source === "audio" ? { required: true } : {}) })} /> },
                    { title: "来源参数 / 序号", width: 190, render: (_value, field) => field.source === "param" ? <Input aria-label={`H3 参数 ${field.fieldName}`} value={field.paramKey || ""} onChange={(event) => updateField(field.index, { paramKey: event.target.value })} /> : ["image", "video", "audio"].includes(field.source || "") ? <InputNumber aria-label={`素材序号 ${field.fieldName}`} min={1} precision={0} value={field.index} placeholder="按字段顺序" onChange={(index) => updateField(field.index, { index: index ?? undefined })} /> : <span className="text-xs text-stone-400">运行时输入</span> },
                    { title: "必填", width: 64, render: (_value, field) => <Checkbox checked={field.required === true} onChange={(event) => updateField(field.index, { required: event.target.checked })} /> },
                ]} />
                <div className="my-5 border-t border-stone-200 dark:border-stone-700" />
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">运行输入</h3><Button onClick={runDefaults} loading={running} disabled={!hasApiKey || mappedFields.some((field) => field.source && field.source !== "constant")}>使用工作流默认值运行</Button></div>
                {mappedFields.length ? <RunPanel config={formConfig} onRun={(fields) => void run(fields)} running={running} result={taskResult} /> : <p className="text-xs text-stone-500">如需填写提示词或素材，启用对应字段并保存映射；也可直接运行工作流默认值。</p>}
                {running ? <Button danger size="small" disabled={!taskId} onClick={() => void cancel()} className="mt-2">取消当前任务</Button> : null}
                {!mappedFields.length && taskResult?.media.length ? <div className="mt-3 grid grid-cols-2 gap-3">{taskResult.media.map((item, index) => <div key={`${item.storageKey}-${index}`} className="overflow-hidden rounded border border-stone-200 dark:border-stone-700">{item.mimeType.startsWith("video/") ? <video src={item.url} controls className="w-full" /> : item.mimeType.startsWith("audio/") ? <audio src={item.url} controls className="w-full p-2" /> : item.mimeType.startsWith("image/") ? <img src={item.url} alt={item.filename} className="w-full" /> : <a href={item.url} download={item.filename} className="block break-all p-3 text-blue-600">下载 {item.filename || "输出文件"}</a>}</div>)}</div> : null}
                {!mappedFields.length && taskResult?.texts?.length ? <div className="mt-3 space-y-2">{taskResult.texts.map((item, index) => <pre key={index} className="whitespace-pre-wrap rounded bg-stone-50 p-3 text-xs dark:bg-stone-800">{item.content}</pre>)}</div> : null}
                <div className="mt-6 border-t border-stone-200 pt-4 dark:border-stone-700"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">运行历史</h3><Button size="small" onClick={() => void fetchRunningHubWorkflowTasks(selected.id).then(({ tasks }) => setHistory(tasks))}>刷新</Button></div>
                    <div className="space-y-2">{history.map((task) => <div key={task.id} className="rounded border border-stone-200 p-2 text-xs dark:border-stone-700"><div className="flex items-center justify-between"><Tag color={task.status === "succeeded" ? "green" : task.status === "failed" ? "red" : "blue"}>{task.status}</Tag><span>{task.createdAt || ""}</span></div>{task.error ? <div className="mt-1 text-red-500">{task.error}</div> : null}</div>)}</div>
                </div>
            </>}
        </section>
    </div>;
}
