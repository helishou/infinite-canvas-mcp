import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Modal, Progress, Select, Tag, message } from "antd";
import { RefreshCw, Square } from "lucide-react";

import { cancelBackendTask, fetchBackendTasks, retryBackendTask, type BackendRuntimeTask } from "@/services/backend-api";

export function CanvasTaskCenter({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const [tasks, setTasks] = useState<BackendRuntimeTask[]>([]);
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const load = useCallback(async () => {
        if (!open || !projectId) return;
        setLoading(true);
        try {
            const result = await fetchBackendTasks({ projectId, status: status || undefined, limit: 100, offset: 0 });
            setTasks(result.tasks || []);
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        finally { setLoading(false); }
    }, [open, projectId, status]);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!open) return;
        const onEvent = (event: Event) => {
            const detail = (event as CustomEvent).detail as { type?: string; entityId?: string; payload?: BackendRuntimeTask } | undefined;
            if (!detail?.entityId || !detail.type?.startsWith("task.") || !detail.payload?.projectId || detail.payload.projectId !== projectId) return;
            setTasks((current) => {
                const next = current.filter((task) => task.id !== detail.entityId);
                return detail.payload && (!status || detail.payload.status === status) ? [detail.payload, ...next] : next;
            });
        };
        window.addEventListener("backend-event", onEvent);
        return () => window.removeEventListener("backend-event", onEvent);
    }, [open, projectId, status]);
    const cancel = async (id: string) => { try { await cancelBackendTask(id); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } };
    const retry = async (id: string) => { try { await retryBackendTask(id); await load(); message.success("已创建重试任务"); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } };
    return <Modal title="任务中心" open={open} onCancel={onClose} footer={null} width={900} destroyOnHidden>
        <div className="mb-3 flex items-center justify-between gap-3">
            <Select value={status} onChange={setStatus} className="w-40" options={[{ value: "", label: "全部状态" }, { value: "queued", label: "排队中" }, { value: "running", label: "运行中" }, { value: "succeeded", label: "已完成" }, { value: "failed", label: "失败" }, { value: "cancelled", label: "已取消" }]} />
            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
        </div>
        {!tasks.length ? <Empty description={loading ? "加载中…" : "暂无任务"} /> : <div className="max-h-[62vh] space-y-2 overflow-y-auto">
            {tasks.map((task) => {
                const terminal = ["succeeded", "failed", "cancelled"].includes(task.status);
                const color = task.status === "succeeded" ? "green" : task.status === "failed" ? "red" : task.status === "running" ? "processing" : "default";
                return <div key={task.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                    <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 flex-wrap items-center gap-1.5"><Tag color={color}>{task.status}</Tag><Tag>{task.kind || task.executor || "task"}</Tag>{task.model ? <Tag>{task.model}</Tag> : null}<span className="truncate text-xs text-stone-500">{task.id}</span></div><div className="flex gap-1">{terminal && task.status !== "succeeded" ? <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void retry(task.id)}>重试</Button> : null}{!terminal ? <Button danger type="text" size="small" icon={<Square className="size-3.5" />} onClick={() => void cancel(task.id)}>取消</Button> : null}</div></div>
                    <Progress percent={Math.round((task.progress || 0) * 100)} size="small" status={task.status === "failed" ? "exception" : task.status === "succeeded" ? "success" : "active"} />
                    <div className="flex flex-wrap gap-3 text-xs text-stone-500"><span>节点：{task.nodeId || "-"}</span><span>Clip：{task.segmentId || "-"}</span><span>执行器：{task.executor || "-"}</span>{task.parentTaskId ? <span>父任务：{task.parentTaskId}</span> : null}</div>
                    {task.error ? <div className="mt-1 break-words text-xs text-red-500">{task.error}</div> : null}
                </div>;
            })}
        </div>}
    </Modal>;
}
