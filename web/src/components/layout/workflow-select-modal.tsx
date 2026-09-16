// ComfyUI 工作流选择弹窗：拉 /api/workflows 列表，选中的写入 channel.models
// 复用 ModelSelectModal 视觉，但去掉「拉取远端模型」按钮（后端工作流列表即真实数据源）
import { App, Button, Checkbox, Input, Modal, Tabs } from "antd";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchWorkflows, type WorkflowItem } from "@/services/api/workflows";

export function WorkflowSelectModal({ open, selectedNames, onConfirm, onClose }: { open: boolean; selectedNames: string[]; onConfirm: (names: string[]) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [existing, setExisting] = useState<string[]>([]);
    const [fetched, setFetched] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState("new");
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        setExisting(selectedNames);
        setFetched([]);
        setSelected(new Set(selectedNames));
        setActiveTab(selectedNames.length ? "existing" : "new");
        setSearch("");
        void loadWorkflows();
    }, [open, selectedNames]);

    const loadWorkflows = async () => {
        setLoading(true);
        try {
            const data = await fetchWorkflows();
            setFetched(data.workflows.map((item: WorkflowItem) => item.name));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载工作流失败");
        } finally {
            setLoading(false);
        }
    };

    const currentList = activeTab === "new" ? fetched : existing;
    const visibleList = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return keyword ? currentList.filter((name) => name.toLowerCase().includes(keyword)) : currentList;
    }, [currentList, search]);
    const visibleSelectedCount = visibleList.filter((name) => selected.has(name)).length;

    const toggle = (name: string, checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(name);
            else next.delete(name);
            return next;
        });

    const selectVisible = (checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            visibleList.forEach((name) => (checked ? next.add(name) : next.delete(name)));
            return next;
        });

    const confirm = () => {
        const ordered = [...existing, ...fetched].filter((name, index, list) => list.indexOf(name) === index).filter((name) => selected.has(name));
        onConfirm(ordered);
        onClose();
    };

    return (
        <Modal
            open={open}
            width={880}
            centered
            onCancel={onClose}
            title={
                <span>
                    {t("config.modelSelect.title")} <span className="ml-2 text-xs font-normal text-stone-500">{t("config.modelSelect.selected", { selected: selected.size, total: new Set([...existing, ...fetched]).size })}</span>
                </span>
            }
            styles={{ body: { maxHeight: "62vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    {t("common.cancel")}
                </Button>,
                <Button key="confirm" type="primary" onClick={confirm}>
                    {t("config.modelSelect.confirm")}
                </Button>,
            ]}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Input className="min-w-[200px] flex-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("config.modelSelect.search")} prefix={<Search className="size-4 text-stone-400" />} allowClear />
            </div>
            <div className="mt-2 text-xs text-stone-500">从 /workflows 页面管理的「自带 + 自定义上传」工作流（来源：后端 /api/workflows）</div>

            <Tabs
                className="mt-3"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    { key: "new", label: t("config.modelSelect.fetchedTab", { count: fetched.length }) },
                    { key: "existing", label: t("config.modelSelect.existingTab", { count: existing.length }) },
                ]}
            />

            <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">{t("config.modelSelect.visibleSelected", { selected: visibleSelectedCount, total: visibleList.length })}</span>
                <div className="flex gap-2">
                    <Button size="small" disabled={!visibleList.length} onClick={() => selectVisible(true)}>
                        {t("config.modelSelect.selectVisible")}
                    </Button>
                    <Button size="small" disabled={!visibleSelectedCount} onClick={() => selectVisible(false)}>
                        {t("config.modelSelect.clearVisible")}
                    </Button>
                </div>
            </div>

            {visibleList.length ? (
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
                    {visibleList.map((name) => (
                        <Checkbox key={name} checked={selected.has(name)} onChange={(event) => toggle(name, event.target.checked)} disabled={loading}>
                            <span className="truncate" title={name}>
                                {name}
                            </span>
                        </Checkbox>
                    ))}
                </div>
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">{loading ? "加载中…" : "暂无工作流，请先到「工作流」页面上传"}</div>
            )}
        </Modal>
    );
}
