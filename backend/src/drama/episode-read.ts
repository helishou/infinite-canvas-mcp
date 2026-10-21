export type EpisodeCanvasView = "ref" | "full";

/**
 * `drama_get_episode` 默认只返回画布引用：整张画布可能内联数百 KB 媒体，不能塞进一次读取。
 * 网页沿用完整画布（不传 canvasView 时为 full）；Agent/MCP 显式请求 ref 并用 canvas_get_state 分页读取。
 */
export function episodeCanvasRead(canvas: Record<string, any> | null, view: EpisodeCanvasView) {
    if (!canvas) return { canvas: null };
    if (view === "full") return { canvas };
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    return {
        canvas: {
            id: canvas.id,
            title: canvas.title,
            revision: canvas.revision,
            nodeCount: nodes.length,
            connectionCount: connections.length,
            updatedAt: canvas.updatedAt,
        },
        nextAction: {
            tool: "canvas_get_state",
            input: { projectId: canvas.id, view: "graph" },
            message: "画布正文未内联；节点用 canvas_get_state 的 nodeIds/nodeLimit/nodeOffset 分页读取，协作文本用 canvas_read_text。",
        },
    };
}
