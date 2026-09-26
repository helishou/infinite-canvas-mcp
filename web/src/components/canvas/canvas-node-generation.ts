import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasGraphIndex, characterReferenceKey, getGenerationResourceNodes, getGroupResourceNodes, isCanvasReferenceNode, nodeResourceItems, type CanvasCharacterReferenceSelection, type CanvasGraphIndex } from "@/lib/canvas/canvas-resource-references";
import { resolveLoopInputPlan } from "@/lib/canvas/canvas-loop-execution";

export type CanvasLoopRuntimeContext = {
    index: number;
    total: number;
    nodeId?: string;
    signal?: AbortSignal;
    roundOutputs?: Map<string, NodeGenerationInput[]>;
    initialNodes?: Map<string, CanvasNodeData>;
    initialConnections?: CanvasConnection[];
    loopOutput?: { loopNodeId: string; roundIndex: number; slotIndex: number; totalRounds?: number; slotNodeId?: string; outputGroupId?: string };
};

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    /** Current loop iteration's image input, kept apart from fixed references. */
    loopInputImages: ReferenceImage[];
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
    const separateLoopImages = Boolean(loopContext?.nodeId && (
        sourceNode?.type === CanvasNodeType.Loop && (sourceNode.metadata?.generationMode || "image") === "image"
        || sourceNode?.type === CanvasNodeType.Image
        || sourceNode?.type === CanvasNodeType.Config && sourceNode.metadata?.smart === true && (sourceNode.metadata.generationMode || "image") === "image"
    ));
    const loopResources = loopContext ? flattenGenerationInputs(inputs.filter((input) => input.nodeId === loopContext.nodeId)) : [];
    const loopImages = loopResources.flatMap((resource) => resource.image ? [resource.image] : []);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim()) && (sourceNode.metadata?.smart !== true || /@\[node:[^\]]+\]/.test(prompt))) {
        const composed = buildComposerGenerationContext(inputs, prompt, separateLoopImages ? loopContext?.nodeId : undefined, separateLoopImages ? loopImages.length : 0);
        if (!loopResources.length) return composed;
        if (separateLoopImages) {
            const loopImageIds = new Set(loopImages.map((image) => image.id));
            composed.referenceImages = composed.referenceImages.filter((image) => !loopImageIds.has(image.id));
            composed.loopInputImages = loopImages;
        }
        const seenImages = new Set(composed.referenceImages.map((image) => image.storageKey || image.dataUrl || image.id));
        for (const resource of loopResources) {
            const image = resource.image;
            if (!image || separateLoopImages) continue;
            const key = image.storageKey || image.dataUrl || image.id;
            if (seenImages.has(key)) continue;
            seenImages.add(key);
            composed.referenceImages.push(image);
        }
        if (loopContext && !prompt.includes(`@[node:${loopContext.nodeId}]`)) {
            const loopTexts = loopResources.flatMap((resource) => resource.text ? [resource.text] : []);
            if (loopTexts.length) {
                composed.prompt = `${composed.prompt}\n\n${loopTexts.join("\n\n")}`;
                composed.textCount += loopTexts.length;
            }
        }
        composed.imageCount = composed.referenceImages.length;
        return composed;
    }

    const resourceInputs = flattenGenerationInputs(inputs);
    const loopInputImages = separateLoopImages ? resourceInputs.flatMap((input) => input.nodeId === loopContext?.nodeId && input.image ? [input.image] : []) : [];
    let textIndex = 0;
    const upstreamText = resourceInputs.flatMap((input) => (input.text ? [textBlock(generationLabel("text", textIndex++), input.text)] : [])).join("\n\n");
    const referenceImages = resourceInputs.flatMap((input) => input.image && !(separateLoopImages && input.nodeId === loopContext?.nodeId) ? [input.image] : []);
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        loopInputImages,
        referenceVideos,
        referenceAudios,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, loopImageNodeId?: string, loopImageCount = 0): NodeGenerationContext {
    const inputByNodeId = new Map<string, NodeGenerationInput[]>();
    for (const input of inputs) inputByNodeId.set(input.nodeId, [...(inputByNodeId.get(input.nodeId) || []), input]);
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const labelByResourceKey = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: loopImageCount, video: 0, audio: 0, text: 0 };
    let loopImageIndex = 0;
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const nodeInputs = inputByNodeId.get(match[1]);
        if (nodeInputs) {
            const labels = flattenGenerationInputs(nodeInputs).map((resource) => {
                const key = `${resource.nodeId}:${resource.type}:${resource.image?.storageKey || resource.image?.dataUrl || resource.video?.storageKey || resource.video?.url || resource.audio?.storageKey || resource.audio?.url || resource.text || ""}`;
                let label = labelByResourceKey.get(key);
                if (!label) {
                    label = resource.type === "image" && resource.nodeId === loopImageNodeId
                        ? generationLabel("image", loopImageIndex++)
                        : generationLabel(resource.type, counts[resource.type]++);
                    labelByResourceKey.set(key, label);
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
            loopInputImages: [],
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
        loopInputImages: [],
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext): NodeGenerationInput[] {
    const resolvedIndex = index || buildCanvasGraphIndex(nodes, connections);
    if (loopContext?.nodeId && (loopContext.loopOutput || loopContext.nodeId === nodeId)) {
        const loopNode = resolvedIndex.nodeById.get(loopContext.nodeId);
        if (loopNode?.type === CanvasNodeType.Loop) {
            return readLoopGenerationResources(loopNode, nodes, connections, resolvedIndex, loopContext, new Set());
        }
    }
    const targetNode = nodes.find((node) => node.id === nodeId);
    const characterSelections = targetNode?.metadata?.characterReferences || {};
    const resourceNodes = getGenerationResourceNodes(nodeId, nodes, connections, index);
    const roundSources = loopContext?.roundOutputs
        ? (index || buildCanvasGraphIndex(nodes, connections)).incomingByNodeId.get(nodeId)?.filter((node) => loopContext.roundOutputs?.has(node.id)) || []
        : [];
    const sources = [...new Map([...resourceNodes, ...roundSources].map((node) => [node.id, node])).values()];
    return sources.flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes, index).flatMap((child) => readNodeGenerationResource(child, characterSelections[child.id], nodes, connections, index, loopContext));
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return readNodeGenerationResource(node, characterSelections[node.id], nodes, connections, index, loopContext);
    });
}

