import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasGraphIndex, characterReferenceKey, getGenerationResourceNodes, getGroupResourceNodes, isCanvasReferenceNode, nodeResourceItems, type CanvasCharacterReferenceSelection, type CanvasGraphIndex } from "@/lib/canvas/canvas-resource-references";

export type CanvasLoopRuntimeContext = {
    index: number;
    total: number;
    nodeId?: string;
    signal?: AbortSignal;
};

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    title: string;
    children: NodeGenerationResourceInput[];
};

export type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections, index, loopContext);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim()) && (sourceNode.metadata?.smart !== true || /@\[node:[^\]]+\]/.test(prompt))) {
        return buildComposerGenerationContext(inputs, prompt);
    }

    const resourceInputs = flattenGenerationInputs(inputs);
    let textIndex = 0;
    const upstreamText = resourceInputs.flatMap((input) => (input.text ? [textBlock(generationLabel("text", textIndex++), input.text)] : [])).join("\n\n");
    const referenceImages = resourceInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            const labels = flattenGenerationInputs([input]).map((resource) => {
                let label = labelByNodeId.get(resource.nodeId);
                if (!label) {
                    label = generationLabel(resource.type, counts[resource.type]++);
                    labelByNodeId.set(resource.nodeId, label);
                    if (resource.type === "text") textBlocks.push(textBlock(label, resource.text || ""));
                    else selectedInputs.push(resource);
                }
                return resource.type === "text" ? `【${label}】` : label;
            });
            nextPrompt += labels.join("、");
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext): NodeGenerationInput[] {
    const targetNode = nodes.find((node) => node.id === nodeId);
    const characterSelections = targetNode?.metadata?.characterReferences || {};
    return getGenerationResourceNodes(nodeId, nodes, connections, index).flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes, index).flatMap((child) => readNodeGenerationResource(child, characterSelections[child.id], nodes, connections, index, loopContext));
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return readNodeGenerationResource(node, characterSelections[node.id], nodes, connections, index, loopContext);
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => {
        const media = input.type === "image" ? input.image?.storageKey || input.image?.dataUrl : input.type === "video" ? input.video?.storageKey || input.video?.url : input.type === "audio" ? input.audio?.storageKey || input.audio?.url : input.text;
        return [`${input.nodeId}:${input.type}:${media || ""}`, input];
    })).values()];
}

function readNodeGenerationResource(node: CanvasNodeData, characterSelection?: CanvasCharacterReferenceSelection, nodes?: CanvasNodeData[], connections?: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext, visited = new Set<string>()): NodeGenerationResourceInput[] {
    if (node.type === CanvasNodeType.Loop && nodes && connections) return readLoopGenerationResources(node, nodes, connections, index, loopContext, visited);
    if (node.type === CanvasNodeType.Character) return readCharacterGenerationResources(node, characterSelection);
    if (node.type === CanvasNodeType.Scene) return readSceneGenerationResources(node);
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image", title: node.title, image }];
    const video = readReferenceVideo(node);
    if (video) return [{ nodeId: node.id, type: "video", title: node.title, video }];
    const audio = readReferenceAudio(node);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.title, audio }];
    const resources = nodeResourceItems(node);
    if (resources.length) return resources.flatMap((item): NodeGenerationResourceInput[] => {
        if (item.kind === "image" && item.url) return [{ nodeId: node.id, type: "image" as const, title: node.title, image: { id: `${node.id}-${item.url}`, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: item.url, storageKey: item.storageKey || node.metadata?.storageKey } }];
        if (item.kind === "video" && item.url) return [{ nodeId: node.id, type: "video" as const, title: node.title, video: { id: `${node.id}-${item.url}`, name: `${node.title || node.id}.mp4`, type: node.metadata?.mimeType || "video/mp4", url: item.url, storageKey: item.storageKey || node.metadata?.storageKey } }];
        if (item.kind === "audio" && item.url) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio: { id: `${node.id}-${item.url}`, name: `${node.title || node.id}.mp3`, type: node.metadata?.mimeType || "audio/mpeg", url: item.url, storageKey: item.storageKey || node.metadata?.storageKey } }];
        if (item.kind === "text" && item.text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text: item.text }];
        return [];
    });
    const text = readNodeTextInput(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
}

function readSceneGenerationResources(node: CanvasNodeData): NodeGenerationResourceInput[] {
    const image = node.metadata?.sceneImage;
    if (!image?.url && !image?.storageKey) return [];
    return [{
        nodeId: node.id,
        type: "image",
        title: `${node.title} · 场景图`,
        image: { id: `${node.id}-场景图`, name: image.name || `${node.title || node.id}.png`, type: image.mimeType || "image/png", dataUrl: image.url || "", storageKey: image.storageKey },
    }];
}

