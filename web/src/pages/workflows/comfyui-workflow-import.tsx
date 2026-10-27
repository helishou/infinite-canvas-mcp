import { useMemo, useState } from "react";
import { Alert, App, Button, Input, Modal, Radio, Spin, Tooltip } from "antd";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchLocalComfyWorkflows, importLocalComfyWorkflow, type LocalComfyWorkflowFile } from "@/services/api/workflows";

export function ComfyUIWorkflowImport({ onImported }: { onImported: (name: string) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [workflows, setWorkflows] = useState<LocalComfyWorkflowFile[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState("");

    const visibleWorkflows = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        return workflows.filter((item) => !query || `${item.name} ${item.relativePath} ${item.instance}`.toLocaleLowerCase().includes(query));
    }, [search, workflows]);

    const show = () => {
        setOpen(true);
        setSearch("");
        setSelectedId("");
        setError("");
        setLoading(true);
        void fetchLocalComfyWorkflows()
            .then(({ workflows: files }) => setWorkflows(files))
            .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setLoading(false));
    };

    const importSelected = async () => {
        const selected = workflows.find((item) => item.id === selectedId);
        if (!selected) return;
        setImporting(true);
        setError("");
        try {
            const result = await importLocalComfyWorkflow({ instance: selected.instance, relativePath: selected.relativePath });
            message.success(t("workflowLibraryActions.importComfyUISuccess", { name: result.name }));
            setOpen(false);
            onImported(result.name);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setImporting(false);
        }
    };

    return <>
        <Tooltip title={t("workflowLibraryActions.importComfyUI")}>
            <Button type="text" size="small" className="shrink-0" aria-label={t("workflowLibraryActions.importComfyUI")} title={t("workflowLibraryActions.importComfyUI")} icon={<FolderOpen className="size-3.5" />} loading={loading || importing} onClick={show} />
        </Tooltip>
        <Modal
            title={t("workflowLibraryActions.importComfyUITitle")}
            open={open}
            onCancel={() => setOpen(false)}
            onOk={() => void importSelected()}
            okText={t("workflowLibraryActions.importComfyUISubmit")}
            cancelText={t("common.cancel")}
            okButtonProps={{ disabled: !visibleWorkflows.some((item) => item.id === selectedId) || loading || importing }}
            confirmLoading={importing}
            destroyOnClose
        >
            <p className="mb-3 text-sm text-muted-foreground">{t("workflowLibraryActions.importComfyUIHint")}</p>
            <Input.Search allowClear value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("workflowLibraryActions.searchComfyUI")} aria-label={t("workflowLibraryActions.searchComfyUI")} />
            <div className="mt-3 max-h-80 overflow-auto rounded-md border border-border p-2">
                {loading ? <div className="flex justify-center py-8"><Spin /></div>
                    : visibleWorkflows.length ? <Radio.Group className="flex w-full flex-col gap-2" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                        {visibleWorkflows.map((item) => <Radio key={item.id} value={item.id} className="!mr-0 w-full rounded px-2 py-1 hover:bg-muted">
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm">{item.name}</span>
                                <span className="truncate text-xs text-muted-foreground">{item.relativePath} · {item.instance}</span>
                            </span>
                        </Radio>)}
                    </Radio.Group>
                        : <p className="m-0 py-8 text-center text-sm text-muted-foreground">{workflows.length ? t("workflowLibraryActions.noComfyUISearchResults") : t("workflowLibraryActions.noComfyUIWorkflows")}</p>}
            </div>
            {error ? <Alert className="mt-3" type="error" showIcon message={error} /> : null}
        </Modal>
    </>;
}
