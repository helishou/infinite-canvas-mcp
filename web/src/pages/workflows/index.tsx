import { useEffect, useState, useCallback, useRef } from "react";
import { Button, Empty, Input, Spin, Tag, message, Select, Switch } from "antd";
import { Upload as UploadIcon, Upload, Play, Trash2, Settings2, Workflow, Code, Server, History } from "lucide-react";
import { request, fetchBackendGenerationLogs, deleteBackendGenerationLogs } from "@/services/backend-api";
import { WorkflowGraphPanel } from "./workflow-graph-panel";
import { InstancesModal } from "./instances-modal";
import "../../styles/workflow-graph.css";
import type { WorkflowConfig, WorkflowField } from "@/types/workflow";

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

type TaskResult = {
    taskId: string;
    promptId: string;
    media: Array<{ url: string; mimeType: string; filename: string; storageKey?: string }>;
    status: { status_str: string; completed: boolean };
    error?: string;
};

export default function WorkflowsPage() {
    const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<WorkflowDetail | null>(null);
    const [running, setRunning] = useState(false);
    const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
    const [activeTab, setActiveTab] = useState("structure");
    const [instancesOpen, setInstancesOpen] = useState(false);
    const [historyLogs, setHistoryLogs] = useState<Array<{ id: string; workflow: string; prompt: string; status: string; createdAt: string; outputs: Array<{ url: string; mimeType: string }>; error?: string }>>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

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
            const workflow = JSON.parse(text);
            await request("POST", "/api/workflows", { name: file.name.replace(/\.json$/, ""), workflow });
            message.success("工作流上传成功");
            fetchWorkflows();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "上传失败");
        } finally {
            setLoading(false);
        }
        return false;
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
            const result = await request<TaskResult>("POST", `/api/workflows/${encodeURIComponent(selected.name)}/run`, {
                fields,
                config: selected.config,
            });
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
            setHistoryLogs((data.logs || []).map((log) => ({
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
    }, []);

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
        <div className="mx-auto max-w-7xl p-6">
            <div className="flex items-center justify-between">
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <Workflow className="size-6" /> 工作流管理
                </h1>
                <Button icon={<Server className="size-4" />} onClick={() => setInstancesOpen(true)}>
                    管理后端
                </Button>
            </div>

            <div className="mt-6 grid grid-cols-12 gap-6">
                <div className="col-span-8">
                    {!selected ? (
                        <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                            <div className="text-center">
                                <Workflow className="mx-auto size-12 text-stone-300" />
                                <p className="mt-2 text-sm text-stone-500">选择工作流查看详情</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
                                <div>
                                    <h2 className="text-lg font-semibold">{selected.config.title || selected.name}</h2>
                                    <p className="text-sm text-stone-500">{selected.name} · {Object.keys(selected.workflow).length} 个节点 · {selected.config.fields.length} 字段</p>
                                </div>
                                <div className="flex gap-2">
                                    <Button danger icon={<Trash2 className="size-4" />} onClick={() => handleDelete(selected.name)} disabled={selected.builtin}>
                                        删除
                                    </Button>
                                </div>
                            </div>

                            <div className="rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                                <div className="flex border-b border-stone-200 dark:border-stone-700">
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${activeTab === "structure" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("structure")}
                                    >
                                        <Code className="size-4" /> 节点图
                                    </button>
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${activeTab === "run" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("run")}
                                    >
                                        <Play className="size-4" /> 运行
                                    </button>
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${activeTab === "history" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                                        onClick={() => setActiveTab("history")}
                                    >
                                        <History className="size-4" /> 历史 ({historyLogs.length})
                                    </button>
                                </div>

                                <div className="p-4">
                                    {activeTab === "structure" && (
                                        <div className="h-[500px]">
                                            <WorkflowGraphPanel
                                                workflow={selected.workflow}
                                                fields={selected.config.fields}
                                                onFieldsChange={handleFieldsChange}
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
                                                                            <img key={i} src={o.url} alt="" className="h-10 w-10 rounded object-cover" />
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

                <div className="col-span-4 space-y-4">
                    <div className="relative flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                        <UploadIcon className="size-4 shrink-0 text-stone-400" />
                        <span className="text-sm text-stone-600 dark:text-stone-300">点击或拖拽上传 .json</span>
                        <input
                            type="file"
                            accept=".json"
                            onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (file) { await handleUpload(file); e.target.value = ""; }
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                        />
                    </div>

                    <div className="rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                        <div className="border-b border-stone-200 px-4 py-3 dark:border-stone-700">
                            <h2 className="text-sm font-medium">工作流列表</h2>
                        </div>
                        {workflows.length === 0 ? (
                            <div className="p-6"><Empty description="暂无工作流" /></div>
                        ) : (
                            <div className="divide-y divide-stone-200 dark:divide-stone-700">
                                {workflows.map((wf) => (
                                    <div
                                        key={wf.name}
                                        className={`cursor-pointer px-4 py-3 transition hover:bg-stone-50 dark:hover:bg-stone-800 ${selected?.name === wf.name ? "bg-stone-100 dark:bg-stone-800" : ""}`}
                                        onClick={() => handleLoadDetail(wf.name)}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-medium">{wf.title}</p>
                                                <p className="text-xs text-stone-500">{wf.name}</p>
                                            </div>
                                            <Tag color="blue">{wf.fieldCount} 字段</Tag>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <InstancesModal open={instancesOpen} onClose={() => setInstancesOpen(false)} />
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

type ImageFieldUploadProps = {
    fieldId: string;
    value: string;
    onChange: (value: string) => void;
};

function ImageFieldUpload({ fieldId, value, onChange }: ImageFieldUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const storageKey = `wf_image_${fieldId}`;
    const [previewUrl, setPreviewUrl] = useState<string>>(() => {
        // 优先使用当前值，否则从 localStorage 恢复
        if (value) return value;
        try { return localStorage.getItem(storageKey) || ""; } catch { return ""; }
    });

    useEffect(() => {
        if (value) setPreviewUrl(value);
    }, [value]);

    useEffect(() => {
        // 持久化到 localStorage
        if (previewUrl && previewUrl.startsWith("data:")) {
            try { localStorage.setItem(storageKey, previewUrl); } catch { /* ignore */ }
        } else if (previewUrl === "") {
            try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
        }
    }, [previewUrl, storageKey]);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        setPreviewUrl(dataUrl);
        onChange(dataUrl);
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
                <Button size="small" icon={<Upload className="size-3" />} onClick={() => inputRef.current?.click()}>
                    {previewUrl ? "更换图片" : "选择图片"}
                </Button>
                {previewUrl && (
                    <>
                        <Tag color="blue" className="text-xs truncate max-w-32">已选择图片</Tag>
                        <Button size="small" danger type="text" onClick={() => { setPreviewUrl(""); onChange(""); }}>
                            <Trash2 className="size-3" />
                        </Button>
                    </>
                )}
            </div>
            {previewUrl && (
                <div className="relative inline-block">
                    <img src={previewUrl} alt="" className="h-24 w-24 rounded object-cover border border-stone-200 dark:border-stone-700" />
                </div>
            )}
        </div>
    );
}

function RunPanel({ config, onRun, running, result }: RunPanelProps) {
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
                                <Tag color="default" className="text-xs">{field.node}.{field.input}</Tag>
                            </label>
                            {field.type === "text" ? (
                                <Input.TextArea value={fields[field.id] || ""} onChange={(e) => setFields((p) => ({ ...p, [field.id]: e.target.value }))} rows={2} placeholder={field.name} />
                            ) : field.type === "image" ? (
                                <ImageFieldUpload fieldId={field.id} value={fields[field.id] || ""} onChange={(v) => setFields((p) => ({ ...p, [field.id]: v }))} />
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
                                {item.mimeType?.startsWith("video/") ? <video src={item.url} controls className="w-full" /> : item.mimeType?.startsWith("audio/") ? <audio src={item.url} controls className="w-full p-2" /> : <img src={item.url} alt={item.filename} className="w-full" />}
                                <p className="truncate px-2 py-1 text-xs text-stone-500">{item.filename}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {result && result.error && <div className="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20">错误: {result.error}</div>}
        </div>
    );
}