function readLoopGenerationResources(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], index: CanvasGraphIndex | undefined, loopContext: CanvasLoopRuntimeContext | undefined, visited: Set<string>): NodeGenerationResourceInput[] {
    if (visited.has(node.id)) return [];
    const nextVisited = new Set(visited).add(node.id);
    const resolvedIndex = index || buildCanvasGraphIndex(nodes, connections);
    const metadata = node.metadata || {};
    const incoming = (resolvedIndex.incomingByNodeId.get(node.id) || []).filter((source) => isCanvasReferenceNode(source, nodes, resolvedIndex));
    const sourceInputs = incoming.flatMap((source) => source.type === CanvasNodeType.Group
        ? getGroupResourceNodes(source.id, nodes, resolvedIndex).flatMap((child) => readNodeGenerationResource(child, undefined, nodes, connections, resolvedIndex, loopContext, nextVisited))
        : readNodeGenerationResource(source, undefined, nodes, connections, resolvedIndex, loopContext, nextVisited));
    const iteration = Math.max(0, loopContext?.index || 0);
    const start = Math.max(0, Math.floor(metadata.loopStart || 1) - 1) + iteration;
    const promptItems = sourceInputs.filter((input) => input.type === "text");
    const imageItems = sourceInputs.filter((input) => input.type === "image");
    const videoItems = sourceInputs.filter((input) => input.type === "video");
    const result: NodeGenerationResourceInput[] = [];

    if (metadata.loopPromptEnabled) {
        const prompt = renderLoopPrompt(metadata.loopPrompt || "", iteration, loopContext?.total || Math.max(1, metadata.loopCount || 1));
        const selected = prompt || (promptItems.length ? promptItems[start % promptItems.length].text : "");
        if (selected) result.push({ nodeId: node.id, type: "text", title: node.title, text: selected });
    }
    if (metadata.loopImageEnabled) result.push(...selectLoopBatch(imageItems, start, metadata.loopImageBatchSize || 1));
    if (metadata.loopVideoEnabled) result.push(...selectLoopBatch(videoItems, start, metadata.loopVideoBatchSize || 1));
    return result;
}

function selectLoopBatch<T extends NodeGenerationResourceInput>(items: T[], index: number, batchSize: number) {
    if (!items.length) return [];
    if (items.length === 1) return [items[0]];
    const size = Math.max(1, Math.min(20, Math.floor(batchSize) || 1));
    const start = (index * size) % items.length;
    return Array.from({ length: Math.min(size, items.length) }, (_, offset) => items[(start + offset) % items.length]);
}

function renderLoopPrompt(prompt: string, index: number, total: number) {
    return prompt
        .replaceAll("《计数》", String(index + 1))
        .replaceAll("《总数》", String(total))
        .replaceAll("《进度》", `${index + 1}/${total}`)
        .replaceAll("{{count}}", String(index + 1))
        .replaceAll("{{total}}", String(total))
        .replaceAll("{{progress}}", `${index + 1}/${total}`)
        .trim();
}

function readCharacterGenerationResources(node: CanvasNodeData, selection?: CanvasCharacterReferenceSelection): NodeGenerationResourceInput[] {
    const images = node.metadata?.characterImages || [];
    const primaryIndex = Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), Math.max(images.length - 1, 0));
    const primaryImage = images[primaryIndex];
    const selectedKeys = new Set(selection?.imageKeys || (primaryImage ? [characterReferenceKey(primaryImage, primaryIndex)] : []));
    const imageInputs = images.flatMap((image, index): NodeGenerationResourceInput[] => {
        if (!image.url || !selectedKeys.has(characterReferenceKey(image, index))) return [];
        return [{
            nodeId: node.id,
            type: "image",
            title: image.outfit || image.name || node.title,
            image: {
                id: `${node.id}-image-${index}`,
                name: image.name || `${node.title || node.id}-${index + 1}.png`,
                type: image.mimeType || "image/png",
                dataUrl: image.url,
                storageKey: image.storageKey,
            },
        }];
    });
    const voiceUrl = node.metadata?.characterVoiceUrl;
    const voiceStorageKey = node.metadata?.characterVoiceStorageKey;
    if (selection?.voiceEnabled === false || (!voiceUrl && !voiceStorageKey)) return imageInputs;
    return [...imageInputs, {
        nodeId: node.id,
        type: "audio",
        title: node.metadata?.characterVoiceName || `${node.title || node.id} · 声线`,
        audio: {
            id: `${node.id}-voice`,
            name: node.metadata?.characterVoiceName || `${node.title || node.id}.mp3`,
            type: "audio/mpeg",
            url: voiceUrl || "",
            storageKey: voiceStorageKey,
        },
    }];
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function textBlock(label: string, text: string) {
    return `【${label}】\n${text}`;
}

function generationLabel(type: NodeGenerationResourceInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
