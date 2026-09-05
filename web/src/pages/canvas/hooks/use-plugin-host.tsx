import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { runLocalH3Task, getLocalH3Task, cancelLocalH3Task, runRunningHubH3Task, getRunningHubH3Task, cancelRunningHubH3Task, runVideoConcatTask } from "@/services/api/comfyui";
import { fetchComfyModels, fetchComfyStatus } from "@/services/api/canvas-agent";
import { createBackendGenerationLog, deleteBackendGenerationLogs, fetchBackendGenerationLogs, getBackendUrl, updateBackendGenerationLog } from "@/services/backend-api";
import { getBackendTokenShared } from "@/lib/backend-token";
import { useAgentStore } from "@/stores/use-agent-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { decodeChannelModel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { ensurePluginsLoaded } from "@/lib/canvas/plugin-loader";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAssetPickerImage, CanvasGenerationLogs, CanvasNodeToolbarItem, CanvasPluginAi, CanvasPluginHost } from "@/types/canvas-plugin";
import type { ReferenceImage } from "@/types/image";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type PluginHostParams = {
    projectId: string;
    updateProject: (id: string, patch: { nodes?: CanvasNodeData[] }) => void;
    effectiveConfig: AiConfig;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (open: boolean) => void;
    theme: CanvasTheme;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    viewportRef: MutableRefObject<ViewportTransform>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    openAssetPicker: (options?: { kind?: "image" }) => Promise<CanvasAssetPickerImage | null>;
    applyAgentOps: (ops?: CanvasAgentOp[]) => unknown;
};

