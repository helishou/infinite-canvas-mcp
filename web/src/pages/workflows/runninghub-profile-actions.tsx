// RunningHub 工作流档案管理：登记云端工作流、重命名、重新同步节点图、删除。
// 与本地库完全分开——这里只保存档案（workflowId + 节点输入映射），不生成本地
// ComfyUI 文件；需要本地副本时用本地库的「从 RunningHub 导入本地副本」。
import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Select, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import {
    deleteRunningHubWorkflow,
    inspectRunningHubWorkflow,
    resyncRunningHubWorkflow,
    saveRunningHubWorkflow,
    type RunningHubWorkflowProfile,
} from "@/services/api/runninghub";

export function RunningHubProfileActions({
    scope,
    profiles,
    selected,
    onChanged,
    onSelected,
    usedByModels,
}: {
    /** 库级登记入口与当前档案操作分开呈现，各自保留请求生命周期。 */
    scope: "library" | "selected";
    profiles: RunningHubWorkflowProfile[];
    selected: RunningHubWorkflowProfile | null;
    onChanged: () => void | Promise<void>;
    /** 改名后刷新父级选中项，保持工作区与列表一致。 */
    onSelected?: (profile: RunningHubWorkflowProfile | null, ownerId: string) => void;
    /** 档案 id → 引用它的模型名；用于删除前的风险提示。 */
    usedByModels?: Map<string, string[]>;
}) {
    const { t } = useTranslation();
    const { message: toast, modal } = App.useApp();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [workflowId, setWorkflowId] = useState("");
    const [sourceProfileId, setSourceProfileId] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");

    const mounted = useRef(true);
    const selectedId = useRef(selected?.id);
    selectedId.current = selected?.id;
    const renameOwner = useRef<string | undefined>(undefined);
    const pendingOwners = useRef(new Set<string>());
    const [pendingIds, setPendingIds] = useState<string[]>([]);
    const addRequest = useRef(0);
    const addPending = useRef<number | null>(null);
    const deleteDialog = useRef<{ ownerId: string; destroy: () => void } | null>(null);
    const selectedBusy = Boolean(selected && pendingIds.includes(selected.id));
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            addRequest.current++;
            deleteDialog.current?.destroy();
        };
    }, []);
    useEffect(() => {
        renameOwner.current = undefined;
        setRenaming(false);
        deleteDialog.current?.destroy();
        deleteDialog.current = null;
    }, [selected?.id]);
    const begin = (ownerId: string) => {
        if (pendingOwners.current.has(ownerId)) return false;
        pendingOwners.current.add(ownerId);
        setPendingIds([...pendingOwners.current]);
        return true;
    };
    const finish = (ownerId: string) => {
        pendingOwners.current.delete(ownerId);
        if (mounted.current) setPendingIds([...pendingOwners.current]);
    };
    const ownsSelection = (ownerId: string) => mounted.current && selectedId.current === ownerId;
    const refresh = async () => {
        if (!mounted.current) return;
        try { await onChanged(); }
        catch (reason) { if (mounted.current) toast.error(reason instanceof Error ? reason.message : "列表刷新失败，请刷新后查看"); }
    };
    const reset = () => {
        setName("");
        setWorkflowId("");
        setSourceProfileId(undefined);
        setError("");
        setBusy(false);
    };

    const closeAdd = () => {
        addRequest.current++;
        addPending.current = null;
        setOpen(false);
        reset();
    };

    /** 登记新档案：只保存 workflowId 与平台当前字段，不写任何本地文件。 */
    const addProfile = async () => {
        if (addPending.current !== null) return;
        const source = profiles.find((item) => item.id === sourceProfileId);
        const id = (source?.workflowId || workflowId).trim();
        if (!id) {
            setError("请填写 RunningHub 工作流 ID");
            return;
        }
        const requestId = ++addRequest.current;
        addPending.current = requestId;
        const current = () => mounted.current && addRequest.current === requestId;
        setBusy(true);
        setError("");
        try {
            const inspected = source?.workflowJson ? { workflowJson: source.workflowJson, fields: source.fields } : await inspectRunningHubWorkflow(id);
            if (!current()) return;
            const title = name.trim() || source?.name || `RunningHub ${id}`;
            await saveRunningHubWorkflow({
                id: `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                name: title,
                workflowId: id,
                fields: inspected.fields || [],
                ...(inspected.workflowJson ? { workflowJson: inspected.workflowJson } : {}),
            });
            if (current()) {
                toast.success(`已登记「${title}」，可在节点图与运行页签使用`);
                closeAdd();
            }
            await refresh();
        } catch (reason) {
            if (current()) setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            if (addPending.current === requestId) addPending.current = null;
            if (current()) setBusy(false);
        }
    };

    /** 改名只改显示名：档案 id 是模型绑定与任务记录的引用身份，不能变。 */
    const renameProfile = async () => {
        if (!selected || renameOwner.current !== selected.id || !ownsSelection(selected.id)) return;
        const next = renameValue.trim();
        if (!next || next === selected.name) {
            setRenaming(false);
            return;
        }
        const ownerId = selected.id;
        if (!begin(ownerId)) return;
        try {
            const { workflow } = await saveRunningHubWorkflow({ ...selected, name: next });
            if (ownsSelection(ownerId)) { renameOwner.current = undefined; toast.success("已重命名"); setRenaming(false); }
            await refresh();
            if (ownsSelection(ownerId)) onSelected?.(workflow, ownerId);
        } catch (reason) {
            if (ownsSelection(ownerId)) toast.error(reason instanceof Error ? reason.message : "重命名失败");
        } finally { finish(ownerId); }
    };

    /** 平台侧改了节点后重新读取图与字段，保留已保存的映射。 */
    const resync = async () => {
        if (!selected || !ownsSelection(selected.id)) return;
        const ownerId = selected.id;
        if (!begin(ownerId)) return;
        try {
            const { workflow } = await resyncRunningHubWorkflow(ownerId);
            if (ownsSelection(ownerId)) toast.success("已重新同步节点图与字段");
            await refresh();
            if (ownsSelection(ownerId)) onSelected?.(workflow, ownerId);
        } catch (reason) {
            if (ownsSelection(ownerId)) toast.error(reason instanceof Error ? reason.message : "重新同步失败");
        } finally { finish(ownerId); }
    };

    const remove = () => {
        if (!selected || pendingOwners.current.has(selected.id) || deleteDialog.current || !ownsSelection(selected.id)) return;
        const ownerId = selected.id;
        const users = usedByModels?.get(selected.id) || [];
        const dialog = modal.confirm({
            title: `删除「${selected.name}」？`,
            content: users.length
                ? `有 ${users.length} 个模型正在使用该工作流：${users.join("、")}。删除后这些模型的相关输入场景将不可用，需要在模型设置里改选其它实现。`
                : "档案删除后不可恢复，已归档的历史任务不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            afterClose: () => { if (deleteDialog.current?.destroy === dialog.destroy) deleteDialog.current = null; },
            onOk: async () => {
                if (!ownsSelection(ownerId) || !begin(ownerId)) return;
                try {
                    await deleteRunningHubWorkflow(ownerId);
                    if (ownsSelection(ownerId)) { toast.success("已删除"); onSelected?.(null, ownerId); }
                    await refresh();
                } catch (reason) {
                    if (ownsSelection(ownerId)) toast.error(reason instanceof Error ? reason.message : "删除失败");
                    throw reason;
                } finally { finish(ownerId); }
            },
        });
        deleteDialog.current = { ownerId, destroy: dialog.destroy };
    };

    return (
        <>
            {scope === "library" ? <Tooltip title={t("workflowLibraryActions.addCloud")}>
                <Button
                    size="small"
                    type="text"
                    className="shrink-0"
                    aria-label={t("workflowLibraryActions.addCloud")}
                    title={t("workflowLibraryActions.addCloud")}
                    icon={<Plus className="size-3.5" />}
                    loading={busy}
                    onClick={() => setOpen(true)}
                />
            </Tooltip> : null}
            {scope === "selected" && selected ? (
                <>
                    {renaming ? (
                        <Input
                            autoFocus
                            disabled={selectedBusy}
                            size="small"
                            className="w-40"
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onPressEnter={() => void renameProfile()}
                            onBlur={() => void renameProfile()}
                        />
                    ) : (
                        <Button size="small" disabled={selectedBusy} onClick={() => { renameOwner.current = selected.id; setRenameValue(selected.name); setRenaming(true); }}>
                            重命名
                        </Button>
                    )}
                    <Tooltip title="重新读取平台当前的节点图与输入字段，保留已保存的映射">
                        <Button size="small" disabled={selectedBusy} icon={<RefreshCw className="size-3.5" />} onClick={() => void resync()}>
                            重新同步
                        </Button>
                    </Tooltip>
                    <Button size="small" disabled={selectedBusy} danger icon={<Trash2 className="size-3.5" />} onClick={remove}>
                        删除
                    </Button>
                </>
            ) : null}
            {scope === "library" ? <Modal
                title={t("workflowLibraryActions.addCloud")}
                open={open}
                onCancel={closeAdd}
                onOk={() => void addProfile()}
                okText="登记"
                confirmLoading={busy}
                destroyOnClose
            >
                <p className="mb-3 text-sm text-stone-500">
                    {t("workflowLibraryActions.addCloudDescription")}
                </p>
                {profiles.length ? (
                    <Select
                        className="mb-3 w-full"
                        aria-label="选择已登记的档案"
                        placeholder="或从已登记档案复制"
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={sourceProfileId}
                        options={profiles.map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.workflowId}` }))}
                        onChange={(value) => {
                            setSourceProfileId(value || undefined);
                            const source = profiles.find((item) => item.id === value);
                            if (source) {
                                setWorkflowId(source.workflowId);
                                if (!name.trim()) setName(`${source.name} 副本`);
                            }
                        }}
                    />
                ) : null}
                <Input
                    className="mb-3"
                    aria-label="RunningHub 工作流 ID"
                    placeholder="RunningHub workflowId"
                    value={workflowId}
                    onChange={(event) => setWorkflowId(event.target.value)}
                    onPressEnter={() => void addProfile()}
                />
                <Input
                    aria-label="工作流名称"
                    placeholder="显示名称（留空则用默认名）"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
                {error ? <div className="mt-3 text-sm text-red-600">{error}</div> : null}
            </Modal> : null}
        </>
    );
}
