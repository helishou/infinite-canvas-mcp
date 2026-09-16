import { App, Button, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { fetchComfyConfig, saveComfyRoot } from "@/services/api/comfyui";

export function ConfigComfyui({ active }: { active: boolean }) {
    const { message } = App.useApp();
    const [root, setRoot] = useState("");
    const [mediaDir, setMediaDir] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!active) return;
        let disposed = false;
        setLoading(true);
        setError("");
        fetchComfyConfig().then(({ localH3Direct }) => {
            if (!disposed) { setRoot(localH3Direct.rootDir); setMediaDir(localH3Direct.mediaDir); }
        }).catch((error) => {
            if (!disposed) setError(error instanceof Error ? error.message : "读取 ComfyUI 目录失败");
        }).finally(() => { if (!disposed) setLoading(false); });
        return () => { disposed = true; };
    }, [active]);

    const save = async () => {
        setSaving(true);
        setError("");
        try {
            const result = await saveComfyRoot(root.trim());
            setRoot(result.localH3Direct.rootDir);
            message.success("ComfyUI 目录已生效");
        } catch (error) {
            setError(error instanceof Error ? error.message : "保存 ComfyUI 目录失败");
        } finally { setSaving(false); }
    };

    return <>
        <div className="mb-2 mt-4 text-sm font-semibold">本地 ComfyUI</div>
        <Form.Item label="ComfyUI 根目录 / 绘世安装目录" validateStatus={error ? "error" : undefined} help={error || undefined} extra="仅用于本地任务的输入缓存，不会移动画布素材。删除 ComfyUI 或其缓存不会删除画布媒体库。">
            <div className="flex gap-2">
                <Input aria-label="ComfyUI 根目录 / 绘世安装目录" value={root} disabled={loading || saving} onChange={(event) => setRoot(event.target.value)} />
                <Button disabled={loading || !root.trim()} loading={saving} onClick={() => void save()}>应用目录</Button>
            </div>
        </Form.Item>
        {mediaDir && <div className="break-all text-xs">画布媒体目录：{mediaDir}</div>}
    </>;
}
