/** Read-only canvas projection of the Backend's compiled, approved image input. */
export type ProductionImageReference = {
    label: string; nodeId: string; assetId: string; assetVersion: string;
    storageKey: string; sha256: string; role: string; preserve?: unknown; exclude?: unknown;
};
export type ProductionImageInput = {
    schemaVersion: 1; targetId: string; sourceNodeId: string;
    sourceHash: string; promptHash: string; inputHash: string;
    references: ProductionImageReference[];
    stale?: boolean;
};

export function productionImageInput(node: { metadata?: unknown } | undefined): ProductionImageInput | undefined {
    const metadata = node?.metadata as Record<string, unknown> | undefined;
    const input = metadata?.productionImageInput as ProductionImageInput | undefined;
    if (!input) return undefined;
    if (input.schemaVersion !== 1 || !input.targetId || !input.sourceNodeId || !Array.isArray(input.references)
        || input.references.some(ref => !ref.nodeId || !ref.storageKey || !ref.sha256 || !ref.assetId || !ref.assetVersion)) {
        throw new Error("正式图片参考清单无效，请回读制作稿并重新准备节点");
    }
    return input;
}
