import crypto from "node:crypto";

type Node = Record<string, any>;
export type Position = { x: number; y: number };
export const productionLayoutStableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
export const productionSharedProjectionNodeId = (episodeId: string, targetId: string) => `shared-ref-${productionLayoutStableId("shared-ref", episodeId, targetId).slice(0, 24)}`;

const nodeSize = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** Find space without moving existing production or user-created nodes. */
export function productionNodePosition(nodes: Node[], preferred: Position, width: number, height: number, columns = 3): Position {
    for (let slot = 0; ; slot++) {
        const position = { x: preferred.x + slot % columns * (width + 100), y: preferred.y + Math.floor(slot / columns) * (height + 120) };
        const overlaps = nodes.some(node => {
            if (!node.position) return false;
            const x = Number(node.position.x), y = Number(node.position.y);
            return position.x < x + nodeSize(node.width, 340) + 60 && position.x + width + 60 > x
                && position.y < y + nodeSize(node.height, 260) + 60 && position.y + height + 60 > y;
        });
        if (!overlaps) return position;
    }
}

export function productionAssetPosition(nodes: Node[], assetIds: string[], assetId: string): Position {
    const index = Math.max(0, assetIds.indexOf(assetId));
    return productionNodePosition(nodes, { x: index % 3 * 720, y: Math.floor(index / 3) * 840 }, 620, 720);
}

export function productionOutputPosition(nodes: Node[]): Position {
    const formal = nodes.filter(node => node.metadata?.productionAssetId || node.metadata?.productionShotId || node.metadata?.productionScriptId || node.metadata?.productionSceneId);
    const bottom = Math.max(520, ...formal.map(node => Number(node.position?.y || 0) + nodeSize(node.height, 260)));
    return productionNodePosition(nodes, { x: 0, y: bottom + 160 }, 1960, 1080, 1);
}

export function productionSceneLayout(members: Node[], shotIds: string[], origin: Position) {
    const leftColumnWidth = 760, columnGap = 120, videoLeftOffset = 40 + leftColumnWidth + columnGap;
    const videos = members.filter(node => node.type === "minimax-h3:video");
    const leftMembers = members.filter(node => node.type !== "minimax-h3:video");
    const slots = new Map<string, Node[]>();
    for (const node of leftMembers) {
        const key = String(node.metadata?.productionShotId || node.id);
        slots.set(key, [...(slots.get(key) || []), node]);
    }
    const ordered = [...slots].sort(([a], [b]) => {
        const ai = shotIds.indexOf(a), bi = shotIds.indexOf(b);
        return (ai < 0 ? shotIds.length : ai) - (bi < 0 ? shotIds.length : bi);
    }).map(([, nodes]) => nodes.sort((a, b) => Number(a.type === "config") - Number(b.type === "config")));
    const positions: Array<{ id: string; position: Position }> = [];
    let y = origin.y + 70;
    for (const slot of ordered) {
        let slotY = y;
        for (const node of slot) {
            positions.push({ id: node.id, position: { x: origin.x + 20, y: slotY } });
            slotY += nodeSize(node.height, 260) + 60;
        }
        y = slotY;
    }
    const leftHeight = y - origin.y;
    let videoY = origin.y + 70, videoWidth = 0;
    for (const node of videos) {
        positions.push({ id: node.id, position: { x: origin.x + videoLeftOffset, y: videoY } });
        videoWidth = Math.max(videoWidth, nodeSize(node.width, 620));
        videoY += nodeSize(node.height, 500) + 100;
    }
    const rightHeight = videoY - origin.y;
    const width = Math.max(2160, videoLeftOffset + videoWidth + 40);
    return { positions, width, height: Math.max(900, leftHeight, rightHeight) };
}
