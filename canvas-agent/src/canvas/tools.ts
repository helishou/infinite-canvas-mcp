import { canvasNodeDefaultSize } from "./node-sizes.js";
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
        if (anchor) return safePosition(anchor).x + nodeWidth(anchor) + 96;
    }
    const nodes = state?.nodes || [];
    return nodes.length ? Math.max(...nodes.map((node) => safePosition(node).x + nodeWidth(node))) + 80 : 0;
}

/** MCP 单节点默认落在选中节点附近；无选区时从画布内容左上区域开始，避免不断追加到最右端。 */
export function nextCanvasNodePosition(state: CanvasSnapshot | null, size: { width: number; height: number }) {
    const nodes = state?.nodes || [];
    const selected = nodes.find((node) => state?.selectedNodeIds?.includes(node.id));
    const desired = selected
        ? { x: safePosition(selected).x + nodeWidth(selected) + 80, y: safePosition(selected).y }
        : nodes.length
            ? { x: Math.min(...nodes.map((node) => safePosition(node).x)), y: Math.min(...nodes.map((node) => safePosition(node).y)) }
            : { x: 0, y: 0 };
    const gap = 48;
    const stepX = Math.max(1, size.width) + gap;
    const stepY = Math.max(1, size.height) + gap;
    const collides = (x: number, y: number) => nodes.some((node) => {
        const position = safePosition(node), width = nodeWidth(node), height = nodeHeight(node);
        return x < position.x + width + gap && x + size.width + gap > position.x
            && y < position.y + height + gap && y + size.height + gap > position.y;
    });
    if (!collides(desired.x, desired.y)) return desired;
    for (let ring = 1; ring <= 32; ring++) {
        const cells: Array<{ dx: number; dy: number }> = [];
        for (let dx = -ring; dx <= ring; dx++) cells.push({ dx, dy: -ring }, { dx, dy: ring });
        for (let dy = -ring + 1; dy < ring; dy++) cells.push({ dx: -ring, dy }, { dx: ring, dy });
        cells.sort((a, b) => (a.dx * a.dx + a.dy * a.dy) - (b.dx * b.dx + b.dy * b.dy)
            || ((a.dx > 0 && a.dy === 0 ? 0 : a.dx === 0 && a.dy > 0 ? 1 : a.dx < 0 && a.dy === 0 ? 2 : a.dx === 0 && a.dy < 0 ? 3 : 4)
                - (b.dx > 0 && b.dy === 0 ? 0 : b.dx === 0 && b.dy > 0 ? 1 : b.dx < 0 && b.dy === 0 ? 2 : b.dx === 0 && b.dy < 0 ? 3 : 4)));
        for (const cell of cells) {
            const position = { x: desired.x + cell.dx * stepX, y: desired.y + cell.dy * stepY };
            if (!collides(position.x, position.y)) return position;
        }
    }
    return { x: Math.max(desired.x, ...nodes.map((node) => safePosition(node).x + nodeWidth(node) + gap)), y: desired.y };
}

/** 计算新节点的默认起点（x + y）。传 anchorId 时新节点贴在 anchor 同行右侧、y 与 anchor 对齐，
 * 没有 anchor 时 x 走 nextCanvasX、y 用 0。 */
export function nextCanvasAnchor(state: CanvasSnapshot | null, anchorId?: string): { x: number; y: number } {
    if (anchorId) {
        const anchor = (state?.nodes || []).find((node) => node.id === anchorId);
        if (anchor) {
            const position = safePosition(anchor);
            return { x: position.x + nodeWidth(anchor) + 96, y: position.y };
        }
    }
    return { x: nextCanvasX(state), y: 0 };
}

/** 计算生成流默认落点：参考节点同行右侧若已被占用，则继续向右找空位。 */
export function nextCanvasFlowAnchor(
    state: CanvasSnapshot | null,
    anchorId: string | undefined,
    options: { includePrompt?: boolean; promptWidth?: number; promptHeight?: number; configOffset?: number; configWidth?: number; configHeight?: number } = {},
): { x: number; y: number } {
    const base = nextCanvasAnchor(state, anchorId);
    const includePrompt = options.includePrompt !== false;
    const promptSize = canvasNodeDefaultSize("text");
    const configSize = canvasNodeDefaultSize("config");
    const promptWidth = safeDimension(options.promptWidth, promptSize.width);
    const promptHeight = safeDimension(options.promptHeight, promptSize.height);
    const configOffset = safeDimension(options.configOffset, 420);
    const configWidth = safeDimension(options.configWidth, configSize.width);
    const configHeight = safeDimension(options.configHeight, configSize.height);
    const nodes = state?.nodes || [];
    let x = base.x;
    for (let attempt = 0; attempt < 128; attempt++) {
        const rectangles = [
            ...(includePrompt ? [{ x, y: base.y, width: promptWidth, height: promptHeight }] : []),
            { x: x + configOffset, y: base.y, width: configWidth, height: configHeight },
        ];
        const collided = nodes.filter((node) => {
            const position = safePosition(node);
            const width = nodeWidth(node);
            const height = nodeHeight(node);
            return rectangles.some((rect) => rect.x < position.x + width + 8
                && rect.x + rect.width + 8 > position.x
                && rect.y < position.y + height + 8
                && rect.y + rect.height + 8 > position.y);
        });
        if (!collided.length) return { x, y: base.y };
        x = Math.max(...collided.map((node) => safePosition(node).x + nodeWidth(node))) + 96;
    }
    return { x, y: base.y };
}

/** 节点缺省宽高时按它自己的类型取默认尺寸，而不是统一当成 320×240。 */
function nodeWidth(node: Pick<CanvasNode, "type" | "width">) {
    return safeDimension(node.width, canvasNodeDefaultSize(node.type).width);
}

function nodeHeight(node: Pick<CanvasNode, "type" | "height">) {
    return safeDimension(node.height, canvasNodeDefaultSize(node.type).height);
}

function safePosition(node: Pick<CanvasNode, "position">) {
    const position = node.position || { x: 0, y: 0 };
    return { x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0, y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0 };
}

function safeDimension(value: unknown, fallback: number) {
    const dimension = Number(value);
    return Number.isFinite(dimension) && dimension > 0 ? dimension : fallback;
}