/** Read only links entering the loop, excluding fixed references wired to its downstream generator. */
export function buildLoopSourceInputs(loopNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext, visited = new Set<string>()): NodeGenerationInput[] {
    const buckets = readLoopInputBuckets(loopNodeId, nodes, connections, index, loopContext, visited);
    return [...buckets.prompts, ...buckets.variableMedia];
}

function loopResourcePlan(metadata: CanvasNodeData["metadata"], buckets: ReturnType<typeof readLoopInputBuckets>) {
    const count = (items: NodeGenerationResourceInput[]) => new Set(items.map((item) => item.nodeId)).size;
    return resolveLoopInputPlan(metadata || {}, count(buckets.variableMedia.filter((item) => item.type === "image")),
        count(buckets.variableMedia.filter((item) => item.type === "video")),
        count(buckets.variableMedia.filter((item) => item.type === "audio")), count(buckets.variablePrompts));
}

function roundInputNodeIds(buckets: ReturnType<typeof readLoopInputBuckets>, plan: ReturnType<typeof resolveLoopInputPlan>, iteration: number) {
    const items = plan.mediaKind ? buckets.variableMedia.filter((item) => item.type === plan.mediaKind) : buckets.variablePrompts;
    const ids = [...new Set(items.map((item) => item.nodeId))];
    const position = plan.start - 1 + iteration * plan.batchSize;
    return ids.slice(position, position + plan.batchSize);
}

/** Freeze the same ordered input slots used when each round builds its model request. */
export function buildLoopRunInputPlan(loopNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    const loop = nodes.find((node) => node.id === loopNodeId);
    const buckets = readLoopInputBuckets(loopNodeId, nodes, connections, index);
    const plan = loopResourcePlan(loop?.metadata, buckets);
    return { ...plan, roundInputNodeIds: Array.from({ length: plan.rounds }, (_, iteration) => roundInputNodeIds(buckets, plan, iteration)) };
}

