import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App, Alert, Button, Checkbox, Input, InputNumber, Segmented, Spin, Table, Tabs, message, Select, Tooltip } from "antd";
import { Upload as UploadIcon, Cloud, Download, Play, Trash2, Workflow } from "lucide-react";
import { request, BackendApiError, fetchBackendGenerationLogs, deleteBackendGenerationLogs, fetchBackendTask, type BackendRuntimeTask } from "@/services/backend-api";
import { exportWorkflowPackage, importWorkflowPackage, renameWorkflowTitle, runWorkflow, type WorkflowConfig, type WorkflowField, type WorkflowPackage, type WorkflowRunResult } from "@/services/api/workflows";
import { WorkflowGraphPanel } from "./workflow-graph-panel";
import { WorkflowLibraryList, type WorkflowLibraryItem } from "./workflow-library-list";
import { RunTab } from "./run-panel";
import { WorkflowWorkbench, type WorkbenchTab } from "./workflow-workbench";
import { RunHistoryList } from "./run-history-list";
import { normalizeOutputNodeSelection, OutputNodePicker } from "./output-node-picker";
import { RunningHubWorkflowImport } from "./runninghub-workflow-import";
import { RunningHubProfileActions } from "./runninghub-profile-actions";
import { RunningHubGraphPanel } from "./runninghub-graph-panel";
import { runningHubProfileToConfig, runningHubRequestFromForm, RunningHubMediaConflict } from "./runninghub-run-adapter";
import { runRunningHubWorkflow, cancelRunningHubTask } from "@/services/api/runninghub";
import { fetchRunningHubWorkflows, fetchRunningHubWorkflowTasks, fetchRunningHubStatus, saveRunningHubWorkflow, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import { useBackendStore } from "@/stores/use-backend-store";
import { useConfigStore } from "@/stores/use-config-store";
import { ComfyChannelsPanel, ComfyRuntimePanel } from "./comfy-management-panels";
import { WorkflowTaskController, WorkflowSubmissionRejected, workflowTaskResult } from "./workflow-task-controller";
import "../../styles/workflow-graph.css";

const localRuns = new WorkflowTaskController();
const cloudRuns = new WorkflowTaskController();

async function submitAndRead(submit: () => Promise<unknown>, read: () => Promise<import("./workflow-task-controller").TaskReceipt>, clientIdHonored: boolean) {
    try {
        const receipt = await submit();
        if (receipt && typeof receipt === "object" && (("taskId" in receipt && typeof receipt.taskId === "string") || ("task" in receipt && receipt.task && typeof receipt.task === "object" && "id" in receipt.task))) return receipt as import("./workflow-task-controller").TaskReceipt;
    }
    catch (error) {
        // Only a completed HTTP rejection plus authoritative absence permits a fresh edited submission.
        if (clientIdHonored && error instanceof BackendApiError && error.status > 0) {
            try { return await read(); }
            catch (readError) {
                if (readError instanceof BackendApiError && readError.status === 404) throw new WorkflowSubmissionRejected(error.message);
            }
        }
        throw error;
    }
    return read();
}

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

let backendSession: { url: string; token: string; scope: string } | undefined;
export default function WorkflowsPage() {
    const url = useBackendStore((state) => state.url);
    const token = useBackendStore((state) => state.token);
    if (!backendSession || backendSession.url !== url || backendSession.token !== token) backendSession = { url, token, scope: crypto.randomUUID() };
    // An opaque in-memory scope prevents receipts from another Backend/account being adopted.
    return <WorkflowWorkspace key={backendSession.scope} connectionScope={backendSession.scope} />;
}

function WorkflowWorkspace({ connectionScope }: { connectionScope: string }) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [libraryLoading, setLibraryLoading] = useState(false);
    const [libraryError, setLibraryError] = useState("");
    const [profilesError, setProfilesError] = useState("");
    const [rhStatusError, setRhStatusError] = useState("");
    const [selected, setSelected] = useState<WorkflowDetail | null>(null);
    const [selectedProfile, setSelectedProfile] = useState<RunningHubWorkflowProfile | null>(null);

    const [section, setSection] = useState("workflows");
    // 本地库与 RunningHub 库共用同一页面壳，数据源与选中项各自独立。
    const [library, setLibrary] = useState<"local" | "runninghub">("local");
    const aiConfig = useConfigStore((state) => state.config);
    const [profiles, setProfiles] = useState<RunningHubWorkflowProfile[]>([]);
    const [profilesLoading, setProfilesLoading] = useState(false);
    const [rhConfigured, setRhConfigured] = useState<{ hasApiKey: boolean; url?: string; workflowTaskReplaySafe?: boolean } | null>(null);

    const [rhTab, setRhTab] = useState<WorkbenchTab>("graph");
    const [rhBaseUrl, setRhBaseUrl] = useState("https://www.runninghub.ai");
    const [activeTab, setActiveTab] = useState<WorkbenchTab>("graph");
    const [historyLogs, setHistoryLogs] = useState<Array<{ id: string; workflow: string; prompt: string; status: string; createdAt: string; outputs: Array<{ url: string; mimeType: string }>; error?: string }>>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");
    // 指定输出节点属于当前工作流的配置，跟着 config 一起存；不选=不过滤。
    const outputNodes = selected?.config.outputNodes || [];
    const [rhOutputSelections, setRhOutputSelections] = useState<Record<string, string[]>>({});
    const rhOutputNodes = selectedProfile ? rhOutputSelections[selectedProfile.id] || [] : [];
    const detailRequest = useRef(0);
    const historyRequest = useRef(0);
    const profileHistoryRequest = useRef(0);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState("");
    const [historyError, setHistoryError] = useState("");
    const [profileHistory, setProfileHistory] = useState<BackendRuntimeTask[]>([]);
    const [profileHistoryLoading, setProfileHistoryLoading] = useState(false);
    const [profileHistoryError, setProfileHistoryError] = useState("");
    const savingRef = useRef(new Set<string>());
    const [savingOwners, setSavingOwners] = useState<Set<string>>(new Set());
    const localOwner = selected ? `${connectionScope}:local:${selected.name}` : "";
    const cloudOwner = selectedProfile ? `${connectionScope}:cloud:${selectedProfile.id}` : "";
    const localRun = useSyncExternalStore(localRuns.subscribe, () => localRuns.get(localOwner));
    const cloudRun = useSyncExternalStore(cloudRuns.subscribe, () => cloudRuns.get(cloudOwner));
    const readCloudTask = useCallback((id: string) => request<{ task: BackendRuntimeTask; events?: unknown[] }>("GET", `/agent/runninghub/tasks/${encodeURIComponent(id)}`), []);
    useEffect(() => {
        if (!localOwner || !localRun?.running) return;
        void localRuns.poll(localOwner, fetchBackendTask);
        const timer = window.setInterval(() => void localRuns.poll(localOwner, fetchBackendTask), 1500);
        return () => window.clearInterval(timer);
    }, [localOwner, localRun?.running]);
    useEffect(() => {
        if (!cloudOwner || !(cloudRun?.running || cloudRun?.cancellation === "pending")) return;
        void cloudRuns.poll(cloudOwner, readCloudTask);
        const timer = window.setInterval(() => void cloudRuns.poll(cloudOwner, readCloudTask), 2000);
        return () => window.clearInterval(timer);
    }, [cloudOwner, cloudRun?.running, cloudRun?.cancellation, readCloudTask]);
    const markSaving = (owner: string, saving: boolean) => {
        if (saving) savingRef.current.add(owner); else savingRef.current.delete(owner);
        setSavingOwners(new Set(savingRef.current));
    };

    const deleteDialog = useRef<{ destroy: () => void } | null>(null);
    const deleteContext = `${library}:${section}:${activeTab}:${selected?.name || ""}`;
    const currentDeleteContext = useRef(deleteContext);
    currentDeleteContext.current = deleteContext;
    const deleteMounted = useRef(true);
    useEffect(() => {
        deleteDialog.current?.destroy();
        deleteDialog.current = null;
    }, [deleteContext]);
    useEffect(() => {
        deleteMounted.current = true;
        return () => {
            deleteMounted.current = false;
            deleteDialog.current?.destroy();
            deleteDialog.current = null;
        };
    }, []);

    const confirmLocalDelete = (key: string, title: string, content: string, remove: () => Promise<void>) => {
        if (library !== "local" || section !== "workflows" || !selected || deleteDialog.current || savingRef.current.has(key)) return;
        const ownerContext = deleteContext;
        const selectionVersion = detailRequest.current;
        const current = () => deleteMounted.current && currentDeleteContext.current === ownerContext && detailRequest.current === selectionVersion;
        let confirmed = false;
        const dialog = modal.confirm({
            title,
            content,
            okText: t("workflowDelete.confirm"),
            cancelText: t("workflowDelete.cancel"),
            okButtonProps: { danger: true },
            focusable: { autoFocusButton: "cancel" },
            afterClose: () => { confirmed = true; if (deleteDialog.current === dialog) deleteDialog.current = null; },
            onCancel: () => { confirmed = true; },
            onOk: async () => {
                if (confirmed || !current() || savingRef.current.has(key)) return;
                confirmed = true;
                markSaving(key, true);
                try { await remove(); }
                catch (err) {
                    confirmed = false;
                    if (current()) message.error(err instanceof Error ? err.message : t("workflowDelete.failed"));
                    throw err;
                } finally { markSaving(key, false); }
            },
        });
        deleteDialog.current = dialog;
    };

    const fetchWorkflows = useCallback(async () => {
        setLibraryLoading(true);
        setLibraryError("");
        try {
            const data = await request<{ workflows: WorkflowItem[] }>("GET", "/api/workflows");
            setWorkflows(data.workflows);
        } catch (err) {
            setLibraryError(err instanceof Error ? err.message : "加载工作流失败");
        } finally { setLibraryLoading(false); }
    }, []);

    useEffect(() => { fetchWorkflows(); }, [fetchWorkflows]);

    /** RunningHub 档案列表；未配置 API Key 时仍可浏览，只是不能运行。 */
    const fetchProfiles = useCallback(async () => {
        setProfilesLoading(true);
        setProfilesError("");
        try {
            const { workflows } = await fetchRunningHubWorkflows();
            setProfiles(workflows || []);
        } catch (err) {
            setProfilesError(err instanceof Error ? err.message : "加载 RunningHub 工作流失败");
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
            .catch((error) => setRhStatusError(error instanceof Error ? error.message : String(error)));
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
            if (backendSession?.scope !== connectionScope) return false;
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

    const handleDelete = (name: string) => {
        if (!selected || selected.name !== name || selected.builtin) return;
        confirmLocalDelete(name, t("workflowDelete.workflowTitle", { name: selected.config.title || name }), t("workflowDelete.workflowDescription", { name }), async () => {
            await request("DELETE", `/api/workflows/${encodeURIComponent(name)}`);
            message.success("工作流已删除");
            void fetchWorkflows();
            setSelected((current) => current?.name === name ? null : current);
        });
    };

    // title 由列表壳传入：重命名输入态是壳内部状态，页面不再持有 editValue。
    const handleRename = async (name: string, title: string) => {
        const trimmed = title.trim();
        setEditingName(null);
        if (!trimmed) return;
        const item = workflows.find((w) => w.name === name);
        if (!item || item.builtin) return;
        if (item.title === trimmed || savingRef.current.has(name)) return;
        markSaving(name, true);
        try {
            await renameWorkflowTitle(name, trimmed);
            setWorkflows((prev) => prev.map((w) => (w.name === name ? { ...w, title: trimmed } : w)));
            setSelected((current) => current?.name === name ? { ...current, config: { ...current.config, title: trimmed } } : current);
            message.success("已重命名");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "重命名失败");
        } finally { markSaving(name, false); }
    };

    // 「在 ComfyUI 中打开」：后端把节点图写进该实例 user/default/workflows/（同名覆盖），
    // 再新开客户端标签页，用户在 ComfyUI 的 File→Load 里直接看到它。官方客户端没有
    // REST 端点能远程载入节点图，这是唯一可靠路径。远程实例无法写盘，兜底下载原始节点图。
    const [comfyOpening, setComfyOpening] = useState("");
    const handleOpenInComfyUI = async (id: string) => {
        if (comfyOpening) return;
        setComfyOpening(id);
        try {
            const result = await request<{ ok?: boolean; url?: string; file?: string; reason?: string; error?: string; pushed?: boolean; pushError?: string }>("POST", `/api/workflows/${encodeURIComponent(id)}/open-in-comfyui`);
            if (result.ok && result.url) {
                if (result.pushed === true) {
                    message.success(`已在 ComfyUI 客户端打开：${result.file}`);
                } else {
                    window.open(result.url, "_blank", "noopener");
                    message.info(`已写入 ${result.file}，但没推送到运行中的客户端（${result.pushError || "原因未知"}），请在 ComfyUI 的 File → Load 里加载`);
                }
                return;
            }
            if (result.reason === "remote") {
                const detail = await request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(id)}`);
                const anchor = document.createElement("a");
                anchor.href = URL.createObjectURL(new Blob([JSON.stringify(detail.workflow, null, 2)], { type: "application/json" }));
                anchor.download = id.split("/").pop()?.replace(/\.json$/, "") || "workflow";
                if (!anchor.download.endsWith(".json")) anchor.download += ".json";
                anchor.click();
                URL.revokeObjectURL(anchor.href);
                if (result.url) window.open(result.url, "_blank", "noopener");
                message.info("远程实例：已下载节点图，请在 ComfyUI 中手动导入");
                return;
            }
            message.error(result.error || "打开失败");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "打开失败");
        } finally {
            setComfyOpening("");
        }
    };

    const handleLoadDetail = async (name: string) => {
        const version = ++detailRequest.current;
        setDetailLoading(true);
        setDetailError("");
        try {
            const detail = await request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(name)}`);
            if (version !== detailRequest.current) return;
            const outputNodes = normalizeOutputNodeSelection(detail.config.outputNodes || [], detail.workflow);
            setSelected({ ...detail, config: { ...detail.config, outputNodes } });
            setHistoryLogs([]);
            setActiveTab("graph");
        } catch (err) {
            if (version === detailRequest.current) setDetailError(err instanceof Error ? err.message : String(err));
        } finally {
            if (version === detailRequest.current) setDetailLoading(false);
        }
    };

    const handleSaveConfig = async (owner: WorkflowDetail, config: WorkflowConfig) => {
        if (savingRef.current.has(owner.name)) return false;
        markSaving(owner.name, true);
        try {
            await request("PUT", `/api/workflows/${encodeURIComponent(owner.name)}/config`, config);
            setSelected((current) => current?.name === owner.name ? { ...current, config } : current);
            void fetchWorkflows();
            return true;
        } catch (err) {
            message.error(err instanceof Error ? err.message : t("workflowRecovery.saveFailed"));
            return false;
        } finally { markSaving(owner.name, false); }
    };

    const handleRun = async (fields: Record<string, string>) => {
        if (!selected || savingRef.current.has(selected.name)) return;
        const owner = selected;
        const config = { ...owner.config, outputNodes: normalizeOutputNodeSelection(outputNodes, owner.workflow) };
        const taskId = crypto.randomUUID();
        await localRuns.start(`${connectionScope}:local:${owner.name}`, taskId, async () => {
            return submitAndRead(() => runWorkflow(owner.name, fields, config, taskId), () => fetchBackendTask(taskId), rhConfigured?.workflowTaskReplaySafe === true);
        }, rhConfigured?.workflowTaskReplaySafe === true);
    };

    const handleOutputNodesChange = (next: string[]) => {
        if (selected) void handleSaveConfig(selected, { ...selected.config, outputNodes: next });
    };

    const loadHistory = useCallback(async () => {
        const version = ++historyRequest.current;
        setLoadingHistory(true);
        setHistoryError("");
        try {
            const data = await fetchBackendGenerationLogs({ projectId: "workflow", limit: 50 });
            if (version !== historyRequest.current) return;
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
            if (version === historyRequest.current) setHistoryError(err instanceof Error ? err.message : t("workflowRecovery.historyFailed"));
        } finally {
            if (version === historyRequest.current) setLoadingHistory(false);
        }
    }, [selected?.name]);

    useEffect(() => { if (activeTab === "history") void loadHistory(); return () => { historyRequest.current += 1; }; }, [activeTab, loadHistory]);

    /**
     * 提交档案到 RunningHub 云端执行。表单值走 values（本次运行的参数覆盖），
     * 提示词与媒体走 input；输出节点选择沿用本地同款选择器。
     */
    const handleRunProfile = async (form: Record<string, string>) => {
        if (!selectedProfile || savingRef.current.has(selectedProfile.id)) return;
        if (!rhConfigured?.hasApiKey) {
            message.warning(t("workflowRecovery.configureCloud"));
            return;
        }
        const owner = selectedProfile;
        const taskId = crypto.randomUUID();
        const outputs = normalizeOutputNodeSelection(rhOutputNodes, (owner.workflowJson || {}) as Parameters<typeof normalizeOutputNodeSelection>[1]);
        let submission: ReturnType<typeof runningHubRequestFromForm>;
        try { submission = runningHubRequestFromForm(owner, form); }
        catch (error) { message.error(error instanceof RunningHubMediaConflict ? t("workflowRecovery.mediaConflict", { kind: error.kind, index: error.index }) : String(error)); return; }
        const { input, values } = submission;
        await cloudRuns.start(`${connectionScope}:cloud:${owner.id}`, taskId, async () => {
            return submitAndRead(() => runRunningHubWorkflow(owner.id, input, values, outputs.length ? { runninghubOutputNodes: outputs } : {}, taskId), () => readCloudTask(taskId), rhConfigured?.workflowTaskReplaySafe === true);
        }, rhConfigured?.workflowTaskReplaySafe === true);
    };

    const loadProfileHistory = useCallback(async () => {
        const id = selectedProfile?.id;
        const version = ++profileHistoryRequest.current;
        if (!id) { setProfileHistory([]); setProfileHistoryLoading(false); return; }
        setProfileHistoryLoading(true);
        setProfileHistoryError("");
        try {
            const { tasks } = await fetchRunningHubWorkflowTasks(id);
            if (version !== profileHistoryRequest.current) return;
            setProfileHistory(tasks || []);
            const active = tasks.find((task) => !["succeeded", "failed", "cancelled"].includes(task.status));
            if (active) cloudRuns.adopt(`${connectionScope}:cloud:${id}`, active);
        } catch (error) {
            if (version === profileHistoryRequest.current) setProfileHistoryError(error instanceof Error ? error.message : String(error));
        } finally { if (version === profileHistoryRequest.current) setProfileHistoryLoading(false); }
    }, [selectedProfile?.id, connectionScope]);
    useEffect(() => {
        setProfileHistory([]);
        void loadProfileHistory();
        return () => { profileHistoryRequest.current += 1; };
    }, [loadProfileHistory]);

    useEffect(() => { if (rhTab === "history") void loadProfileHistory(); }, [rhTab, loadProfileHistory, cloudRun?.result]);

    const handleDeleteHistory = (id: string) => {
        const entry = historyLogs.find((log) => log.id === id);
        if (!selected || !entry) return;
        confirmLocalDelete(`history:${id}`, t("workflowDelete.historyTitle"), t("workflowDelete.historyDescription", { name: entry.workflow, time: new Date(entry.createdAt).toLocaleString(), id }), async () => {
            await deleteBackendGenerationLogs({ id });
            setHistoryLogs((current) => current.filter((entry) => entry.id !== id));
            message.success("已删除");
        });
    };

    const handleFieldsChange = (newFields: WorkflowField[]) => {
        if (!selected) return;
        const updatedConfig = { ...selected.config, fields: newFields };
        void handleSaveConfig(selected, updatedConfig);
    };

    /**
     * 节点图里改的档案映射立刻落盘，行为与本地字段编辑一致。
     * 先更新本地选中项让浮窗马上反映新状态，再 PUT 回档案；
     * 保存失败要回滚，否则界面显示的映射和平台档案会长期不一致。
     */
    const handleProfileFieldsChange = async (nextFields: RunningHubWorkflowProfile["fields"]) => {
        if (!selectedProfile) return;
        const previous = selectedProfile;
        if (savingRef.current.has(previous.id)) return;
        markSaving(previous.id, true);
        const next = { ...previous, fields: nextFields };
        try {
            const { workflow } = await saveRunningHubWorkflow(next);
            setSelectedProfile((current) => current?.id === previous.id ? workflow : current);
            setProfiles((current) => current.map((item) => (item.id === next.id ? workflow : item)));
        } catch (err) {
            message.error(err instanceof Error ? err.message : "保存 RunningHub 映射失败");
        } finally { markSaving(previous.id, false); }
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

    const retryOriginalSubmission = async (owner: string, controller: WorkflowTaskController) => {
        try {
            const status = await fetchRunningHubStatus();
            if (backendSession?.scope !== connectionScope) return;
            setRhConfigured(status);
            if (status.workflowTaskReplaySafe === true) await controller.retrySubmission(owner);
        } catch (error) {
            setRhConfigured((current) => current ? { ...current, workflowTaskReplaySafe: false } : current);
            setRhStatusError(error instanceof Error ? error.message : String(error));
        }
    };

    const runNotice = (owner: string, state: import("./workflow-task-controller").WorkflowRunState | undefined, controller: WorkflowTaskController, read: (id: string) => Promise<import("./workflow-task-controller").TaskReceipt>) => state && (state.error || state.unknown || state.cancellation) ? (
        <Alert type={state.cancellation === "confirmed" ? "info" : "warning"}
            description={<div className="space-y-2"><p>{t(state.cancellation === "confirmed" ? "workflowRecovery.cancelConfirmed" : state.cancellation === "unconfirmed" ? "workflowRecovery.cancelUnconfirmed" : state.cancellation === "local" ? "workflowRecovery.cancelLocalOnly" : state.cancellation === "pending" ? "workflowRecovery.cancelWaiting" : state.unknown ? "workflowRecovery.submissionUnknown" : "workflowRecovery.queryFailed")}</p><p className="break-all text-xs">{state.remoteTaskId || state.taskId}</p>{state.error ? <p className="break-all text-xs">{state.error}</p> : null}<Button size="small" onClick={() => void controller.poll(owner, read)}>{t("workflowRecovery.refreshStatus")}</Button>{controller === cloudRuns && state.cancellation && state.cancellation !== "confirmed" ? <><a className="ml-2 underline" href={rhBaseUrl} target="_blank" rel="noreferrer">{t("workflowRecovery.viewCloud")}</a>{!state.cancellationAcknowledged ? <Button size="small" onClick={() => controller.acknowledgeCancellation(owner)}>{t("workflowRecovery.acknowledgeCancellation")}</Button> : null}</> : null}{state.unknown && state.retryable && rhConfigured?.workflowTaskReplaySafe === true ? <Button size="small" loading={state.submitting} onClick={() => void retryOriginalSubmission(owner, controller)}>{t("workflowRecovery.retrySameSubmission")}</Button> : null}</div>}
        />
    ) : null;

    // 两个库共用同一个右栏：切换器在顶部，下面按 library 换列表内容。
    const libraryColumn = (
        <div className="order-first flex max-h-80 min-h-48 min-w-0 flex-col gap-3 lg:order-last lg:col-span-4 lg:max-h-none lg:min-h-0">
            <Segmented
                block
                value={library}
                onChange={(value) => setLibrary(value as "local" | "runninghub")}
                options={[
                    { label: `本地 ComfyUI (${workflows.length})`, value: "local" },
                    { label: `RunningHub (${profiles.length})`, value: "runninghub" },
                ]}
            />
            {libraryError && library === "local" ? <Alert type="error" description={libraryError} action={<Button size="small" onClick={() => void fetchWorkflows()}>{t("workflowRecovery.refreshStatus")}</Button>} /> : null}
            {profilesError && library === "runninghub" ? <Alert type="error" description={profilesError} action={<Button size="small" onClick={() => void fetchProfiles()}>{t("workflowRecovery.refreshStatus")}</Button>} /> : null}
            {rhStatusError && library === "runninghub" ? <Alert type="error" description={rhStatusError} action={<Button size="small" onClick={() => { void fetchRunningHubStatus().then((status) => { setRhConfigured(status); setRhStatusError(""); }).catch((error) => { setRhConfigured((current) => current ? { ...current, workflowTaskReplaySafe: false } : current); setRhStatusError(String(error)); }); }}>{t("workflowRecovery.refreshStatus")}</Button>} /> : null}
            {libraryLoading && library === "local" ? <Spin size="small" /> : null}
            {library === "runninghub" ? (
                <div className="flex shrink-0 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs dark:border-stone-700 dark:bg-stone-900">
                    {profilesLoading ? <Spin size="small" /> : null}
                    <span className="flex-1 text-stone-600 dark:text-stone-300">
                        {rhConfigured === null ? t("workflowRecovery.cloudStatusUnknown") : rhConfigured.hasApiKey
                            ? "云端工作流库：档案与平台节点图保持一致。"
                            : "未配置 RunningHub API Key，可浏览档案但无法运行。"}
                    </span>
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-200 px-3 py-2.5 dark:border-stone-700">
                    <h2 className="min-w-0 text-sm font-medium">{library === "local" ? "本地工作流列表" : "RunningHub 工作流列表"}</h2>
                    <div role="group" aria-label={t("workflowLibraryActions.libraryActions")} className="flex shrink-0 items-center gap-1">
                        {library === "local" ? <>
                            <Tooltip title={t(loading ? "workflowLibraryActions.importingFile" : "workflowLibraryActions.importFile")}>
                                <label className={`relative inline-flex size-6 items-center justify-center rounded text-stone-600 focus-within:ring-2 focus-within:ring-blue-500 dark:text-stone-300 ${loading ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-stone-100 dark:hover:bg-stone-800"}`}>
                                    {loading ? <Spin size="small" /> : <UploadIcon aria-hidden="true" className="size-3.5" />}
                                    <span className="sr-only">{t("workflowLibraryActions.importFile")}</span>
                                    <input
                                        type="file"
                                        accept=".json"
                                        disabled={loading}
                                        aria-label={t("workflowLibraryActions.importFile")}
                                        aria-busy={loading}
                                        onChange={async (e) => {
                                            const input = e.currentTarget;
                                            const file = input.files?.[0];
                                            if (file) { await handleUpload(file); input.value = ""; }
                                        }}
                                        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                                    />
                                </label>
                            </Tooltip>
                            <RunningHubWorkflowImport workflows={workflows} onImported={(name) => { void fetchWorkflows().then(() => handleLoadDetail(name)); }} />
                        </> : <RunningHubProfileActions
                            scope="library"
                            profiles={profiles}
                            selected={null}
                            onChanged={fetchProfiles}
                        />}
                    </div>
                </div>
                {library === "local" ? (
                    <>
                        {!libraryLoading && !libraryError ? <WorkflowLibraryList
                            items={libraryItems}
                            selectedId={selected?.name}
                            onSelect={(item) => void handleLoadDetail(item.id)}
                            onRename={(item, title) => void handleRename(item.id, title)}
                            emptyText="暂无本地工作流"
                            onAction={(item) => void handleOpenInComfyUI(item.id)}
                            actionTitle="在 ComfyUI 中打开"
                            actionBusyId={comfyOpening || null}
                        /> : null}
                    </>
                ) : (
                    <>
                        {!profilesLoading && !profilesError ? <WorkflowLibraryList
                            items={profileItems}
                            selectedId={selectedProfile?.id}
                            onSelect={(item) => setSelectedProfile(profiles.find((profile) => profile.id === item.id) || null)}
                            emptyText="暂无 RunningHub 工作流档案"
                        /> : null}
                    </>
                )}
            </div>
        </div>
    );

    return (
        <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden px-3 py-4 sm:px-6">
            <div className="shrink-0">
                <h1 className="flex items-center gap-2 text-xl font-semibold"><Workflow className="size-5" /> {t("microTools.workflow.workspaceTitle")}</h1>
                <p className="mt-0.5 text-xs text-stone-500">{t("microTools.workflow.workspaceDescription")}</p>
            </div>

            {detailLoading ? <Spin size="small" /> : null}
            {detailError ? <Alert type="error" description={detailError} /> : null}
            <Tabs
                className="mt-2 shrink-0 [&_.ant-tabs-nav]:!mb-3"
                activeKey={section}
                onChange={setSection}
                items={[
                    { key: "workflows", label: "工作流库" },
                    { key: "models", label: t("microTools.workflow.localModels") },
                    { key: "runtime", label: "运行环境" },
                ]}
            />

            <div className={`min-h-0 flex-1 ${section === "workflows" ? "overflow-y-auto lg:overflow-hidden" : "overflow-y-auto"}`}>
            {section === "workflows" && library === "runninghub" ? (
                <div className="grid min-h-0 grid-cols-1 gap-4 lg:h-full lg:grid-cols-12">
                    <div className="flex h-[70vh] min-h-[480px] min-w-0 flex-col gap-3 lg:col-span-8 lg:h-auto lg:min-h-0">
                        {!selectedProfile ? (
                            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                                <div className="text-center">
                                    <Cloud className="mx-auto size-10 text-stone-300" />
                                    <p className="mt-2 text-sm text-stone-500">{t("microTools.workflow.selectCloudProfile")}</p>
                                    <p className="mt-1 text-xs text-stone-400">档案保存节点输入映射，运行由 RunningHub 云端执行并按平台计费</p>
                                </div>
                            </div>
                        ) : (
                            <WorkflowWorkbench
                                activeTab={rhTab}
                                onTabChange={setRhTab}
                                historyCount={profileHistory.length}
                                title={selectedProfile.name}
                                subtitle={`${selectedProfile.workflowId} · RunningHub 云端执行`}
                                actions={<RunningHubProfileActions
                                    scope="selected"
                                    profiles={profiles}
                                    selected={selectedProfile}
                                    onChanged={fetchProfiles}
                                    onSelected={(profile, ownerId) => setSelectedProfile((current) => current?.id === ownerId ? profile : current)}
                                    usedByModels={usedByModels}
                                />}
                                graph={
                                    <fieldset className="h-full min-h-0" disabled={savingOwners.has(selectedProfile?.id || "")} aria-busy={savingOwners.has(selectedProfile?.id || "")}><RunningHubGraphPanel
                                        workflowId={selectedProfile.workflowId}
                                        workflow={selectedProfile.workflowJson}
                                        fields={selectedProfile.fields || []}
                                        baseUrl={rhBaseUrl}
                                        onFieldsChange={(next) => void handleProfileFieldsChange(next)}
                                    /></fieldset>
                                }
                                run={
                                    <RunTab
                                        key={`runninghub:${selectedProfile.id}`}
                                        config={runningHubProfileToConfig(selectedProfile)}
                                        onRun={(form) => void handleRunProfile(form)}
                                        running={Boolean(cloudRun?.running)}
                                        disabled={savingOwners.has(selectedProfile?.id || "") || Boolean(cloudRun?.unknown || cloudRun?.cancellation && cloudRun.cancellation !== "confirmed" && !cloudRun.cancellationAcknowledged)}
                                        cancelPending={cloudRun?.cancelling}
                                        result={cloudRun?.result || null}
                                        runLabel="提交到 RunningHub"
                                        emptyText={t("microTools.workflow.noCloudMappings")}
                                        hint="表单里的参数只影响本次运行，不会写回档案；媒体按档案里 image/video/audio 字段的顺序注入"
                                        statusText={t(cloudRun?.submitting ? "workflowRecovery.submitting" : cloudRun?.cancellation === "pending" ? "workflowRecovery.cancelWaiting" : cloudRun?.unknown ? "workflowRecovery.submissionUnknown" : cloudRun?.error ? "workflowRecovery.queryFailed" : "workflowRecovery.running")}
                                        onCancel={cloudRun?.taskId && !cloudRun.unknown && !cloudRun.submitting && !cloudRun.cancellation ? () => void cloudRuns.cancel(cloudOwner, cancelRunningHubTask, readCloudTask) : undefined}
                                        extra={runNotice(cloudOwner, cloudRun, cloudRuns, readCloudTask)}
                                        outputPicker={
                                            <OutputNodePicker
                                                graph={(selectedProfile.workflowJson || {}) as never}
                                                value={rhOutputNodes}
                                                onChange={(next) => setRhOutputSelections((current) => ({ ...current, [selectedProfile.id]: next }))}
                                            />
                                        }
                                    />
                                }
                                history={
                                    <RunHistoryList
                                        entries={profileHistory.map((task) => ({ id: task.id, status: task.status, title: selectedProfile.name, time: task.createdAt ? new Date(task.createdAt).toLocaleString() : undefined, prompt: String(task.input?.prompt || ""), error: task.error || undefined, outputs: workflowTaskResult(task).media, texts: task.result?.texts?.map((item) => item.content) }))}
                                        loading={profileHistoryLoading}
                                        onRefresh={loadProfileHistory}
                                        error={profileHistoryError}
                                        hint={t("workflowRecovery.cloudHistory")}
                                    />
                                }
                            />
                        )}
                    </div>
                    {libraryColumn}
                </div>
            ) : section === "workflows" ? <div className="grid min-h-0 grid-cols-1 gap-4 lg:h-full lg:grid-cols-12">
                <div className="h-[70vh] min-h-[480px] min-w-0 lg:col-span-8 lg:h-auto lg:min-h-0">
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
                                        <Button size="small" danger loading={savingOwners.has(selected.name)} icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete(selected.name)}>删除</Button>
                                    )}
                                </>
                            }
                            graph={
                                <fieldset className="h-full min-h-0" disabled={savingOwners.has(selected?.name || "")} aria-busy={savingOwners.has(selected?.name || "")}><WorkflowGraphPanel
                                    name={selected.name}
                                    workflow={selected.workflow}
                                    fields={selected.config.fields}
                                    onFieldsChange={handleFieldsChange}
                                    onWorkflowChange={(workflow) => {
                                        if (!selected) return;
                                        const nextOutputNodes = normalizeOutputNodeSelection(outputNodes, workflow);
                                        const owner = selected;
                                        if (savingRef.current.has(owner.name)) return;
                                        markSaving(owner.name, true);
                                        void request("PUT", `/api/workflows/${encodeURIComponent(owner.name)}/workflow`, workflow).then(() => {
                                            setSelected((current) => current?.name === owner.name ? { ...current, workflow, config: { ...current.config, outputNodes: nextOutputNodes } } : current);
                                        }).catch((error) => message.error(error instanceof Error ? error.message : "保存节点图失败")).finally(() => markSaving(owner.name, false));
                                    }}
                                /></fieldset>
                            }
                            run={
                                <RunTab
                                    key={`local:${selected.name}`}
                                    config={selected.config}
                                    onRun={handleRun}
                                    running={Boolean(localRun?.running)}
                                    disabled={savingOwners.has(selected?.name || "") || Boolean(localRun?.unknown)}
                                    statusText={t(localRun?.submitting ? "workflowRecovery.submitting" : localRun?.unknown ? "workflowRecovery.submissionUnknown" : localRun?.error ? "workflowRecovery.queryFailed" : "workflowRecovery.running")}
                                    result={localRun?.result || null}
                                    extra={runNotice(localOwner, localRun, localRuns, fetchBackendTask)}
                                    outputPicker={<OutputNodePicker disabled={savingOwners.has(selected?.name || "")} graph={selected.workflow} value={outputNodes} onChange={handleOutputNodesChange} />}
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
                                        deletePending: savingOwners.has(`history:${log.id}`),
                                    }))}
                                    loading={loadingHistory}
                                    error={historyError}
                                    onRefresh={loadHistory}
                                    hint={t("workflowRecovery.localHistory")}
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
