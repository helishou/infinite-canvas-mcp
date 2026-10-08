import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { previewH3Generation, fetchBackendH3Defaults, saveBackendH3Defaults, resetBackendH3Defaults } from '@/services/backend-api';
import { useTranslation } from "react-i18next";

import { storeGeneratedVideo } from "@/services/api/video";
import { fetchWorkflowDetail } from "@/services/api/workflows";
import { getLocalH3Task, resolveBackendAgentEndpoint, runVideoConcatTask } from "@/services/api/comfyui";
import { fetchComfyModels } from "@/services/api/canvas-agent";
import { applyBackendCanvasOperations, backendMediaUrl, createBackendGenerationLog, deleteBackendGenerationLogs, fetchBackendGenerationLogs, getBackendUrl, resolveBackendH3Confirmation, startCanvasGeneration, updateBackendGenerationLog } from "@/services/backend-api";
import { observeCanvasGenerationTask } from "@/services/api/canvas-generation-task";
import { getBackendTokenShared } from "@/lib/backend-token";
import { canvasTaskActionPath, canvasTaskPath } from "@basketikun/canvas-agent/generation-api";
import { decodeChannelModel, resolveModelWorkflow, resolveModelWorkflowParams, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { createCanvasReferenceService } from "@/lib/canvas/reference-service";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { ensurePluginsLoaded } from "@/lib/canvas/plugin-loader";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAssetPickerImage, CanvasGenerationCommand, CanvasGenerationLogs, CanvasMediaPreview, CanvasNodeToolbarItem, CanvasPluginAi, CanvasPluginHost, CanvasReferenceService, CanvasVideoModelSchema } from "@/types/canvas-plugin";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { flushCanvasProjectBeforeGeneration, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasGraphIndex } from "@/lib/canvas/canvas-graph-index";
import { createPluginGraphAccess } from "./plugin-graph-access";
import { requestFormalH3OutputSelection } from "@/lib/canvas/h3-output-restore";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type PluginHostParams = {
    projectId: string;
    effectiveConfig: AiConfig;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (open: boolean) => void;
    theme: CanvasTheme;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectGraphIndex: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => CanvasGraphIndex;
    viewportRef: MutableRefObject<ViewportTransform>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    openAssetPicker: (options?: { kind?: "image" }) => Promise<CanvasAssetPickerImage | null>;
    openMediaPreview: (item: CanvasMediaPreview) => void;
    applyAgentOps: (ops?: CanvasAgentOp[]) => unknown;
};

async function persistH3Result<T extends { url: string; mimeType: string; storageKey?: string; segments?: Array<{ media?: Array<{ url: string; mimeType: string; storageKey?: string }> }> }>(result: T): Promise<T & { storageKey?: string }> {
    // Comfy 后端已经落库的 H3 输出直接复用；再次经浏览器下载并上传会重复写一份大视频，也拖慢后续播放缓存。
    const stored = result.storageKey ? { url: result.url, storageKey: result.storageKey } : await storeGeneratedVideo({ url: result.url, mimeType: result.mimeType });
    const segments = result.segments
        ? await Promise.all(result.segments.map(async (segment) => ({
            ...segment,
            media: segment.media ? await Promise.all(segment.media.map(async (media) => {
                if (!media.mimeType.startsWith("video/") || media.storageKey) return media;
                const item = await storeGeneratedVideo({ url: media.url, mimeType: media.mimeType });
                return { ...media, url: item.url, storageKey: item.storageKey };
            })) : segment.media,
        })))
        : result.segments;
    return { ...result, url: stored.url, storageKey: stored.storageKey, segments };
}

/**
 * Plugin node host capabilities: expose host-side AI generation, canvas access, and panel controls
 * through plugin-callable host/ai objects. Loads installed remote plugins on mount and returns renderers for plugin panels and toolbars.
 */
