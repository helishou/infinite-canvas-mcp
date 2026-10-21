type Row = Record<string, any>;
export type ImageNodeChoice = { projectId: string; nodeId: string; assetId?: string; title?: string; shared?: boolean; sharedProjection?: boolean };
export function imageChoiceKey(value?: { projectId?: string; nodeId?: string }) { return value?.projectId && value.nodeId ? JSON.stringify([value.projectId, value.nodeId]) : undefined; }
export function smartImageChoices(canvasId: string, nodes: Row[], assets: Record<string, Row>, sharedProjects: Row[], assetPlan: Row[] = []) {
    const valid = (node: Row) => ["character", "scene", "prop"].includes(String(node.type)) || node.type === "image" && Boolean(node.metadata?.storageKey) || node.type === "config" && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image";
    const result: ImageNodeChoice[] = nodes.filter(valid).map(node => {
        const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata as Row : {};
        const sharedOrigin = (metadata.sharedAssetReference || metadata.sharedAssetOrigin) as Row | undefined;
        const sharedAssetId = String(metadata.productionAssetId || sharedOrigin?.assetId || "");
        const sharedPlan = sharedOrigin && (assetPlan.find(row => String(row.id || row.asset_id || "") === sharedAssetId)
            || assetPlan.find(row => {
                const source = row.sharedSource as Row | undefined;
                return source?.sourceProjectId === sharedOrigin.sourceProjectId && source?.sourceNodeId === sharedOrigin.sourceNodeId;
            }));
        const localAssetId = Object.entries(assets).find(([assetId, asset]) => asset.nodeId === node.id
            && !assetPlan.some(row => String(row.id || row.asset_id || "") === assetId && row.sharedSource))?.[0];
        return {
            projectId: canvasId,
            nodeId: node.id,
            title: sharedPlan?.asset_name || node.title,
            assetId: sharedPlan ? String(sharedPlan.id || sharedPlan.asset_id || "") || undefined : localAssetId,
            ...(sharedOrigin && sharedPlan ? { sharedProjection: true } : {}),
        };
    });
    for (const plan of assetPlan) {
        const assetId = String(plan.id || plan.asset_id || "");
        const source = plan.sharedSource as Row | undefined;
        if (!source || source.sourceProjectId === canvasId) continue;
        const project = sharedProjects.find(project => project.id === source.sourceProjectId), node = project?.nodes?.find((node: Row) => node.id === source.sourceNodeId);
        if (!project || !node || !valid(node)) continue;
        const key = imageChoiceKey({ projectId: project.id, nodeId: node.id });
        if (result.some(choice => imageChoiceKey(choice) === key)) continue;
        result.push({ projectId: project.id, nodeId: node.id, assetId, title: plan?.asset_name || plan?.name || node.title, shared: true });
    }
    return result;
}
