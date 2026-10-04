import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Input, InputNumber, Spin, Table, Tabs, message, Select } from "antd";
import { Upload as UploadIcon, Download, Play, Trash2, Workflow } from "lucide-react";
import { request, fetchBackendGenerationLogs, deleteBackendGenerationLogs } from "@/services/backend-api";
import { exportWorkflowPackage, importWorkflowPackage, renameWorkflowTitle, runWorkflow, pollWorkflowTask, type WorkflowConfig, type WorkflowField, type WorkflowPackage, type WorkflowRunResult } from "@/services/api/workflows";
import { WorkflowGraphPanel } from "./workflow-graph-panel";
import { WorkflowLibraryList, type WorkflowLibraryItem } from "./workflow-library-list";
import { RunTab } from "./run-panel";
import { WorkflowWorkbench, type WorkbenchTab } from "./workflow-workbench";
import { RunHistoryList } from "./run-history-list";
import { normalizeOutputNodeSelection, OutputNodePicker } from "./output-node-picker";
import { RunningHubWorkflowImport } from "./runninghub-workflow-import";
import { ComfyChannelsPanel, ComfyRuntimePanel } from "./comfy-management-panels";
import "../../styles/workflow-graph.css";

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
    const [activeTab, setActiveTab] = useState<WorkbenchTab>("graph");
    const [historyLogs, setHistoryLogs] = useState<Array<{ id: string; workflow: string; prompt: string; status: string; createdAt: string; outputs: Array<{ url: string; mimeType: string }>; error?: string }>>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");
    // 指定输出节点属于当前工作流的配置，跟着 config 一起存；不选=不过滤。
    const [outputNodes, setOutputNodes] = useState<string[]>([]);

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

    // title 由列表壳传入：重命名输入态是壳内部状态，页面不再持有 editValue。
    const handleRename = async (name: string, title: string) => {
        const trimmed = title.trim();
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
            const outputNodes = normalizeOutputNodeSelection(detail.config.outputNodes || [], detail.workflow);
            setSelected({ ...detail, config: { ...detail.config, outputNodes } });
            setTaskResult(null);
            setOutputNodes(outputNodes);
            setActiveTab("graph");
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
            // 输出节点跟着本轮一起提交；config 里同时落盘，保证下次运行保持一致。
            const baseConfig = selected.config;
            const config = { ...baseConfig, outputNodes };
            await handleSaveConfig(config);
            const { taskId } = await runWorkflow(selected.name, fields, config);
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

    const handleOutputNodesChange = (next: string[]) => {
        setOutputNodes(next);
        if (selected) void handleSaveConfig({ ...selected.config, outputNodes: next });
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

    /** 本地工作流库列表项：标题取配置标题，副标题是文件名，徽标是字段数。 */
    const libraryItems = useMemo<WorkflowLibraryItem[]>(
        () =>
            workflows.map((wf) => ({
                id: wf.name,
                title: wf.title,
                meta: wf.name.replace(/^custom\//, ""),
                badge: `${wf.fieldCount} 字段`,
                builtin: wf.builtin,
            })),
        [workflows],
    );

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
                        <WorkflowWorkbench
                            activeTab={activeTab}
                            onTabChange={setActiveTab}
                            historyCount={historyLogs.length}
                            title={
                                editingName === selected.name ? (
                                    <Input
                                        autoFocus
                                        size="small"
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        onPressEnter={() => handleRename(selected.name, editValue)}
                                        onBlur={() => handleRename(selected.name, editValue)}
                                        className="w-full"
                                    />
                                ) : (
                                    <h2
                                        className={`truncate ${selected.builtin ? "cursor-default" : "cursor-pointer hover:text-blue-600"}`}
                                        title={selected.builtin ? "" : "双击重命名"}
                                        onDoubleClick={() => {
                                            if (selected.builtin) return;
                                            setEditingName(selected.name);
                                            setEditValue(selected.config.title || selected.name);
                                        }}
                                    >
                                        {selected.config.title || selected.name}
                                    </h2>
                                )
                            }
                            subtitle={`${selected.name.replace(/^custom\//, "")} · ${Object.keys(selected.workflow).length} 个节点 · ${selected.config.fields.length} 字段`}
                            actions={
                                <>
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={handleExport}>导出</Button>
                                    {!selected.builtin && (
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete(selected.name)}>删除</Button>
                                    )}
                                </>
                            }
                            graph={
                                <WorkflowGraphPanel
                                    name={selected.name}
                                    workflow={selected.workflow}
                                    fields={selected.config.fields}
                                    onFieldsChange={handleFieldsChange}
                                    onWorkflowChange={(workflow) => {
                                        if (!selected) return;
                                        const nextOutputNodes = normalizeOutputNodeSelection(outputNodes, workflow);
                                        setOutputNodes(nextOutputNodes);
                                        const next = { ...selected, workflow, config: { ...selected.config, outputNodes: nextOutputNodes } };
                                        setSelected(next);
                                        void request("PUT", `/api/workflows/${encodeURIComponent(selected.name)}/workflow`, workflow).catch((error) => message.error(error instanceof Error ? error.message : "保存节点图失败"));
                                    }}
                                />
                            }
                            run={
                                <RunTab
                                    config={selected.config}
                                    onRun={handleRun}
                                    running={running}
                                    result={taskResult}
                                    outputPicker={<OutputNodePicker graph={selected.workflow} value={outputNodes} onChange={handleOutputNodesChange} />}
                                />
                            }
                            history={
                                <RunHistoryList
                                    entries={historyLogs.map((log) => ({
                                        id: log.id,
                                        status: log.status,
                                        title: log.workflow,
                                        time: new Date(log.createdAt).toLocaleString(),
                                        prompt: log.prompt,
                                        error: log.error,
                                        outputs: log.outputs,
                                        onDelete: () => void handleDeleteHistory(log.id),
                                    }))}
                                    loading={loadingHistory}
                                    onRefresh={loadHistory}
                                    hint="工作流运行历史（与生图/画布日志共享存储）"
                                />
                            }
                        />
                    )}
                </div>

                <div className="col-span-4 flex min-h-0 flex-col gap-3">
                    <div className="relative flex shrink-0 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                        {loading ? <Spin size="small" /> : <UploadIcon className="size-4 shrink-0 text-stone-400" />}
                        <span className="text-sm text-stone-600 dark:text-stone-300">{loading ? "正在导入…" : "导入本地 ComfyUI JSON / 工作流包"}</span>
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
                    <RunningHubWorkflowImport workflows={workflows} onImported={(name) => { void fetchWorkflows().then(() => handleLoadDetail(name)); }} />

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                        <div className="shrink-0 border-b border-stone-200 px-3 py-2.5 dark:border-stone-700">
                            <h2 className="text-sm font-medium">工作流列表</h2>
                        </div>
                        <WorkflowLibraryList
                            items={libraryItems}
                            selectedId={selected?.name}
                            onSelect={(item) => void handleLoadDetail(item.id)}
                            onRename={(item, title) => void handleRename(item.id, title)}
                        />
                    </div>
                </div>
            </div> : section === "models" ? <ComfyChannelsPanel /> : <ComfyRuntimePanel />}
            </div>
        </div>
    );
}