async function persistH3Result(result: Awaited<ReturnType<typeof runLocalH3Task>>) {
    const stored = await storeGeneratedVideo({ url: result.url, mimeType: result.mimeType, width: result.width, height: result.height, durationMs: result.durationMs });
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
    const { projectId, updateProject, effectiveConfig, isAiConfigReady, openConfigDialog, theme, nodesRef, connectionsRef, viewportRef, setNodes, setDialogNodeId, openAssetPicker, applyAgentOps } = params;
    const generationLogs = useMemo<CanvasGenerationLogs>(() => {
        const unavailable = () => { throw new Error("总后台未连接，无法访问生成日志"); };
        return {
            list: async (options: Parameters<CanvasGenerationLogs["list"]>[0] = {}) => { if (!useBackendStore.getState().connected) return []; const result = await fetchBackendGenerationLogs({ ...options, projectId: options.projectId || projectId }); return result.logs || []; },
            create: async (input: any) => { if (!useBackendStore.getState().connected) return unavailable(); const result = await createBackendGenerationLog({ ...input, projectId: input.projectId || projectId }); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            update: async (id: string, patch: any) => { if (!useBackendStore.getState().connected) return unavailable(); const result = await updateBackendGenerationLog(id, patch); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            remove: async (options: any) => { if (!useBackendStore.getState().connected) return unavailable(); const result = await deleteBackendGenerationLogs(options); return Number(result.deleted || 0); },
        };
    }, [projectId]);

    // Host capabilities available to plugin nodes; methods receive nodeId and are not bound to a specific node.
    const pluginAi = useMemo<CanvasPluginAi>(() => {
        // Convert plugin reference images (data URLs or URLs) into the ReferenceImage[] expected by the host generation API.
        const toReferences = (refs?: string[]): ReferenceImage[] => (refs || []).filter(Boolean).map((src, index) => ({ id: `plugin-ref-${index}`, name: `ref-${index}.png`, type: "image/png", dataUrl: src }));
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
                const references = toReferences(options?.references);
                const items = references.length ? await requestEdit(config, prompt, references, { signal: options?.signal }) : await requestGeneration(config, prompt, { signal: options?.signal });
                const images = await Promise.all(items.map(async (item) => {
                    try {
                        return await imageToDataUrl({ dataUrl: item.dataUrl }, { signal: options?.signal });
                    } catch (error) {
                        if (options?.signal?.aborted) throw error;
                        return item.dataUrl;
                    }
                }));
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
                const file = await storeGeneratedVideo(await requestVideoGeneration(config, prompt, toReferences(options?.references), { signal: options?.signal }));
                return { url: file.url, mimeType: file.mimeType, width: file.width, height: file.height, durationMs: file.durationMs };
            },
            generateText: async (prompt, options) => {
                console.log("pluginAi.generateText", { prompt, options });
                const config = { ...buildGenerationConfig(effectiveConfig, undefined, "text"), ...(options?.model ? { model: options.model } : {}) };
                ensureReady(config);
                const content = options?.references?.length
                    ? [{ type: "text" as const, text: prompt }, ...options.references.map((reference) => ({ type: "image_url" as const, image_url: { url: reference.url } }))]
                    : prompt;
                const messages: AiTextMessage[] = [...(options?.system ? [{ role: "system" as const, content: options.system }] : []), { role: "user" as const, content }];
                const text = await requestImageQuestion(config, messages, (delta) => options?.onDelta?.(delta), { signal: options?.signal });
                return { text };
            },
            runLocalH3: async (prompt, input, params, options) => {
                const backendUrl = getBackendUrl();
                const backendToken = getBackendTokenShared();
                if (!(await fetch(`${backendUrl}/health`).then((response) => response.ok).catch(() => false))) throw new Error("总后台未连接，无法运行本地 MiniMax H3");
                const comfy = await fetch(`${backendUrl}/comfy/config?token=${encodeURIComponent(backendToken)}`).then(async (response) => {
                    if (!response.ok) throw new Error(`读取 ComfyUI 配置失败（HTTP ${response.status}）`);
                    return await response.json() as { url?: string };
                });
                if (!comfy.url) throw new Error("尚未配置本地 ComfyUI 地址");
                let comfyStatus;
                try {
                    comfyStatus = await fetchComfyStatus(backendUrl, backendToken);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`无法检查 ComfyUI 状态：${message}`);
                }
                if (comfyStatus.connected !== true) {
                    throw new Error(`ComfyUI 未启动，请先启动 ComfyUI${comfyStatus.url ? `（${comfyStatus.url}）` : ""}`);
                }
                const result = await runLocalH3Task(backendUrl, backendToken, comfy.url, prompt, input, params, options?.signal, options?.onTaskId);
                return persistH3Result(result);
            },
            getLocalH3Task: async (taskId) => {
                const task = await getLocalH3Task(getBackendUrl(), getBackendTokenShared(), taskId) as Awaited<ReturnType<typeof getLocalH3Task>>;
                if (task.status === "succeeded" && task.result?.url && !task.result.storageKey) {
                    return { ...task, result: await persistH3Result(task.result) };
                }
                return task;
            },
            cancelLocalH3Task: async (taskId) => {
                const task = await cancelLocalH3Task(getBackendUrl(), getBackendTokenShared(), taskId);
                return { id: task.id, status: task.status, progress: task.progress, error: task.error, result: null };
            },
            runVideoConcat: async (videos, options) => {
                const agent = useAgentStore.getState();
                if (!agent.connected || !agent.url || !agent.token) throw new Error("Canvas Agent 未连接，无法运行视频拼接");
                const result = await runVideoConcatTask(agent.url, agent.token, videos, options?.signal);
                return result;
            },
            listLocalH3Models: async () => {
                const result = await fetchComfyModels(getBackendUrl(), getBackendTokenShared());
                return { models: result.data?.models || [], loras: result.data?.loras || [], textEncoders: result.data?.textEncoders || [], videoVaes: result.data?.videoVaes || [], audioVaes: result.data?.audioVaes || [], latentUpscaleModels: result.data?.latentUpscaleModels || [], nanfeng: result.data?.nanfeng || {} };
            },
            runRunningHubH3: async (prompt, input, params, options) => {
                const agent = useAgentStore.getState();
                if (!agent.connected || !agent.url || !agent.token) throw new Error("Canvas Agent 未连接，无法运行 RunningHub MiniMax H3");
                const result = await runRunningHubH3Task(agent.url, agent.token, prompt, input, params, options?.signal, options?.onTaskId);
                return persistH3Result(result);
            },
            getRunningHubH3Task: async (taskId) => {
                const agent = useAgentStore.getState();
                if (!agent.connected || !agent.url || !agent.token) throw new Error("Canvas Agent 未连接，无法查询 RunningHub H3 任务");
                const task = await getRunningHubH3Task(agent.url, agent.token, taskId) as Awaited<ReturnType<typeof getRunningHubH3Task>>;
                if (task.status === "succeeded" && task.result?.url && !task.result.storageKey) {
                    return { ...task, result: await persistH3Result(task.result) };
                }
                return task;
            },
            cancelRunningHubH3Task: async (taskId) => {
                const agent = useAgentStore.getState();
                if (!agent.connected || !agent.url || !agent.token) throw new Error("Canvas Agent 未连接，无法取消 RunningHub H3 任务");
                const task = await cancelRunningHubH3Task(agent.url, agent.token, taskId);
                return { id: task.id, status: task.status, progress: task.progress, error: task.error, result: null };
            },
            // List configured models for a capability; labels use the model name without the channel prefix.
            listModels: (capability) => selectableModelsByCapability(effectiveConfig, capability as ModelCapability | undefined).map((value) => ({ value, label: decodeChannelModel(value)?.model || value })),
            defaultModel: (capability) => buildGenerationConfig(effectiveConfig, undefined, capability).model,
        };
    }, [effectiveConfig, isAiConfigReady, openConfigDialog, t]);

    const pluginHost = useMemo<CanvasPluginHost>(
        () => ({
            projectId,
            getNode: (id) => nodesRef.current.find((node) => node.id === id) || null,
            getNodes: () => nodesRef.current,
            getConnections: () => connectionsRef.current,
            getUpstream: (nodeId) =>
                connectionsRef.current
                    .filter((conn) => conn.toNodeId === nodeId)
                    .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                    .filter((node): node is CanvasNodeData => Boolean(node)),
            getDownstream: (nodeId) =>
                connectionsRef.current
                    .filter((conn) => conn.fromNodeId === nodeId)
                    .map((conn) => nodesRef.current.find((node) => node.id === conn.toNodeId))
                    .filter((node): node is CanvasNodeData => Boolean(node)),
            updateNode: (nodeId, patch) => {
                const nextNodes = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, ...patch } : node));
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
                updateProject(projectId, { nodes: nextNodes });
            },
            updateMetadata: (nodeId, patch) => {
                const nextNodes = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node));
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
                updateProject(projectId, { nodes: nextNodes });
            },
            applyOps: (ops) => applyAgentOps(ops),
            ai: pluginAi,
            openPanel: (nodeId) => setDialogNodeId(nodeId),
            closePanel: () => setDialogNodeId(null),
            openAssetPicker,
            generationLogs,
        }),
        [applyAgentOps, generationLogs, openAssetPicker, pluginAi, projectId, updateProject],
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
            if (!definition?.interactionToggle || !node.metadata?.content || definition.forceInteractive?.(node)) return custom;
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
    useEffect(() => {
        void ensurePluginsLoaded();
        const reloadPlugins = () => void ensurePluginsLoaded();
        window.addEventListener("backend-connected", reloadPlugins);
        return () => window.removeEventListener("backend-connected", reloadPlugins);
    }, []);

    return { pluginHost, renderPluginPanel, buildNodeToolbarItems };
}
