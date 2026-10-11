// RunningHub 工作流档案管理：登记云端工作流、重命名、重新同步节点图、删除。
// 与本地库完全分开——这里只保存档案（workflowId + 节点输入映射），不生成本地
// ComfyUI 文件；需要本地副本时用「转换为本地副本」。
import { useState } from "react";
import { App, Button, Input, Modal, Select, Tooltip, message } from "antd";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import {
    deleteRunningHubWorkflow,
    inspectRunningHubWorkflow,
    resyncRunningHubWorkflow,
    saveRunningHubWorkflow,
    type RunningHubWorkflowProfile,
} from "@/services/api/runninghub";

export function RunningHubProfileActions({
    profiles,
    selected,
    onChanged,
    onSelected,
    usedByModels,
}: {
    profiles: RunningHubWorkflowProfile[];
    selected: RunningHubWorkflowProfile | null;
    onChanged: () => void | Promise<void>;
    /** 改名后刷新父级选中项，保持工作区与列表一致。 */
    onSelected?: (profile: RunningHubWorkflowProfile | null) => void;
    /** 档案 id → 引用它的模型名；用于删除前的风险提示。 */
    usedByModels?: Map<string, string[]>;
}) {
    const { message: toast, modal } = App.useApp();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [workflowId, setWorkflowId] = useState("");
    const [sourceProfileId, setSourceProfileId] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");

    const reset = () => {
        setName("");
        setWorkflowId("");
        setSourceProfileId(undefined);
        setError("");
        setBusy(false);
    };

    /** 登记新档案：只保存 workflowId 与平台当前字段，不写任何本地文件。 */
    const addProfile = async () => {
        const source = profiles.find((item) => item.id === sourceProfileId);
        const id = (source?.workflowId || workflowId).trim();
        if (!id) {
            setError("请填写 RunningHub 工作流 ID");
            return;
        }
        setBusy(true);
        setError("");
        try {
            const inspected = source?.workflowJson ? { workflowJson: source.workflowJson, fields: source.fields } : await inspectRunningHubWorkflow(id);
            const title = name.trim() || source?.name || `RunningHub ${id}`;
            await saveRunningHubWorkflow({
                id: `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                name: title,
                workflowId: id,
                fields: inspected.fields || [],
                ...(inspected.workflowJson ? { workflowJson: inspected.workflowJson } : {}),
            });
            toast.success(`已登记「${title}」，可在节点图与运行页签使用`);
            setOpen(false);
            reset();
            await onChanged();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setBusy(false);
        }
    };

    /** 改名只改显示名：档案 id 是模型绑定与任务记录的引用身份，不能变。 */
    const renameProfile = async () => {
        if (!selected) return;
        const next = renameValue.trim();
        if (!next || next === selected.name) {
            setRenaming(false);
            return;
        }
        try {
            const { workflow } = await saveRunningHubWorkflow({ ...selected, name: next });
            toast.success("已重命名");
            setRenaming(false);
            await onChanged();
            onSelected?.(workflow);
        } catch (reason) {
            toast.error(reason instanceof Error ? reason.message : "重命名失败");
        }
    };

    /** 平台侧改了节点后重新读取图与字段，保留已保存的映射。 */
    const resync = async () => {
        if (!selected) return;
        try {
            const { workflow } = await resyncRunningHubWorkflow(selected.id);
            toast.success("已重新同步节点图与字段");
            await onChanged();
            onSelected?.(workflow);
        } catch (reason) {
            toast.error(reason instanceof Error ? reason.message : "重新同步失败");
        }
    };

    const remove = () => {
        if (!selected) return;
        const users = usedByModels?.get(selected.id) || [];
        modal.confirm({
            title: `删除「${selected.name}」？`,
            content: users.length
                ? `有 ${users.length} 个模型正在使用该工作流：${users.join("、")}。删除后这些模型的相关输入场景将不可用，需要在模型设置里改选其它实现。`
                : "档案删除后不可恢复，已归档的历史任务不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteRunningHubWorkflow(selected.id);
                    toast.success("已删除");
                    onSelected?.(null);
                    await onChanged();
                } catch (reason) {
                    toast.error(reason instanceof Error ? reason.message : "删除失败");
                }
            },
        });
    };

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2.5">
            <Button size="small" type="primary" icon={<Plus className="size-3.5" />} onClick={() => setOpen(true)}>
                添加 RunningHub 工作流
            </Button>
            {selected ? (
                <>
                    {renaming ? (
                        <Input
                            autoFocus
                            size="small"
                            className="w-40"
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onPressEnter={() => void renameProfile()}
                            onBlur={() => void renameProfile()}
                        />
                    ) : (
                        <Button size="small" onClick={() => { setRenameValue(selected.name); setRenaming(true); }}>
                            重命名
                        </Button>
                    )}
                    <Tooltip title="重新读取平台当前的节点图与输入字段，保留已保存的映射">
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void resync()}>
                            重新同步
                        </Button>
                    </Tooltip>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={remove}>
                        删除
                    </Button>
                </>
            ) : null}
            <Modal
                title="添加 RunningHub 工作流"
                open={open}
                onCancel={() => { setOpen(false); reset(); }}
                onOk={() => void addProfile()}
                okText="登记"
                confirmLoading={busy}
                destroyOnClose
            >
                <p className="mb-3 text-sm text-stone-500">
                    登记后由 RunningHub 云端执行，不会生成本地 ComfyUI 文件。若需要一份可在本地运行的副本，登记后在本地库用「转换为本地副本」。
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
            </Modal>
        </div>
    );
}
