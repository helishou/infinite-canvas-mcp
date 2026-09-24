import { App, Button, Card, Checkbox, Empty, Form, Tag } from "antd";
import { Download, FileUp, Image as ImageIcon, Music, Pencil, Plus, Server, Trash2, Type, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ConfigComfyui } from "@/components/layout/config-comfyui";
import { ModelWorkflowEditorModal } from "@/components/layout/model-workflow-editor-modal";
import { backendMediaUrl, fetchBackendGenerationLogs, request, type BackendGenerationLog } from "@/services/backend-api";
import { createModelPackage, parseModelPackage, restoreModelPackage } from "@/services/api/model-packages";
import { importWorkflowPackage, type WorkflowPackage } from "@/services/api/workflows";
import { createModelChannel, hydrateConfigFromBackend, modelOptionName, normalizeChannelModels, useConfigStore, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";
import { InstancesModal } from "./instances-modal";

const CAPABILITY_LABELS = { image: "图片", video: "视频", text: "文本", audio: "音频" } as const;

export function ComfyChannelsPanel() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const importRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [generationLogs, setGenerationLogs] = useState<BackendGenerationLog[]>([]);
    const [modelTarget, setModelTarget] = useState<{ channelId: string; model: ChannelModel | null } | null>(null);
    const channel = config.channels.find((item) => item.kind === "comfyui") || null;
    const covers = useMemo(() => {
        const entries = (channel?.models || []).map((model) => [model.name, findModelCover(generationLogs, channel?.id || "", model)] as const);
        return new Map(entries);
    }, [channel, generationLogs]);

    useEffect(() => {
        let disposed = false;
        fetchBackendGenerationLogs({ status: "success" })
            .then((result) => {
                if (!disposed) setGenerationLogs(result.logs || []);
            })
            .catch(() => {
                if (!disposed) setGenerationLogs([]);
            });
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        const names = new Set((channel?.models || []).map((model) => model.name));
        setSelectedNames((current) => new Set([...current].filter((name) => names.has(name))));
    }, [channel?.models]);

    const updateChannels = (next: ModelChannel[]) => replaceConfig({ ...config, channels: next });
    const addModel = () => {
        const target =
            channel ||
            createModelChannel({
                name: "本地 ComfyUI",
                kind: "comfyui",
                baseUrl: "http://127.0.0.1:8188",
                models: [],
            });
        if (!channel) updateChannels([...config.channels, target]);
        setModelTarget({ channelId: target.id, model: null });
    };
    const saveModel = (next: ChannelModel) => {
        if (!modelTarget) return;
        const saved = modelTarget.model ? { ...modelTarget.model, ...next } : next;
        updateChannels(
            config.channels.map((channel) => {
                if (channel.id !== modelTarget.channelId) return channel;
                const index = channel.models.findIndex((model) => model.name === modelTarget.model?.name);
                const models =
                    index < 0
                        ? [...channel.models.filter((model) => model.name !== saved.name), saved]
                        : channel.models.map((model, itemIndex) => (itemIndex === index ? saved : model)).filter((model, itemIndex) => model.name !== saved.name || itemIndex === index);
                return { ...channel, models };
            }),
        );
        message.success(modelTarget.model ? "模型已更新" : "模型已添加");
    };
    const deleteModel = (channelId: string, name: string) => {
        updateChannels(config.channels.map((channel) => (channel.id === channelId ? { ...channel, models: channel.models.filter((model) => model.name !== name) } : channel)));
        message.success("模型已删除");
    };
    const importModels = async (files: File[]) => {
        setImporting(true);
        try {
            const importedModels: ChannelModel[] = [];
            let importedStandaloneWorkflow = false;
            const entries = await Promise.all(files.map(async (file) => ({ file, value: JSON.parse(await file.text()) as Record<string, unknown> })));
            const parsedPackages = new Map(entries.filter(({ value }) => value.format === "infinite-canvas-models").map(({ file, value }) => [file, parseModelPackage(value)]));
            for (const { file, value } of entries) {
                const modelPackage = parsedPackages.get(file);
                if (modelPackage) importedModels.push(...(await restoreModelPackage(modelPackage)));
                else if (value.format === "infinite-canvas-workflow") {
                    await importWorkflowPackage(file.name, value as WorkflowPackage);
                    importedStandaloneWorkflow = true;
                } else {
                    await request("POST", "/api/workflows", { name: file.name.replace(/\.json$/i, ""), workflow: value });
                    importedStandaloneWorkflow = true;
                }
            }
            if (importedStandaloneWorkflow) await hydrateConfigFromBackend();
            if (importedModels.length) {
                const latest = useConfigStore.getState().config;
                const local = latest.channels.find((item) => item.kind === "comfyui") || createModelChannel({ id: "local-comfyui", name: "本地 ComfyUI", kind: "comfyui", baseUrl: "http://127.0.0.1:8188", models: [] });
                const incoming = new Map(importedModels.map((model) => [model.name, model]));
                const merged = local.models.map((model) => incoming.get(model.name) || model);
                for (const model of incoming.values()) if (!local.models.some((item) => item.name === model.name)) merged.push(model);
                const channels = latest.channels.some((item) => item.id === local.id)
                    ? latest.channels.map((item) => (item.id === local.id ? { ...local, models: normalizeChannelModels(merged) } : item))
                    : [...latest.channels, { ...local, models: normalizeChannelModels(merged) }];
                useConfigStore.getState().replaceConfig({ ...latest, channels });
            }
            message.success(`已导入 ${files.length} 个文件${importedModels.length ? `，包含 ${new Set(importedModels.map((model) => model.name)).size} 个模型` : ""}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型导入失败");
        } finally {
            setImporting(false);
        }
    };
    const exportModels = async (models: ChannelModel[], label: string) => {
        if (!models.length) return;
        setExporting(true);
        try {
            const modelPackage = await createModelPackage(models);
            const safeLabel = label.replace(/[\\/:*?"<>|]+/g, "-");
            const url = URL.createObjectURL(new Blob([JSON.stringify(modelPackage, null, 2)], { type: "application/json" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${safeLabel}.models.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            message.success(`已导出 ${models.length} 个模型及其工作流`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型导出失败");
        } finally {
            setExporting(false);
        }
    };
    const models = channel?.models || [];
    const selectedModels = models.filter((model) => selectedNames.has(model.name));
    const allSelected = Boolean(models.length) && selectedNames.size === models.length;

    return (
        <div className="mt-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">模型列表</h2>
                    <p className="mt-1 text-sm text-stone-500">管理本地模型，最近一次生成产物会自动作为封面。</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <input
                        ref={importRef}
                        type="file"
                        accept=".json"
                        multiple
                        className="hidden"
                        onChange={async (event) => {
                            const files = Array.from(event.target.files || []);
                            event.target.value = "";
                            if (files.length) await importModels(files);
                        }}
                    />
                    {models.length ? (
                        <Checkbox
                            checked={allSelected}
                            indeterminate={selectedNames.size > 0 && !allSelected}
                            onChange={(event) => setSelectedNames(event.target.checked ? new Set(models.map((model) => model.name)) : new Set())}
                        >
                            全选
                        </Checkbox>
                    ) : null}
                    <Button icon={<Download className="size-4" />} disabled={!selectedModels.length} loading={exporting} onClick={() => exportModels(selectedModels, selectedModels.length === 1 ? selectedModels[0].name : `无限画布-${selectedModels.length}个模型`)}>
                        导出选中{selectedModels.length ? ` (${selectedModels.length})` : ""}
                    </Button>
                    <Button icon={<Download className="size-4" />} disabled={!models.length} loading={exporting} onClick={() => exportModels(models, "无限画布-全部模型")}>
                        导出全部
                    </Button>
                    <Button icon={<FileUp className="size-4" />} loading={importing} onClick={() => importRef.current?.click()}>
                        导入模型
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addModel}>
                        添加模型
                    </Button>
                </div>
            </div>

            {channel?.models.length ? (
                <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {channel.models.map((model) => (
                        <ModelCard
                            key={model.name}
                            model={model}
                            cover={covers.get(model.name) || null}
                            selected={selectedNames.has(model.name)}
                            onSelectedChange={(selected) => setSelectedNames((current) => {
                                const next = new Set(current);
                                if (selected) next.add(model.name);
                                else next.delete(model.name);
                                return next;
                            })}
                            onConfigure={() => setModelTarget({ channelId: channel.id, model })}
                            onDelete={() => deleteModel(channel.id, model.name)}
                        />
                    ))}
                </section>
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 py-12 dark:border-stone-700">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有模型" />
                </div>
            )}

            <ModelWorkflowEditorModal open={Boolean(modelTarget)} model={modelTarget?.model || null} onSave={saveModel} onClose={() => setModelTarget(null)} />
        </div>
    );
}

type ModelCover = { url: string; kind: "image" | "video" };

function ModelCard({ model, cover, selected, onSelectedChange, onConfigure, onDelete }: { model: ChannelModel; cover: ModelCover | null; selected: boolean; onSelectedChange: (selected: boolean) => void; onConfigure: () => void; onDelete: () => void }) {
    const [coverFailed, setCoverFailed] = useState(false);
    const PlaceholderIcon = model.capability === "video" ? Video : model.capability === "audio" ? Music : model.capability === "text" ? Type : ImageIcon;

    useEffect(() => setCoverFailed(false), [cover?.url]);

    return (
        <Card
            hoverable
            className="group flex h-full flex-col overflow-hidden"
            styles={{ body: { display: "flex", flex: 1, flexDirection: "column", padding: 0 } }}
            cover={
                <div className="relative aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-stone-900">
                    <button type="button" className="block size-full cursor-pointer text-left" onClick={onConfigure}>
                        {cover && !coverFailed ? (
                            cover.kind === "video" ? (
                                <video src={cover.url} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" muted playsInline preload="metadata" onError={() => setCoverFailed(true)} />
                            ) : (
                                <img src={cover.url} alt={model.name} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" loading="lazy" decoding="async" onError={() => setCoverFailed(true)} />
                            )
                        ) : (
                            <span className="grid size-full place-items-center text-stone-400 dark:text-stone-600"><PlaceholderIcon className="size-9" /></span>
                        )}
                        {cover && !coverFailed ? <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white backdrop-blur-sm">最近产物</span> : null}
                    </button>
                    <Checkbox className="absolute right-3 top-3 rounded bg-white/90 px-1.5 py-1 shadow-sm dark:bg-stone-950/85" checked={selected} aria-label={`选择 ${model.name}`} onChange={(event) => onSelectedChange(event.target.checked)} />
                </div>
            }
        >
            <button type="button" className="block w-full flex-1 cursor-pointer p-4 text-left" onClick={onConfigure}>
                <h3 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100" title={model.name}>{model.name}</h3>
                <div className="mt-2"><Tag className="m-0">{CAPABILITY_LABELS[model.capability]}</Tag></div>
            </button>
            <div className="flex items-center gap-1 px-3 pb-3">
                <Button block size="small" type="text" icon={<Pencil className="size-3.5" />} onClick={onConfigure}>配置</Button>
                <Button size="small" danger type="text" aria-label={`删除 ${model.name}`} icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
            </div>
        </Card>
    );
}

function findModelCover(logs: BackendGenerationLog[], channelId: string, model: ChannelModel): ModelCover | null {
    const workflows = new Set(model.workflows || []);
    for (const log of logs) {
        const logModel = String(log.model || "");
        const logWorkflow = String(log.workflow || "");
        const matches = logModel === model.name || logModel === `${channelId}::${model.name}` || modelOptionName(logModel) === model.name || workflows.has(logModel) || workflows.has(logWorkflow);
        if (!matches) continue;
        const media = (log.outputs || []).map(readModelCover).filter((item): item is ModelCover => Boolean(item));
        const preferred = model.capability === "video" ? media.find((item) => item.kind === "video") : media.find((item) => item.kind === "image");
        if (preferred) return preferred;
        if (media[0]) return media[0];
    }
    return null;
}

function readModelCover(output: Record<string, unknown>): ModelCover | null {
    const storageKey = typeof output.storageKey === "string" ? output.storageKey : "";
    const url = storageKey ? backendMediaUrl(storageKey) : String(output.url || output.localUrl || output.video_url || "");
    if (!url) return null;
    const type = String(output.mimeType || output.type || "").toLowerCase();
    if (type.startsWith("video") || /\.(mp4|webm|mov|m4v|mkv)(?:\?|#|$)/i.test(url)) return { url, kind: "video" };
    if (type.startsWith("image") || /\.(png|jpe?g|webp|gif|avif|bmp)(?:\?|#|$)/i.test(url)) return { url, kind: "image" };
    return null;
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
                    <div className="mt-1 text-xs text-stone-500">管理用于模型调度的 ComfyUI 地址，例如本机或局域网实例。</div>
                </div>
                <Button icon={<Server className="size-4" />} onClick={() => setInstancesOpen(true)}>
                    管理实例
                </Button>
            </section>
            <InstancesModal open={instancesOpen} onClose={() => setInstancesOpen(false)} />
        </div>
    );
}
