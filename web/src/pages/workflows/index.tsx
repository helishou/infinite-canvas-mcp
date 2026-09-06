import { useEffect, useState, useCallback } from "react";
import { Button, Empty, Input, Modal, Spin, Switch, Select, Tag, message, Tree } from "antd";
import { Plus, Upload as UploadIcon, Play, Trash2, Edit3, Settings2, Workflow, Code, Server, History } from "lucide-react";
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
    const [addingField, setAddingField] = useState<{ nodeId: string; inputName: string } | null>(null);
    const [fieldForm, setFieldForm] = useState<Partial<WorkflowField>>({});
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

    useEffect(() => {
        fetchWorkflows();
    }, [fetchWorkflows]);

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
            message.success("配置已保存");
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

    // 加载工作流历史（统一从 generation_logs 读取）
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

    useEffect(() => {
        if (activeTab === "history") loadHistory();
    }, [activeTab, loadHistory]);

    const handleDeleteHistory = async (id: string) => {
        try {
            await deleteBackendGenerationLogs({ id });
            loadHistory();
            message.success("已删除");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "删除失败");
        }
    };

    // 点击 JSON 结构的 input 时，弹出添加字段对话框
    const handleAddField = (nodeId: string, inputName: string, currentValue: any) => {
        setAddingField({ nodeId, inputName });
        setFieldForm({
            id: `${nodeId}_${inputName}`,
            node: nodeId,
            input: inputName,
            name: inputName,
            type: typeof currentValue === "number" ? "number" : "text",
            default: currentValue,
        });
    };

    const handleConfirmAddField = () => {
        if (!selected || !addingField) return;
        if (!fieldForm.id || !fieldForm.name) {
            message.warning("请填写字段 ID 和名称");
            return;
        }
        const newField: WorkflowField = {
            id: fieldForm.id,
            node: addingField.nodeId,
            input: addingField.inputName,
            name: fieldForm.name || addingField.inputName,
            type: fieldForm.type || "text",
            default: fieldForm.default,
            min: fieldForm.min,
            max: fieldForm.max,
            step: fieldForm.step,
        };
        const updatedConfig = {
            ...selected.config,
            fields: [...selected.config.fields, newField],
        };
        handleSaveConfig(updatedConfig);
        setAddingField(null);
        setFieldForm({});
    };

    const handleRemoveField = (fieldId: string) => {
        if (!selected) return;
        const updatedConfig = {
            ...selected.config,
            fields: selected.config.fields.filter((f) => f.id !== fieldId),
        };
        handleSaveConfig(updatedConfig);
    };

    // 将 workflow JSON 转换为 Tree 数据
    const buildTreeData = (workflow: Record<string, any>) => {
        return Object.entries(workflow).map(([nodeId, node]) => {
            const classType = (node as any).class_type || "Unknown";
            const inputs = (node as any).inputs || {};
            const children = Object.entries(inputs).map(([inputName, value]) => ({
                title: (
                    <div className="flex items-center justify-between group">
                        <span className="text-xs">
                            <code className="text-blue-600 dark:text-blue-400">{inputName}</code>
                            <span className="ml-2 text-stone-400 truncate max-w-32">
                                {typeof value === "string" ? value : JSON.stringify(value)}
                            </span>
                        </span>
                        <Button
                            type="text"
                            size="small"
                            icon={<Plus className="size-3" />}
                            className="opacity-0 group-hover:opacity-100 transition"
                            onClick={(e) => {
                                e.stopPropagation();
                                handleAddField(nodeId, inputName, value);
                            }}
                        />
                    </div>
                ),
                key: `${nodeId}.inputs.${inputName}`,
                isLeaf: true,
            }));
            return {
                title: (
                    <div className="flex items-center gap-2">
                        <Tag color="geekblue" className="text-xs">{nodeId}</Tag>
                        <span className="text-sm font-mono">{classType}</span>
                    </div>
                ),
                key: nodeId,
                children,
            };
        });
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
                                    <p className="text-sm text-stone-500">{selected.name} · {Object.keys(selected.workflow).length} 个节点</p>
                                </div>
                                <div className="flex gap-2">
                                    <Button icon={<Edit3 className="size-4" />} onClick={() => setActiveTab("config")}>
                                        编辑配置
                                    </Button>
                                    <Button danger icon={<Trash2 className="size-4" />} onClick={() => handleDelete(selected.name)} disabled={selected.builtin}>
                                        删除
                                    </Button>
                                </div>
                            </div>

                            {/* Tab 切换 */}
                            <div className="rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                                <div className="flex border-b border-stone-200 dark:border-stone-700">
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${
                                            activeTab === "structure" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"
                                        }`}
                                        onClick={() => setActiveTab("structure")}
                                    >
                                        <Code className="size-4" /> 节点图
                                    </button>
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${
                                            activeTab === "config" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"
                                        }`}
                                        onClick={() => setActiveTab("config")}
                                    >
                                        <Settings2 className="size-4" /> 字段配置 ({selected.config.fields.length})
                                    </button>
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${
                                            activeTab === "run" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"
                                        }`}
                                        onClick={() => setActiveTab("run")}
                                    >
                                        <Play className="size-4" /> 运行
                                    </button>
                                    <button
                                        className={`flex items-center gap-2 px-4 py-3 text-sm transition ${
                                            activeTab === "history" ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"
                                        }`}
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
                                                onNodeClick={(nodeId) => {
                                                    handleAddField(nodeId, "", "");
                                                }}
                                            />
                                        </div>
                                    )}

                                    {activeTab === "config" && (
                                        <FieldConfigPanel
                                            config={selected.config}
                                            workflow={selected.workflow}
                                            onSave={handleSaveConfig}
                                            onAddField={handleAddField}
                                            onRemoveField={handleRemoveField}
                                        />
                                    )}

                                    {activeTab === "run" && (
                                        <RunPanel config={selected.config} onRun={handleRun} running={running} result={taskResult} />
                                    )}

                                    {activeTab === "history" && (
                                        <div>
                                            <div className="mb-3 flex items-center justify-between">
                                                <p className="text-xs text-stone-500">
                                                    工作流运行历史（与生图/画布日志共享存储）
                                                </p>
                                                <Button size="small" onClick={loadHistory} disabled={loadingHistory}>
                                                    刷新
                                                </Button>
                                            </div>
                                            {loadingHistory ? (
                                                <Spin />
                                            ) : historyLogs.length === 0 ? (
                                                <Empty description="暂无运行历史" />
                                            ) : (
                                                <div className="space-y-2">
                                                    {historyLogs.map((log) => (
                                                        <div
                                                            key={log.id}
                                                            className="flex items-center gap-3 rounded border border-stone-200 bg-white p-3 text-sm dark:border-stone-700 dark:bg-stone-800"
                                                        >
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <Tag color={log.status === "success" ? "green" : log.status === "failed" ? "red" : "blue"}>
                                                                        {log.status}
                                                                    </Tag>
                                                                    <span className="font-medium truncate">{log.workflow}</span>
                                                                    <span className="text-xs text-stone-400 shrink-0">
                                                                        {new Date(log.createdAt).toLocaleString()}
                                                                    </span>
                                                                </div>
                                                                {log.prompt && (
                                                                    <p className="text-xs text-stone-500 truncate" title={log.prompt}>
                                                                        {log.prompt}
                                                                    </p>
                                                                )}
                                                                {log.error && (
                                                                    <p className="text-xs text-red-500 truncate" title={log.error}>
                                                                        {log.error}
                                                                    </p>
                                                                )}
                                                                {log.outputs.length > 0 && (
                                                                    <div className="mt-1 flex gap-1">
                                                                        {log.outputs.slice(0, 4).map((o, i) => (
                                                                            <img
                                                                                key={i}
                                                                                src={o.url}
                                                                                alt=""
                                                                                className="h-10 w-10 rounded object-cover"
                                                                            />
                                                                        ))}
                                                                        {log.outputs.length > 4 && (
                                                                            <span className="flex h-10 w-10 items-center justify-center rounded bg-stone-100 text-xs text-stone-500">
                                                                                +{log.outputs.length - 4}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <Button
                                                                size="small"
                                                                danger
                                                                icon={<Trash2 className="size-3" />}
                                                                onClick={() => handleDeleteHistory(log.id)}
                                                            />
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
                                if (file) {
                                    await handleUpload(file);
                                    e.target.value = "";
                                }
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                        />
                    </div>

                    <div className="rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                        <div className="border-b border-stone-200 px-4 py-3 dark:border-stone-700">
                            <h2 className="text-sm font-medium">工作流列表</h2>
                        </div>
                        {workflows.length === 0 ? (
                            <div className="p-6">
                                <Empty description="暂无工作流" />
                            </div>
                        ) : (
                            <div className="divide-y divide-stone-200 dark:divide-stone-700">
                                {workflows.map((wf) => (
                                    <div
                                        key={wf.name}
                                        className={`cursor-pointer px-4 py-3 transition hover:bg-stone-50 dark:hover:bg-stone-800 ${
                                            selected?.name === wf.name ? "bg-stone-100 dark:bg-stone-800" : ""
                                        }`}
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

            {/* 添加字段 Modal */}
            {addingField && (
                <Modal
                    title="添加字段映射"
                    open
                    onCancel={() => { setAddingField(null); setFieldForm({}); }}
                    onOk={handleConfirmAddField}
                    okText="添加"
                    cancelText="取消"
                >
                    <div className="space-y-3">
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">节点 ID</label>
                            <Input value={addingField.nodeId} disabled />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">输入名</label>
                            <Input value={addingField.inputName} disabled />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">字段 ID *</label>
                            <Input
                                value={fieldForm.id || ""}
                                onChange={(e) => setFieldForm((prev) => ({ ...prev, id: e.target.value }))}
                                placeholder="唯一标识"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">显示名 *</label>
                            <Input
                                value={fieldForm.name || ""}
                                onChange={(e) => setFieldForm((prev) => ({ ...prev, name: e.target.value }))}
                                placeholder="如：提示词、宽度"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">类型</label>
                            <Input
                                value={fieldForm.type || "text"}
                                onChange={(e) => setFieldForm((prev) => ({ ...prev, type: e.target.value as any }))}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-stone-500">默认值</label>
                            <Input
                                value={String(fieldForm.default ?? "")}
                                onChange={(e) => setFieldForm((prev) => ({ ...prev, default: e.target.value }))}
                            />
                        </div>
                    </div>
                </Modal>
            )}

            <InstancesModal open={instancesOpen} onClose={() => setInstancesOpen(false)} />
        </div>
    );
}

type FieldConfigPanelProps = {
    config: WorkflowConfig;
    workflow: Record<string, any>;
    onSave: (config: WorkflowConfig) => void;
    onAddField: (nodeId: string, inputName: string, value: any) => void;
    onRemoveField: (id: string) => void;
};

function FieldConfigPanel(props: FieldConfigPanelProps) {
    const { config, onSave, onRemoveField } = props;
    const [editing, setEditing] = useState<WorkflowConfig>({ ...config, fields: [...config.fields] });

    useEffect(() => {
        setEditing({ ...config, fields: [...config.fields] });
    }, [config]);

    const handleSave = () => {
        onSave(editing);
    };

    const updateField = (index: number, updates: Partial<WorkflowField>) => {
        setEditing((prev) => ({
            ...prev,
            fields: prev.fields.map((f, i) => (i === index ? { ...f, ...updates } : f)),
        }));
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="mb-1 block text-xs text-stone-500">工作流名称</label>
                    <Input
                        value={editing.title}
                        onChange={(e) => setEditing((prev) => ({ ...prev, title: e.target.value }))}
                    />
                </div>
                <div>
                    <label className="mb-1 block text-xs text-stone-500">操作类型</label>
                    <Input
                        value={editing.operation}
                        onChange={(e) => setEditing((prev) => ({ ...prev, operation: e.target.value }))}
                        placeholder="如：generate, upscale"
                    />
                </div>
            </div>
            <div>
                <label className="mb-1 block text-xs text-stone-500">描述</label>
                <Input.TextArea
                    value={editing.description}
                    onChange={(e) => setEditing((prev) => ({ ...prev, description: e.target.value }))}
                    rows={2}
                />
            </div>

            <div>
                <div className="mb-2 flex items-center justify-between">
                    <label className="text-xs text-stone-500">字段定义</label>
                    <span className="text-xs text-stone-400">点击 JSON 结构中的 input 可快速添加</span>
                </div>

                {editing.fields.length === 0 ? (
                    <div className="rounded border border-dashed border-stone-300 p-6 text-center text-sm text-stone-400 dark:border-stone-700">
                        暂无字段，切换到「JSON 结构」Tab 点击 + 添加
                    </div>
                ) : (
                    <div className="space-y-2">
                        {editing.fields.map((field, index) => (
                            <div key={field.id} className="flex items-center gap-2 rounded border border-stone-200 bg-stone-50 p-2 dark:border-stone-700 dark:bg-stone-800">
                                <div className="flex-1 grid grid-cols-4 gap-2">
                                    <Input
                                        size="small"
                                        placeholder="field_id"
                                        value={field.id}
                                        onChange={(e) => updateField(index, { id: e.target.value })}
                                    />
                                    <Input
                                        size="small"
                                        placeholder="node"
                                        value={field.node}
                                        onChange={(e) => updateField(index, { node: e.target.value })}
                                    />
                                    <Input
                                        size="small"
                                        placeholder="input"
                                        value={field.input}
                                        onChange={(e) => updateField(index, { input: e.target.value })}
                                    />
                                    <Input
                                        size="small"
                                        placeholder="显示名"
                                        value={field.name}
                                        onChange={(e) => updateField(index, { name: e.target.value })}
                                    />
                                </div>
                                <Select
                                    size="small"
                                    value={field.type}
                                    onChange={(val) => updateField(index, { type: val })}
                                    options={["text", "number", "slider", "boolean", "dropdown", "image"].map((t) => ({ label: t, value: t }))}
                                    className="w-24"
                                />
                                {field.type === "dropdown" && (
                                    <Input
                                        size="small"
                                        placeholder="选项（逗号分隔）"
                                        value={(field.options ?? []).join(",")}
                                        onChange={(e) => updateField(index, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                                    />
                                )}
                                <Switch size="small" checked={field.randomEnabled} onChange={(val) => updateField(index, { randomEnabled: val })} title="随机值" />
                                <Button size="small" danger type="text" onClick={() => onRemoveField(field.id)}>
                                    <Trash2 className="size-3" />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex justify-end gap-2">
                <Button onClick={() => setEditing({ ...config, fields: [...config.fields] })}>重置</Button>
                <Button type="primary" onClick={handleSave}>保存配置</Button>
            </div>
        </div>
    );
}

type RunPanelProps = {
    config: WorkflowConfig;
    onRun: (fields: Record<string, string>) => void;
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
    const [previewUrl, setPreviewUrl] = useState<string>(value || "");

    useEffect(() => {
        setPreviewUrl(value || "");
    }, [value]);

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

    const handleClear = () => {
        setPreviewUrl("");
        onChange("");
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <input
                    ref={inputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileChange}
                />
                <Button
                    size="small"
                    icon={<Upload className="size-3" />}
                    onClick={() => inputRef.current?.click()}
                >
                    {value ? "更换图片" : "选择图片"}
                </Button>
                {value && (
                    <>
                        <Tag color="blue" className="text-xs font-mono truncate max-w-32">已选择图片</Tag>
                        <Button size="small" danger type="text" onClick={handleClear}>
                            <Trash2 className="size-3" />
                        </Button>
                    </>
                )}
            </div>
            {previewUrl && (
                <div className="relative inline-block">
                    <img
                        src={previewUrl}
                        alt=""
                        className="h-24 w-24 rounded object-cover border border-stone-200 dark:border-stone-700"
                    />
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
            if (f.default !== undefined && f.default !== null) {
                defaults[f.id] = String(f.default);
            }
        }
        setFields(defaults);
    }, [config.fields]);

    const handleSubmit = () => {
        onRun(fields);
    };

    return (
        <div className="space-y-4">
            {config.fields.length === 0 ? (
                <div className="text-center text-sm text-stone-500">
                    <Settings2 className="mx-auto mb-2 size-8 text-stone-300" />
                    <p>请先配置字段后再运行</p>
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
                                <Input.TextArea
                                    value={fields[field.id] || ""}
                                    onChange={(e) => setFields((prev) => ({ ...prev, [field.id]: e.target.value }))}
                                    rows={2}
                                    placeholder={field.name}
                                />
                            ) : field.type === "image" ? (
                                <ImageFieldUpload
                                    fieldId={field.id}
                                    value={fields[field.id] || ""}
                                    onChange={(val) => setFields((prev) => ({ ...prev, [field.id]: val }))}
                                />
                            ) : field.type === "dropdown" ? (
                                <Select
                                    value={fields[field.id] || undefined}
                                    onChange={(val) => setFields((prev) => ({ ...prev, [field.id]: val }))}
                                    options={(field.options ?? []).map((o) => ({ label: o, value: o }))}
                                    placeholder={field.name}
                                    className="w-full"
                                />
                            ) : (
                                <Input
                                    value={fields[field.id] || ""}
                                    onChange={(e) => setFields((prev) => ({ ...prev, [field.id]: e.target.value }))}
                                    placeholder={String(field.default || "")}
                                />
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Button
                type="primary"
                icon={<Play className="size-4" />}
                onClick={handleSubmit}
                loading={running}
                disabled={config.fields.length === 0}
            >
                {running ? "执行中..." : "运行工作流"}
            </Button>

            {running && (
                <div className="flex items-center gap-2 text-sm text-stone-500">
                    <Spin size="small" /> 正在提交到 ComfyUI...
                </div>
            )}

            {result && result.media.length > 0 && (
                <div>
                    <h4 className="mb-2 text-sm font-medium">执行结果</h4>
                    <div className="grid grid-cols-2 gap-3">
                        {result.media.map((item, idx) => (
                            <div key={idx} className="overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                                {item.mimeType?.startsWith("video/") ? (
                                    <video src={item.url} controls className="w-full" />
                                ) : item.mimeType?.startsWith("audio/") ? (
                                    <audio src={item.url} controls className="w-full p-2" />
                                ) : (
                                    <img src={item.url} alt={item.filename} className="w-full" />
                                )}
                                <p className="truncate px-2 py-1 text-xs text-stone-500">{item.filename}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {result && result.error && (
                <div className="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20">
                    错误: {result.error}
                </div>
            )}

        </div>
    );
}
