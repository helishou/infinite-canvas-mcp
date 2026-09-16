import { App, Button, Empty, Form, Tag } from "antd";
import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigComfyui } from "@/components/layout/config-comfyui";
import { createModelChannel, useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { InstancesModal } from "./instances-modal";

export function ComfyChannelsPanel() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const [editingId, setEditingId] = useState("");
    const channels = config.channels.filter((channel) => channel.kind === "comfyui");
    const editingChannel = config.channels.find((channel) => channel.id === editingId) || null;

    const updateChannels = (next: ModelChannel[]) => replaceConfig({ ...config, channels: next });
    const addChannel = () => {
        const channel = createModelChannel({
            name: "本地 ComfyUI",
            kind: "comfyui",
            baseUrl: "http://127.0.0.1:8188",
            models: [],
        });
        updateChannels([...config.channels, channel]);
        setEditingId(channel.id);
    };
    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => item.id === channel.id ? channel : item));
        message.success("ComfyUI 模型与路由已保存");
    };
    const deleteChannel = (id: string) => {
        updateChannels(config.channels.filter((channel) => channel.id !== id));
        if (editingId === id) setEditingId("");
        message.success("ComfyUI 渠道已删除");
    };

    return (
        <div className="mt-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">模型与工作流路由</h2>
                    <p className="mt-1 text-sm text-stone-500">把工作流组织为可选择的图片、视频、文本或音频模型，并按文生、单参考、多参考分别配置路由。</p>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>添加模型渠道</Button>
            </div>

            {channels.length ? (
                <div className="space-y-2">
                    {channels.map((channel) => (
                        <div key={channel.id} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{channel.name}</div>
                                <div className="mt-1 truncate text-xs text-stone-500">{channel.baseUrl || "未填写地址"}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <Tag>{channel.models.length} 个模型</Tag>
                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingId(channel.id)}>配置模型与路由</Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 py-12 dark:border-stone-700">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 ComfyUI 模型配置" />
                </div>
            )}

            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingId("")} lockKind />
        </div>
    );
}

export function ComfyRuntimePanel() {
    const [instancesOpen, setInstancesOpen] = useState(false);

    return (
        <div className="mt-5 space-y-4">
            <section className="rounded-lg border border-stone-200 bg-white px-4 pb-1 pt-2 dark:border-stone-800 dark:bg-stone-900">
                <Form layout="vertical" requiredMark={false}>
                    <ConfigComfyui active />
                </Form>
            </section>
            <section className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 bg-white px-4 py-4 dark:border-stone-800 dark:bg-stone-900">
                <div>
                    <div className="text-sm font-semibold">运行实例</div>
                    <div className="mt-1 text-xs text-stone-500">管理用于工作流调度的 ComfyUI 地址，例如本机或局域网实例。</div>
                </div>
                <Button icon={<Server className="size-4" />} onClick={() => setInstancesOpen(true)}>管理实例</Button>
            </section>
            <InstancesModal open={instancesOpen} onClose={() => setInstancesOpen(false)} />
        </div>
    );
}