function readLoopInputBuckets(loopNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext, visited = new Set<string>()) {
    const resolvedIndex = index || buildCanvasGraphIndex(nodes, connections);
    const nextVisited = new Set(visited).add(loopNodeId);
    const sources = (resolvedIndex.incomingByNodeId.get(loopNodeId) || [])
        .filter((source) => isCanvasReferenceNode(source, nodes, resolvedIndex))
        .map((source) => ({ source, inputs: source.type === CanvasNodeType.Group
            ? getGroupResourceNodes(source.id, nodes, resolvedIndex).flatMap((child) => readNodeGenerationResource(child, undefined, nodes, connections, resolvedIndex, loopContext, nextVisited))
            : readNodeGenerationResource(source, undefined, nodes, connections, resolvedIndex, loopContext, nextVisited) }));
    const media = (input: NodeGenerationResourceInput) => input.type === "image" || input.type === "video" || input.type === "audio";
    const groupMedia = sources.filter(({ source }) => source.type === CanvasNodeType.Group).flatMap(({ inputs }) => inputs.filter(media));
    const groupPrompts = sources.filter(({ source }) => source.type === CanvasNodeType.Group).flatMap(({ inputs }) => inputs.filter((input) => input.type === "text"));
    const directPrompts = sources.filter(({ source }) => source.type !== CanvasNodeType.Group).flatMap(({ inputs }) => inputs.filter((input) => input.type === "text"));
    return {
        prompts: [...groupPrompts, ...directPrompts],
        variablePrompts: groupPrompts.length ? groupPrompts : groupMedia.length || sources.some(({ inputs }) => inputs.some(media)) ? [] : directPrompts,
        fixedPrompts: groupPrompts.length ? directPrompts : groupMedia.length || sources.some(({ inputs }) => inputs.some(media)) ? directPrompts : [],
        variableMedia: groupMedia.length ? groupMedia : sources.flatMap(({ inputs }) => inputs.filter(media)),
        fixedMedia: groupMedia.length ? sources.filter(({ source }) => source.type !== CanvasNodeType.Group).flatMap(({ inputs }) => inputs.filter(media)) : [],
    };
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => {
        const media = input.type === "image" ? input.image?.storageKey || input.image?.dataUrl : input.type === "video" ? input.video?.storageKey || input.video?.url : input.type === "audio" ? input.audio?.storageKey || input.audio?.url : input.text;
        return [`${input.nodeId}:${input.type}:${media || ""}`, input];
    })).values()];
}

