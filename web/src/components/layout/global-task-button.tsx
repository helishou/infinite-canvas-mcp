import { useState } from "react";
import { Alert, Button, Empty, Modal, Progress, Spin, Tag, Tooltip } from "antd";
import { ListChecks, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchBackendTasks } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { groupRecentTasks } from "./task-groups";
import { taskDestination } from "@/pages/home/workbench-data";

/** Opens in place so checking tasks never discards the current editor or input. */
export function GlobalTaskButton({ className }: { className?: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return <>
        <Tooltip title={t("home.workbench.tasks")}><Button type="text" shape="circle" className={className} icon={<ListChecks className="size-4" />} aria-label={t("home.workbench.tasks")} onClick={() => setOpen(true)} /></Tooltip>
        {open && <GlobalTaskDialog onClose={() => setOpen(false)} />}
    </>;
}

function GlobalTaskDialog({ onClose }: { onClose: () => void }) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const connected = useBackendStore(state => state.connected);
    const backendUrl = useBackendStore(state => state.url);
    const projects = useCanvasStore(state => state.projects);
    const tasks = useQuery({ queryKey: ["global-task-dialog", backendUrl], enabled: connected, queryFn: async () => (await fetchBackendTasks({ limit: 30 })).tasks || [], refetchOnMount: "always" });
    const projectIds = new Set(projects.map(project => project.id));
    const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    return <Modal rootClassName="canvas-blocking-overlay" open title={t("home.workbench.recentTasks")} onCancel={onClose} width={720} footer={<Button disabled={!connected} loading={tasks.isFetching} icon={<RefreshCw className="size-4" />} onClick={() => void tasks.refetch()}>{t("home.workbench.refresh")}</Button>}>
        <p className="mb-3 text-xs text-muted-foreground">{t("microTools.tasks.scope")}</p>
        <div className="max-h-[65vh] overflow-y-auto">
            {!connected ? <Empty description={t("home.workbench.offline")} /> : tasks.isError ? <Alert type="error" showIcon message={tasks.error instanceof Error ? tasks.error.message : String(tasks.error)} /> : tasks.isPending ? <div className="grid min-h-32 place-items-center"><Spin /></div> : tasks.data.length ? groupRecentTasks(tasks.data).map(group => <section key={group.key} aria-label={t(`microTools.tasks.${group.key}`)}><h3 className="sticky top-0 bg-background py-2 text-sm font-medium">{t(`microTools.tasks.${group.key}`)} · {group.tasks.length}</h3>{group.tasks.map(task => {
                const destination = taskDestination(task, projectIds);
                return <div key={task.id} className="border-b border-border py-4 last:border-0">
                    <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{projects.find(project => project.id === task.projectId)?.title || task.model || task.kind || t("home.workbench.task")}</p><p className="mt-1 text-xs text-muted-foreground">{task.model} · {date(task.updatedAt || task.createdAt || "")}</p></div>
                        <Tag color={task.status === "failed" ? "error" : task.status === "running" ? "processing" : task.status === "succeeded" ? "success" : "default"}>{t(`home.workbench.status_${task.status}`)}</Tag>
                        {destination && <Button size="small" onClick={() => { onClose(); navigate(destination); }}>{t("home.workbench.openSource")}</Button>}
                    </div>
                    {task.status === "running" && <Progress className="!mt-2" percent={Math.min(100, Math.max(0, Math.round((Number(task.progress) || 0) * 100)))} size="small" />}
                    {task.error && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{task.error}</p>}
                </div>;
            })}</section>) : <Empty description={t("home.workbench.noTasks")} />}
        </div>
    </Modal>;
}
