import type { CanvasProject } from "../db.js";

export type ResolvedCanvasImageReference = {
    id: string;
    name: string;
    storageKey?: string;
    dataUrl?: string;
    url?: string;
    mimeType: string;
};

/**
 * 配置节点只是智能节点的持久化外壳；真正参与参考图解析的类型由
 * metadata.generationMode 决定。不要把它当作字面上的 config 丢弃。
 */
export function effectiveCanvasNodeType(node: Record<string, unknown>) {
    const type = String(node.type || "");
    const metadata = recordOf(node.metadata);
    if (type === "config" && metadata.smart === true) {
        const mode = String(metadata.generationMode || "").trim();
        if (["text", "image", "video", "audio"].includes(mode)) return mode;
    }
    return type;
}

/** 把单个节点按其有效类型展开成真正能交给 provider 的图片输入。 */
export function resolveCanvasImageReferenceNode(
    node: Record<string, unknown>,
    referenceTarget: Record<string, unknown> = node,
    added: Set<string> = new Set(),
) {
    const references: ResolvedCanvasImageReference[] = [];
    const effectiveType = effectiveCanvasNodeType(node);
    if (effectiveType === "image") {
        if (String(node.type || "") === "config") addSmartImageReferences(node, references, added);
        else addImageReference(node, references, added);
    } else if (effectiveType === "character") {
        addCharacterImageReferences(node, referenceTarget, references, added);
    } else if (effectiveType === "scene") {
        addSceneImageReferences(node, references, added);
    }
    return references;
}

/** 按调用方明确给出的节点 ID 展开参考图，保留用户选择顺序。 */
export function resolveCanvasImageReferencesByIds(
    project: CanvasProject,
    targetNodeId: string,
    referenceNodeIds: string[],
) {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const target = nodeById.get(targetNodeId);
    if (!target) return [];
    const added = new Set<string>();
    return referenceNodeIds.flatMap((id) => {
        const node = nodeById.get(String(id));
        return node ? resolveCanvasImageReferenceNode(node, target, added) : [];
    });
}

/**
 * 从画布图谱解析图片生成的参考图。
 * sourceNodeId 是本次生成的源节点：配置节点直接读入边；生成结果节点
 * 先沿父级配置节点回溯，再把自身作为改图源，顺序与前端展示顺序一致。
 */
export function resolveCanvasImageReferences(project: CanvasProject, sourceNodeId: string) {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const source = nodeById.get(sourceNodeId);
    if (!source) return null;

    const references: ResolvedCanvasImageReference[] = [];
    const added = new Set<string>();
    if (String(source.type || "") === "image") addImageReference(source, references, added);

    if (String(source.type || "") === "image" && recordOf(source.metadata).generationType === "edit") {
        // 局部修改的输入顺序就是提示词里的「图片1=原图、图片2=蒙版」：
        // 先按连线顺序补上改图源（图片节点本身，或智能节点的主图），再把蒙版排到最后。
        const incoming = incomingNodes(sourceNodeId, connections, nodeById);
        for (const node of incoming) {
            if (isMaskOverlayNode(node)) continue;
            if (effectiveCanvasNodeType(node) === "image") references.push(...resolveCanvasImageReferenceNode(node, source, added));
        }
        for (const node of incoming) {
            if (String(node.type || "") === "image" && isMaskOverlayNode(node)) addImageReference(node, references, added);
        }
        return references;
    }

    const inputNode = String(source.type || "") === "config"
        ? source
        : outgoingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config")
            || incomingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config");
    const referenceTarget = inputNode || source;
    for (const node of incomingNodes(String(referenceTarget.id || ""), connections, nodeById)) {
        references.push(...resolveCanvasImageReferenceNode(node, referenceTarget, added));
    }
    return references;
}

/** Resolve the directly referenced scene nodes in the same order used for generation image inputs. */
export function resolveCanvasSceneNodes(project: CanvasProject, sourceNodeId: string) {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const source = nodeById.get(sourceNodeId);
    if (!source) return [];
    const inputNode = String(source.type || "") === "config"
        ? source
        : outgoingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config")
            || incomingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config");
    return incomingNodes(String((inputNode || source).id || ""), connections, nodeById)
        .filter((node) => String(node.type || "") === "scene");
}

function incomingNodes(targetId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.toNodeId || "") === targetId)
        .sort((left, right) => {
            const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
            const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder;
        })
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.fromNodeId || ""));
            return node ? [node] : [];
        });
}

function outgoingNodes(sourceId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.fromNodeId || "") === sourceId)
        .sort((left, right) => {
            const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
            const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder;
        })
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.toNodeId || ""));
            return node ? [node] : [];
        });
}

