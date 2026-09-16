import { toolInputSchemas, toolNames, type ToolName } from "./schemas.js";
import type { CanvasNode, CanvasSnapshot } from "./types.js";

/** 判断传入名称是否为已注册的画布工具。 */
export function isToolName(name: unknown): name is ToolName {
    return typeof name === "string" && toolNames.includes(name as ToolName);
}

/** 按工具名称校验并解析调用参数。 */
export function parseToolInput(name: ToolName, input: unknown) {
    return toolInputSchemas[name].parse(input ?? {});
}

/** 压缩画布快照，避免向 Agent 返回过长的节点内容。 */
export function compactCanvasState(state: CanvasSnapshot | null) {
    if (!state) throw new Error("当前没有已连接画布");
    return { ...state, nodes: (state.nodes || []).map(compactNode) };
}

/** 压缩单个画布节点的元数据内容。 */
export function compactNode(node: CanvasNode) {
    const metadata = { ...(node.metadata || {}) };
    if (typeof metadata.content === "string" && metadata.content.length > 240) metadata.content = `${metadata.content.slice(0, 120)}...`;
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata };
}

/** 计算新节点在当前画布右侧的默认横坐标。
 * 传 anchorId 时新节点会贴在 anchor 节点同行右侧（结果落位是 96px 间距，与 backend db.ts:437 一致），
 * 用于 generation flow 复用上游参考图位置：避免多次 MCP 调用把节点推到画布最远端。 */
export function nextCanvasX(state: CanvasSnapshot | null, anchorId?: string) {
    if (anchorId) {
        const anchor = (state?.nodes || []).find((node) => node.id === anchorId);
        if (anchor) return anchor.position.x + (anchor.width || 0) + 96;
    }
    const nodes = state?.nodes || [];
    return nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + 80 : 0;
}

/** 计算新节点的默认起点（x + y）。传 anchorId 时新节点贴在 anchor 同行右侧、y 与 anchor 对齐，
 * 没有 anchor 时 x 走 nextCanvasX、y 用 0。 */
export function nextCanvasAnchor(state: CanvasSnapshot | null, anchorId?: string): { x: number; y: number } {
    if (anchorId) {
        const anchor = (state?.nodes || []).find((node) => node.id === anchorId);
        if (anchor) return { x: anchor.position.x + (anchor.width || 0) + 96, y: anchor.position.y || 0 };
    }
    return { x: nextCanvasX(state), y: 0 };
}
