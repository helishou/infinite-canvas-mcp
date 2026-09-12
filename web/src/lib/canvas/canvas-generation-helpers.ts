import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { referenceUrl } from "@/lib/canvas/canvas-node-factory";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content;
            const hydrateH3Ref = async <T extends { url?: string; dataUrl?: string; storageKey?: string; type?: string }>(ref: T) => {
                const fallback = ref.url || ref.dataUrl || "";
                if (!ref.storageKey) {
                    if (!/^blob:|^data:/i.test(fallback)) return ref;
                    try {
                        const stored = await uploadImage(fallback);
                        return { ...ref, url: stored.url, ...(ref.dataUrl !== undefined ? { dataUrl: stored.url } : {}), storageKey: stored.storageKey };
                    } catch {
                        return ref;
                    }
                }
                const url = ref.type?.startsWith("image") || ref.dataUrl !== undefined
                    ? await resolveImageUrl(ref.storageKey, fallback)
                    : await resolveMediaUrl(ref.storageKey, fallback);
                return { ...ref, url, ...(ref.dataUrl !== undefined ? { dataUrl: url } : {}) };
            };
            const extendedMetadata = metadata as (CanvasNodeMetadata & Record<string, unknown>) | undefined;
            const isH3Node = Boolean(extendedMetadata && (node.type === CanvasNodeType.Video || node.type === "minimax-h3:video" || Array.isArray(extendedMetadata.segments) || (extendedMetadata.h3Refs && typeof extendedMetadata.h3Refs === "object")));
            if (isH3Node && extendedMetadata) {
                const segments = Array.isArray(extendedMetadata.segments) ? await Promise.all(extendedMetadata.segments.map(async (segment: unknown) => {
                    if (!segment || typeof segment !== "object") return segment;
                    const value = segment as Record<string, unknown>;
                    const refs = Array.isArray(value.refItems) ? await Promise.all(value.refItems.map((ref) => ref && typeof ref === "object" ? hydrateH3Ref(ref as { url?: string; dataUrl?: string; storageKey?: string; type?: string }) : ref)) : value.refItems;
                    const grouped = value.refs && typeof value.refs === "object" ? Object.fromEntries(await Promise.all(Object.entries(value.refs as Record<string, unknown>).map(async ([kind, list]) => [kind, Array.isArray(list) ? await Promise.all(list.map((ref) => ref && typeof ref === "object" ? hydrateH3Ref({ ...(ref as Record<string, unknown>), type: kind } as { url?: string; dataUrl?: string; storageKey?: string; type?: string }) : ref)) : list]))) : value.refs;
                    const result = typeof value.result === "string" && value.resultStorageKey
                        ? await resolveMediaUrl(String(value.resultStorageKey), value.result)
                        : value.result;
                    const results = Array.isArray(value.results)
                        ? await Promise.all(value.results.map((item) => item && typeof item === "object" ? hydrateH3Ref({ ...(item as Record<string, unknown>), type: "video" } as { url?: string; dataUrl?: string; storageKey?: string; type?: string }) : item))
                        : value.results;
                    return { ...value, ...(Array.isArray(refs) ? { refItems: refs } : {}), ...(grouped ? { refs: grouped } : {}), ...(result !== undefined ? { result } : {}), ...(Array.isArray(results) ? { results } : {}) };
                })) : extendedMetadata.segments;
                const h3Refs = extendedMetadata.h3Refs && typeof extendedMetadata.h3Refs === "object" ? Object.fromEntries(await Promise.all(Object.entries(extendedMetadata.h3Refs as Record<string, unknown>).map(async ([kind, list]) => [kind, Array.isArray(list) ? await Promise.all(list.map((ref) => ref && typeof ref === "object" ? hydrateH3Ref({ ...(ref as Record<string, unknown>), type: kind } as { url?: string; dataUrl?: string; storageKey?: string; type?: string }) : ref)) : list]))) : extendedMetadata.h3Refs;
                const materials = Array.isArray(extendedMetadata.materials)
                    ? await Promise.all(extendedMetadata.materials.map((item) => item && typeof item === "object" ? hydrateH3Ref({ ...(item as Record<string, unknown>), type: "video" } as { url?: string; dataUrl?: string; storageKey?: string; type?: string }) : item))
                    : extendedMetadata.materials;
                const outputContent = extendedMetadata.storageKey
                    ? await resolveMediaUrl(String(extendedMetadata.storageKey), content || "")
                    : content;
                return { ...node, metadata: { ...metadata, ...(outputContent !== undefined ? { content: outputContent } : {}), ...(Array.isArray(segments) ? { segments } : {}), ...(h3Refs ? { h3Refs } : {}), ...(Array.isArray(materials) ? { materials } : {}) } };
            }
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && metadata?.storageKey) return { ...node, metadata: { ...metadata, content: await resolveMediaUrl(metadata.storageKey, content) } };
            if (node.type !== CanvasNodeType.Image || !metadata) return node;

            const hydrateImage = async <T extends { content?: string; storageKey?: string; mimeType?: string; bytes?: number; naturalWidth?: number | null; naturalHeight?: number | null }>(image: T): Promise<T> => {
                const raw = image.content || "";
                if (!raw && !image.storageKey) return image;
                const resolved = await resolveImageUrl(image.storageKey, raw);
                if (!resolved) return image;
                if (resolved === raw && !raw.startsWith("data:image/")) return image;
                if (image.storageKey) return { ...image, content: resolved };

                // 历史 MCP 节点保存过 ComfyUI /view 临时地址。首次打开时把它落到总后台媒体库，
                // 后续节点只使用稳定的 storageKey，不再依赖 ComfyUI 临时文件。
                if (resolved !== raw || raw.startsWith("data:image/")) {
                    try {
                        const stored = await uploadImage(resolved, { category: "library" });
                        return { ...image, content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes, naturalWidth: stored.width, naturalHeight: stored.height };
                    } catch {
                        return { ...image, content: resolved };
                    }
                }
                return { ...image, content: resolved };
            };

            const hydratedRoot = content ? await hydrateImage({ content, storageKey: metadata.storageKey, mimeType: metadata.mimeType, bytes: metadata.bytes, naturalWidth: metadata.naturalWidth, naturalHeight: metadata.naturalHeight }) : null;
            const images = await Promise.all((metadata.images || []).map((image) => hydrateImage(image)));
            const rootChanged = Boolean(hydratedRoot && (hydratedRoot.content !== content || hydratedRoot.storageKey !== metadata.storageKey || hydratedRoot.mimeType !== metadata.mimeType || hydratedRoot.bytes !== metadata.bytes || hydratedRoot.naturalWidth !== metadata.naturalWidth || hydratedRoot.naturalHeight !== metadata.naturalHeight));
            const hasImageChanges = images.some((image, index) => image !== metadata.images?.[index]);
            if (!rootChanged && !hasImageChanges) return node;
            return {
                ...node,
                metadata: {
                    ...metadata,
                    ...(rootChanged && hydratedRoot ? { ...hydratedRoot } : {}),
                    ...(metadata.images ? { images } : {}),
                },
            };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    const resources = [...new Map(inputs.flatMap((input) => (input.type === "group" ? input.children : [input])).map((input) => [input.nodeId, input])).values()];
    return {
        textCount: resources.filter((input) => input.type === "text").length,
        imageCount: resources.filter((input) => input.type === "image").length,
        videoCount: resources.filter((input) => input.type === "video").length,
        audioCount: resources.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.count || config.canvasImageCount : config.count) || defaultConfig.count),
    };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    // 之前会把「loading 但前端没拿到 runtimeTaskId」的节点直接判成 error 并提示
    // 「页面刷新后生成已中断」。但生成是后端跑的，刷新瞬间 / 网络抖动 / 用户提前切走
    // 都可能让前端没拿到 ID，**后端任务大概率还在跑**——此时把节点标为 error 会让用户
    // 误以为失败、并误点「重试」触发第二次任务，占用 ComfyUI 队列还可能写出覆盖。现改为
    // 清回 idle，让用户按需手动重新触发；带 runtimeTaskId 的节点交给 project.tsx 的
    // 轮询恢复逻辑继续等后端结果。
    return nodes.map((node) => {
        if (node.metadata?.status !== "loading" || node.metadata.runtimeTaskId || isPersistentH3Node(node)) return node;
        const { runtimeTaskId: _runtimeTaskId, errorDetails: _errorDetails, ...rest } = node.metadata;
        return {
            ...node,
            metadata: {
                ...rest,
                status: "idle" as const,
                images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "idle" as const, errorDetails: undefined } : image)),
                texts: node.metadata.texts?.map((text) => (text.status === "loading" ? { ...text, status: "idle" as const, errorDetails: undefined } : text)),
            },
        };
    });
}

function isPersistentH3Node(node: CanvasNodeData) {
    const metadata = node.metadata as (CanvasNodeMetadata & Record<string, unknown>) | undefined;
    return Boolean(metadata && (node.type === "minimax-h3:video" || Array.isArray(metadata.segments) || (metadata.h3Refs && typeof metadata.h3Refs === "object")));
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}