function addImageReference(node: Record<string, unknown>, references: ResolvedCanvasImageReference[], added: Set<string>) {
    const id = String(node.id || "");
    const metadata = recordOf(node.metadata);
    const content = String(metadata.content || metadata.url || "");
    const storageKey = String(metadata.storageKey || "");
    if (!id || (!content && !storageKey) || added.has(id)) return;
    added.add(id);
    references.push({
        id,
        name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.png`,
        ...(storageKey ? { storageKey } : {}),
        ...(content.startsWith("data:") ? { dataUrl: content } : {}),
        ...(content && !content.startsWith("data:") ? { url: content } : {}),
        mimeType: String(metadata.mimeType || "image/png"),
    });
}

function addSmartImageReferences(node: Record<string, unknown>, references: ResolvedCanvasImageReference[], added: Set<string>) {
    const id = String(node.id || "");
    if (!id) return;
    const metadata = recordOf(node.metadata);
    const images = Array.isArray(metadata.images) ? metadata.images.filter((image): image is Record<string, unknown> => Boolean(image) && typeof image === "object" && !Array.isArray(image)) : [];
    const completedImages = images.filter((image) => Boolean(image.content || image.storageKey));
    if (!completedImages.length) {
        addImageReference(node, references, added);
        return;
    }
    const primaryImageId = String(metadata.primaryImageId || "");
    const image = completedImages.find((item) => String(item.id || "") === primaryImageId) || completedImages[0];
    const imageIndex = images.indexOf(image);
    const imageId = String(image.id || imageIndex);
    const referenceId = `${id}:image:${imageId}`;
    if (added.has(referenceId)) return;
    const content = String(image.content || "");
    const storageKey = String(image.storageKey || "");
    added.add(referenceId);
    references.push({
        id: referenceId,
        name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}-${imageIndex + 1}.png`,
        ...(storageKey ? { storageKey } : {}),
        ...(content.startsWith("data:") ? { dataUrl: content } : {}),
        ...(content && !content.startsWith("data:") ? { url: content } : {}),
        mimeType: String(image.mimeType || metadata.mimeType || "image/png"),
    });
}

function addCharacterImageReferences(node: Record<string, unknown>, referenceTarget: Record<string, unknown>, references: ResolvedCanvasImageReference[], added: Set<string>) {
    const id = String(node.id || "");
    if (!id || added.has(id)) return;
    added.add(id);
    const metadata = recordOf(node.metadata);
    const images = Array.isArray(metadata.characterImages) ? metadata.characterImages.filter((image): image is Record<string, unknown> => Boolean(image) && typeof image === "object" && !Array.isArray(image)) : [];
    const targetMetadata = recordOf(referenceTarget.metadata);
    const selections = recordOf(targetMetadata.characterReferences);
    const selection = recordOf(selections[id]);
    const primaryIndex = Math.min(Math.max(Number(metadata.characterPrimaryIndex ?? 0), 0), Math.max(images.length - 1, 0));
    const primaryImage = images[primaryIndex];
    const primaryKey = primaryImage ? String(primaryImage.storageKey || primaryImage.url || primaryImage.name || `image-${primaryIndex}`) : "";
    const selectedKeys = Array.isArray(selection.imageKeys) ? new Set(selection.imageKeys.map(String)) : new Set(primaryKey ? [primaryKey] : []);
    images.forEach((image, index) => {
        const key = String(image.storageKey || image.url || image.name || `image-${index}`);
        if (selectedKeys && !selectedKeys.has(key)) return;
        const content = String(image.url || "");
        const storageKey = String(image.storageKey || "");
        if (!content && !storageKey) return;
        references.push({
            id: `${id}:character-image:${key}`,
            name: String(image.name || node.title || id),
            ...(storageKey ? { storageKey } : {}),
            ...(content.startsWith("data:") ? { dataUrl: content } : {}),
            ...(content && !content.startsWith("data:") ? { url: content } : {}),
            mimeType: String(image.mimeType || "image/png"),
        });
    });
}

function addSceneImageReferences(node: Record<string, unknown>, references: ResolvedCanvasImageReference[], added: Set<string>) {
    const id = String(node.id || "");
    if (!id || added.has(id)) return;
    const metadata = recordOf(node.metadata);
    // 色卡是 SVG 元数据，供画布展示/提示词使用，不作为图片模型的二进制参考图。
    // 直连 GPT Image 的 multipart image[] 只接受可解码的栅格图片；把 SVG 色卡混入会让整个请求失败。
    const images = [
        { key: "sceneImage", label: "scene" },
    ] as const;
    let addedImage = false;
    for (const { key, label } of images) {
        const image = recordOf(metadata[key]);
        const content = String(image.url || "");
        const storageKey = String(image.storageKey || "");
        if (!content && !storageKey) continue;
        addedImage = true;
        const referenceId = `${id}:${label}`;
        if (added.has(referenceId)) continue;
        added.add(referenceId);
        references.push({
            id: referenceId,
            name: String(image.name || `${node.title || id}-${label}`),
            ...(storageKey ? { storageKey } : {}),
            ...(content.startsWith("data:") ? { dataUrl: content } : {}),
            ...(content && !content.startsWith("data:") ? { url: content } : {}),
            mimeType: String(image.mimeType || "image/png"),
        });
    }
    if (addedImage) added.add(id);
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 蒙版标注节点：新建画布写入 metadata.maskOverlay，旧画布没有标记时按标题兜底。
 * 它只用于把蒙版排到改图输入的末位，不参与普通参考图解析。
 */
export function isMaskOverlayNode(node: Record<string, unknown>) {
    const metadata = recordOf(node.metadata);
    if (metadata.maskOverlay === true || metadata.maskRole === "mask") return true;
    return /遮罩|蒙版/.test(String(node.title || ""));
}
