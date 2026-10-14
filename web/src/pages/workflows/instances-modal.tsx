import { useState, useEffect } from "react";
import { Modal, Input, Button, message } from "antd";
import { Plus, Trash2, Server } from "lucide-react";
import { request } from "@/services/backend-api";

export function InstancesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [rows, setRows] = useState<Array<{ addr: string; root: string }>>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (open) {
            request<{ instances: string[]; roots?: Record<string, string> }>("GET", "/api/comfyui/instances")
                .then((d) => setRows((d.instances || []).map((addr) => ({ addr, root: d.roots?.[addr] || "" }))))
                .catch(() => setRows([]));
        }
    }, [open]);

    const save = async () => {
        setLoading(true);
        try {
            const roots: Record<string, string> = {};
            for (const row of rows) if (row.root.trim()) roots[row.addr] = row.root.trim();
            await request("PUT", "/api/comfyui/instances", { instances: rows.map((row) => row.addr), roots });
            message.success("已保存");
            onClose();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "保存失败");
        } finally {
            setLoading(false);
        }
    };

    const update = (idx: number, patch: Partial<{ addr: string; root: string }>) => {
        setRows((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
    };

    const add = () => setRows((prev) => [...prev, { addr: "", root: "" }]);
    const remove = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

    return (
        <Modal title="ComfyUI 实例管理" open={open} onCancel={onClose} onOk={save} okText="保存" cancelText="取消" confirmLoading={loading}>
            <div className="space-y-3">
                {rows.length === 0 && <p className="text-sm text-stone-500">暂无实例，点击下方按钮添加</p>}
                {rows.map((row, idx) => (
                    <div key={idx} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <Server className="size-4 shrink-0 text-stone-400" />
                            <Input value={row.addr} onChange={(e) => update(idx, { addr: e.target.value })} placeholder="host:port（如 127.0.0.1:8188）" />
                            <Button size="small" danger type="text" icon={<Trash2 className="size-3" />} onClick={() => remove(idx)} />
                        </div>
                        <div className="pl-6">
                            <Input
                                value={row.root}
                                onChange={(e) => update(idx, { root: e.target.value })}
                                placeholder="本机 ComfyUI 根目录（可选；填写后本地工作流可一键写入其 workflows 目录，如 D:/ComfyUIV16/ComfyUI）"
                                size="small"
                            />
                        </div>
                    </div>
                ))}
                <Button type="dashed" block size="small" icon={<Plus className="size-3" />} onClick={add}>
                    添加实例
                </Button>
            </div>
        </Modal>
    );
}
