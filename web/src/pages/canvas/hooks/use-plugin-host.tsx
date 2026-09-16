import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { getLocalH3Task, getRunningHubH3Task, resolveBackendAgentEndpoint, runVideoConcatTask } from "@/services/api/comfyui";
import { fetchComfyModels } from "@/services/api/canvas-agent";
import { createBackendGenerationLog, deleteBackendGenerationLogs, fetchBackendGenerationLogs, getBackendUrl, startCanvasGeneration, updateBackendGenerationLog } from "@/services/backend-api";
import { getBackendTokenShared } from "@/lib/backend-token";
import { canvasTaskActionPath, canvasTaskPath } from "@basketikun/canvas-agent/generation-api";
import { decodeChannelModel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { ensurePluginsLoaded } from "@/lib/canvas/plugin-loader";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAssetPickerImage, CanvasGenerationCommand, CanvasGenerationLogs, CanvasNodeToolbarItem, CanvasPluginAi, CanvasPluginHost } from "@/types/canvas-plugin";
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
    const { projectId, updateProject, effectiveConfig, isAiConfigReady, openConfigDialog, theme, nodesRef, connectionsRef, viewportRef, setNodes, setDialogNodeId, openAssetPicker, applyAgentOps } = params;
    const generationLogs = useMemo<CanvasGenerationLogs>(() => {
        return {
            list: async (options: Parameters<CanvasGenerationLogs["list"]>[0] = {}) => { const result = await fetchBackendGenerationLogs({ ...options, projectId: options.projectId || projectId }); return result.logs || []; },
            create: async (input: any) => { const result = await createBackendGenerationLog({ ...input, projectId: input.projectId || projectId }); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            update: async (id: string, patch: any) => { const result = await updateBackendGenerationLog(id, patch); if (!result.log) throw new Error("总后台未返回生成日志"); return result.log; },
            remove: async (options: any) => { const result = await deleteBackendGenerationLogs(options); return Number(result.deleted || 0); },
        };
    }, [projectId]);
    const h3Defaults = useMemo(() => ({
        get: async () => {
            const response = await fetch(`${getBackendUrl()}/plugins/minimax-h3/defaults?token=${encodeURIComponent(getBackendTokenShared())}`);
            if (!response.ok) throw new Error(`读取 H3 默认参数失败（HTTP ${response.status}）`);
            const data = await response.json() as { defaults?: Record<string, unknown> | null };
            return data.defaults || {};
        },
        set: async (settings: Record<string, unknown>) => {
            const response = await fetch(`${getBackendUrl()}/plugins/minimax-h3/defaults?token=${encodeURIComponent(getBackendTokenShared())}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
            if (!response.ok) throw new Error(`保存 H3 默认参数失败（HTTP ${response.status}）`);
            return ((await response.json()) as { defaults?: Record<string, unknown> }).defaults || settings;
        },
        reset: async () => {
            const response = await fetch(`${getBackendUrl()}/plugins/minimax-h3/defaults?token=${encodeURIComponent(getBackendTokenShared())}`, { method: "DELETE" });
            if (!response.ok) throw new Error(`重置 H3 默认参数失败（HTTP ${response.status}）`);
            window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: {} }));
        },
    }), []);

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
            runCanvasGeneration: async (command: CanvasGenerationCommand) => {
                const data = await startCanvasGeneration(command);
                if (!data.task) throw new Error("画布生成失败：Backend 未返回任务");
                return data.task;
            },
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
            runVideoConcat: async (videos, options) => {
                const { endpoint, token } = resolveBackendAgentEndpoint();
                return runVideoConcatTask(endpoint, token, videos, options?.signal);
            },
            listLocalH3Models: async () => {
                const result = await fetchComfyModels(getBackendUrl(), getBackendTokenShared());
                return { models: result.data?.models || [], loras: result.data?.loras || [], textEncoders: result.data?.textEncoders || [], videoVaes: result.data?.videoVaes || [], audioVaes: result.data?.audioVaes || [], latentUpscaleModels: result.data?.latentUpscaleModels || [], nanfeng: result.data?.nanfeng || {} };
            },
            getRunningHubH3Task: async (taskId) => {
                const task = await getRunningHubH3Task(getBackendUrl(), getBackendTokenShared(), taskId) as Awaited<ReturnType<typeof getRunningHubH3Task>>;
                if (task.status === "succeeded" && task.result?.url && !task.result.storageKey) {
                    return { ...task, result: await persistH3Result(task.result) };
                }
                return task;
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
            h3Defaults,
            openPanel: (nodeId) => setDialogNodeId(nodeId),
            closePanel: () => setDialogNodeId(null),
            openAssetPicker,
            generationLogs,
        }),
        [applyAgentOps, generationLogs, h3Defaults, openAssetPicker, pluginAi, projectId, updateProject],
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
    // v2 布局快照（layout）只存浏览器镜像：后端默认参数是生成参数集合，
    // 上行同步/下行回写都必须剥掉 layout，避免布局混进生成参数。
    const stripLayout = (settings: Record<string, unknown>): Record<string, unknown> => {
        const { layout: _layout, ...rest } = settings;
        return rest;
    };
    useEffect(() => {
        void (async () => {
            const raw = localStorage.getItem("minimax-h3-default-params");
            const local = raw ? (() => { try { const parsed = JSON.parse(raw) as { settings?: Record<string, unknown> }; return parsed.settings || {}; } catch { return {}; } })() : {};
            const remote = await h3Defaults.get().catch(() => ({}));
            if (Object.keys(remote).length) {
                window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: stripLayout(remote) }));
                if (raw) localStorage.removeItem("minimax-h3-default-params");
            } else if (Object.keys(stripLayout(local)).length) {
                const migrated = await h3Defaults.set(stripLayout(local));
                window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: stripLayout(migrated) }));
                localStorage.removeItem("minimax-h3-default-params");
            }
        })();
        void ensurePluginsLoaded();
        const reloadPlugins = () => void ensurePluginsLoaded();
        const refreshH3Defaults = (event: Event) => {
            const detail = (event as CustomEvent<{ type?: string; entityId?: string }>).detail;
            if (detail?.type !== "settings.updated" || detail.entityId !== "plugin:minimax-h3:defaults:v1") return;
            void h3Defaults.get().then((settings) => window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: stripLayout(settings) })));
        };
        window.addEventListener("backend-connected", reloadPlugins);
        window.addEventListener("backend-event", refreshH3Defaults);
        return () => { window.removeEventListener("backend-connected", reloadPlugins); window.removeEventListener("backend-event", refreshH3Defaults); };
    }, [h3Defaults]);

    return { pluginHost, renderPluginPanel, buildNodeToolbarItems };
}