function readNodeGenerationResource(node: CanvasNodeData, characterSelection?: CanvasCharacterReferenceSelection, nodes?: CanvasNodeData[], connections?: CanvasConnection[], index?: CanvasGraphIndex, loopContext?: CanvasLoopRuntimeContext, visited = new Set<string>()): NodeGenerationResourceInput[] {
    const roundOutput = loopContext?.roundOutputs?.get(node.id);
    if (roundOutput) return flattenGenerationInputs(roundOutput);
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

export function recordLoopGenerationOutput(loopContext: CanvasLoopRuntimeContext | undefined, node: CanvasNodeData, mode: "image" | "video" | "audio" | "text", task: { result?: unknown }) {
    if (!loopContext?.roundOutputs) return;
    const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
    const media = Array.isArray(result.media) ? result.media : [];
    const outputs: NodeGenerationInput[] = mode === "text"
        ? (Array.isArray(result.texts) ? result.texts : []).flatMap((item, index): NodeGenerationInput[] => {
            const text = item && typeof item === "object" ? String((item as Record<string, unknown>).content || "") : "";
            return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
        })
        : media.flatMap((item, index): NodeGenerationInput[] => {
            if (!item || typeof item !== "object") return [];
            const value = item as Record<string, unknown>;
            const url = String(value.url || "");
            const storageKey = String(value.storageKey || "");
            if (!url && !storageKey) return [];
            const id = `${node.id}-loop-${loopContext.index}-${index}`;
            const name = `${node.title || node.id}-${index + 1}`;
            const mimeType = String(value.mimeType || `${mode}/*`);
            if (mode === "image") return [{ nodeId: node.id, type: "image", title: node.title, image: { id, name: `${name}.png`, type: mimeType, dataUrl: url, storageKey } }];
            if (mode === "video") return [{ nodeId: node.id, type: "video", title: node.title, video: { id, name: `${name}.mp4`, type: mimeType, url, storageKey } }];
            return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id, name: `${name}.mp3`, type: mimeType, url, storageKey } }];
        });
    if (!outputs.length) throw new Error(`循环中节点“${node.title || node.id}”的任务成功但没有可传递的结果`);
    loopContext.roundOutputs.set(node.id, outputs);
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
    const resolvedIndex = index || buildCanvasGraphIndex(nodes, connections);
    const metadata = node.metadata || {};
    const { variablePrompts, fixedPrompts, variableMedia, fixedMedia } = readLoopInputBuckets(node.id, nodes, connections, resolvedIndex, loopContext, visited);
    const iteration = Math.max(0, loopContext?.index || 0);
    const buckets = { variablePrompts, fixedPrompts, variableMedia, fixedMedia, prompts: [...variablePrompts, ...fixedPrompts] };
    const plan = loopResourcePlan(metadata, buckets);
    const position = plan.start - 1 + iteration * plan.batchSize;
    const selectedIds = new Set(roundInputNodeIds(buckets, plan, iteration));
    const selectedPromptIds = new Set([...new Set(variablePrompts.map((input) => input.nodeId))].slice(position, position + plan.batchSize));
    const result: NodeGenerationResourceInput[] = [];

    const selectedUpstream = variablePrompts.filter((input) => selectedPromptIds.has(input.nodeId)).map((input) => input.text || "").filter(Boolean);
    const fixedUpstream = fixedPrompts.map((input) => input.text || "").filter(Boolean);
    if (metadata.loopPromptEnabled || selectedUpstream.length || fixedUpstream.length) {
        const localPrompts = metadata.loopPromptEnabled ? metadata.loopPrompts !== undefined
            ? metadata.loopPrompts.map((value) => value.trim()).filter(Boolean)
            : splitLoopPromptItems(metadata.loopPrompt || "") : [];
        const prompt = localPrompts.length ? localPrompts[position % localPrompts.length] : "";
        const selected = [...selectedUpstream, ...fixedUpstream].join("\n\n");
        const effectivePrompt = selected && ["现在生成第《计数》张卖点图片", "Generate selling-point image 《计数》"].includes(prompt) ? "" : prompt;
        const combined = [selected, effectivePrompt].filter(Boolean).join("\n\n");
        if (combined) result.push({ nodeId: node.id, type: "text", title: node.title, text: renderLoopPrompt(combined, position, loopContext?.total || Math.max(1, metadata.loopCount || 1)) });
    }
    result.push(...fixedMedia);
    result.push(...variableMedia.filter((item) => item.type === plan.mediaKind && selectedIds.has(item.nodeId)).map((item) => ({ ...item, nodeId: node.id })));
    return result;
}

export function splitLoopPromptItems(value: string) {
    const text = value.trim();
    if (!text) return [];
    const numbered = text.split(/\s*(?:^|\s)\d+\s*[.、)）．]\s+/).map((item) => item.trim()).filter(Boolean);
    if (numbered.length >= 2) return numbered;
    const lines = text.split(/\r?\n+/).map((item) => item.trim()).filter(Boolean);
    return lines.length >= 2 ? lines : [text];
}

function selectLoopBatch<T extends NodeGenerationResourceInput>(items: T[], index: number, batchSize: number) {
    if (!items.length) return [];
    const size = Math.max(1, Math.min(100, Math.floor(batchSize) || 1));
    return items.slice(index, index + size);
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
    const images = [...context.loopInputImages, ...context.referenceImages];
    if (!images.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return {
        ...context,
        referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))),
        loopInputImages: await Promise.all(context.loopInputImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))),
    };
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
