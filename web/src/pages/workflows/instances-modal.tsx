import { useState, useEffect } from "react";
import { Modal, Input, Button, message } from "antd";
import { Plus, Trash2, Server } from "lucide-react";
import { request } from "@/services/backend-api";

export function InstancesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [instances, setInstances] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (open) {
            request<{ instances: string[] }>("GET", "/api/comfyui/instances")
                .then((d) => setInstances(d.instances))
                .catch(() => setInstances([]));
        }
    }, [open]);

    const save = async () => {
        setLoading(true);
        try {
            await request("PUT", "/api/comfyui/instances", { instances });
            message.success("已保存");
            onClose();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "保存失败");
        } finally {
            setLoading(false);
        }
    };

    const update = (idx: number, val: string) => {
        setInstances((prev) => prev.map((v, i) => (i === idx ? val : v)));
    };

    const add = () => setInstances((prev) => [...prev, ""]);
    const remove = (idx: number) => setInstances((prev) => prev.filter((_, i) => i !== idx));

    return (
        <Modal title="ComfyUI 实例管理" open={open} onCancel={onClose} onOk={save} okText="保存" cancelText="取消" confirmLoading={loading}>
            <div className="space-y-2">
                {instances.length === 0 && <p className="text-sm text-stone-500">暂无实例，点击下方按钮添加</p>}
                {instances.map((addr, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                        <Server className="size-4 shrink-0 text-stone-400" />
                        <Input value={addr} onChange={(e) => update(idx, e.target.value)} placeholder="host:port（如 127.0.0.1:8188）" />
                        <Button size="small" danger type="text" icon={<Trash2 className="size-3" />} onClick={() => remove(idx)} />
                    </div>
                ))}
                <Button type="dashed" block size="small" icon={<Plus className="size-3" />} onClick={add}>
                    添加实例
                </Button>
            </div>
        </Modal>
    );
}
