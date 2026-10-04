import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Input, InputNumber, Segmented, Spin, Table, Tabs, message, Select } from "antd";
import { Upload as UploadIcon, Cloud, Download, Play, Trash2, Workflow } from "lucide-react";
import { request, fetchBackendGenerationLogs, deleteBackendGenerationLogs } from "@/services/backend-api";
import { exportWorkflowPackage, importWorkflowPackage, renameWorkflowTitle, runWorkflow, pollWorkflowTask, type WorkflowConfig, type WorkflowField, type WorkflowPackage, type WorkflowRunResult } from "@/services/api/workflows";
import { WorkflowGraphPanel } from "./workflow-graph-panel";
import { WorkflowLibraryList, type WorkflowLibraryItem } from "./workflow-library-list";
import { RunTab } from "./run-panel";
import { WorkflowWorkbench, type WorkbenchTab } from "./workflow-workbench";
import { RunHistoryList } from "./run-history-list";
import { normalizeOutputNodeSelection, OutputNodePicker } from "./output-node-picker";
import { RunningHubWorkflowImport } from "./runninghub-workflow-import";
import { RunningHubProfileActions } from "./runninghub-profile-actions";
import { RunningHubGraphPanel } from "./runninghub-graph-panel";
import { runningHubProfileToConfig, runningHubValuesFromForm } from "./runninghub-run-adapter";
import { runRunningHubWorkflow, cancelRunningHubTask } from "@/services/api/runninghub";
import { fetchRunningHubWorkflows, fetchRunningHubStatus, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import { useConfigStore } from "@/stores/use-config-store";
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
    const [selectedProfile, setSelectedProfile] = useState<RunningHubWorkflowProfile | null>(null);
    const [running, setRunning] = useState(false);
    const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
    const [section, setSection] = useState("workflows");
    // 本地库与 RunningHub 库共用同一页面壳，数据源与选中项各自独立。
    const [library, setLibrary] = useState<"local" | "runninghub">("local");
    const aiConfig = useConfigStore((state) => state.config);
    const [profiles, setProfiles] = useState<RunningHubWorkflowProfile[]>([]);
    const [profilesLoading, setProfilesLoading] = useState(false);
    const [rhConfigured, setRhConfigured] = useState<{ hasApiKey: boolean; url?: string } | null>(null);
    const [rhRunning, setRhRunning] = useState(false);
    const [rhTaskId, setRhTaskId] = useState<string | null>(null);
    const [rhResult, setRhResult] = useState<WorkflowRunResult | null>(null);
    const [rhTab, setRhTab] = useState<WorkbenchTab>("graph");
    const [rhBaseUrl, setRhBaseUrl] = useState("https://www.runninghub.ai");
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

    /** RunningHub 档案列表；未配置 API Key 时仍可浏览，只是不能运行。 */
    const fetchProfiles = useCallback(async () => {
        setProfilesLoading(true);
        try {
            const { workflows } = await fetchRunningHubWorkflows();
            setProfiles(workflows || []);
        } catch (err) {
            message.error(err instanceof Error ? err.message : "加载 RunningHub 工作流失败");
        } finally {
            setProfilesLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchProfiles();
        void fetchRunningHubStatus()
            .then((status) => {
                setRhConfigured(status);
                if (status?.url) setRhBaseUrl(status.url);
            })
            .catch(() => setRhConfigured(null));
    }, [fetchProfiles]);

    /**
     * 档案 id → 引用它的模型名。删除档案前用它提示影响面；模型绑定用的是档案
     * 稳定 id，所以展示名变化不影响这里的判断。
     */
    const usedByModels = useMemo(() => {
        const usage = new Map<string, string[]>();
        const channels = (aiConfig?.channels || []) as Array<{ models?: Array<Record<string, any>> }>;
        for (const channel of channels) {
            for (const model of channel.models || []) {
                for (const binding of Object.values((model.workflowBindings || {}) as Record<string, any>)) {
                    if (binding?.provider !== "runninghub" || !binding.profileId) continue;
                    const list = usage.get(binding.profileId) || [];
                    list.push(String(model.name || "未命名模型"));
                    usage.set(binding.profileId, list);
                }
            }
        }
        return usage;
    }, [aiConfig]);

    /** 档案列表项：副标题是 workflowId，徽标显示已启用映射数 / 总字段数。 */
    const profileItems = useMemo<WorkflowLibraryItem[]>(
        () =>
            profiles.map((profile) => {
                const enabled = (profile.fields || []).filter((field) => field.enabled !== false).length;
                return {
                    id: profile.id,
                    title: profile.name,
                    meta: profile.workflowId,
                    badge: `${enabled}/${(profile.fields || []).length} 字段`,
                };
            }),
        [profiles],
    );

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

    /**
     * 提交档案到 RunningHub 云端执行。表单值走 values（本次运行的参数覆盖），
     * 提示词与媒体走 input；输出节点选择沿用本地同款选择器。
     */
    const handleRunProfile = async (form: Record<string, string>) => {
        if (!selectedProfile) return;
        if (!rhConfigured?.hasApiKey) {
            message.warning("请先在「运行环境」配置 RunningHub API Key");
            return;
        }
        setRhRunning(true);
        setRhResult(null);
        try {
            const { task } = await runRunningHubWorkflow(
                selectedProfile.id,
                { prompt: form.prompt || "" },
                runningHubValuesFromForm(form),
                outputNodes.length ? { runninghubOutputNodes: outputNodes } : {},
            );
            setRhTaskId(task.id);
            message.success("已提交 RunningHub，云端计费按平台规则");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "提交 RunningHub 失败");
            setRhRunning(false);
        }
    };

    /** 轮询云端任务到终态；结果媒体由 Backend 归档，这里只展示。 */
    useEffect(() => {
        if (!rhTaskId || !rhRunning) return;
        let stopped = false;
        const timer = window.setInterval(() => {
            void (async () => {
                try {
                    const { task } = await request<{ task: { status: string; error?: string; result?: { media?: WorkflowRunResult["media"] } } }>(
                        "GET",
                        `/agent/runninghub/tasks/${encodeURIComponent(rhTaskId)}`,
                    );
                    if (stopped) return;
                    if (task.status === "succeeded") {
                        setRhResult({ media: task.result?.media || [], status: { status_str: "success", completed: true } });
                        setRhRunning(false);
                        window.clearInterval(timer);
                    } else if (task.status === "failed" || task.status === "cancelled") {
                        message.error(task.error || `RunningHub 任务${task.status}`);
                        setRhRunning(false);
                        window.clearInterval(timer);
                    }
                } catch {
                    /* 单次轮询失败不终止，等待下一次 */
                }
            })();
        }, 2000);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [rhTaskId, rhRunning]);

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

    // 两个库共用同一个右栏：切换器在顶部，下面按 library 换列表内容。
    const libraryColumn = (
        <div className="col-span-4 flex min-h-0 flex-col gap-3">
            <Segmented
                block
                value={library}
                onChange={(value) => setLibrary(value as "local" | "runninghub")}
                options={[
                    { label: `本地 ComfyUI (${workflows.length})`, value: "local" },
                    { label: `RunningHub (${profiles.length})`, value: "runninghub" },
                ]}
            />
            {library === "runninghub" ? (
                <div className="flex shrink-0 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs dark:border-stone-700 dark:bg-stone-900">
                    {profilesLoading ? <Spin size="small" /> : null}
                    <span className="flex-1 text-stone-600 dark:text-stone-300">
                        {rhConfigured?.hasApiKey
                            ? "云端工作流库：档案与平台节点图保持一致。"
                            : "未配置 RunningHub API Key，可浏览档案但无法运行。"}
                    </span>
                </div>
            ) : (
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
            )}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                <div className="shrink-0 border-b border-stone-200 px-3 py-2.5 dark:border-stone-700">
                    <h2 className="text-sm font-medium">{library === "local" ? "本地工作流列表" : "RunningHub 工作流列表"}</h2>
                </div>
                {library === "local" ? (
                    <>
                        <div className="shrink-0 px-3 pt-2.5">
                            <RunningHubWorkflowImport workflows={workflows} onImported={(name) => { void fetchWorkflows().then(() => handleLoadDetail(name)); }} />
                        </div>
                        <WorkflowLibraryList
                            items={libraryItems}
                            selectedId={selected?.name}
                            onSelect={(item) => void handleLoadDetail(item.id)}
                            onRename={(item, title) => void handleRename(item.id, title)}
                            emptyText="暂无本地工作流"
                        />
                    </>
                ) : (
                    <>
                        <RunningHubProfileActions
                            profiles={profiles}
                            selected={selectedProfile}
                            onChanged={fetchProfiles}
                            onSelected={setSelectedProfile}
                            usedByModels={usedByModels}
                        />
                        <WorkflowLibraryList
                            items={profileItems}
                            selectedId={selectedProfile?.id}
                            onSelect={(item) => setSelectedProfile(profiles.find((profile) => profile.id === item.id) || null)}
                            emptyText={rhConfigured?.hasApiKey === false ? "未配置 API Key" : "暂无 RunningHub 工作流档案"}
                        />
                    </>
                )}
            </div>
        </div>
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
            {section === "workflows" && library === "runninghub" ? (
                <div className="grid h-full min-h-0 grid-cols-12 gap-4">
                    <div className="col-span-8 flex min-h-0 flex-col gap-3">
                        {!selectedProfile ? (
                            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                                <div className="text-center">
                                    <Cloud className="mx-auto size-10 text-stone-300" />
                                    <p className="mt-2 text-sm text-stone-500">从右侧选择一个 RunningHub 工作流档案</p>
                                    <p className="mt-1 text-xs text-stone-400">档案保存节点输入映射，运行由 RunningHub 云端执行并按平台计费</p>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <h2 className="truncate">{selectedProfile.name}</h2>
                                        <p className="text-xs text-stone-500">
                                            {selectedProfile.workflowId} · RunningHub 云端执行
                                        </p>
                                    </div>
                                    <WorkflowWorkbench
                                        activeTab={rhTab}
                                        onTabChange={setRhTab}
                                        historyCount={0}
                                        title={<span className="text-sm font-medium">节点图 / 运行</span>}
                                        graph={
                                            <RunningHubGraphPanel
                                                workflowId={selectedProfile.workflowId}
                                                workflow={selectedProfile.workflowJson}
                                                fields={selectedProfile.fields || []}
                                                baseUrl={rhBaseUrl}
                                            />
                                        }
                                        run={
                                            <RunTab
                                                config={runningHubProfileToConfig(selectedProfile)}
                                                onRun={(form) => void handleRunProfile(form)}
                                                running={rhRunning}
                                                result={rhResult}
                                                runLabel="提交到 RunningHub"
                                                emptyText="该档案没有启用任何输入映射，点档案的「重新同步」读取字段后在运行环境配置映射"
                                                hint="表单里的参数只影响本次运行，不会写回档案；媒体按档案里 image/video/audio 字段的顺序注入"
                                                statusText="已提交 RunningHub，等待云端完成…"
                                                onCancel={rhTaskId ? () => { void cancelRunningHubTask(rhTaskId); setRhRunning(false); } : undefined}
                                                outputPicker={
                                                    <OutputNodePicker
                                                        graph={(selectedProfile.workflowJson || {}) as never}
                                                        value={outputNodes}
                                                        onChange={handleOutputNodesChange}
                                                    />
                                                }
                                            />
                                        }
                                        history={
                                            <RunHistoryList
                                                entries={[]}
                                                loading={false}
                                                onRefresh={() => undefined}
                                                hint="RunningHub 档案的运行历史在 Backend 任务记录里，可通过任务查询查看"
                                            />
                                        }
                                    />
                                </div>
                            </>
                        )}
                    </div>
                    {libraryColumn}
                </div>
            ) : section === "workflows" ? <div className="grid h-full min-h-0 grid-cols-12 gap-4">
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
                    {libraryColumn}
                </div> : section === "models" ? <ComfyChannelsPanel /> : <ComfyRuntimePanel />}
            </div>
        </div>
    );
}
