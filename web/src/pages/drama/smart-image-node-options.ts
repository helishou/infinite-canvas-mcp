type Row = Record<string, any>;
export type ImageNodeChoice = { projectId: string; nodeId: string; assetId?: string; title?: string; shared?: boolean };
export function imageChoiceKey(value?: { projectId?: string; nodeId?: string }) { return value?.projectId && value.nodeId ? JSON.stringify([value.projectId, value.nodeId]) : undefined; }
export function smartImageChoices(canvasId: string, nodes: Row[], assets: Record<string, Row>, sharedProjects: Row[], assetPlan: Row[] = []) {
    const valid = (node: Row) => node.type === "config" && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image";
    const result: ImageNodeChoice[] = nodes.filter(valid).map(node => ({ projectId: canvasId, nodeId: node.id, title: node.title, assetId: Object.entries(assets).find(([, asset]) => asset.nodeId === node.id && !asset.sharedSource)?.[0] }));
    for (const [assetId, asset] of Object.entries(assets)) {
        const source = asset.sharedSource;
        if (!source || source.sourceProjectId === canvasId) continue;
        const project = sharedProjects.find(project => project.id === source.sourceProjectId), node = project?.nodes?.find((node: Row) => node.id === source.sourceNodeId);
        if (!project || !node || !valid(node)) continue;
        const key = imageChoiceKey({ projectId: project.id, nodeId: node.id });
        if (result.some(choice => imageChoiceKey(choice) === key)) continue;
        const plan = assetPlan.find(row => (row.asset_id || row.id) === assetId);
        result.push({ projectId: project.id, nodeId: node.id, assetId, title: plan?.asset_name || plan?.name || node.title, shared: true });
    }
    return result;
}