export function usePluginHost(params: PluginHostParams) {
    const { t } = useTranslation();
    const { projectId, effectiveConfig, isAiConfigReady, openConfigDialog, theme, nodesRef, connectionsRef, viewportRef, setNodes, setDialogNodeId, openAssetPicker, openMediaPreview, applyAgentOps } = params;
    const getProject = useCallback(() => useCanvasStore.getState().projects.find((item) => item.id === projectId), [projectId]);
    const graphAccess = useMemo(() => createPluginGraphAccess(getProject, () => ({ nodes: nodesRef.current, connections: connectionsRef.current }), params.selectGraphIndex), [getProject, nodesRef, connectionsRef, params.selectGraphIndex]);
    const generationLogs = useMemo<CanvasGenerationLogs>(() => {
        return {
            list: async (options: Parameters<CanvasGenerationLogs["list"]>[0] = {}) => { const result = await fetchBackendGenerationLogs({ ...options, projectId: options.projectId || projectId }); return result.logs || []; },
            create: async (input: any) => { const result = await createBackendGenerationLog({ ...input, projectId: input.projectId || projectId }); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            update: async (id: string, patch: any) => { const result = await updateBackendGenerationLog(id, patch); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            remove: async (options: any) => { const result = await deleteBackendGenerationLogs(options); return Number(result.deleted || 0); },
        };
    }, [projectId]);
    const defaultLoadVersion = useRef(0);
    const h3Defaults = useMemo(() => ({
        get: fetchBackendH3Defaults,
        set: async (settings: Record<string, unknown>) => {
            defaultLoadVersion.current++;
            const committed = await saveBackendH3Defaults(settings);
            defaultLoadVersion.current++;
            window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: committed }));
            return committed;
        },
        reset: async () => {
            defaultLoadVersion.current++;
            await resetBackendH3Defaults();
            defaultLoadVersion.current++;
            window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: {} }));
        },
    }), []);

    const references = useMemo<CanvasReferenceService>(() => createCanvasReferenceService(projectId), [projectId]);

    // Host capabilities available to plugin nodes; methods receive nodeId and are not bound to a specific node.
    const pluginAi = useMemo<CanvasPluginAi>(() => {
        const signal = (value?: AbortSignal) => value || new AbortController().signal;
        const toReferences = (refs?: string[]) => (refs || []).filter(Boolean).map((src, index) => ({ id: `plugin-ref-${index}`, name: `ref-${index}.png`, mimeType: "image/png", ...(src.startsWith("data:") ? { dataUrl: src } : { url: src }) }));
        const mediaUrl = (media: { storageKey?: string; url?: string }) => media.storageKey ? backendMediaUrl(media.storageKey) : String(media.url || "");
        // Open the configuration dialog and throw when AI is not configured, allowing the plugin to handle the error.
        const ensureReady = (config: AiConfig) => {
            if (!isAiConfigReady(config, config.model)) {
                openConfigDialog(true);
                throw new Error(t("canvas.plugins.aiConfigRequired"));
            }
        };
        return {
            generateImage: async (prompt, options) => {
                const config = { ...buildGenerationConfig(effectiveConfig, undefined, "image"), count: String(options?.count || 1), ...(options?.model ? { model: options.model } : {}), ...(options?.size ? { size: options.size } : {}) };
                ensureReady(config);
                const task = await observeCanvasGenerationTask({ mode: "image", projectId, model: config.model, prompt, references: toReferences(options?.references), count: options?.count || 1, size: options?.size || config.size }, signal(options?.signal), "插件图片");
                const images = (task.result?.media || task.result?.images || []).map(mediaUrl).filter(Boolean);
                if (!images.length) throw new Error("插件图片任务成功但没有返回图片");
                return { images };
            },
            generateVideo: async (prompt, options) => {
                const config = {
                    ...buildGenerationConfig(effectiveConfig, undefined, "video"),
                    ...(options?.model ? { model: options.model } : {}),
                    ...(options?.size ? { size: options.size } : {}),
                    ...(options?.seconds ? { videoSeconds: options.seconds } : {}),
                };
                ensureReady(config);
                const task = await observeCanvasGenerationTask({ mode: "video", projectId, model: config.model, prompt, references: toReferences(options?.references), size: options?.size || config.size, seconds: options?.seconds || config.videoSeconds }, signal(options?.signal), "插件视频");
                const file = (task.result?.media || [])[0];
                if (!file) throw new Error("插件视频任务成功但没有返回视频");
                return { url: mediaUrl(file), mimeType: file.mimeType, width: file.width || undefined, height: file.height || undefined, durationMs: file.durationMs || undefined };
            },
            generateText: async (prompt, options) => {
                const config = { ...buildGenerationConfig(effectiveConfig, undefined, "text"), ...(options?.model ? { model: options.model } : {}) };
                ensureReady(config);
                const references = (options?.references || []).map((reference, index) => ({ id: `plugin-ref-${index}`, name: reference.name || `ref-${index}.png`, mimeType: reference.mimeType || "image/png", ...(reference.storageKey ? { storageKey: reference.storageKey } : {}), ...(reference.url.startsWith("data:") ? { dataUrl: reference.url } : { url: reference.url }) }));
                // 传入 log 时登记生成日志（platform=canvas-text，进「生文」筛选）；节点/Clip 写进任务 params，任务中心按其展示归属。
                const logMeta = options?.log;
                const startedAtMs = Date.now();
                const log = logMeta ? await generationLogs.create({
                    projectId, platform: "canvas-text", status: "running", model: config.model,
                    prompt: logMeta.prompt ?? prompt, nodeId: logMeta.nodeId, segmentId: logMeta.segmentId, taskMode: logMeta.taskMode,
                    references: logMeta.references || [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 0, outputs: [], params: {},
                }).catch(() => null) : null;
                try {
                    const task = await observeCanvasGenerationTask({ mode: "text", projectId, model: config.model, prompt, references, count: 1, params: { ...(options?.system ? { systemPrompt: options.system } : {}), ...(logMeta?.nodeId ? { nodeId: logMeta.nodeId } : {}), ...(logMeta?.segmentId ? { segmentId: logMeta.segmentId } : {}), reasoningEffort: config.reasoningEffort } }, signal(options?.signal), "插件文本");
                    const text = String(task.result?.texts?.[0]?.content || "");
                    if (!text) throw new Error("插件文本任务成功但没有返回文本");
                    options?.onDelta?.(text);
                    if (log) void generationLogs.update(log.id, { status: "success", finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs, runtimeTaskId: task.id, outputs: [{ type: "text", text }] }).catch(() => { });
                    return { text, taskId: task.id };
                } catch (error) {
                    if (log) void generationLogs.update(log.id, {
                        status: options?.signal?.aborted ? "cancelled" : "failed",
                        finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
                        error: error instanceof Error ? error.message : String(error),
                    }).catch(() => { });
                    throw error;
                }
            },
            previewH3Generation,
            runCanvasGeneration: async (command: CanvasGenerationCommand) => {
                let checkedCommand = command;
                if (command.operation === 'h3-run') {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    const preview = await previewH3Generation(command);
                    if (!preview.ready) throw new Error(preview.diagnostics.map(issue => issue.message).join('；') || 'H3 预检未就绪');
                    checkedCommand = { ...command, expectedPlanHash: command.expectedPlanHash || preview.planHash };
                }
                const data = await startCanvasGeneration(checkedCommand);
                if (!data.task) throw new Error("画布生成失败：Backend 未返回任务");
                return data.task;
            },
            resolveH3Confirmation: async ({ taskId, ...input }) => (await resolveBackendH3Confirmation(taskId, input)).task as unknown as import("@/types/canvas-plugin").LocalH3Task,
            getLocalH3Task: async (taskId) => {
                const task = await getLocalH3Task(getBackendUrl(), getBackendTokenShared(), taskId) as Awaited<ReturnType<typeof getLocalH3Task>>;
                if (task.status === "succeeded" && task.result?.url && !task.result.storageKey) {
                    return { ...task, result: await persistH3Result(task.result) };
                }
                return task;
            },
            getCanvasH3Task: async (taskId) => {
                const response = await fetch(`${getBackendUrl()}${canvasTaskPath(taskId)}?token=${encodeURIComponent(getBackendTokenShared())}`);
                const data = await response.json() as { task?: import("@/types/canvas-plugin").LocalH3Task; error?: string };
                if (!response.ok || !data.task) throw new Error(data.error || `读取 H3 运行失败（HTTP ${response.status}）`);
                return data.task;
            },
            cancelCanvasH3Task: async (taskId) => {
                const response = await fetch(`${getBackendUrl()}${canvasTaskActionPath(taskId, "cancel")}?token=${encodeURIComponent(getBackendTokenShared())}`, { method: "POST" });
                const data = await response.json() as { task?: import("@/types/canvas-plugin").LocalH3Task; error?: string };
                if (!response.ok || !data.task) throw new Error(data.error || `取消 H3 运行失败（HTTP ${response.status}）`);
                return data.task;
            },
            restoreH3Output: async (input) => {
                const project = getProject();
                if (!project) throw new Error("画布已关闭，无法还原历史输出");
                const node = project.nodes.find(node => node.id === input.nodeId);
                if (!node) throw new Error("目标 H3 节点已不存在，请刷新后重新选择");
                if (requestFormalH3OutputSelection(projectId, node, input)) return;
                await applyBackendCanvasOperations(projectId, [{ type: "restore_h3_output", ...input }], Number(project.revision || 0));
            },
            runVideoConcat: async (videos, options) => {
                const { endpoint, token } = resolveBackendAgentEndpoint();
                return runVideoConcatTask(endpoint, token, videos, options?.signal);
            },
            listLocalH3Models: async () => {
                const result = await fetchComfyModels(getBackendUrl(), getBackendTokenShared());
                return { models: result.data?.models || [], loras: result.data?.loras || [], textEncoders: result.data?.textEncoders || [], videoVaes: result.data?.videoVaes || [], audioVaes: result.data?.audioVaes || [], latentUpscaleModels: result.data?.latentUpscaleModels || [], nanfeng: result.data?.nanfeng || {} };
            },
            // List configured models for a capability; labels use the model name without the channel prefix.
            listModels: (capability) => selectableModelsByCapability(effectiveConfig, capability as ModelCapability | undefined).map((value) => ({ value, label: decodeChannelModel(value)?.model || value })),
            defaultModel: (capability) => buildGenerationConfig(effectiveConfig, undefined, capability).model,
            describeVideoModel: async (model: string, referenceCount: number): Promise<CanvasVideoModelSchema> => {
                const resolved = resolveModelWorkflow(effectiveConfig, model, referenceCount);
                const decoded = decodeChannelModel(model);
                const modelName = decoded?.model || model;
                const channel = effectiveConfig.channels.find((item) => decoded?.channelId ? item.id === decoded.channelId : item.models.some((candidate) => candidate.name === modelName));
                const declaration = channel?.models.find((candidate) => candidate.name === modelName);
                if (resolved) {
                    const detail = await fetchWorkflowDetail(resolved);
                    return { model, kind: "workflow", workflow: resolved, supported: true, fields: detail.config?.fields || [], defaultValues: resolveModelWorkflowParams(effectiveConfig, model, referenceCount) };
                }
                const fallback = declaration?.workflows?.[0];
                if (fallback) {
                    const detail = await fetchWorkflowDetail(fallback);
                    return { model, kind: "workflow", workflow: fallback, supported: false, fields: detail.config?.fields || [], error: `该视频模型不支持当前输入数量（${referenceCount} 个参考）` };
                }
                if (channel?.kind !== "comfyui" && declaration?.capability === "video") return {
                    model, kind: "direct", supported: true, fields: [
                        { id: "seconds", name: "时长（秒）", type: "number", default: 6, min: 1, max: 20, step: 1 },
                        { id: "size", name: "视频尺寸", type: "text", default: "1280x720" },
                        { id: "resolution", name: "清晰度", type: "text", default: "720p" },
                    ],
                };
                return { model, kind: "unsupported", supported: false, fields: [], error: `当前输入模式没有可用的视频模型工作流（${referenceCount} 个参考）` };
            },
        };
    }, [effectiveConfig, generationLogs, isAiConfigReady, openConfigDialog, projectId, t]);

    const pluginHost = useMemo<CanvasPluginHost>(
        () => ({
            projectId,
            mediaUrl: backendMediaUrl,
            ...graphAccess,
            updateNode: (nodeId, patch) => {
                setNodes((nodes) => {
                    const next = nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node));
                    nodesRef.current = next;
                    return next;
                });
            },
            updateMetadata: (nodeId, patch) => {
                setNodes((nodes) => {
                    const next = nodes.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node));
                    nodesRef.current = next;
                    return next;
                });
            },
            applyOps: (ops) => applyAgentOps(ops),
            flush: () => flushCanvasProjectBeforeGeneration(projectId),
            ai: pluginAi,
            h3Defaults,
            references,
            openPanel: (nodeId) => setDialogNodeId(nodeId),
            closePanel: () => setDialogNodeId(null),
            openAssetPicker,
            openMediaPreview,
            generationLogs,
        }),
        [applyAgentOps, generationLogs, graphAccess, h3Defaults, openAssetPicker, openMediaPreview, pluginAi, projectId, references, setNodes],
    );

    const renderPluginPanel = useCallback(
        (panelNode: CanvasNodeData) => {
            const Panel = getNodeDefinition(panelNode.type)?.Panel;
            if (!Panel) return null;
            const ctx = buildNodeContext(pluginHost, panelNode, theme, viewportRef.current.k);
            return <Panel ctx={ctx} onClose={() => setDialogNodeId(null)} />;
        },
        [pluginHost, theme],
    );

    // Build the node toolbar from plugin items and a host-provided interaction/move toggle when enabled.
    const buildNodeToolbarItems = useCallback(
        (node: CanvasNodeData): CanvasNodeToolbarItem[] => {
            const definition = getNodeDefinition(node.type);
            const ctx = buildNodeContext(pluginHost, node, theme, viewportRef.current.k);
            const custom = definition?.toolbar?.(ctx) || [];
            // Show the interaction/move toggle only for nodes with content that are not forced into an interactive state.
            if (!definition?.interactionToggle || !node.metadata?.content || definition.forceInteractive?.(node, ctx.view.getSnapshot())) return custom;
            const interactive = Boolean(node.metadata?.interactive);
            const toggle: CanvasNodeToolbarItem = {
                id: "node-interaction-toggle",
                title: t(interactive ? "canvas.plugins.interactiveTitle" : "canvas.plugins.movableTitle"),
                label: t(interactive ? "canvas.plugins.move" : "canvas.plugins.interact"),
                icon: interactive ? "✋" : "🖐",
                active: interactive,
                onClick: () => pluginHost.updateMetadata(node.id, { interactive: !interactive }),
            };
            return [toggle, ...custom];
        },
        [pluginHost, t, theme],
    );

    // Load installed remote plugins on startup.
    // 布局快照（layout）随默认参数一起存在 Backend，但它是视图设置：下行必须原样喂给插件
    // （插件缓存里读默认布局，生成参数读取时自行剥掉 layout），只有「老 localStorage 参数
    // 上迁」这条上行路径要剥，避免把本地布局写进生成参数集合。
    const stripLayout = (settings: Record<string, unknown>): Record<string, unknown> => {
        const { layout: _layout, ...rest } = settings;
        return rest;
    };
    useEffect(() => {
        let active = true;
        void (async () => {
            const version = ++defaultLoadVersion.current;
            const raw = localStorage.getItem("minimax-h3-default-params");
            const local = raw ? (() => { try { const parsed = JSON.parse(raw) as { settings?: Record<string, unknown> }; return parsed.settings || {}; } catch { return {}; } })() : {};
            const remote = await h3Defaults.get();
            if (!active || version !== defaultLoadVersion.current) return;
            if (Object.keys(remote).length) {
                window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: remote }));
                if (raw) localStorage.removeItem("minimax-h3-default-params");
            } else if (Object.keys(stripLayout(local)).length) {
                const migrated = await h3Defaults.set(stripLayout(local));
                if (!active) return;
                window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: migrated }));
                localStorage.removeItem("minimax-h3-default-params");
            } else {
                window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: {} }));
            }
        })().catch(error => console.error("H3 默认参数尚未读取，保留原设置与迁移数据", error));
        void ensurePluginsLoaded();
        const readDefaults = async () => {
            const version = ++defaultLoadVersion.current;
            try {
                const settings = await h3Defaults.get();
                if (active && version === defaultLoadVersion.current) window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: settings }));
            } catch (error) { console.error("H3 默认参数更新尚未确认，保留上次读取值", error); }
        };
        const reloadPlugins = () => { void ensurePluginsLoaded(); void readDefaults(); };
        const refreshH3Defaults = (event: Event) => {
            const detail = (event as CustomEvent<{ type?: string; entityId?: string }>).detail;
            if (detail?.type !== "settings.updated" || detail.entityId !== "plugin:minimax-h3:defaults:v1") return;
            void readDefaults();
        };
        window.addEventListener("backend-connected", reloadPlugins);
        window.addEventListener("backend-event", refreshH3Defaults);
        return () => { active = false; window.removeEventListener("backend-connected", reloadPlugins); window.removeEventListener("backend-event", refreshH3Defaults); };
    }, [h3Defaults]);

    return { pluginHost, renderPluginPanel, buildNodeToolbarItems };
}
