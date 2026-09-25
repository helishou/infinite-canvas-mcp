import type { CanvasOperation } from "./project-ops.js";
import type { Stores } from "../stores/types.js";

type CharacterNode = { id: string; type: string; title?: string; metadata?: Record<string, unknown> };

/** 打开画布时只从资产库刷新当前画布；资产写入和节点编辑均不触发此函数。 */
export function syncCharacterAssetsForProject(stores: Stores, projectId: string) {
    const project = stores.projects.get(projectId);
    if (!project) throw new Error(`画布不存在: ${projectId}`);
    const assets = stores.assets.list({ kind: "character" });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const nodes = Array.isArray(project.nodes) ? project.nodes as CharacterNode[] : [];
    const allProjects = stores.projects.list();
    const operations: CanvasOperation[] = nodes.flatMap((node) => {
        if (node.type !== "character") return [];
        const linked = byId.get(String(node.metadata?.characterAssetId || ""));
        const legacy = !linked && !node.metadata?.characterAssetId
            ? assets.filter((asset) => asset.metadata?.source === "canvas" && asset.metadata.nodeId === node.id && (!asset.metadata.projectId || asset.metadata.projectId === projectId))
            : [];
        const uniqueOrigin = legacy.length === 1 && allProjects.filter((item) => Array.isArray(item.nodes) && (item.nodes as CharacterNode[]).some((candidate) => candidate.id === node.id && candidate.type === "character")).length === 1;
        const asset = linked || (uniqueOrigin ? legacy[0] : undefined);
        if (!asset) return [];
        const data = asset.data && typeof asset.data === "object" && !Array.isArray(asset.data) ? asset.data : {};
        const images = Array.isArray(data.images) ? data.images : [];
        const fields: Record<string, unknown> = {
            characterAssetId: asset.id,
            characterName: asset.title,
            characterEnglishName: data.englishName || "",
            characterDescription: data.description || "",
            characterImages: images,
            characterVoiceUrl: data.voice || "",
            characterVoiceName: data.voiceName || "",
            characterVoiceDescription: data.voiceDescription || "",
            characterVoiceStorageKey: data.voiceStorageKey || "",
            characterVoiceAssetId: data.voiceAssetId || "",
        };
        const previousImages = Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages as Array<Record<string, unknown>> : [];
        if (JSON.stringify(previousImages) !== JSON.stringify(images)) {
            const previousIndex = Math.min(Math.max(Number(node.metadata?.characterPrimaryIndex) || 0, 0), Math.max(previousImages.length - 1, 0));
            const previousPrimary = previousImages[previousIndex];
            const match = images.findIndex((image) => {
                const candidate = image as Record<string, unknown>;
                return previousPrimary?.storageKey ? candidate.storageKey === previousPrimary.storageKey : Boolean(previousPrimary?.url && candidate.url === previousPrimary.url);
            });
            const primaryIndex = match >= 0 ? match : Math.min(previousIndex, Math.max(images.length - 1, 0));
            const primary = images[primaryIndex] as Record<string, unknown> | undefined;
            Object.assign(fields, {
                characterPrimaryIndex: primaryIndex,
                content: primary?.url || "",
                storageKey: primary?.storageKey || "",
                naturalWidth: primary?.width || 0,
                naturalHeight: primary?.height || 0,
                bytes: primary?.bytes || 0,
                mimeType: primary?.mimeType || "",
            });
        }
        const metadata = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(node.metadata?.[key]) !== JSON.stringify(value)));
        const patch = node.title === asset.title ? {} : { title: asset.title };
        return Object.keys(metadata).length || Object.keys(patch).length ? [{ type: "update_node", id: node.id, patch, metadata }] : [];
    });
    if (!operations.length) return { projectId, revision: Number(project.revision || 0), updatedAt: String(project.updatedAt || ""), operations, updated: 0 };
    const result = stores.projects.applyOperations(projectId, undefined, operations, {
        source: { clientId: "system:character-assets-on-open", kind: "system", label: "打开画布同步角色资产" },
    });
    return { projectId, revision: result.revision, updatedAt: String(result.project.updatedAt || ""), operations: result.operations, updated: operations.length };
}
